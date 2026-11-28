"""Which bot sends a message to a chat on behalf of a center (SQL function `tg_delivery_routes`, migration 0068): the
center's own bot when the person has opened it, else the shared bot unless the center stopped it. No route = the message
cannot be delivered, and that is reported as a failure, never silently dropped."""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from nazoratly.config import Settings
from nazoratly.db import Database, execute, fetch_all
from nazoratly.guardian_telegram import TelegramApi
from nazoratly.secrets_box import SecretsBox
from nazoratly.telegram_registry import ANON, bot_id_of_token, env_token

ROUTES_SQL = "SELECT * FROM tg_delivery_routes(%s, %s) ORDER BY route_order"
MARK_UNREACHABLE_SQL = "SELECT tg_mark_unreachable(%s, %s)"
UNDELIVERABLE = (
    "undeliverable: no bot can reach this chat (the center stopped the shared bot or the bots were blocked)"
)


# the "I have paid" button of a debt reminder. It is not tied to a role or a menu epoch: it must work whenever the
# person taps it; who may tap it is checked against the guardian links every time
PAID_PREFIX = "paid:"
PAID_CALLBACK = re.compile(r"^paid:([0-9a-f]{32})$")


def paid_callback(student_public_id: uuid.UUID) -> str:
    return f"{PAID_PREFIX}{student_public_id.hex}"


@dataclass(frozen=True)
class Route:
    bot_id: int | None  # None = the shared bot of the environment, not registered yet
    token: str = field(repr=False)
    center_bot: bool = False


def resolve_routes(
    rows: Sequence[Mapping[str, Any]], env_token: str | None, box: SecretsBox | None
) -> list[Route]:
    """Rows of tg_delivery_routes -> routes with their tokens; a row whose token is not available is left out."""
    out: list[Route] = []
    for r in rows:
        stored = None
        if r["secret_ciphertext"] is not None and box is not None:
            stored = box.decrypt(bytes(r["secret_ciphertext"]))
        if r["is_center"]:
            token = stored
        elif env_token is not None and (
            stored is None or bot_id_of_token(env_token) == bot_id_of_token(stored)
        ):
            token = env_token
        else:
            token = stored
        if token:
            out.append(Route(None if r["bot_id"] is None else int(r["bot_id"]), token, bool(r["is_center"])))
    return out


def refused_for_good(status: int | None, description: str) -> bool:
    """This bot cannot message this chat (blocked, or the person never opened it): another bot may still reach him."""
    return status == 403 or (status == 400 and "chat not found" in description.lower())


async def send_text(
    db: Database,
    settings: Settings,
    box: SecretsBox | None,
    transport: httpx.AsyncBaseTransport | None,
    *,
    org_id: int,
    chat_id: int,
    text: str,
) -> bool:
    """Send one message from the API process (the portal sign-in code) through the person's route."""
    async with db.tx(ANON) as conn:
        rows = await fetch_all(conn, ROUTES_SQL, (org_id, chat_id))
    for route in resolve_routes(rows, env_token(settings), box):
        api = TelegramApi(settings.telegram_api_base, route.token, transport)
        if await api.send_message(chat_id, text):
            return True
        if not refused_for_good(*api.last_error):
            return False
        async with db.tx(ANON) as conn:
            await execute(conn, MARK_UNREACHABLE_SQL, (route.bot_id, chat_id))
    return False
