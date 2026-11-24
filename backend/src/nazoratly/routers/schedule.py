"""Schedule: calendar (week/day) of all lessons, schedule checks (room/teacher conflicts, room capacity), moving /
cancelling / substituting a lesson with the payroll effect, and the guardian message DRAFTS those changes create.

Model B: a notice is only a draft. It reaches the outbox when a person approves it (and the database re-checks the
guardian link and the active notifications consent at that moment)."""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, model_validator

from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.academics import my_teacher_id
from nazoratly.routers.lessons import _LESSON_SQL, LessonOut, _lesson_for
from nazoratly.rules import schedule as R
from nazoratly.scheduling import (
    EFFECTIVE_TEACHER_SQL,
    conflicts_by_lesson,
    drop_draft_payroll_lines,
    ensure_no_conflict,
    hhmm,
    lesson_in_frozen_payroll,
    teacher_pay,
)
from nazoratly.schemas import Dec2, LongText, Model, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["schedule"], route_class=IdempotentRoute)

MAX_CHECK_DAYS = 62


# ---- calendar ------------------------------------------------------------------------------------------------
class ClashOut(Out):
    kind: Literal["room", "teacher"]
    lesson_id: uuid.UUID
    group_name: str


class CalendarEntry(Out):
    lesson_id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    teacher_id: uuid.UUID | None
    teacher_name: str | None
    is_substitute: bool
    room_id: uuid.UUID | None
    room_name: str | None
    room_capacity: int | None
    group_capacity: int | None
    enrolled: int
    lesson_date: date
    start_time: time
    end_time: time
    status: str
    kind: str
    moved_from_date: date | None
    conflicts: list[ClashOut]
    capacity_problem: str = Field(description="ok | group_capacity_over_room | enrolled_over_room")


class CalendarDay(Out):
    date: date
    weekday: int = Field(description="ISO weekday, 1 = Monday")
    entries: list[CalendarEntry]


class CalendarOut(Out):
    view: Literal["week", "day"]
    date_from: date
    date_to: date
    days: list[CalendarDay]


_CAL_SQL = (
    f"SELECT l.id AS pk, l.public_id AS lesson_id, g.public_id AS group_id, g.name AS group_name, g.capacity AS group_capacity,"
    " (SELECT count(*) FROM enrollments e WHERE e.group_id = g.id AND e.status IN ('trial', 'active')) AS enrolled,"
    f" et.id AS teacher_pk, et.public_id AS teacher_id, et.full_name AS teacher_name,"
    " (l.substitute_teacher_id IS NOT NULL) AS is_substitute, l.room_id AS room_pk, r.public_id AS room_id, r.name AS room_name,"
    " r.capacity AS room_capacity, l.lesson_date, l.start_time, l.end_time, l.status, l.kind, l.original_date AS moved_from_date,"
    " g.teacher_id AS group_teacher_pk, l.teacher_id AS lesson_teacher_pk, l.substitute_teacher_id AS substitute_pk "
    "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
    f"LEFT JOIN teachers et ON et.org_id = l.org_id AND et.id = {EFFECTIVE_TEACHER_SQL} "
    "LEFT JOIN rooms r ON r.org_id = l.org_id AND r.id = l.room_id "
    "WHERE l.lesson_date BETWEEN %s AND %s AND g.deleted_at IS NULL "
    "ORDER BY l.lesson_date, l.start_time, lower(g.name), l.id"
)


def _clash_rows(rows: list[dict[str, Any]]) -> dict[str, list[R.Conflict]]:
    return conflicts_by_lesson(
        [
            {
                "id": r["pk"],
                "lesson_date": r["lesson_date"],
                "start_time": r["start_time"],
                "end_time": r["end_time"],
                "room_id": r["room_pk"],
                "teacher_id": r["teacher_pk"],
                "status": r["status"],
            }
            for r in rows
        ]
    )


