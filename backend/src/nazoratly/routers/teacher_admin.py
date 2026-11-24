"""Teacher app, owner side: invite a teacher, switch the "write to guardians" right, the app settings, the log of what
teachers wrote, unmarked lessons and the reminder run."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, StringConstraints

from nazoratly.db import Session, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Cfg, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.academics import my_teacher_id
from nazoratly.rules import teacher as R
from nazoratly.schemas import Message, Model, Out, Page, make_page
from nazoratly.teacher_app import (
    invite_hash,
    load_app_settings,
    new_invite_code,
    org_now,
    sweep_center,
    unmarked_now,
)

router = APIRouter(prefix="/v1", tags=["teacher app (owner)"], route_class=IdempotentRoute)

_STATE_SQL = "CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' WHEN i.status = 'pending' THEN 'valid' ELSE i.status END"
_INV_SQL = (
    f"SELECT i.public_id AS id, t.public_id AS teacher_id, t.full_name AS teacher_name, {_STATE_SQL} AS status, "
    "i.expires_at, i.created_at, i.used_at, i.used_via FROM teacher_invitations i "
    "JOIN teachers t ON t.org_id = i.org_id AND t.id = i.teacher_id"
)


class InvitationOut(Out):
    id: uuid.UUID
    teacher_id: uuid.UUID
    teacher_name: str
    status: Literal["valid", "used", "revoked", "expired"]
    expires_at: datetime
    created_at: datetime
    used_at: datetime | None
    used_via: Literal["bot", "api"] | None


class InvitationCreated(InvitationOut):
    code: str = Field(
        description="shown ONCE; only its hash is stored. The teacher sends it to the bot or the API."
    )
    link: str | None = Field(description="t.me deep link when the bot username is configured")


@router.post(
    "/teachers/{teacher_id}/invitations",
    response_model=InvitationCreated,
    status_code=201,
    summary="Invite a teacher (one-time code, 7 days); an older open invitation of this teacher is revoked",
)
async def invite_teacher(
    teacher_id: uuid.UUID, p: Annotated[Principal, Depends(require("staff:manage"))], db: DB, cfg: Cfg
) -> InvitationCreated:
    code = new_invite_code()
    async with db.tx(p.session()) as conn:
        tid = await resolve(conn, "teachers", teacher_id, what="teacher")
        t = await fetch_one(conn, "SELECT user_id, status FROM teachers WHERE id = %s", (tid,))
        assert t is not None
        if t["user_id"] is not None:
            raise Conflict(
                "This teacher already has an account", details={"reason": "teacher_already_linked"}
            )
        if t["status"] != "active":
            raise Conflict("An inactive teacher cannot be invited")
        await execute(
            conn,
            "UPDATE teacher_invitations SET status = 'revoked' WHERE teacher_id = %s AND status = 'pending'",
            (tid,),
        )
        row = await fetch_one(
            conn,
            "INSERT INTO teacher_invitations (org_id, teacher_id, token_hash, expires_at, created_by_user_id) "
            "VALUES (%s, %s, %s, now() + make_interval(days => %s), %s) RETURNING public_id",
            (p.org_id, tid, invite_hash(code), R.INVITE_TTL_DAYS, p.user_id),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_INV_SQL} WHERE i.public_id = %s", (row["public_id"],))
    assert out is not None
    username = cfg.telegram_bot_username
    return InvitationCreated(
        **out, code=code, link=f"https://t.me/{username}?start={code}" if username else None
    )


@router.get("/teacher-invitations", response_model=Page[InvitationOut], summary="Invitations, newest first")
async def list_invitations(
    p: Annotated[Principal, Depends(require("staff:read"))],
    db: DB,
    pg: Paging,
    teacher_id: uuid.UUID | None = None,
) -> Page[InvitationOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_INV_SQL} WHERE (%s::uuid IS NULL OR t.public_id = %s) ORDER BY i.created_at DESC, i.id DESC LIMIT %s OFFSET %s",
            (teacher_id, teacher_id, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, InvitationOut)


@router.delete(
    "/teacher-invitations/{invitation_id}", response_model=Message, summary="Revoke an open invitation"
)
async def revoke_invitation(
    invitation_id: uuid.UUID, p: Annotated[Principal, Depends(require("staff:manage"))], db: DB
) -> Message:
    async with db.tx(p.session()) as conn:
        row = await fetch_one(
            conn,
            "SELECT id, status FROM teacher_invitations WHERE public_id = %s FOR UPDATE",
            (invitation_id,),
        )
        if row is None:
            raise NotFound("invitation not found")
        if row["status"] != "pending":
            raise Conflict(f"The invitation is already {row['status']}")
        await execute(conn, "UPDATE teacher_invitations SET status = 'revoked' WHERE id = %s", (row["id"],))
    return Message(message="revoked")


# ---- the right to write to guardians ----------------------------------------------------------------------------------
class MessagingIn(Model):
    enabled: bool


class MessagingOut(Out):
    teacher_id: uuid.UUID
    enabled: bool


@router.patch(
    "/teachers/{teacher_id}/messaging",
    response_model=MessagingOut,
    summary="Switch a teacher's right to write to guardians on or off",
)
async def set_messaging(
    teacher_id: uuid.UUID,
    body: MessagingIn,
    p: Annotated[Principal, Depends(require("staff:manage"))],
    db: DB,
) -> MessagingOut:
    async with db.tx(p.session()) as conn:
        tid = await resolve(conn, "teachers", teacher_id, what="teacher")
        await execute(
            conn, "UPDATE teachers SET guardian_messaging_enabled = %s WHERE id = %s", (body.enabled, tid)
        )
    return MessagingOut(teacher_id=teacher_id, enabled=body.enabled)


# ---- settings -----------------------------------------------------------------------------------------------------
HHMM = Annotated[str, StringConstraints(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")]


class AppSettingsOut(Out):
    reminder_after_hours: int = Field(description="hours after a lesson ends before the teacher is reminded")
    guardian_daily_limit: int = Field(
        description="messages (per guardian reached) a teacher may send per day"
    )
    digest_after: str = Field(
        description="local time after which the owner gets the list of today's unmarked lessons"
    )


class AppSettingsPatch(Model):
    reminder_after_hours: Annotated[int, Field(ge=0, le=48)] | None = None
    guardian_daily_limit: Annotated[int, Field(ge=0, le=500)] | None = None
    digest_after: HHMM | None = None


@router.get("/teacher-app/settings", response_model=AppSettingsOut)
async def get_app_settings(p: Annotated[Principal, Depends(require("staff:read"))], db: DB) -> AppSettingsOut:
    async with db.tx(p.session()) as conn:
        return AppSettingsOut(**await load_app_settings(conn, p.org_id))


@router.patch("/teacher-app/settings", response_model=AppSettingsOut)
async def patch_app_settings(
    body: AppSettingsPatch, p: Annotated[Principal, Depends(require("staff:manage"))], db: DB
) -> AppSettingsOut:
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    p.require_center_wide()  # one setting set per center
    async with db.tx(p.session()) as conn:
        await load_app_settings(conn, p.org_id)
        for k, v in changes.items():
            col = {
                "reminder_after_hours": "reminder_after_hours",
                "guardian_daily_limit": "guardian_daily_limit",
                "digest_after": "digest_after",
            }[k]
            await execute(
                conn, f"UPDATE teacher_app_settings SET {col} = %s WHERE org_id = %s", (v, p.org_id)
            )
        return AppSettingsOut(**await load_app_settings(conn, p.org_id))


# ---- the log of teacher messages ------------------------------------------------------------------------------------
class TeacherMessageOut(Out):
    id: uuid.UUID
    teacher_id: uuid.UUID
    teacher_name: str
    student_id: uuid.UUID
    student_name: str
    guardian_id: uuid.UUID
    guardian_name: str
    group_name: str
    template: str | None
    body: str
    delivery: str = Field(
        description="status of the outbox message: queued, sending, sent, failed, cancelled"
    )
    created_at: datetime


_LOG_SQL = (
    "SELECT m.public_id AS id, t.public_id AS teacher_id, t.full_name AS teacher_name, s.public_id AS student_id, "
    "s.full_name AS student_name, gd.public_id AS guardian_id, gd.full_name AS guardian_name, g.name AS group_name, "
    "m.template, m.body, o.status AS delivery, m.created_at "
    "FROM teacher_guardian_messages m "
    "JOIN teachers t ON t.org_id = m.org_id AND t.id = m.teacher_id "
    "JOIN students s ON s.org_id = m.org_id AND s.id = m.student_id "
    "JOIN guardians gd ON gd.org_id = m.org_id AND gd.id = m.guardian_id "
    "JOIN study_groups g ON g.org_id = m.org_id AND g.id = m.group_id "
    "JOIN outbox_messages o ON o.org_id = m.org_id AND o.id = m.outbox_message_id"
)


@router.get(
    "/teacher-messages",
    response_model=Page[TeacherMessageOut],
    summary="What teachers wrote to guardians (read-only log)",
)
async def teacher_messages(
    p: Annotated[Principal, Depends(require("staff:read"))],
    db: DB,
    pg: Paging,
    teacher_id: uuid.UUID | None = None,
    day: Annotated[date | None, Query(description="only this day (center time)")] = None,
) -> Page[TeacherMessageOut]:
    where: list[str] = ["TRUE"]
    params: list[Any] = []
    if teacher_id:
        where.append("t.public_id = %s")
        params.append(teacher_id)
    if day:
        where.append(
            "(m.created_at AT TIME ZONE (SELECT timezone FROM organizations WHERE id = m.org_id))::date = %s"
        )
        params.append(day)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_LOG_SQL} WHERE {' AND '.join(where)} ORDER BY m.created_at DESC, m.id DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, TeacherMessageOut)


# ---- unmarked lessons -----------------------------------------------------------------------------------------------
class UnmarkedOut(Out):
    lesson_id: uuid.UUID
    group_name: str
    teacher_id: uuid.UUID | None
    teacher_name: str | None
    lesson_date: date
    start_time: str
    end_time: str
    state: Literal["waiting", "reminder_due", "reminded"]
    reminder_at: str


@router.get(
    "/lessons/unmarked",
    response_model=list[UnmarkedOut],
    summary="Finished lessons of the last 7 days without any roll call (a teacher sees only own)",
)
async def unmarked_lessons(
    p: Annotated[Principal, Depends(require("attendance:read"))], db: DB
) -> list[UnmarkedOut]:
    async with db.tx(p.session()) as conn:
        settings = await load_app_settings(conn, p.org_id)
        mine = None
        if p.role == "teacher":
            mine = await my_teacher_id(conn, p) or -1
        items = await unmarked_now(
            conn, teacher_pk=mine, after_hours=int(settings["reminder_after_hours"]), now=await org_now(conn)
        )
        teacher_public = {
            int(r["id"]): r["public_id"] for r in await fetch_all(conn, "SELECT id, public_id FROM teachers")
        }
        lesson_public = {
            int(r["id"]): r["public_id"]
            for r in await fetch_all(
                conn,
                "SELECT id, public_id FROM lessons WHERE id = ANY(%s)",
                ([int(i["row"]["id"]) for i in items],),
            )
        }
    out = []
    for i in items:
        r = i["row"]
        out.append(
            UnmarkedOut(
                lesson_id=lesson_public[int(r["id"])],
                group_name=r["group_name"],
                teacher_id=teacher_public.get(int(r["teacher_pk"])) if r["teacher_pk"] is not None else None,
                teacher_name=r["teacher_name"],
                lesson_date=r["lesson_date"],
                start_time=r["start_time"].strftime("%H:%M"),
                end_time=r["end_time"].strftime("%H:%M"),
                state=i["state"],
                reminder_at=i["reminder_at"],
            )
        )
    return out


class SweepOut(Out):
    teacher_reminders: int
    digests: int


@router.post(
    "/teacher-app/reminders/run",
    response_model=SweepOut,
    summary="Run the reminder pass of this center now (internal staff messages only; safe to repeat)",
)
async def run_reminders(p: Annotated[Principal, Depends(require("staff:manage"))], db: DB) -> SweepOut:
    p.require_center_wide()
    async with db.tx(
        Session(user_id=None, org_id=p.org_id, request_id=p.request_id, actor_type="system")
    ) as conn:
        return SweepOut(**await sweep_center(conn, p.org_id))
