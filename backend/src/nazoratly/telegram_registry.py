"""The registry of Telegram bots (migration 0068): the shared nazoratly bot and the bots centers own.

A bot token exists in the database only encrypted (`SecretsBox`) and a webhook secret only as its sha256. Nothing here
ever returns or logs a token; `BotInfo.__repr__` leaves it out."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass, field
from typing import Any

from nazoratly.config import Settings
from nazoratly.db import Conn, Database, Session, fetch_all, fetch_one
from nazoratly.secrets_box import SecretsBox

ANON = Session(user_id=None, org_id=None, actor_type="system")


@dataclass(frozen=True)
class BotInfo:
    id: int
    public_id: uuid.UUID
    org_id: int | None  # None = the shared bot
    bot_user_id: int
    username: str
    token: str = field(repr=False)

    @property
    def shared(self) -> bool:
        return self.org_id is None


def new_webhook_secret() -> str:
    """A secret_token for setWebhook: 1-256 characters of A-Z a-z 0-9 _ - (Bot API)."""
    return secrets.token_urlsafe(32)


def secret_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def bot_id_of_token(token: str) -> int | None:
    """The numeric id a bot token starts with (`123456:AAH...`)."""
    head = token.split(":", 1)[0]
    return int(head) if head.isdigit() else None


def webhook_url(base_url: str, public_id: uuid.UUID) -> str:
    return f"{base_url.rstrip('/')}/hooks/bot/{public_id}"


def env_token(settings: Settings) -> str | None:
    t = settings.telegram_bot_token
    return None if t is None else t.get_secret_value()


def _decrypt(box: SecretsBox | None, cipher: Any) -> str | None:
    return None if box is None or cipher is None else box.decrypt(bytes(cipher))


def _shared_token(settings: Settings, box: SecretsBox | None, bot_user_id: int, cipher: Any) -> str | None:
    """The shared bot's token: the one in the environment (where the operator writes it) when it belongs to the same bot,
    else the registered copy."""
    env = env_token(settings)
    if env is not None and bot_id_of_token(env) == bot_user_id:
        return env
    return _decrypt(box, cipher)


async def find_by_public_id(
    db: Database, settings: Settings, box: SecretsBox | None, public_id: uuid.UUID
) -> tuple[BotInfo, str] | None:
    """(the live bot behind a webhook address, the sha256 of its webhook secret); None when there is none."""
    async with db.tx(ANON) as conn:
        row = await fetch_one(conn, "SELECT * FROM tg_bot_by_public_id(%s)", (public_id,))
    if row is None:
        return None
    if row["org_id"] is None:
        token = _shared_token(settings, box, int(row["bot_user_id"]), row["secret_ciphertext"])
    else:
        token = _decrypt(box, row["secret_ciphertext"])
    if token is None:
        return None
    info = BotInfo(
        id=int(row["id"]),
        public_id=row["public_id"],
        org_id=None if row["org_id"] is None else int(row["org_id"]),
        bot_user_id=int(row["bot_user_id"]),
        username=str(row["username"]),
        token=token,
    )
    return info, str(row["token_hash"])


async def shared_bot(db: Database, settings: Settings, box: SecretsBox | None) -> BotInfo | None:
    """The registered shared bot, or None while it is not registered."""
    async with db.tx(ANON) as conn:
        row = await fetch_one(conn, "SELECT * FROM tg_shared_bot()")
    if row is None:
        return None
    token = _shared_token(settings, box, int(row["bot_user_id"]), row["secret_ciphertext"])
    if token is None:
        return None
    return BotInfo(
        id=int(row["id"]),
        public_id=row["public_id"],
        org_id=None,
        bot_user_id=int(row["bot_user_id"]),
        username=str(row["username"]),
        token=token,
    )


async def shared_token(db: Database, settings: Settings, box: SecretsBox | None) -> str | None:
    """The token that signs the shared bot's Mini App data and sends its messages: registered, else the environment's."""
    bot = await shared_bot(db, settings, box)
    return bot.token if bot is not None else env_token(settings)


async def center_bots(conn: Conn, org_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not org_ids:
        return {}
    rows = await fetch_all(conn, "SELECT * FROM tg_center_bots(%s::bigint[])", (org_ids,))
    return {int(r["org_id"]): r for r in rows}


async def link_username(conn: Conn, org_id: int, settings: Settings) -> str | None:
    """The bot new invitation links of a center point to: its own bot, else the shared one."""
    own = await center_bots(conn, [org_id])
    if org_id in own:
        return str(own[org_id]["username"])
    row = await fetch_one(conn, "SELECT username FROM tg_shared_bot()")
    return str(row["username"]) if row is not None else settings.telegram_bot_username