@router.get(
    "/calendar",
    response_model=CalendarOut,
    summary="Week or day calendar of all lessons (a teacher sees only their own)",
)
async def calendar(
    p: Annotated[Principal, Depends(require("academics:read"))],
    db: DB,
    day: Annotated[date, Query(alias="date", description="any date inside the week/day")],
    view: Literal["week", "day"] = "week",
    group_id: uuid.UUID | None = None,
    teacher_id: uuid.UUID | None = None,
    room_id: uuid.UUID | None = None,
) -> CalendarOut:
    if view == "day":
        d_from = d_to = day
    else:
        monday, sunday = R.week_range(day.isoformat())
        d_from, d_to = date.fromisoformat(monday), date.fromisoformat(sunday)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(conn, _CAL_SQL, (d_from, d_to))
        mine: int | None = None
        if p.role == "teacher":
            mine = await my_teacher_id(conn, p) or -1
    clashes = _clash_rows(rows)  # computed on ALL lessons: a teacher's lesson can clash with somebody else's
    by_pk = {r["pk"]: r for r in rows}
    entries: dict[date, list[CalendarEntry]] = {}
    for r in rows:
        if mine is not None and mine not in (
            r["lesson_teacher_pk"],
            r["group_teacher_pk"],
            r["substitute_pk"],
        ):
            continue
        if group_id and r["group_id"] != group_id:
            continue
        if teacher_id and r["teacher_id"] != teacher_id:
            continue
        if room_id and r["room_id"] != room_id:
            continue
        found = clashes.get(str(r["pk"]), [])
        entries.setdefault(r["lesson_date"], []).append(
            CalendarEntry(
                lesson_id=r["lesson_id"],
                group_id=r["group_id"],
                group_name=r["group_name"],
                teacher_id=r["teacher_id"],
                teacher_name=r["teacher_name"],
                is_substitute=r["is_substitute"],
                room_id=r["room_id"],
                room_name=r["room_name"],
                room_capacity=r["room_capacity"],
                group_capacity=r["group_capacity"],
                enrolled=int(r["enrolled"]),
                lesson_date=r["lesson_date"],
                start_time=r["start_time"],
                end_time=r["end_time"],
                status=r["status"],
                kind=r["kind"],
                moved_from_date=r["moved_from_date"],
                conflicts=[
                    ClashOut(
                        kind=c.kind,
                        lesson_id=by_pk[int(c.other_id)]["lesson_id"],
                        group_name=by_pk[int(c.other_id)]["group_name"],
                    )
                    for c in found
                ],
                capacity_problem=R.capacity_check(
                    group_capacity=r["group_capacity"],
                    enrolled=int(r["enrolled"]),
                    room_capacity=r["room_capacity"],
                ),
            )
        )
    days = []
    cur = d_from
    while cur <= d_to:
        days.append(CalendarDay(date=cur, weekday=cur.isoweekday(), entries=entries.get(cur, [])))
        cur += timedelta(days=1)
    return CalendarOut(view=view, date_from=d_from, date_to=d_to, days=days)


# ---- checks --------------------------------------------------------------------------------------------------
class ClashPair(Out):
    date: date
    kind: Literal["room", "teacher"]
    lesson_a: uuid.UUID
    group_a: str
    start_a: time
    lesson_b: uuid.UUID
    group_b: str
    start_b: time
    room: str | None
    teacher: str | None


class CapacityWarning(Out):
    problem: str
    group_id: uuid.UUID
    group_name: str
    room_id: uuid.UUID
    room_name: str
    room_capacity: int | None
    group_capacity: int | None
    enrolled: int


class ChecksOut(Out):
    date_from: date
    date_to: date
    conflicts: list[ClashPair]
    capacity: list[CapacityWarning]


