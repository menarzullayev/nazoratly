"""Telegram Mini App `initData` verification (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).

The secret key is HMAC_SHA256(key="WebAppData", message=bot_token); the data-check-string is every received field except
`hash`, as `key=value`, sorted by key and joined with newlines. A signature proves the data came from Telegram for THIS bot;
`auth_date` limits how long a captured string can be replayed."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl


class BadInitData(ValueError):
    """The string is not valid, signed, fresh initData."""


@dataclass(frozen=True)
class TelegramUser:
    id: int
    first_name: str
    username: str | None


MAX_AGE_S = 24 * 3600
MAX_FUTURE_S = 300  # clock skew we tolerate


def sign_init_data(fields: dict[str, str], bot_token: str) -> str:
    """The hash Telegram would put on these fields (used by tests to build valid initData)."""
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    return hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()


def verify_init_data(init_data: str, bot_token: str, *, now: float | None = None) -> TelegramUser:
    if len(init_data) > 4096:
        raise BadInitData("too long")
    pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=False)
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise BadInitData("duplicate fields")
    given = fields.pop("hash", "")
    if not given:
        raise BadInitData("no hash")
    expected = sign_init_data(fields, bot_token)
    if not hmac.compare_digest(given.lower().encode(), expected.encode()):
        raise BadInitData("bad signature")
    try:
        auth_date = int(fields["auth_date"])
    except (KeyError, ValueError):
        raise BadInitData("no auth_date") from None
    t = time.time() if now is None else now
    if auth_date > t + MAX_FUTURE_S or t - auth_date > MAX_AGE_S:
        raise BadInitData("stale")
    try:
        user = json.loads(fields["user"])
        return TelegramUser(
            id=int(user["id"]), first_name=str(user.get("first_name", "")), username=user.get("username")
        )
    except (KeyError, ValueError, TypeError):
        raise BadInitData("no user") from None
