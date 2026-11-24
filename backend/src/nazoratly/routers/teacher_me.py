"""Teacher app, the teacher's own side: profile, own groups and lessons, hours and pay, messages to guardians and the
in-app notifications. Everything here is the signed-in teacher's own data; attendance, notes/grades and QR scans keep
using their existing endpoints (which already restrict a teacher to own groups and lessons)."""

from __future__ import annotations

import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, StringConstraints, model_validator

from nazoratly.db import fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Forbidden, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.finance import month_start, next_month
from nazoratly.rules import teacher as R
from nazoratly.schemas import Dec2, Model, Out, Page, make_page
from nazoratly.teacher_app import (
    load_app_settings,
    messages_today,
    org_now,
    own_groups,
    reachable_guardians,
    require_teacher,
    send_guardian_message,
)

router = APIRouter(prefix="/v1", tags=["teacher app"], route_class=IdempotentRoute)

Teacher = Annotated[Principal, Depends(require("attendance:write"))]


class MeOut(Out):
    teacher_id: uuid.UUID
    full_name: str
    phone: str | None
    pay_model: str
    messaging_enabled: bool
    messages_sent_today: int
    messages_left_today: int
    groups: int
    unread_notifications: int


@router.get(
    "/teacher/me", response_model=MeOut, summary="The signed-in teacher: profile, limits and counters"
)
async def teacher_me(p: Teacher, db: DB) -> MeOut:
    async with db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        settings = await load_app_settings(conn, p.org_id)
        sent = await messages_today(conn, int(t["id"]))
        groups = len(await own_groups(conn, int(t["id"])))
        unread = await fetch_one(
            conn,
            "SELECT count(*) AS n FROM staff_notifications WHERE user_id = %s AND read_at IS NULL",
            (p.user_id,),
        )
        assert unread is not None
    return MeOut(
        teacher_id=t["public_id"],
        full_name=t["full_name"],
        phone=t["phone"],
        pay_model=t["pay_model"],
        messaging_enabled=bool(t["guardian_messaging_enabled"]),
        messages_sent_today=sent,
        messages_left_today=max(0, int(settings["guardian_daily_limit"]) - sent),
        groups=groups,
        unread_notifications=int(unread["n"]),
    )


class OwnGroupOut(Out):
    id: uuid.UUID
    name: str
    course_name: str
    status: str
    students: int


@router.get("/teacher/groups", response_model=list[OwnGroupOut], summary="The groups this teacher teaches")
async def teacher_groups(p: Teacher, db: DB) -> list[OwnGroupOut]:
    async with db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        rows = await own_groups(conn, int(t["id"]))
    return [
        OwnGroupOut(id=r["public_id"], name=r["name"], course_name=r["course_name"], status=r["status"], students=int(r["students"]))
        for r in rows
    ]


class StudentOut(Out):
    id: uuid.UUID
    full_name: str
    guardian_reachable: bool = Field(
        description="a guardian can receive a Telegram message (link, reminders, consent)"
    )


@router.get(
    "/teacher/groups/{group_id}/students",
    response_model=list[StudentOut],
    summary="Active students of one of the teacher's own groups (no contact details)",
)
async def teacher_group_students(group_id: uuid.UUID, p: Teacher, db: DB) -> list[StudentOut]:
    async with db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        gid = await resolve(conn, "study_groups", group_id, what="group")
        if gid not in [int(g["id"]) for g in await own_groups(conn, int(t["id"]))]:
            raise Forbidden("Teachers can access only their own groups")
        rows = await fetch_all(
            conn,
            "SELECT s.id, s.public_id, s.full_name FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
            "WHERE e.group_id = %s AND e.status = 'active' AND s.deleted_at IS NULL ORDER BY lower(s.full_name), s.id",
            (gid,),
        )
        out = [
            StudentOut(
                id=r["public_id"],
                full_name=r["full_name"],
                guardian_reachable=bool(await reachable_guardians(conn, int(r["id"]))),
            )
            for r in rows
        ]
    return out


class OwnLessonOut(Out):
    lesson_id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    lesson_date: date
    start_time: time
    end_time: time
    status: str
    kind: str
    is_substitute: bool
    enrolled: int
    marked: int
    needs_roll_call: bool = Field(description="the lesson is over, not cancelled and has no roll call yet")


