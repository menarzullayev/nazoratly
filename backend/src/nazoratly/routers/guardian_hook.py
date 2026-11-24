"""Telegram webhook of the guardian bot. Telegram posts updates here (authenticated by the secret token header); the
bot answers through the Bot API. Unset secret/token = the endpoint does not exist (404)."""

from __future__ import annotations

import hmac
from typing import Any

import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nazoratly.deps import DB, Cfg
from nazoratly.errors import body as error_body
from nazoratly.guardian_bot import GuardianBot
from nazoratly.guardian_telegram import TelegramApi

log = structlog.get_logger("guardian_hook")
router = APIRouter(prefix="/hooks", tags=["webhook relays"], include_in_schema=False)


@router.post("/guardian-bot")
async def guardian_bot_webhook(request: Request, settings: Cfg, db: DB) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    secret = settings.guardian_bot_secret.get_secret_value() if settings.guardian_bot_secret else ""
    if not secret or settings.telegram_bot_token is None:
        return JSONResponse(
            error_body("not_found", "The guardian bot is not configured", rid), status_code=404
        )
    given = request.headers.get("x-telegram-bot-api-secret-token", "")
    if not hmac.compare_digest(given.encode(), secret.encode()):
        return JSONResponse(error_body("forbidden", "Invalid secret token", rid), status_code=403)
    try:
        update: Any = await request.json()
    except ValueError:
        return JSONResponse(error_body("bad_request", "Not JSON", rid), status_code=400)
    if not isinstance(update, dict):
        return JSONResponse(error_body("bad_request", "Not an update", rid), status_code=400)
    api = TelegramApi(settings, getattr(request.app.state, "outbound_transport", None))
    await GuardianBot(db, settings, api).handle(update)
    return JSONResponse({"ok": True})
