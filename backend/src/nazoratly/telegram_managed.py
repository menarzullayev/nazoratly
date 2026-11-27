"""Telegram Managed Bots: the shared bot is the manager of bots that centers create with one tap.

A created bot is connected to a center only when that center's owner asked first and confirmed from the same Telegram
account that creates it (migration 0070). Its token is fetched with `getManagedBotToken` by the shared bot and then goes
the same way as a pasted token (`nazoratly.telegram_connect`). A later `managed_bot` update (the token was replaced)
refreshes it; if the bot's owner is no longer the account that created it, the center is disconnected."""

from __future__ import annotations

import secrets
from typing import Any
from urllib.parse import quote

import httpx
import structlog

from nazoratly.config import Settings
from nazoratly.db import Database, Session, execute, fetch_one
from nazoratly.errors import ApiError
from nazoratly.rules import guardian as G
from nazoratly.secrets_box import SecretsBox
from nazoratly.security import sha256
from nazoratly.telegram_bot_api import TelegramError, bot_call
from nazoratly.telegram_connect import connect_bot, disconnect_bot
from nazoratly.telegram_registry import ANON, BotInfo

log = structlog.get_logger("telegram_managed")

PREFIX = "NZC-"
LENGTH = 20
TTL_MINUTES = 30
BUTTON_TEXT = "🤖 Markaz botini yaratish"
BAD_CONFIRM = "Tasdiqlash kodi noto'g'ri, ishlatilgan yoki muddati tugagan. Panelda yangi so'rov yarating."


def new_code() -> str:
    return PREFIX + "".join(secrets.choice(G.CODE_ALPHABET) for _ in range(LENGTH))


def looks_like_code(text: str) -> bool:
    return text.strip().upper().startswith(PREFIX)


def code_hash(code: str) -> str:
    return sha256(code.strip().upper()).hex()


def default_username() -> str:
    return f"nazoratly_{secrets.token_hex(4)}_bot"


def creation_link(manager: str, suggested_username: str, name: str) -> str:
    """https://core.telegram.org/bots/features#managed-bots"""
    return f"https://t.me/newbot/{manager}/{suggested_username}?name={quote(name[:64])}"


def creation_keyboard(suggested_username: str, name: str) -> dict[str, Any]:
    button = {
        "text": BUTTON_TEXT,
        "request_managed_bot": {
            "request_id": 1,
            "suggested_name": name[:64],
            "suggested_username": suggested_username,
        },
    }
    return {"keyboard": [[button]], "resize_keyboard": True, "one_time_keyboard": True}


async def on_managed_bot(
    db: Database,
    settings: Settings,
    box: SecretsBox | None,
    transport: httpx.AsyncBaseTransport | None,
    manager: BotInfo,
    update: dict[str, Any],
) -> tuple[int, str] | None:
    """A `managed_bot` update of the shared bot. Returns (chat to tell, text), or None when there is nobody to tell."""
    user, bot = update.get("user") or {}, update.get("bot") or {}
    creator, bot_user_id = user.get("id"), bot.get("id")
    if not isinstance(creator, int) or not isinstance(bot_user_id, int):
        return None
    async with db.tx(ANON) as conn:
        known = await fetch_one(conn, "SELECT * FROM tg_managed_bot(%s)", (bot_user_id,))

    if known is not None:
        org_id = int(known["out_org_id"])
        session = Session(user_id=None, org_id=org_id, actor_type="system")
        if known["creator_telegram_user_id"] != creator:
            # the bot changed hands: whoever holds it now must not speak for the center
            await disconnect_bot(db, settings, box, transport, session=session, org_id=org_id)
            log.warning("managed_bot_owner_changed", org_id=org_id)
            return None
        try:
            await _connect(db, settings, box, transport, manager, bot_user_id, session, org_id, None, creator)
        except (ApiError, TelegramError) as exc:
            log.warning("managed_bot_refresh_failed", org_id=org_id, error=type(exc).__name__)
        return None

    async with db.tx(ANON) as conn:
        request = await fetch_one(conn, "SELECT * FROM tg_managed_claim(%s)", (creator,))
    if request is None:
        log.warning("managed_bot_without_request")
        return (
            creator,
            "Bu bot hech bir markazga ulanmadi: avval markaz egasi panelda ulash so'rovini yaratadi.",
        )
    org_id = int(request["out_org_id"])
    session = Session(user_id=int(request["out_user_id"]), org_id=org_id, actor_type="system")
    try:
        await _connect(
            db,
            settings,
            box,
            transport,
            manager,
            bot_user_id,
            session,
            org_id,
            int(request["out_user_id"]),
            creator,
        )
    except (ApiError, TelegramError) as exc:
        reason = exc.message if isinstance(exc, ApiError) else exc.description
        async with db.tx(session) as conn:
            await execute(
                conn,
                "UPDATE telegram_managed_requests SET completed_at = NULL, failure = %s WHERE id = %s",
                (reason[:300], request["out_id"]),
            )
        return creator, f"Botni ulab bo'lmadi: {reason}"
    return creator, f"✅ @{bot.get('username')} markazga ulandi. Uni ochib «Start»ni bosing."


async def _connect(
    db: Database,
    settings: Settings,
    box: SecretsBox | None,
    transport: httpx.AsyncBaseTransport | None,
    manager: BotInfo,
    bot_user_id: int,
    session: Session,
    org_id: int,
    user_id: int | None,
    creator: int,
) -> None:
    token = await bot_call(
        settings.telegram_api_base,
        manager.token,
        "getManagedBotToken",
        {"user_id": bot_user_id},
        transport=transport,
    )
    if not isinstance(token, str) or token.split(":", 1)[0] != str(bot_user_id):
        raise TelegramError("Telegram did not return the bot's token")
    await connect_bot(
        db,
        settings,
        box,
        transport,
        session=session,
        org_id=org_id,
        user_id=user_id,
        token=token,
        method="managed",
        creator_telegram_user_id=creator,
    )
