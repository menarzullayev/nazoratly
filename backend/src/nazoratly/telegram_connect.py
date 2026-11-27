"""Connecting and disconnecting a center's own bot (a pasted token, or a bot made through Managed Bots).

The token is checked with Telegram, stored only encrypted and never returned or logged. The bot's webhook points at
`/hooks/bot/{id}` with a fresh secret of which only the sha256 is stored. A bot can be connected to one center only, and
the connection is reserved in the database before Telegram is told, so a center can never take over the webhook of a bot
another center uses."""

from __future__ import annotations

import re
import uuid
from typing import Any

import httpx
import structlog
from psycopg.errors import UniqueViolation

from nazoratly.config import Settings
from nazoratly.db import Database, Session, execute, fetch_one
from nazoratly.errors import Conflict, Unprocessable
from nazoratly.secrets_box import SecretsBox
from nazoratly.telegram_bot_api import TelegramError, bot_call
from nazoratly.telegram_registry import (
    ANON,
    bot_id_of_token,
    env_token,
    new_webhook_secret,
    secret_hash,
    webhook_url,
)
from nazoratly.telegram_setup import CENTER_UPDATES, COMMANDS

log = structlog.get_logger("telegram_connect")

TOKEN_SHAPE = re.compile(r"^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$")


class NotConfigured(Conflict):
    code = "telegram_not_configured"


class BotInUse(Conflict):
    code = "bot_in_use"


class AnotherBotConnected(Conflict):
    code = "another_bot_connected"


class TelegramRefused(Unprocessable):
    code = "telegram_refused"


def require_ready(settings: Settings, box: SecretsBox | None) -> tuple[str, SecretsBox]:
    """(public https base URL, secrets box), or the reason bots cannot be connected on this server."""
    base = settings.public_base_url
    if box is None or not base or not base.startswith("https://"):
        raise NotConfigured(
            "The server cannot connect bots yet: the operator must set the secrets key and the public https address"
        )
    return base, box


async def connect_bot(
    db: Database,
    settings: Settings,
    box: SecretsBox | None,
    transport: httpx.AsyncBaseTransport | None,
    *,
    session: Session,
    org_id: int,
    user_id: int | None,
    token: str,
    method: str,
    creator_telegram_user_id: int | None = None,
) -> uuid.UUID:
    """Connect (or refresh the token of) the center's bot; returns the bot's public id."""
    base, secrets_box = require_ready(settings, box)
    if not TOKEN_SHAPE.match(token):
        raise Unprocessable("This is not a bot token (it looks like 123456789:AA...)")
    bot_user_id = bot_id_of_token(token)
    assert bot_user_id is not None
    shared_env = env_token(settings)
    if shared_env is not None and bot_id_of_token(shared_env) == bot_user_id:
        raise BotInUse("This is the shared nazoratly bot: a center needs a bot of its own")

    api = settings.telegram_api_base
    try:
        me = await bot_call(api, token, "getMe", transport=transport)
    except TelegramError as exc:
        raise TelegramRefused(f"Telegram did not accept this token: {exc.description}") from None
    if not isinstance(me, dict) or me.get("id") != bot_user_id or not me.get("username"):
        raise TelegramRefused("Telegram did not confirm this bot")
    username = str(me["username"])

    async with db.tx(ANON) as conn:
        await execute(conn, "SELECT tg_forget_stale_pending(%s)", (bot_user_id,))
        claim = await fetch_one(conn, "SELECT * FROM tg_bot_claim(%s)", (bot_user_id,))
    if claim is not None and claim["org_id"] != org_id:
        raise BotInUse("This bot is already connected to another center or is the shared bot")

    secret = new_webhook_secret()
    cipher, hashed = secrets_box.encrypt(token), secret_hash(secret)
    try:
        async with db.tx(session) as conn:
            live = await fetch_one(
                conn,
                "SELECT id, public_id, bot_user_id, status, secret_ciphertext, token_hash, method, "
                "creator_telegram_user_id, username FROM telegram_bots WHERE status <> 'disabled' FOR UPDATE",
            )
            if live is not None and (live["bot_user_id"] != bot_user_id or live["status"] != "active"):
                raise AnotherBotConnected("The center already has a bot: disconnect it first")
            if live is None:
                row = await fetch_one(
                    conn,
                    "INSERT INTO telegram_bots (org_id, bot_user_id, username, secret_ciphertext, token_hash, method, "
                    "status, creator_telegram_user_id, created_by_user_id) "
                    "VALUES (%s, %s, %s, %s, %s, %s, 'pending', %s, %s) RETURNING id, public_id",
                    (
                        org_id,
                        bot_user_id,
                        username,
                        cipher,
                        hashed,
                        method,
                        creator_telegram_user_id,
                        user_id,
                    ),
                )
            else:  # the same bot again: new token (it may have been replaced) and a new webhook secret
                row = await fetch_one(
                    conn,
                    "UPDATE telegram_bots SET username = %s, secret_ciphertext = %s, token_hash = %s, method = %s, "
                    "creator_telegram_user_id = %s WHERE id = %s RETURNING id, public_id",
                    (username, cipher, hashed, method, creator_telegram_user_id, live["id"]),
                )
    except UniqueViolation:
        raise BotInUse("This bot, or another bot of the center, is being connected right now") from None
    assert row is not None
    public_id: uuid.UUID = row["public_id"]

    try:
        await bot_call(
            api,
            token,
            "setWebhook",
            {"url": webhook_url(base, public_id), "secret_token": secret, "allowed_updates": CENTER_UPDATES},
            transport=transport,
        )
    except TelegramError as exc:
        await _undo(db, session, int(row["id"]), live)
        raise TelegramRefused(f"Telegram did not accept the webhook: {exc.description}") from None
    async with db.tx(session) as conn:
        await execute(conn, "UPDATE telegram_bots SET status = 'active' WHERE id = %s", (row["id"],))
    try:
        await bot_call(api, token, "setMyCommands", {"commands": COMMANDS}, transport=transport)
    except TelegramError as exc:  # cosmetic: the bot works without the command list
        log.warning("set_commands_failed", status=exc.status)
    return public_id