@router.get(
    "/schedule/checks",
    response_model=ChecksOut,
    summary="Room/teacher conflicts of a date range and groups that do not fit their room",
)
async def checks(
    p: Annotated[Principal, Depends(require("academics:write"))], db: DB, date_from: date, date_to: date
) -> ChecksOut:
    if date_to < date_from or (date_to - date_from).days > MAX_CHECK_DAYS:
        raise Unprocessable(f"date range must be 0-{MAX_CHECK_DAYS} days")
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(conn, _CAL_SQL, (date_from, date_to))
        pairs = await fetch_all(
            conn,
            "SELECT DISTINCT g.id AS gid, g.public_id AS group_id, g.name AS group_name, g.capacity AS group_capacity,"
            " (SELECT count(*) FROM enrollments e WHERE e.group_id = g.id AND e.status IN ('trial', 'active')) AS enrolled,"
            " r.public_id AS room_id, r.name AS room_name, r.capacity AS room_capacity "
            "FROM study_groups g JOIN rooms r ON r.org_id = g.org_id "
            "WHERE g.deleted_at IS NULL AND g.status IN ('planned', 'active') AND ("
            " EXISTS (SELECT 1 FROM group_schedules gs WHERE gs.group_id = g.id AND gs.room_id = r.id) OR "
            " EXISTS (SELECT 1 FROM lessons l WHERE l.group_id = g.id AND l.room_id = r.id AND l.status <> 'cancelled' "
            "         AND l.lesson_date BETWEEN %s AND %s)) ORDER BY g.name, r.name",
            (date_from, date_to),
        )
    by_pk = {r["pk"]: r for r in rows}
    seen: set[tuple[int, int, str]] = set()
    conflicts: list[ClashPair] = []
    for pk, found in sorted(_clash_rows(rows).items(), key=lambda kv: int(kv[0])):
        for c in found:
            a, b = sorted((int(pk), int(c.other_id)))
            if (a, b, c.kind) in seen:
                continue
            seen.add((a, b, c.kind))
            ra, rb = by_pk[a], by_pk[b]
            conflicts.append(
                ClashPair(
                    date=ra["lesson_date"],
                    kind=c.kind,
                    lesson_a=ra["lesson_id"],
                    group_a=ra["group_name"],
                    start_a=ra["start_time"],
                    lesson_b=rb["lesson_id"],
                    group_b=rb["group_name"],
                    start_b=rb["start_time"],
                    room=ra["room_name"] if c.kind == "room" else None,
                    teacher=ra["teacher_name"] if c.kind == "teacher" else None,
                )
            )
    conflicts.sort(key=lambda c: (c.date, c.start_a, c.group_a, c.kind))
    warnings: list[CapacityWarning] = []
    for g in pairs:
        verdict = R.capacity_check(
            group_capacity=g["group_capacity"], enrolled=int(g["enrolled"]), room_capacity=g["room_capacity"]
        )
        if verdict != "ok":
            warnings.append(
                CapacityWarning(
                    problem=verdict,
                    group_id=g["group_id"],
                    group_name=g["group_name"],
                    room_id=g["room_id"],
                    room_name=g["room_name"],
                    room_capacity=g["room_capacity"],
                    group_capacity=g["group_capacity"],
                    enrolled=int(g["enrolled"]),
                )
            )
    return ChecksOut(date_from=date_from, date_to=date_to, conflicts=conflicts, capacity=warnings)


# ---- move / cancel / substitute ------------------------------------------------------------------------------
class PayEffectOut(Out):
    teacher_id: uuid.UUID
    teacher_name: str
    month: str
    delta: Dec2
    payroll_status: str | None = Field(
        description="status of that teacher's payroll for the month (None = not generated yet); approved/paid "
        "payrolls are frozen: correct them with an adjustment line"
    )


class ChangeResult(Out):
    change_id: uuid.UUID
    kind: str
    lesson: LessonOut
    payroll_effect: list[PayEffectOut]
    draft_payroll_lines_removed: int
    notices_created: int
    students_without_notice: int = Field(
        description="enrolled students nobody can be told about (no linked guardian, no consent)"
    )
    allowed_conflicts: list[dict[str, Any]]


class MoveIn(Model):
    lesson_date: date
    start_time: time
    end_time: time
    room_id: uuid.UUID | None = Field(default=None, description="omit to keep the room")
    reason: LongText | None = None
    notify: bool = Field(default=True, description="prepare guardian message drafts (a person approves them)")
    allow_conflict: bool = False

    @model_validator(mode="after")
    def _order(self) -> MoveIn:
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class CancelIn(Model):
    reason: LongText | None = None
    notify: bool = True


class SubstituteIn(Model):
    teacher_id: uuid.UUID | None = Field(description="the substitute; null removes the substitute")
    reason: LongText | None = None
    allow_conflict: bool = False


