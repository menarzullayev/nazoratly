"""The center's own Telegram bot (owner only): connect by token, see who moved from the shared bot, stop the shared bot,
disconnect. The token goes in and never comes out. (The settings screen belongs to the web panel; this is its API.)"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import SecretStr, StringConstraints

from nazoratly.db import Conn, execute, fetch_all, fetch_one
from nazoratly.deps import DB, Cfg, Principal, require
from nazoratly.errors import Conflict, NotFound
from nazoratly.schemas import Message, Model, Out
from nazoratly.telegram_connect import (
    AnotherBotConnected,
    NotConfigured,
    connect_bot,
    disconnect_bot,
    require_ready,
)
from nazoratly.telegram_managed import TTL_MINUTES, code_hash, default_username, new_code
from nazoratly.telegram_registry import shared_bot

router = APIRouter(prefix="/v1/telegram", tags=["telegram bots"])


async def owner(p: Annotated[Principal, Depends(require("org:manage"))]) -> Principal:
    p.require_center_wide()
    return p


Owner = Annotated[Principal, Depends(owner)]


class MiniAppUrls(Out):
    guardian: str
    teacher: str


class BotOut(Out):
    connected: bool
    username: str | None = None
    method: Literal["token", "managed"] | None = None
    connected_at: datetime | None = None
    shared_bot_stopped: bool = False
    miniapp_urls: MiniAppUrls | None = None
    people_total: int = 0
    people_moved: int = 0


class ConnectIn(Model):
    token: SecretStr


class SharedBotIn(Model):
    stopped: bool


class PersonOut(Out):
    role: Literal["teacher", "guardian"]
    id: uuid.UUID
    full_name: str
    moved: bool
    moved_via: Literal["code", "direct"] | None


class MigrationOut(Out):
    bot_username: str
    shared_bot_stopped: bool
    total: int
    moved: int
    people: list[PersonOut]


# Everyone of the center the bots can talk to: teachers with a linked account, guardians with a linked chat. "Moved" =
# has an open conversation with the center's bot.
_PEOPLE_SQL = """
SELECT x.role, x.id, x.full_name, (c.telegram_user_id IS NOT NULL) AS moved, c.opened_via AS moved_via
FROM (
  SELECT 'teacher' AS role, t.public_id AS id, t.full_name, u.telegram_user_id AS tg
  FROM teachers t JOIN users u ON u.id = t.user_id
  JOIN memberships m ON m.org_id = t.org_id AND m.user_id = u.id AND m.status = 'active' AND m.role = 'teacher'
  WHERE t.deleted_at IS NULL AND u.telegram_user_id IS NOT NULL
  UNION ALL
  SELECT 'guardian', g.public_id, g.full_name, g.telegram_chat_id
  FROM guardians g
  WHERE g.deleted_at IS NULL AND g.telegram_chat_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM student_guardians sg WHERE sg.org_id = g.org_id AND sg.guardian_id = g.id)
) x
LEFT JOIN telegram_chats c ON c.bot_id = %s AND c.telegram_user_id = x.tg AND c.unreachable_at IS NULL
ORDER BY moved, x.role DESC, lower(x.full_name), x.id
"""

_LIVE_SQL = (
    "SELECT id, public_id, username, method, updated_at, created_at, shared_stopped_at "
    "FROM telegram_bots WHERE status = 'active'"
)


async def _status(conn: Conn, base: str | None) -> BotOut:
    bot = await fetch_one(conn, _LIVE_SQL)
    if bot is None:
        return BotOut(connected=False)
    people = await fetch_all(conn, _PEOPLE_SQL, (bot["id"],))
    urls = None
    if base:
        root = base.rstrip("/")
        urls = MiniAppUrls(
            guardian=f"{root}/ui/guardian?bot={bot['public_id']}",
            teacher=f"{root}/ui/teacher?bot={bot['public_id']}",
        )
    return BotOut(
        connected=True,
        username=bot["username"],
        method=bot["method"],
        connected_at=bot["created_at"],
        shared_bot_stopped=bot["shared_stopped_at"] is not None,
        miniapp_urls=urls,
        people_total=len(people),
        people_moved=sum(1 for r in people if r["moved"]),
    )


@router.get("/bot", response_model=BotOut, summary="The center's own bot (never its token)")
async def get_bot(p: Owner, db: DB, cfg: Cfg) -> BotOut:
    async with db.tx(p.session()) as conn:
        return await _status(conn, cfg.public_base_url)


@router.put(
    "/bot",
    response_model=BotOut,
    summary="Connect the center's own bot with its BotFather token (sets the bot's webhook; the token is stored encrypted)",
)
async def put_bot(body: ConnectIn, request: Request, p: Owner, db: DB, cfg: Cfg) -> BotOut:
    await connect_bot(
        db,
        cfg,
        request.app.state.secrets_box,
        getattr(request.app.state, "outbound_transport", None),
        session=p.session(),
        org_id=p.org_id,
        user_id=p.user_id,
        token=body.token.get_secret_value().strip(),
        method="token",
    )
    async with db.tx(p.session()) as conn:
        return await _status(conn, cfg.public_base_url)


@router.delete("/bot", response_model=Message, summary="Disconnect the center's bot and forget its token")
async def delete_bot(request: Request, p: Owner, db: DB, cfg: Cfg) -> Message:
    done = await disconnect_bot(
        db,
        cfg,
        request.app.state.secrets_box,
        getattr(request.app.state, "outbound_transport", None),
        session=p.session(),
        org_id=p.org_id,
    )
    if not done:
        raise NotFound("The center has no bot of its own")
    return Message(message="disconnected; the shared bot serves the center again")


@router.get("/bot/migration", response_model=MigrationOut, summary="Who has moved to the center's own bot")
async def migration(p: Owner, db: DB) -> MigrationOut:
    async with db.tx(p.session()) as conn:
        bot = await fetch_one(conn, _LIVE_SQL)
        if bot is None:
            raise NotFound("The center has no bot of its own")
        people = [PersonOut(**r) for r in await fetch_all(conn, _PEOPLE_SQL, (bot["id"],))]
    return MigrationOut(
        bot_username=bot["username"],
        shared_bot_stopped=bot["shared_stopped_at"] is not None,
        total=len(people),
        moved=sum(1 for x in people if x.moved),
        people=people,
    )


@router.put(
    "/bot/shared",
    response_model=BotOut,
    summary="Stop (or resume) the shared bot for this center: people who have not moved can then not be reached",
)
async def shared_switch(body: SharedBotIn, p: Owner, db: DB, cfg: Cfg) -> BotOut:
    async with db.tx(p.session()) as conn:
        changed = await execute(
            conn,
            "UPDATE telegram_bots SET shared_stopped_at = CASE WHEN %s THEN COALESCE(shared_stopped_at, now()) END "
            "WHERE status = 'active'",
            (body.stopped,),
        )
        if not changed:
            raise Conflict("Connect the center's own bot first")
        return await _status(conn, cfg.public_base_url)


# ---- Managed Bots -----------------------------------------------------------------------------------------------------
class ManagedIn(Model):
    suggested_username: (
        Annotated[str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$")] | None
    ) = None


class ManagedCreated(Out):
    id: uuid.UUID
    confirm_link: str
    expires_at: datetime


class ManagedStatus(Out):
    id: uuid.UUID
    status: Literal["waiting_confirmation", "waiting_creation", "connected", "expired", "cancelled", "failed"]
    suggested_username: str
    expires_at: datetime
    failure: str | None


@router.post(
    "/bot/managed",
    response_model=ManagedCreated,
    status_code=201,
    summary="Connect a new bot through Telegram Managed Bots: returns the link the owner opens in the shared bot",
)
async def managed_start(body: ManagedIn, request: Request, p: Owner, db: DB, cfg: Cfg) -> ManagedCreated:
    require_ready(cfg, request.app.state.secrets_box)
    manager = await shared_bot(db, cfg, request.app.state.secrets_box)
    if manager is None:
        raise NotConfigured("The shared bot, which manages the new bots, is not set up on this server yet")
    code = new_code()
    async with db.tx(p.session()) as conn:
        if await fetch_one(conn, "SELECT 1 AS x FROM telegram_bots WHERE status = 'active'") is not None:
            raise AnotherBotConnected("The center already has a bot: disconnect it first")
        await execute(
            conn,
            "UPDATE telegram_managed_requests SET cancelled_at = now() WHERE completed_at IS NULL AND cancelled_at IS NULL",
        )
        row = await fetch_one(
            conn,
            "INSERT INTO telegram_managed_requests (org_id, created_by_user_id, token_hash, suggested_username, expires_at) "
            "VALUES (%s, %s, %s, %s, now() + make_interval(mins => %s)) RETURNING public_id, expires_at",
            (
                p.org_id,
                p.user_id,
                code_hash(code),
                body.suggested_username or default_username(),
                TTL_MINUTES,
            ),
        )
    assert row is not None
    return ManagedCreated(
        id=row["public_id"],
        confirm_link=f"https://t.me/{manager.username}?start={code}",
        expires_at=row["expires_at"],
    )


@router.get(
    "/bot/managed", response_model=ManagedStatus, summary="How the latest Managed Bots request stands"
)
async def managed_status(p: Owner, db: DB) -> ManagedStatus:
    async with db.tx(p.session()) as conn:
        row = await fetch_one(
            conn,
            "SELECT public_id AS id, suggested_username, expires_at, failure, CASE "
            "WHEN completed_at IS NOT NULL THEN 'connected' WHEN cancelled_at IS NOT NULL THEN 'cancelled' "
            "WHEN failure IS NOT NULL THEN 'failed' WHEN expires_at <= now() THEN 'expired' "
            "WHEN confirmed_at IS NULL THEN 'waiting_confirmation' ELSE 'waiting_creation' END AS status "
            "FROM telegram_managed_requests q ORDER BY q.id DESC LIMIT 1",
        )
    if row is None:
        raise NotFound("No Managed Bots request yet")
    return ManagedStatus(**row)