_LESSONS_SQL = (
    "SELECT l.public_id AS lesson_id, g.public_id AS group_id, g.name AS group_name, l.lesson_date, l.start_time, l.end_time, "
    "l.status, l.kind, COALESCE(l.substitute_teacher_id = %(t)s, false) AS is_substitute, "
    "(SELECT count(*) FROM enrollments e WHERE e.org_id = l.org_id AND e.group_id = l.group_id AND e.status = 'active') AS enrolled, "
    "(SELECT count(*) FROM attendance a WHERE a.org_id = l.org_id AND a.lesson_id = l.id) AS marked "
    "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
    "WHERE l.lesson_date BETWEEN %(from)s AND %(to)s AND COALESCE(l.substitute_teacher_id, l.teacher_id, g.teacher_id) = %(t)s "
    "ORDER BY l.lesson_date, l.start_time, l.id"
)


@router.get(
    "/teacher/lessons",
    response_model=list[OwnLessonOut],
    summary="The teacher's lessons in a date range (default: today)",
)
async def teacher_lessons(
    p: Teacher,
    db: DB,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> list[OwnLessonOut]:
    async with db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        now = await org_now(conn)
        d_from = date_from or now.date()
        d_to = date_to or d_from
        if d_to < d_from or (d_to - d_from).days > 92:
            raise Unprocessable("The range must be 0..92 days")
        rows = await fetch_all(conn, _LESSONS_SQL, {"t": t["id"], "from": d_from, "to": d_to})
    out = []
    for r in rows:
        ended = datetime.combine(r["lesson_date"], r["end_time"]) <= now
        out.append(
            OwnLessonOut(**r, needs_roll_call=ended and r["status"] != "cancelled" and int(r["marked"]) == 0)
        )
    return out


class PayrollRef(Out):
    status: str
    total: Dec2


class PayOut(Out):
    month: date
    lessons: int
    minutes: int
    hours: str
    pay_model: str
    pay_rate: Dec2
    estimate: int = Field(
        description="whole so'm, from the lessons held so far (see the payroll for the final number)"
    )
    payroll: PayrollRef | None


@router.get(
    "/teacher/pay",
    response_model=PayOut,
    summary="Own hours and pay estimate for a month, plus the payroll if it exists",
)
async def teacher_pay(
    p: Teacher,
    db: DB,
    month: Annotated[str, StringConstraints(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")] | None = None,
) -> PayOut:
    async with db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        first = (
            month_start(date.fromisoformat(f"{month}-01"))
            if month
            else (await org_now(conn)).date().replace(day=1)
        )
        nxt = next_month(first)
        lessons = await fetch_all(
            conn,
            "SELECT (EXTRACT(EPOCH FROM (l.end_time - l.start_time)) / 60)::int AS minutes FROM lessons l "
            "JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
            "WHERE l.status = 'held' AND l.lesson_date >= %(f)s AND l.lesson_date < %(n)s "
            "AND (l.kind <> 'makeup' OR EXISTS (SELECT 1 FROM attendance a WHERE a.lesson_id = l.id AND a.status IN ('present','late'))) "
            "AND COALESCE(l.substitute_teacher_id, l.teacher_id, g.teacher_id) = %(t)s ORDER BY l.lesson_date, l.id",
            {"f": first, "n": nxt, "t": t["id"]},
        )
        collected = Decimal(0)
        if t["pay_model"] == "percent":
            base = await fetch_one(
                conn,
                "SELECT COALESCE(sum(pa.amount), 0) AS collected FROM payment_allocations pa "
                "JOIN charges c ON c.org_id = pa.org_id AND c.id = pa.charge_id "
                "JOIN enrollments e ON e.org_id = c.org_id AND e.id = c.enrollment_id "
                "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
                "WHERE c.kind IN ('tuition', 'package') AND c.voided_at IS NULL AND c.period_month = %s AND g.teacher_id = %s",
                (first, t["id"]),
            )
            assert base is not None
            collected = base["collected"]
        pr = await fetch_one(
            conn,
            "SELECT tp.status, v.total FROM teacher_payrolls tp JOIN v_teacher_payroll_totals v ON v.payroll_id = tp.id "
            "WHERE tp.teacher_id = %s AND tp.period_month = %s",
            (t["id"], first),
        )
    summary = R.month_summary(
        [int(r["minutes"]) for r in lessons], str(t["pay_model"]), str(t["pay_rate"]), str(collected)
    )
    return PayOut(
        month=first,
        pay_model=t["pay_model"],
        pay_rate=t["pay_rate"],
        payroll=PayrollRef(status=pr["status"], total=pr["total"]) if pr else None,
        **summary,
    )


# ---- messages to guardians --------------------------------------------------------------------------------------------
class TemplateOut(Out):
    code: str
    text: str = Field(description="with {student}, {group} and {date} placeholders")


@router.get(
    "/teacher/message-templates", response_model=list[TemplateOut], summary="Ready-made message texts"
)
async def message_templates(_: Teacher) -> list[TemplateOut]:
    return [TemplateOut(code=c, text=t) for c, t in R.TEMPLATES.items()]


class GuardianMessageIn(Model):
    student_id: uuid.UUID
    group_id: uuid.UUID | None = Field(
        default=None, description="which own group; default: the first one the student is in"
    )
    guardian_id: uuid.UUID | None = Field(
        default=None, description="one guardian; default: every guardian who can receive it"
    )
    template: Literal["absent", "late", "homework", "praise", "meeting"] | None = None
    text: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=R.MAX_TEXT)] | None
    ) = None

    @model_validator(mode="after")
    def _one_of(self) -> GuardianMessageIn:
        if (self.template is None) == (self.text is None):
            raise ValueError("send either a template or a free text, not both and not neither")
        return self


