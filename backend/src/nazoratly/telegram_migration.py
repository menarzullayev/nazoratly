"""Staged move of a center's people from the shared bot to the center's own bot: the one-time transition code.

A code is made in the shared bot for the Telegram account that asked, lives 30 minutes, works once, and only that same
account can use it in the center's bot. Only its hash is stored."""

from __future__ import annotations

import secrets

from nazoratly.db import Database, Session, execute, fetch_one
from nazoratly.rules import guardian as G
from nazoratly.security import sha256

PREFIX = "NZM-"
LENGTH = 20
TTL_MINUTES = 30


def new_code() -> str:
    return PREFIX + "".join(secrets.choice(G.CODE_ALPHABET) for _ in range(LENGTH))


def looks_like_code(text: str) -> bool:
    return text.strip().upper().startswith(PREFIX)


def _hash(code: str) -> str:
    return sha256(code.strip().upper()).hex()


def _session(org_id: int) -> Session:
    return Session(user_id=None, org_id=org_id, actor_type="system")


async def issue(db: Database, org_id: int, telegram_user_id: int) -> str:
    """A new code for this account; earlier unused ones of the same center stop working."""
    code = new_code()
    async with db.tx(_session(org_id)) as conn:
        await execute(
            conn,
            "DELETE FROM telegram_migration_codes WHERE (telegram_user_id = %s AND used_at IS NULL) "
            "OR expires_at < now() - interval '1 day'",
            (telegram_user_id,),
        )
        await execute(
            conn,
            "INSERT INTO telegram_migration_codes (org_id, telegram_user_id, token_hash, expires_at) "
            "VALUES (%s, %s, %s, now() + make_interval(mins => %s))",
            (org_id, telegram_user_id, _hash(code), TTL_MINUTES),
        )
    return code


async def redeem(db: Database, org_id: int, telegram_user_id: int, code: str) -> bool:
    """Use a code in the center's bot. False for an unknown, used, expired or foreign code (which stays unused)."""
    async with db.tx(_session(org_id)) as conn:
        row = await fetch_one(
            conn,
            "UPDATE telegram_migration_codes SET used_at = now() WHERE token_hash = %s AND telegram_user_id = %s "
            "AND used_at IS NULL AND expires_at > now() RETURNING id",
            (_hash(code), telegram_user_id),
        )
    return row is not None