async def _pay_effects(
    conn: Conn,
    *,
    kind: str,
    old_date: date,
    new_date: date | None,
    teacher_pk: int | None,
    substitute_pk: int | None,
) -> list[PayEffectOut]:
    teacher = await teacher_pay(conn, teacher_pk)
    substitute = await teacher_pay(conn, substitute_pk)
    effects = R.payroll_effect(
        kind=kind,
        old_date=old_date.isoformat(),
        new_date=None if new_date is None else new_date.isoformat(),
        teacher=None if teacher is None else teacher.pay,
        substitute=None if substitute is None else substitute.pay,
    )
    people = {t.pay.id: t for t in (teacher, substitute) if t is not None}
    out: list[PayEffectOut] = []
    for e in effects:
        t = people[e.teacher]
        status = await fetch_one(
            conn,
            "SELECT status FROM teacher_payrolls WHERE teacher_id = %s AND period_month = %s",
            (t.id, date.fromisoformat(f"{e.month}-01")),
        )
        out.append(
            PayEffectOut(
                teacher_id=t.public_id,
                teacher_name=t.name,
                month=e.month,
                delta=e.delta,
                payroll_status=None if status is None else str(status["status"]),
            )
        )
    return out


async def _locked_lesson(conn: Conn, p: Principal, lesson_public: uuid.UUID) -> dict[str, Any]:
    lesson = await _lesson_for(conn, p, lesson_public)
    row = await fetch_one(
        conn,
        f"SELECT l.id, l.group_id, l.teacher_id, l.substitute_teacher_id, l.room_id, l.lesson_date, l.start_time, l.end_time, "
        f"l.status, l.kind, l.original_date, l.original_start_time, g.name AS group_name, g.teacher_id AS group_teacher_id, "
        f"{EFFECTIVE_TEACHER_SQL} AS effective_teacher_id "
        "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id WHERE l.id = %s FOR UPDATE OF l",
        (lesson["id"],),
    )
    assert row is not None
    return row


async def _record_change(
    conn: Conn,
    p: Principal,
    lesson: dict[str, Any],
    *,
    kind: str,
    new_date: date | None,
    new_start: time | None,
    new_end: time | None,
    new_teacher: int | None,
    new_room: int | None,
    reason: str | None,
    effects: list[PayEffectOut],
) -> tuple[int, uuid.UUID]:
    row = await fetch_one(
        conn,
        "INSERT INTO lesson_changes (org_id, lesson_id, kind, old_date, old_start_time, old_end_time, new_date, new_start_time,"
        " new_end_time, old_teacher_id, new_teacher_id, old_room_id, new_room_id, reason, payroll_effect, created_by_user_id) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s) RETURNING id, public_id",
        (
            p.org_id,
            lesson["id"],
            kind,
            lesson["lesson_date"],
            lesson["start_time"],
            lesson["end_time"],
            new_date,
            new_start,
            new_end,
            lesson["effective_teacher_id"],
            new_teacher,
            lesson["room_id"],
            new_room,
            reason,
            json.dumps(
                [{"teacher": str(e.teacher_id), "month": e.month, "delta": str(e.delta)} for e in effects]
            ),
            p.user_id,
        ),
    )
    assert row is not None
    return int(row["id"]), row["public_id"]