class SentOut(Out):
    id: uuid.UUID
    guardian_id: uuid.UUID
    created_at: datetime


class GuardianMessageOut(Out):
    sent: list[SentOut]
    remaining_today: int


@router.post(
    "/teacher/guardian-messages",
    response_model=GuardianMessageOut,
    status_code=201,
    summary="Write to the guardians of a student of an own group (logged, limited per day, can be switched off)",
)
async def send_message(body: GuardianMessageIn, p: Teacher, db: DB) -> GuardianMessageOut:
    async with db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        sid = await resolve(conn, "students", body.student_id, what="student")
        gid = await resolve(conn, "study_groups", body.group_id, what="group") if body.group_id else None
        guardian = None
        if body.guardian_id:
            guardian = await resolve(conn, "guardians", body.guardian_id, what="guardian")
        res = await send_guardian_message(
            conn,
            org_id=p.org_id,
            user_id=p.user_id,
            teacher=t,
            student_id=sid,
            group_id=gid,
            template=body.template,
            text=body.text,
            guardian_id=guardian,
        )
    return GuardianMessageOut(**res)


class OwnMessageOut(Out):
    id: uuid.UUID
    student_name: str
    guardian_name: str
    group_name: str
    template: str | None
    body: str
    delivery: str
    created_at: datetime


@router.get(
    "/teacher/guardian-messages",
    response_model=Page[OwnMessageOut],
    summary="What this teacher wrote (read-only)",
)
async def own_messages(p: Teacher, db: DB, pg: Paging) -> Page[OwnMessageOut]:
    async with db.tx(p.session()) as conn:
        t = await require_teacher(conn, p.user_id)
        rows = await fetch_all(
            conn,
            "SELECT m.public_id AS id, s.full_name AS student_name, gd.full_name AS guardian_name, g.name AS group_name, "
            "m.template, m.body, o.status AS delivery, m.created_at FROM teacher_guardian_messages m "
            "JOIN students s ON s.org_id = m.org_id AND s.id = m.student_id "
            "JOIN guardians gd ON gd.org_id = m.org_id AND gd.id = m.guardian_id "
            "JOIN study_groups g ON g.org_id = m.org_id AND g.id = m.group_id "
            "JOIN outbox_messages o ON o.org_id = m.org_id AND o.id = m.outbox_message_id "
            "WHERE m.teacher_id = %s ORDER BY m.created_at DESC, m.id DESC LIMIT %s OFFSET %s",
            (t["id"], pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, OwnMessageOut)


# ---- notifications (any signed-in staff member: their own) ------------------------------------------------------------
class NotificationOut(Out):
    id: uuid.UUID
    kind: str
    body: str
    day: date | None
    created_at: datetime
    read_at: datetime | None


@router.get(
    "/notifications", response_model=Page[NotificationOut], summary="My internal reminders, newest first"
)
async def notifications(
    p: Annotated[Principal, Depends(require("org:read"))], db: DB, pg: Paging, unread: bool = False
) -> Page[NotificationOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            "SELECT public_id AS id, kind, body, day, created_at, read_at FROM staff_notifications "
            "WHERE user_id = %s AND (NOT %s OR read_at IS NULL) ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s",
            (p.user_id, unread, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, NotificationOut)


@router.post(
    "/notifications/{notification_id}/read", response_model=NotificationOut, summary="Mark one as read"
)
async def read_notification(
    notification_id: uuid.UUID, p: Annotated[Principal, Depends(require("org:read"))], db: DB
) -> NotificationOut:
    async with db.tx(p.session()) as conn:
        row = await fetch_one(
            conn,
            "UPDATE staff_notifications SET read_at = COALESCE(read_at, now()) WHERE public_id = %s AND user_id = %s "
            "RETURNING public_id AS id, kind, body, day, created_at, read_at",
            (notification_id, p.user_id),
        )
        if row is None:
            raise NotFound("notification not found")
    return NotificationOut.model_validate(row)
