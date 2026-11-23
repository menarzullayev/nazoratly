"""Telegram webhook relay.

Google Apps Script web apps answer every POST with a 302 redirect, and Telegram never follows redirects, so a bot
webhook cannot point at Apps Script directly. Telegram posts here instead (authenticated by the
X-Telegram-Bot-Api-Secret-Token header); the update is forwarded to the Apps Script URL, which has already run its
`doPost` by the time it answers with the redirect (the redirect is deliberately not followed).
"""

from __future__ import annotations

import hmac
from urllib.parse import quote

import httpx
import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nazoratly.deps import Cfg
from nazoratly.errors import body as error_body

log = structlog.get_logger("relay")
router = APIRouter(prefix="/hooks", tags=["webhook relays"])


@router.post("/telegram", summary="Telegram webhook relay (forwards updates to Apps Script)")
async def telegram_relay(request: Request, settings: Cfg) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    secret = settings.tg_relay_secret.get_secret_value() if settings.tg_relay_secret else ""
    if not settings.tg_relay_target or not secret:
        return JSONResponse(error_body("not_found", "Relay is not configured", rid), status_code=404)
    given = request.headers.get("x-telegram-bot-api-secret-token", "")
    if not hmac.compare_digest(given.encode(), secret.encode()):
        return JSONResponse(error_body("forbidden", "Invalid secret token", rid), status_code=403)
    url = f"{settings.tg_relay_target}{'&' if '?' in settings.tg_relay_target else '?'}s={quote(secret, safe='')}"
    transport = getattr(request.app.state, "outbound_transport", None)
    try:
        async with httpx.AsyncClient(transport=transport, timeout=25, follow_redirects=False) as http:
            r = await http.post(
                url, content=await request.body(), headers={"Content-Type": "application/json"}
            )
    except httpx.HTTPError as exc:
        log.warning("relay_failed", error=type(exc).__name__)
        return JSONResponse(error_body("bad_gateway", "Target did not answer", rid), status_code=502)
    if r.status_code >= 400:  # 2xx/3xx: Apps Script ran doPost and redirected to the (ignored) response
        log.warning("relay_target_error", status=r.status_code)
        return JSONResponse(
            error_body("bad_gateway", f"Target answered {r.status_code}", rid), status_code=502
        )
    return JSONResponse({"ok": True})
