"""Shared helpers of the Telegram tests: register bots in the registry, read a conversation's state, strip and add the
role namespace of callback data. Nothing here talks to Telegram."""

from __future__ import annotations

import itertools
import re
from typing import Any

import psycopg

from nazoratly.telegram_registry import bot_id_of_token, secret_hash

_NAMESPACE = re.compile(r"^[gt]:\d+:")
_UPDATE_IDS = itertools.count(10_000_000)


def next_update_id() -> int:
    return next(_UPDATE_IDS)


def register_shared(dsn: str, box: Any, token: str, secret: str, username: str = "nazoratly_test_bot") -> str:
    """Register the shared bot the way `telegram_setup` does; returns its webhook path."""
    with psycopg.connect(dsn, autocommit=True) as c:
        row = c.execute(
            "SELECT out_public_id FROM tg_shared_register(%s, %s, %s, %s)",
            (bot_id_of_token(token), username, box.encrypt(token), secret_hash(secret)),
        ).fetchone()
    assert row is not None
    return f"/hooks/bot/{row[0]}"


def drop_bots(dsn: str) -> None:
    """Forget every registered bot (and their conversations), so other tests see an unconfigured server."""
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute("DELETE FROM telegram_bots")


def chat_state(dsn: str, chat: int, bot_path: str | None = None) -> tuple[str | None, int | None, int] | None:
    """(chosen role, chosen center, epoch) of a person with a bot (the shared one unless a webhook path is given)."""
    where = "b.public_id = %s::uuid" if bot_path else "b.org_id IS NULL AND %s::text IS NULL"
    with psycopg.connect(dsn, autocommit=True) as c:
        row = c.execute(
            "SELECT t.active_role, t.active_org_id, t.epoch FROM telegram_chats t JOIN telegram_bots b ON b.id = t.bot_id "
            f"WHERE t.telegram_user_id = %s AND b.status = 'active' AND {where}",
            (chat, bot_path.rsplit("/", 1)[1] if bot_path else None),
        ).fetchone()
    return None if row is None else (row[0], row[1], row[2])


def strip_ns(data: str) -> str:
    return _NAMESPACE.sub("", data)


def has_ns(data: str) -> bool:
    return bool(_NAMESPACE.match(data)) or data.startswith("role:")


def register_center(
    dsn: str, box: Any, org_public: str, token: str, secret: str, username: str, *, stopped: bool = False
) -> str:
    """A center bot written straight into the registry (the connect API has its own tests); returns its webhook path."""
    with psycopg.connect(dsn, autocommit=True) as c:
        row = c.execute(
            "INSERT INTO telegram_bots (org_id, bot_user_id, username, secret_ciphertext, token_hash, method, status, "
            "shared_stopped_at) SELECT id, %s, %s, %s, %s, 'token', 'active', CASE WHEN %s THEN now() END "
            "FROM organizations WHERE public_id = %s::uuid RETURNING public_id",
            (bot_id_of_token(token), username, box.encrypt(token), secret_hash(secret), stopped, org_public),
        ).fetchone()
    assert row is not None
    return f"/hooks/bot/{row[0]}"
