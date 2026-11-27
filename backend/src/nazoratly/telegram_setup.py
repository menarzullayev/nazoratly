"""Operator command: register the shared bot and point its webhook at this server.

    docker compose exec api python -m nazoratly.telegram_setup shared

Needs NAZORATLY_TELEGRAM_BOT_TOKEN, NAZORATLY_SECRETS_KEY and NAZORATLY_PUBLIC_BASE_URL (https). Safe to repeat: it
issues a new webhook secret each time. The token is never printed."""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid
from dataclasses import dataclass

import httpx

from nazoratly.config import Settings, get_settings
from nazoratly.db import Database, fetch_one
from nazoratly.secrets_box import SecretsBox
from nazoratly.telegram_bot_api import TelegramError, bot_call
from nazoratly.telegram_registry import ANON, env_token, new_webhook_secret, secret_hash, webhook_url

SHARED_UPDATES = ["message", "callback_query", "managed_bot"]
CENTER_UPDATES = ["message", "callback_query"]
COMMANDS = [
    {"command": "start", "description": "Boshlash / ulanish"},
    {"command": "rol", "description": "Rol va markazni tanlash"},
    {"command": "yordam", "description": "Yordam"},
]


class SetupError(Exception):
    pass


@dataclass(frozen=True)
class Registered:
    public_id: uuid.UUID
    username: str
    webhook: str


async def setup_shared(
    db: Database,
    settings: Settings,
    box: SecretsBox | None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Registered:
    token = env_token(settings)
    if token is None:
        raise SetupError("NAZORATLY_TELEGRAM_BOT_TOKEN is not set")
    if box is None:
        raise SetupError("NAZORATLY_SECRETS_KEY is not set")
    base = settings.public_base_url
    if not base or not base.startswith("https://"):
        raise SetupError("NAZORATLY_PUBLIC_BASE_URL must be the public https address of this server")
    me = await bot_call(settings.telegram_api_base, token, "getMe", transport=transport)
    secret = new_webhook_secret()
    async with db.tx(ANON) as conn:
        row = await fetch_one(
            conn,
            "SELECT * FROM tg_shared_register(%s, %s, %s, %s)",
            (int(me["id"]), str(me["username"]), box.encrypt(token), secret_hash(secret)),
        )
    assert row is not None
    url = webhook_url(base, row["out_public_id"])
    await bot_call(
        settings.telegram_api_base,
        token,
        "setWebhook",
        {"url": url, "secret_token": secret, "allowed_updates": SHARED_UPDATES},
        transport=transport,
    )
    await bot_call(
        settings.telegram_api_base, token, "setMyCommands", {"commands": COMMANDS}, transport=transport
    )
    return Registered(row["out_public_id"], str(me["username"]), url)


async def _run() -> int:
    settings = get_settings()
    db = Database(settings)
    await db.open()
    try:
        box = SecretsBox(settings.secrets_key.get_secret_value()) if settings.secrets_key else None
        done = await setup_shared(db, settings, box)
    except (SetupError, TelegramError) as exc:
        print(f"failed: {exc}", file=sys.stderr)
        return 1
    finally:
        await db.close()
    print(f"shared bot @{done.username} registered; webhook: {done.webhook}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nazoratly.telegram_setup")
    parser.add_argument("what", choices=["shared"])
    parser.parse_args(argv)
    if sys.platform == "win32":  # psycopg async needs a selector loop
        return asyncio.run(_run(), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(_run())


if __name__ == "__main__":
    sys.exit(main())
