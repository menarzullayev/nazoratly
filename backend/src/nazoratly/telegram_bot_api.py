"""Bot API calls whose answer matters (connecting a bot, setting its webhook). Errors never carry the URL: it contains
the token."""

from __future__ import annotations

from typing import Any

import httpx


class TelegramError(Exception):
    """The Bot API refused, or could not be reached. `description` is safe to show: no token, no URL."""

    def __init__(self, description: str, status: int | None = None) -> None:
        super().__init__(description)
        self.description = description
        self.status = status


async def bot_call(
    api_base: str,
    token: str,
    method: str,
    payload: dict[str, Any] | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Any:
    """The `result` of a Bot API method; TelegramError otherwise."""
    try:
        async with httpx.AsyncClient(transport=transport, timeout=15) as http:
            r = await http.post(f"{api_base.rstrip('/')}/bot{token}/{method}", json=payload or {})
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        raise TelegramError(f"Telegram did not answer ({type(exc).__name__})") from None
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code == 200 and isinstance(data, dict) and data.get("ok") is True:
        return data.get("result")
    note = str(data.get("description", "") if isinstance(data, dict) else "")[:200]
    raise TelegramError(note.replace(token, "[token]") or f"Telegram answered {r.status_code}", r.status_code)
