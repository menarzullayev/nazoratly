"""The center's own Telegram bot (owner only): connect by token, see who moved from the shared bot, stop the shared bot,
disconnect. The token goes in and never comes out. (The settings screen belongs to the web panel; this is its API.)"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import SecretStr

from nazoratly.db import Conn, execute, fetch_all, fetch_one
from nazoratly.deps import DB, Cfg, Principal, require
from nazoratly.errors import Conflict, NotFound
from nazoratly.schemas import Message, Model, Out
from nazoratly.telegram_connect import connect_bot, disconnect_bot

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
