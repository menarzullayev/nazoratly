"""Telegram webhook relay of the Sheets edition.

Google Apps Script web apps answer every POST with a 302 redirect, and Telegram never follows redirects, so a bot
webhook cannot point at Apps Script directly. Telegram posts here instead (authenticated by the
X-Telegram-Bot-Api-Secret-Token header); the update is forwarded to the Apps Script URL, which has already run its
`doPost` by the time it answers with the redirect (the redirect is deliberately not followed).

`/hooks/relay/{id}` serves one registered connection each (`nazoratly.relays`); `/hooks/telegram` is the single
connection configured in the environment. Only Apps Script web apps are ever called, and nothing of an update is stored
or logged.
"""

from __future__ import annotations

import hmac
import uuid
from urllib.parse import quote

import httpx
import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nazoratly import relays
from nazoratly.deps import DB, Cfg
from nazoratly.errors import body as error_body

log = structlog.get_logger("relay")
router = APIRouter(prefix="/hooks", tags=["webhook relays"])


def _error(request: Request, status: int, code: str, message: str) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    return JSONResponse(error_body(code, message, rid), status_code=status)


async def _forward(request: Request, target: str, secret: str) -> JSONResponse:
    """Check the caller's secret, then pass the update on to the Apps Script web app."""
    given = request.headers.get("x-telegram-bot-api-secret-token", "")
    if not hmac.compare_digest(given.encode(), secret.encode()):
        return _error(request, 403, "forbidden", "Invalid secret token")
    if not relays.allowed_target(target):
        log.warning("relay_target_not_allowed")
        return _error(request, 502, "bad_gateway", "The target is not an Apps Script web app")
    url = f"{target}?s={quote(secret, safe='')}"
    transport = getattr(request.app.state, "outbound_transport", None)
    try:
        async with httpx.AsyncClient(transport=transport, timeout=25, follow_redirects=False) as http:
            r = await http.post(
                url, content=await request.body(), headers={"Content-Type": "application/json"}
            )
    except httpx.HTTPError as exc:
        log.warning("relay_failed", error=type(exc).__name__)
        return _error(request, 502, "bad_gateway", "Target did not answer")
    if r.status_code >= 400:  # 2xx/3xx: Apps Script ran doPost and redirected to the (ignored) response
        log.warning("relay_target_error", status=r.status_code)
        return _error(request, 502, "bad_gateway", f"Target answered {r.status_code}")
    return JSONResponse({"ok": True})


@router.post("/telegram", summary="Telegram webhook relay (forwards updates to Apps Script)")
async def telegram_relay(request: Request, settings: Cfg) -> JSONResponse:
    secret = settings.tg_relay_secret.get_secret_value() if settings.tg_relay_secret else ""
    if not settings.tg_relay_target or not secret:
        return _error(request, 404, "not_found", "Relay is not configured")
    return await _forward(request, settings.tg_relay_target, secret)


@router.post("/relay/{relay_id}", summary="Telegram webhook relay of one registered Sheets connection")
async def sheet_relay(relay_id: str, request: Request, db: DB) -> JSONResponse:
    try:
        wanted = uuid.UUID(relay_id)
    except ValueError:
        return _error(request, 404, "not_found", "No such relay")
    found = await relays.find(db, request.app.state.secrets_box, wanted)
    if found is None:
        return _error(request, 404, "not_found", "No such relay")
    return await _forward(request, found.target, found.secret)
