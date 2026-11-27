"""The one webhook entry of every bot: `POST /hooks/bot/{id}` (the shared bot and the bots centers own).

Telegram authenticates itself with the bot's own `secret_token` header; only its sha256 is stored. An update id is taken
once per bot, so a retried delivery never runs a tap twice."""

from __future__ import annotations

import hmac
import uuid
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nazoratly.db import Database, execute, fetch_one
from nazoratly.deps import DB, Cfg
from nazoratly.errors import body as error_body
from nazoratly.telegram_dispatch import Dispatcher
from nazoratly.telegram_registry import ANON, find_by_public_id, secret_hash

router = APIRouter(prefix="/hooks", tags=["webhook relays"], include_in_schema=False)

# Telegram keeps an undelivered update for at most 24 hours: ids older than this can never come back.
_SEEN_TTL = "3 days"


async def _first_delivery(db: Database, bot_id: int, update_id: int) -> bool:
    async with db.tx(ANON) as conn:
        await execute(
            conn, f"DELETE FROM telegram_updates WHERE received_at < now() - interval '{_SEEN_TTL}'"
        )
        row = await fetch_one(
            conn,
            "INSERT INTO telegram_updates (bot_id, update_id) VALUES (%s, %s) ON CONFLICT DO NOTHING "
            "RETURNING 1 AS x",
            (bot_id, update_id),
        )
    return row is not None


@router.post("/bot/{public_id}")
async def bot_webhook(public_id: str, request: Request, settings: Cfg, db: DB) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    unknown = JSONResponse(error_body("not_found", "No such bot", rid), status_code=404)
    try:
        wanted = uuid.UUID(public_id)
    except ValueError:
        return unknown
    box = request.app.state.secrets_box
    found = await find_by_public_id(db, settings, box, wanted)
    if found is None:
        return unknown
    bot, expected = found
    given = request.headers.get("x-telegram-bot-api-secret-token", "")
    if not hmac.compare_digest(secret_hash(given).encode(), expected.encode()):
        return JSONResponse(error_body("forbidden", "Invalid secret token", rid), status_code=403)
    try:
        update: Any = await request.json()
    except ValueError:
        return JSONResponse(error_body("bad_request", "Not JSON", rid), status_code=400)
    update_id = update.get("update_id") if isinstance(update, dict) else None
    if not isinstance(update_id, int) or not -(2**63) <= update_id < 2**63:
        return JSONResponse(error_body("bad_request", "Not an update", rid), status_code=400)
    if await _first_delivery(db, bot.id, update_id):
        transport = getattr(request.app.state, "outbound_transport", None)
        await Dispatcher(db, settings, box, bot, transport).handle(update)
    return JSONResponse({"ok": True})