async def _make_notices(
    conn: Conn,
    p: Principal,
    lesson: dict[str, Any],
    *,
    change_id: int,
    kind: Literal["cancel", "move"],
    new_date: date | None,
    new_start: time | None,
    reason: str | None,
) -> tuple[int, int]:
    """One draft per (student, guardian) who may be told: linked guardian that receives messages and an active
    notifications consent. Returns (drafts created, enrolled students nobody can be told about)."""
    org = await fetch_one(conn, "SELECT name FROM organizations WHERE id = app_org_id()")
    assert org is not None
    makeup_only = lesson["kind"] == "makeup"
    students = await fetch_all(
        conn,
        "SELECT s.id AS sid, s.full_name AS student_name FROM enrollments e "
        "JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
        "WHERE e.group_id = %(g)s AND e.status IN ('trial', 'active') AND e.started_on <= %(d)s "
        "AND (e.ended_on IS NULL OR e.ended_on >= %(d)s) AND s.deleted_at IS NULL "
        "AND (NOT %(mk)s OR EXISTS (SELECT 1 FROM absence_entitlements ae WHERE ae.makeup_lesson_id = %(l)s AND ae.student_id = e.student_id)) "
        "ORDER BY lower(s.full_name), s.id",
        {"g": lesson["group_id"], "d": lesson["lesson_date"], "mk": makeup_only, "l": lesson["id"]},
    )
    told: set[int] = set()
    created = 0
    for s in students:
        guardians = await fetch_all(
            conn,
            "SELECT gd.id AS gid, gd.full_name FROM student_guardians sg "
            "JOIN guardians gd ON gd.org_id = sg.org_id AND gd.id = sg.guardian_id AND gd.deleted_at IS NULL "
            "WHERE sg.student_id = %s AND sg.receives_reminders "
            "AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.student_id = sg.student_id AND dc.purpose = 'notifications' "
            "            AND dc.revoked_at IS NULL) ORDER BY sg.is_primary DESC, sg.id",
            (s["sid"],),
        )
        for g in guardians:
            body = R.change_message(
                kind=kind,
                guardian=g["full_name"],
                student=s["student_name"],
                group=lesson["group_name"],
                old_date=lesson["lesson_date"].isoformat(),
                old_start=hhmm(lesson["start_time"]),
                new_date=None if new_date is None else new_date.isoformat(),
                new_start=None if new_start is None else hhmm(new_start),
                reason=reason,
                center=str(org["name"]),
            )
            await execute(
                conn,
                "INSERT INTO schedule_notices (org_id, change_id, student_id, guardian_id, body) VALUES (%s, %s, %s, %s, %s)",
                (p.org_id, change_id, s["sid"], g["gid"], body),
            )
            created += 1
            told.add(int(s["sid"]))
    return created, len(students) - len(told)


async def _finish(
    conn: Conn,
    lesson: dict[str, Any],
    *,
    change_public: uuid.UUID,
    kind: str,
    effects: list[PayEffectOut],
    removed: int,
    notices: tuple[int, int],
    allowed: list[dict[str, Any]],
) -> ChangeResult:
    out = await fetch_one(conn, f"{_LESSON_SQL} WHERE l.id = %s", (lesson["id"],))
    assert out is not None
    return ChangeResult(
        change_id=change_public,
        kind=kind,
        lesson=LessonOut.model_validate(out),
        payroll_effect=effects,
        draft_payroll_lines_removed=removed,
        notices_created=notices[0],
        students_without_notice=notices[1],
        allowed_conflicts=allowed,
    )


async def _guard_change(conn: Conn, lesson: dict[str, Any], *, allowed: tuple[str, ...]) -> None:
    if lesson["status"] not in allowed:
        raise Conflict(
            f"Only {' or '.join(allowed)} lessons can be changed this way (this one is {lesson['status']})"
        )
    if await lesson_in_frozen_payroll(conn, int(lesson["id"])):
        raise Conflict(
            "The lesson is already in an approved or paid payroll; correct that payroll with an adjustment line"
        )