async def _undo(db: Database, session: Session, row_id: int, previous: dict[str, Any] | None) -> None:
    async with db.tx(session) as conn:
        if previous is None:
            await execute(conn, "DELETE FROM telegram_bots WHERE id = %s AND status = 'pending'", (row_id,))
            return
        await execute(
            conn,
            "UPDATE telegram_bots SET username = %s, secret_ciphertext = %s, token_hash = %s, method = %s, "
            "creator_telegram_user_id = %s WHERE id = %s",
            (
                previous["username"],
                previous["secret_ciphertext"],
                previous["token_hash"],
                previous["method"],
                previous["creator_telegram_user_id"],
                row_id,
            ),
        )


async def disconnect_bot(
    db: Database,
    settings: Settings,
    box: SecretsBox | None,
    transport: httpx.AsyncBaseTransport | None,
    *,
    session: Session,
    org_id: int,
) -> bool:
    """Disable the center's bot, forget its token, end the sign-ins made through it. False = there was none.

    The webhook is removed at Telegram on a best-effort basis: the address answers 404 from now on either way."""
    async with db.tx(session) as conn:
        live = await fetch_one(
            conn,
            "SELECT id, secret_ciphertext FROM telegram_bots WHERE status <> 'disabled' FOR UPDATE",
        )
        if live is None:
            return False
        await execute(
            conn,
            "UPDATE telegram_bots SET status = 'disabled', secret_ciphertext = NULL, token_hash = NULL, "
            "shared_stopped_at = NULL, disabled_at = now() WHERE id = %s",
            (live["id"],),
        )
    async with db.auth_tx() as conn:
        await execute(
            conn,
            "UPDATE refresh_tokens SET revoked_at = now() WHERE org_lock = %s AND revoked_at IS NULL",
            (org_id,),
        )
    token = box.decrypt(bytes(live["secret_ciphertext"])) if box is not None else None
    if token is not None:
        try:
            await bot_call(settings.telegram_api_base, token, "deleteWebhook", transport=transport)
        except TelegramError as exc:
            log.warning("delete_webhook_failed", status=exc.status)
    return True
