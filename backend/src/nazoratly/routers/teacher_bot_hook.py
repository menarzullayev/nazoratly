"""Webhook of the teacher bot. Telegram posts updates here (authenticated by the secret_token header); the update is handled
in-process by `nazoratly.teacher_bot`. Answers 404 until the bot token and the webhook secret are configured."""

from __future__ import annotations

import hmac
from collections import OrderedDict
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nazoratly.deps import DB, Cfg
from nazoratly.errors import body as error_body
from nazoratly.teacher_bot import handle_update

router = APIRouter(prefix="/hooks", tags=["webhook relays"], include_in_schema=False)

_SEEN: OrderedDict[int, None] = (
    OrderedDict()
)  # recent update ids: Telegram retries a slow answer, a tap must not run twice
_SEEN_MAX = 2000


@router.post("/teacher-bot")
async def teacher_bot_hook(request: Request, settings: Cfg, db: DB) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    secret = settings.tg_teacher_secret.get_secret_value() if settings.tg_teacher_secret else ""
    if not secret or settings.telegram_bot_token is None:
        return JSONResponse(error_body("not_found", "Teacher bot is not configured", rid), status_code=404)
    given = request.headers.get("x-telegram-bot-api-secret-token", "")
    if not hmac.compare_digest(given.encode(), secret.encode()):
        return JSONResponse(error_body("forbidden", "Invalid secret token", rid), status_code=403)
    try:
        update: dict[str, Any] = await request.json()
    except ValueError:
        return JSONResponse(error_body("bad_request", "Not JSON", rid), status_code=400)
    uid = update.get("update_id")
    if isinstance(uid, int):
        if uid in _SEEN:
            return JSONResponse({"ok": True})
        _SEEN[uid] = None
        while len(_SEEN) > _SEEN_MAX:
            _SEEN.popitem(last=False)
    await handle_update(db, settings, getattr(request.app.state, "outbound_transport", None), update)
    return JSONResponse({"ok": True})