@router.post(
    "/lessons/{lesson_id}/move",
    response_model=ChangeResult,
    summary="Move a planned lesson to another date/time/room (prepares guardian message drafts)",
)
async def move_lesson(
    lesson_id: uuid.UUID, body: MoveIn, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> ChangeResult:
    async with db.tx(p.session()) as conn:
        lesson = await _locked_lesson(conn, p, lesson_id)
        await _guard_change(conn, lesson, allowed=("planned",))
        room = (
            await resolve_opt(conn, "rooms", body.room_id, what="room") if body.room_id else lesson["room_id"]
        )
        same = (
            body.lesson_date == lesson["lesson_date"]
            and body.start_time == lesson["start_time"]
            and body.end_time == lesson["end_time"]
            and room == lesson["room_id"]
        )
        if same:
            raise Unprocessable("The lesson is already at this date, time and room")
        taken = await fetch_one(
            conn,
            "SELECT 1 AS x FROM lessons WHERE group_id = %s AND lesson_date = %s AND start_time = %s AND id <> %s",
            (lesson["group_id"], body.lesson_date, body.start_time, lesson["id"]),
        )
        if taken is not None:
            raise Conflict("The group already has a lesson at that date and start time")
        allowed = await ensure_no_conflict(
            conn,
            lesson_id=int(lesson["id"]),
            day=body.lesson_date,
            start=body.start_time,
            end=body.end_time,
            room_id=room,
            teacher_id=lesson["effective_teacher_id"],
            allow=body.allow_conflict,
        )
        effects = await _pay_effects(
            conn,
            kind="move",
            old_date=lesson["lesson_date"],
            new_date=body.lesson_date,
            teacher_pk=lesson["effective_teacher_id"],
            substitute_pk=None,
        )
        change_pk, change_public = await _record_change(
            conn,
            p,
            lesson,
            kind="move",
            new_date=body.lesson_date,
            new_start=body.start_time,
            new_end=body.end_time,
            new_teacher=None,
            new_room=room,
            reason=body.reason,
            effects=effects,
        )
        removed = await drop_draft_payroll_lines(conn, int(lesson["id"]))
        await execute(
            conn,
            "UPDATE lessons SET lesson_date = %s, start_time = %s, end_time = %s, room_id = %s, "
            "original_date = COALESCE(original_date, %s), original_start_time = COALESCE(original_start_time, %s) WHERE id = %s",
            (
                body.lesson_date,
                body.start_time,
                body.end_time,
                room,
                lesson["lesson_date"],
                lesson["start_time"],
                lesson["id"],
            ),
        )
        notices = (0, 0)
        if body.notify:
            notices = await _make_notices(
                conn,
                p,
                lesson,
                change_id=change_pk,
                kind="move",
                new_date=body.lesson_date,
                new_start=body.start_time,
                reason=body.reason,
            )
        return await _finish(
            conn,
            lesson,
            change_public=change_public,
            kind="move",
            effects=effects,
            removed=removed,
            notices=notices,
            allowed=allowed,
        )


@router.post(
    "/lessons/{lesson_id}/cancel",
    response_model=ChangeResult,
    summary="Cancel a planned lesson (prepares guardian message drafts)",
)
async def cancel_lesson(
    lesson_id: uuid.UUID, body: CancelIn, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> ChangeResult:
    async with db.tx(p.session()) as conn:
        lesson = await _locked_lesson(conn, p, lesson_id)
        await _guard_change(conn, lesson, allowed=("planned",))
        n = await fetch_one(
            conn, "SELECT count(*) AS n FROM attendance WHERE lesson_id = %s", (lesson["id"],)
        )
        assert n is not None
        if n["n"]:
            raise Conflict("Lesson has attendance records; remove them before cancelling")
        effects = await _pay_effects(
            conn,
            kind="cancel",
            old_date=lesson["lesson_date"],
            new_date=None,
            teacher_pk=lesson["effective_teacher_id"],
            substitute_pk=None,
        )
        change_pk, change_public = await _record_change(
            conn,
            p,
            lesson,
            kind="cancel",
            new_date=None,
            new_start=None,
            new_end=None,
            new_teacher=None,
            new_room=None,
            reason=body.reason,
            effects=effects,
        )
        removed = await drop_draft_payroll_lines(conn, int(lesson["id"]))
        await execute(
            conn,
            "UPDATE lessons SET status = 'cancelled', cancel_reason = %s WHERE id = %s",
            (body.reason, lesson["id"]),
        )
        if lesson["kind"] == "makeup":  # the student keeps the make-up right
            await execute(
                conn,
                "UPDATE absence_entitlements SET status = 'open', makeup_lesson_id = NULL, used_on = NULL "
                "WHERE makeup_lesson_id = %s AND status = 'scheduled'",
                (lesson["id"],),
            )
        notices = (0, 0)
        if body.notify:
            notices = await _make_notices(
                conn,
                p,
                lesson,
                change_id=change_pk,
                kind="cancel",
                new_date=None,
                new_start=None,
                reason=body.reason,
            )
        return await _finish(
            conn,
            lesson,
            change_public=change_public,
            kind="cancel",
            effects=effects,
            removed=removed,
            notices=notices,
            allowed=[],
        )


@router.post(
    "/lessons/{lesson_id}/substitute",
    response_model=ChangeResult,
    summary="Set (or clear) the substitute teacher of a lesson; payroll follows the substitute",
)
async def substitute_lesson(
    lesson_id: uuid.UUID,
    body: SubstituteIn,
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
) -> ChangeResult:
    async with db.tx(p.session()) as conn:
        lesson = await _locked_lesson(conn, p, lesson_id)
        await _guard_change(conn, lesson, allowed=("planned", "held"))
        new_sub = await resolve_opt(conn, "teachers", body.teacher_id, what="teacher")
        if new_sub is not None:
            active = await fetch_one(conn, "SELECT status FROM teachers WHERE id = %s", (new_sub,))
            assert active is not None
            if active["status"] != "active":
                raise Unprocessable("The substitute teacher is not active")
        new_effective = new_sub or lesson["teacher_id"] or lesson["group_teacher_id"]
        if new_effective == lesson["effective_teacher_id"] and new_sub == lesson["substitute_teacher_id"]:
            raise Unprocessable("The lesson already has this teacher")
        allowed: list[dict[str, Any]] = []
        if new_effective is not None:
            allowed = await ensure_no_conflict(
                conn,
                lesson_id=int(lesson["id"]),
                day=lesson["lesson_date"],
                start=lesson["start_time"],
                end=lesson["end_time"],
                room_id=lesson["room_id"],
                teacher_id=new_effective,
                allow=body.allow_conflict,
            )
        effects = await _pay_effects(
            conn,
            kind="substitute",
            old_date=lesson["lesson_date"],
            new_date=None,
            teacher_pk=lesson["effective_teacher_id"],
            substitute_pk=new_effective,
        )
        _, change_public = await _record_change(
            conn,
            p,
            lesson,
            kind="substitute",
            new_date=None,
            new_start=None,
            new_end=None,
            new_teacher=new_effective,
            new_room=None,
            reason=body.reason,
            effects=effects,
        )
        removed = await drop_draft_payroll_lines(conn, int(lesson["id"]))
        await execute(
            conn, "UPDATE lessons SET substitute_teacher_id = %s WHERE id = %s", (new_sub, lesson["id"])
        )
        return await _finish(
            conn,
            lesson,
            change_public=change_public,
            kind="substitute",
            effects=effects,
            removed=removed,
            notices=(0, 0),
            allowed=allowed,
        )


# ---- history -------------------------------------------------------------------------------------------------
class ChangeOut(Out):
    id: uuid.UUID
    kind: str
    old_date: date
    old_start_time: time
    new_date: date | None
    new_start_time: time | None
    old_teacher_name: str | None
    new_teacher_name: str | None
    reason: str | None
    payroll_effect: list[dict[str, Any]]
    notices: int
    created_at: datetime


@router.get(
    "/lessons/{lesson_id}/changes", response_model=list[ChangeOut], summary="History of a lesson's changes"
)
async def lesson_changes(
    lesson_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:read"))], db: DB
) -> list[ChangeOut]:
    async with db.tx(p.session()) as conn:
        lesson = await _lesson_for(conn, p, lesson_id)
        rows = await fetch_all(
            conn,
            "SELECT c.public_id AS id, c.kind, c.old_date, c.old_start_time, c.new_date, c.new_start_time, ot.full_name AS old_teacher_name,"
            " nt.full_name AS new_teacher_name, c.reason, c.payroll_effect, c.created_at,"
            " (SELECT count(*) FROM schedule_notices n WHERE n.change_id = c.id) AS notices "
            "FROM lesson_changes c LEFT JOIN teachers ot ON ot.org_id = c.org_id AND ot.id = c.old_teacher_id "
            "LEFT JOIN teachers nt ON nt.org_id = c.org_id AND nt.id = c.new_teacher_id "
            "WHERE c.lesson_id = %s ORDER BY c.created_at, c.id",
            (lesson["id"],),
        )
    return [ChangeOut.model_validate(r) for r in rows]


# ---- notices (guardian message drafts) -------------------------------------------------------------------------
NoticeStatus = Literal["pending", "approved", "rejected"]


class NoticeOut(Out):
    id: uuid.UUID
    status: str
    kind: str
    student_id: uuid.UUID
    student_name: str
    guardian_id: uuid.UUID
    guardian_name: str
    body: str
    group_name: str
    old_date: date
    new_date: date | None
    created_at: datetime
    decided_at: datetime | None


class ApproveNoticeIn(Model):
    channel: Literal["telegram", "sms"] | None = None


_NOTICE_SQL = (
    "SELECT n.public_id AS id, n.status, c.kind, s.public_id AS student_id, s.full_name AS student_name, gd.public_id AS guardian_id,"
    " gd.full_name AS guardian_name, n.body, g.name AS group_name, c.old_date, c.new_date, n.created_at, n.decided_at "
    "FROM schedule_notices n JOIN lesson_changes c ON c.org_id = n.org_id AND c.id = n.change_id "
    "JOIN lessons l ON l.org_id = c.org_id AND l.id = c.lesson_id JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
    "JOIN students s ON s.org_id = n.org_id AND s.id = n.student_id JOIN guardians gd ON gd.org_id = n.org_id AND gd.id = n.guardian_id"
)


@router.get(
    "/schedule-notices", response_model=Page[NoticeOut], summary="Guardian message drafts for lesson changes"
)
async def list_notices(
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
    pg: Paging,
    status: NoticeStatus | None = "pending",
) -> Page[NoticeOut]:
    where = "TRUE" if status is None else "n.status = %s"
    params: tuple[Any, ...] = () if status is None else (status,)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_NOTICE_SQL} WHERE {where} ORDER BY n.created_at, n.id LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, NoticeOut)


