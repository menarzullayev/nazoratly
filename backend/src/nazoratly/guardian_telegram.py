"""Telegram side of the guardian cabinet: a small Bot API client, the Mini App `initData` check and the keyboards.

All outbound traffic of the cabinet goes through `TelegramApi`; tests give the app a fake transport
(`app.state.outbound_transport`), so no real message is ever sent from a test. The bot token is never logged: errors
carry only the Bot API description."""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qsl

import httpx
import structlog

from nazoratly.config import Settings

log = structlog.get_logger("guardian_telegram")

INIT_DATA_MAX_AGE_S = 86_400


class TelegramApi:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._token = settings.telegram_bot_token.get_secret_value() if settings.telegram_bot_token else None
        self._base = settings.telegram_api_base.rstrip("/")
        self._transport = transport

    @property
    def configured(self) -> bool:
        return self._token is not None

    async def call(
        self,
        method: str,
        *,
        json_body: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> bool:
        if self._token is None:
            return False
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=15) as http:
                r = await http.post(
                    f"{self._base}/bot{self._token}/{method}", json=json_body, data=data, files=files
                )
        except httpx.HTTPError as exc:  # never str(exc): it contains the URL with the bot token
            log.warning("telegram_call_failed", method=method, error=type(exc).__name__)
            return False
        ok = r.status_code == 200
        if not ok:
            log.warning("telegram_call_rejected", method=method, status=r.status_code)
        return ok

    async def send_message(self, chat_id: int, text: str, reply_markup: dict[str, Any] | None = None) -> bool:
        body: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text[:4000],
            "link_preview_options": {"is_disabled": True},
        }
        if reply_markup is not None:
            body["reply_markup"] = reply_markup
        return await self.call("sendMessage", json_body=body)

    async def answer_callback(self, callback_id: str, text: str | None = None) -> bool:
        body: dict[str, Any] = {"callback_query_id": callback_id}
        if text:
            body["text"] = text[:190]
        return await self.call("answerCallbackQuery", json_body=body)

    async def send_document(
        self, chat_id: int, filename: str, pdf: bytes, caption: str | None = None
    ) -> bool:
        data: dict[str, Any] = {"chat_id": str(chat_id)}
        if caption:
            data["caption"] = caption[:1000]
        return await self.call(
            "sendDocument", data=data, files={"document": (filename, pdf, "application/pdf")}
        )


def verify_init_data(
    init_data: str, bot_token: str, *, now: datetime | None = None, max_age_s: int = INIT_DATA_MAX_AGE_S
) -> dict[str, Any] | None:
    """Telegram Mini App `initData`: returns the parsed `user` object when the HMAC signature is valid and `auth_date` is
    fresh, else None. https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app"""
    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    given = pairs.pop("hash", None)
    if not given:
        return None
    check = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, given):
        return None
    try:
        auth_date = int(pairs.get("auth_date", ""))
        user = json.loads(pairs.get("user", ""))
    except ValueError:
        return None
    current = (now or datetime.now(UTC)).timestamp()
    if auth_date > current + 60 or current - auth_date > max_age_s:
        return None
    if not isinstance(user, dict) or not isinstance(user.get("id"), int):
        return None
    return user


# ---- keyboards -------------------------------------------------------------------------------------------------
def inline(rows: list[list[tuple[str, str]]]) -> dict[str, Any]:
    """rows of (label, callback_data)."""
    return {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in row] for row in rows]}


def contact_keyboard() -> dict[str, Any]:
    return {
        "keyboard": [[{"text": "📱 Telefon raqamimni ulashish", "request_contact": True}]],
        "resize_keyboard": True,
        "one_time_keyboard": True,
    }