async def _pending_notice(conn: Conn, notice_public: uuid.UUID) -> int:
    nid = await resolve(conn, "schedule_notices", notice_public, what="notice")
    cur = await fetch_one(conn, "SELECT status FROM schedule_notices WHERE id = %s FOR UPDATE", (nid,))
    assert cur is not None
    if cur["status"] != "pending":
        raise Conflict(f"Notice is already {cur['status']}")
    return nid


@router.post(
    "/schedule-notices/{notice_id}/approve",
    response_model=NoticeOut,
    summary="Approve a notice: queues the guardian message (this call IS the person's approval)",
)
async def approve_notice(
    notice_id: uuid.UUID,
    body: ApproveNoticeIn,
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
) -> NoticeOut:
    async with db.tx(p.session()) as conn:
        nid = await _pending_notice(conn, notice_id)
        n = await fetch_one(
            conn,
            "SELECT n.student_id, n.guardian_id, n.body, g.telegram_chat_id, g.phone FROM schedule_notices n "
            "JOIN guardians g ON g.org_id = n.org_id AND g.id = n.guardian_id WHERE n.id = %s",
            (nid,),
        )
        assert n is not None
        channel = body.channel or ("telegram" if n["telegram_chat_id"] is not None else "sms")
        if channel == "telegram" and n["telegram_chat_id"] is None:
            raise Conflict("Guardian has no Telegram chat; choose sms")
        if channel == "sms" and n["phone"] is None:
            raise Conflict("Guardian has no phone number; choose telegram")
        linked = await fetch_one(
            conn,
            "SELECT 1 AS x FROM student_guardians WHERE student_id = %s AND guardian_id = %s AND receives_reminders",
            (n["student_id"], n["guardian_id"]),
        )
        consent = await fetch_one(
            conn,
            "SELECT 1 AS x FROM data_consents WHERE student_id = %s AND purpose = 'notifications' AND revoked_at IS NULL",
            (n["student_id"],),
        )
        if linked is None or consent is None:
            raise Conflict(
                "The guardian no longer receives messages for this student (link or consent changed)"
            )
        out = await fetch_one(
            conn,
            "INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, idempotency_key) "
            "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, n["student_id"], n["guardian_id"], channel, n["body"], f"schedule-notice-{notice_id}"),
        )
        assert out is not None
        await execute(
            conn,
            "UPDATE schedule_notices SET status = 'approved', decided_by_user_id = %s, decided_at = now(), outbox_id = %s WHERE id = %s",
            (p.user_id, out["id"], nid),
        )
        res = await fetch_one(conn, f"{_NOTICE_SQL} WHERE n.id = %s", (nid,))
    assert res is not None
    return NoticeOut.model_validate(res)


@router.post(
    "/schedule-notices/{notice_id}/reject",
    response_model=NoticeOut,
    summary="Reject a notice: nothing is sent",
)
async def reject_notice(
    notice_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> NoticeOut:
    async with db.tx(p.session()) as conn:
        nid = await _pending_notice(conn, notice_id)
        await execute(
            conn,
            "UPDATE schedule_notices SET status = 'rejected', decided_by_user_id = %s, decided_at = now() WHERE id = %s",
            (p.user_id, nid),
        )
        res = await fetch_one(conn, f"{_NOTICE_SQL} WHERE n.id = %s", (nid,))
    assert res is not None
    return NoticeOut.model_validate(res)
