"""Lessons (incl. generation from the weekly schedule), attendance roll call, attendance reports."""

from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, model_validator

from nazoratly.db import Conn, execute, fetch_all, fetch_one, patch_row, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, Forbidden, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.academics import assert_group_access, my_teacher_id
from nazoratly.schemas import LongText, Message, Model, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["lessons & attendance"], route_class=IdempotentRoute)

LessonStatus = Literal["planned", "held", "cancelled"]
AttStatus = Literal["present", "absent", "late", "excused"]
MAX_GENERATE_DAYS = 400


class LessonIn(Model):
    group_id: uuid.UUID
    lesson_date: date
    start_time: time
    end_time: time
    teacher_id: uuid.UUID | None = Field(default=None, description="defaults to the group's teacher")
    room_id: uuid.UUID | None = None
    topic: LongText | None = None

    @model_validator(mode="after")
    def _order(self) -> LessonIn:
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class LessonPatch(Model):
    status: LessonStatus | None = None
    topic: LongText | None = None
    teacher_id: uuid.UUID | None = None
    room_id: uuid.UUID | None = None
    start_time: time | None = None
    end_time: time | None = None


class LessonOut(Out):
    id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    teacher_id: uuid.UUID | None
    teacher_name: str | None
    room_id: uuid.UUID | None
    lesson_date: date
    start_time: time
    end_time: time
    status: str
    topic: str | None


class GenerateIn(Model):
    date_from: date
    date_to: date


class GenerateOut(Out):
    created: int
    skipped_existing: int


_LESSON_SQL = (
    "SELECT l.public_id AS id, g.public_id AS group_id, g.name AS group_name, t.public_id AS teacher_id, t.full_name AS teacher_name,"
    " r.public_id AS room_id, l.lesson_date, l.start_time, l.end_time, l.status, l.topic "
    "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
    "LEFT JOIN teachers t ON t.org_id = l.org_id AND t.id = l.teacher_id "
    "LEFT JOIN rooms r ON r.org_id = l.org_id AND r.id = l.room_id"
)


async def _lesson_for(conn: Conn, p: Principal, lesson_public: uuid.UUID) -> dict[str, object]:
    """Load a lesson and enforce the teacher-only-own-lessons rule."""
    lid = await resolve(conn, "lessons", lesson_public, what="lesson")
    row = await fetch_one(
        conn,
        "SELECT l.id, l.group_id, l.teacher_id, l.lesson_date, l.status, g.teacher_id AS group_teacher_id "
        "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id WHERE l.id = %s",
        (lid,),
    )
    assert row is not None
    if p.role == "teacher":
        mine = await my_teacher_id(conn, p)
        if mine is None or mine not in (row["teacher_id"], row["group_teacher_id"]):
            raise Forbidden("Teachers can access only their own lessons")
    return row


@router.post("/lessons", response_model=LessonOut, status_code=201)
async def create_lesson(
    body: LessonIn, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> LessonOut:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", body.group_id, what="group")
        tid = await resolve_opt(conn, "teachers", body.teacher_id, what="teacher")
        if tid is None:
            g = await fetch_one(conn, "SELECT teacher_id FROM study_groups WHERE id = %s", (gid,))
            assert g is not None
            tid = g["teacher_id"]
        rid = await resolve_opt(conn, "rooms", body.room_id, what="room")
        row = await fetch_one(
            conn,
            "INSERT INTO lessons (org_id, group_id, teacher_id, room_id, lesson_date, start_time, end_time, topic) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, gid, tid, rid, body.lesson_date, body.start_time, body.end_time, body.topic),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_LESSON_SQL} WHERE l.id = %s", (row["id"],))
    assert out is not None
    return LessonOut.model_validate(out)


@router.get("/lessons", response_model=Page[LessonOut])
async def list_lessons(
    p: Annotated[Principal, Depends(require("academics:read"))],
    db: DB,
    pg: Paging,
    date_from: date,
    date_to: date,
    group_id: uuid.UUID | None = None,
    teacher_id: uuid.UUID | None = None,
    status: LessonStatus | None = None,
) -> Page[LessonOut]:
    if date_to < date_from or (date_to - date_from).days > 366:
        raise Unprocessable("date range must be 0-366 days")
    where: list[str] = ["l.lesson_date BETWEEN %s AND %s"]
    params: list[Any] = [date_from, date_to]
    if group_id:
        where.append("g.public_id = %s")
        params.append(group_id)
    if teacher_id:
        where.append("t.public_id = %s")
        params.append(teacher_id)
    if status:
        where.append("l.status = %s")
        params.append(status)
    async with db.tx(p.session()) as conn:
        if p.role == "teacher":
            where.append("(l.teacher_id = %s OR g.teacher_id = %s)")
            mine = await my_teacher_id(conn, p) or -1
            params += [mine, mine]
        rows = await fetch_all(
            conn,
            f"{_LESSON_SQL} WHERE {' AND '.join(where)} ORDER BY l.lesson_date, l.start_time, l.id LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, LessonOut)


@router.get("/lessons/{lesson_id}", response_model=LessonOut)
async def get_lesson(
    lesson_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:read"))], db: DB
) -> LessonOut:
    async with db.tx(p.session()) as conn:
        lesson = await _lesson_for(conn, p, lesson_id)
        out = await fetch_one(conn, f"{_LESSON_SQL} WHERE l.id = %s", (lesson["id"],))
    assert out is not None
    return LessonOut.model_validate(out)


@router.patch("/lessons/{lesson_id}", response_model=LessonOut)
async def patch_lesson(
    lesson_id: uuid.UUID,
    body: LessonPatch,
    p: Annotated[Principal, Depends(require("attendance:write"))],
    db: DB,
) -> LessonOut:
    changes = body.model_dump(exclude_unset=True)
    structural = changes.keys() & {"teacher_id", "room_id", "start_time", "end_time"}
    if structural and not p.can("academics:write"):
        raise Forbidden("Your role may only change a lesson's status and topic")
    async with db.tx(p.session()) as conn:
        lesson = await _lesson_for(conn, p, lesson_id)
        if "teacher_id" in changes:
            changes["teacher_id"] = await resolve_opt(conn, "teachers", changes["teacher_id"], what="teacher")
        if "room_id" in changes:
            changes["room_id"] = await resolve_opt(conn, "rooms", changes["room_id"], what="room")
        if changes.get("status") == "cancelled":
            n = await fetch_one(
                conn, "SELECT count(*) AS n FROM attendance WHERE lesson_id = %s", (lesson["id"],)
            )
            assert n is not None
            if n["n"]:
                raise Conflict("Lesson has attendance records; remove them before cancelling")
        await patch_row(conn, "lessons", int(str(lesson["id"])), changes)
        out = await fetch_one(conn, f"{_LESSON_SQL} WHERE l.id = %s", (lesson["id"],))
    assert out is not None
    return LessonOut.model_validate(out)


@router.post(
    "/groups/{group_id}/lessons/generate",
    response_model=GenerateOut,
    summary="Create lessons from the weekly schedule",
)
async def generate_lessons(
    group_id: uuid.UUID,
    body: GenerateIn,
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
) -> GenerateOut:
    if body.date_to < body.date_from:
        raise Unprocessable("date_to cannot be before date_from")
    if (body.date_to - body.date_from).days > MAX_GENERATE_DAYS:
        raise Unprocessable(f"range is limited to {MAX_GENERATE_DAYS} days")
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        g = await fetch_one(
            conn, "SELECT teacher_id, start_date, end_date FROM study_groups WHERE id = %s", (gid,)
        )
        assert g is not None
        slots = await fetch_all(
            conn,
            "SELECT weekday, start_time, end_time, room_id FROM group_schedules WHERE group_id = %s",
            (gid,),
        )
        if not slots:
            raise Unprocessable("The group has no weekly schedule")
        start = max(body.date_from, g["start_date"])
        end = min(body.date_to, g["end_date"]) if g["end_date"] else body.date_to
        created = skipped = 0
        day = start
        while day <= end:
            for s in slots:
                if s["weekday"] == day.isoweekday():
                    cur = await conn.execute(
                        "INSERT INTO lessons (org_id, group_id, teacher_id, room_id, lesson_date, start_time, end_time) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (group_id, lesson_date, start_time) DO NOTHING",
                        (p.org_id, gid, g["teacher_id"], s["room_id"], day, s["start_time"], s["end_time"]),
                    )
                    created += cur.rowcount
                    skipped += 1 - cur.rowcount
            day += timedelta(days=1)
    return GenerateOut(created=created, skipped_existing=skipped)


# ---- attendance ----------------------------------------------------------------------------------------------
class RosterEntry(Out):
    student_id: uuid.UUID
    student_name: str
    status: str | None
    minutes_late: int
    marked_at: datetime | None


class RosterOut(Out):
    lesson_id: uuid.UUID
    lesson_date: date
    lesson_status: str
    entries: list[RosterEntry]


class MarkIn(Model):
    student_id: uuid.UUID
    status: AttStatus
    minutes_late: Annotated[int, Field(ge=0, le=600)] = 0

    @model_validator(mode="after")
    def _late(self) -> MarkIn:
        if self.status != "late" and self.minutes_late:
            raise ValueError("minutes_late is only valid with status 'late'")
        return self


class AttendanceIn(Model):
    records: Annotated[list[MarkIn], Field(min_length=1, max_length=500)]


_ROSTER_SQL = (
    "SELECT s.id AS sid, s.public_id AS student_id, s.full_name AS student_name, a.status, COALESCE(a.minutes_late, 0) AS minutes_late, a.marked_at "
    "FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
    "LEFT JOIN attendance a ON a.org_id = e.org_id AND a.lesson_id = %(lesson)s AND a.student_id = e.student_id "
    "WHERE e.group_id = %(group)s AND e.started_on <= %(day)s AND (e.ended_on IS NULL OR e.ended_on >= %(day)s) "
    "AND e.status <> 'frozen' AND s.deleted_at IS NULL ORDER BY lower(s.full_name), s.id"
)


async def _roster(conn: Conn, lesson: dict[str, object]) -> list[dict[str, object]]:
    return await fetch_all(
        conn, _ROSTER_SQL, {"lesson": lesson["id"], "group": lesson["group_id"], "day": lesson["lesson_date"]}
    )


@router.get(
    "/lessons/{lesson_id}/attendance", response_model=RosterOut, summary="Roll-call sheet of a lesson"
)
async def get_roster(
    lesson_id: uuid.UUID, p: Annotated[Principal, Depends(require("attendance:read"))], db: DB
) -> RosterOut:
    async with db.tx(p.session()) as conn:
        lesson = await _lesson_for(conn, p, lesson_id)
        rows = await _roster(conn, lesson)
    return RosterOut(
        lesson_id=lesson_id,
        lesson_date=lesson["lesson_date"],
        lesson_status=str(lesson["status"]),
        entries=[RosterEntry.model_validate(r) for r in rows],
    )


@router.put("/lessons/{lesson_id}/attendance", response_model=RosterOut, summary="Save roll call (upsert)")
async def put_attendance(
    lesson_id: uuid.UUID,
    body: AttendanceIn,
    p: Annotated[Principal, Depends(require("attendance:write"))],
    db: DB,
) -> RosterOut:
    async with db.tx(p.session()) as conn:
        lesson = await _lesson_for(conn, p, lesson_id)
        if lesson["status"] == "cancelled":
            raise Conflict("Lesson is cancelled")
        roster = {r["student_id"]: r["sid"] for r in await _roster(conn, lesson)}
        seen: set[uuid.UUID] = set()
        for rec in body.records:
            if rec.student_id in seen:
                raise Unprocessable("A student appears twice in the request")
            seen.add(rec.student_id)
            if rec.student_id not in roster:
                raise Unprocessable(
                    "Student is not in this lesson's roster", details={"student_id": str(rec.student_id)}
                )
        for rec in body.records:
            await execute(
                conn,
                "INSERT INTO attendance (org_id, lesson_id, student_id, status, minutes_late, marked_by_user_id) "
                "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (lesson_id, student_id) DO UPDATE "
                "SET status = EXCLUDED.status, minutes_late = EXCLUDED.minutes_late, "
                "marked_by_user_id = EXCLUDED.marked_by_user_id, marked_at = now()",
                (p.org_id, lesson["id"], roster[rec.student_id], rec.status, rec.minutes_late, p.user_id),
            )
        if lesson["status"] == "planned":
            await execute(conn, "UPDATE lessons SET status = 'held' WHERE id = %s", (lesson["id"],))
            lesson["status"] = "held"
        rows = await _roster(conn, lesson)
    return RosterOut(
        lesson_id=lesson_id,
        lesson_date=lesson["lesson_date"],
        lesson_status=str(lesson["status"]),
        entries=[RosterEntry.model_validate(r) for r in rows],
    )


@router.delete(
    "/lessons/{lesson_id}/attendance/{student_id}",
    response_model=Message,
    summary="Remove one attendance mark",
)
async def delete_mark(
    lesson_id: uuid.UUID,
    student_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("attendance:write"))],
    db: DB,
) -> Message:
    async with db.tx(p.session()) as conn:
        lesson = await _lesson_for(conn, p, lesson_id)
        sid = await resolve(conn, "students", student_id, what="student")
        n = await execute(
            conn, "DELETE FROM attendance WHERE lesson_id = %s AND student_id = %s", (lesson["id"], sid)
        )
        if n == 0:
            raise NotFound("no mark for this student")
    return Message(message="mark removed")


class MonthCell(Out):
    student_id: uuid.UUID
    lesson_id: uuid.UUID
    status: str


class MonthStudent(Out):
    student_id: uuid.UUID
    student_name: str
    present: int
    late: int
    absent: int
    excused: int


class MonthReport(Out):
    group_id: uuid.UUID
    month: date
    lessons: list[LessonOut]
    students: list[MonthStudent]
    cells: list[MonthCell]


@router.get(
    "/groups/{group_id}/attendance",
    response_model=MonthReport,
    summary="Attendance matrix of a group for a month",
)
async def group_month(
    group_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("attendance:read"))],
    db: DB,
    month: Annotated[date, Query(description="any date in the month")],
) -> MonthReport:
    first = month.replace(day=1)
    nxt = (first + timedelta(days=32)).replace(day=1)
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        await assert_group_access(conn, p, gid)
        lessons = await fetch_all(
            conn,
            f"{_LESSON_SQL} WHERE l.group_id = %s AND l.lesson_date >= %s AND l.lesson_date < %s ORDER BY l.lesson_date, l.start_time",
            (gid, first, nxt),
        )
        cells = await fetch_all(
            conn,
            "SELECT s.public_id AS student_id, l.public_id AS lesson_id, a.status FROM attendance a "
            "JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id JOIN students s ON s.org_id = a.org_id AND s.id = a.student_id "
            "WHERE l.group_id = %s AND l.lesson_date >= %s AND l.lesson_date < %s",
            (gid, first, nxt),
        )
        studs = await fetch_all(
            conn,
            "SELECT s.public_id AS student_id, s.full_name AS student_name,"
            " count(*) FILTER (WHERE a.status = 'present') AS present, count(*) FILTER (WHERE a.status = 'late') AS late,"
            " count(*) FILTER (WHERE a.status = 'absent') AS absent, count(*) FILTER (WHERE a.status = 'excused') AS excused "
            "FROM students s JOIN enrollments e ON e.org_id = s.org_id AND e.student_id = s.id AND e.group_id = %(g)s "
            "LEFT JOIN (SELECT a.* FROM attendance a JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id "
            "           WHERE l.group_id = %(g)s AND l.lesson_date >= %(f)s AND l.lesson_date < %(n)s) a "
            "ON a.org_id = s.org_id AND a.student_id = s.id "
            "WHERE s.deleted_at IS NULL AND e.started_on < %(n)s AND (e.ended_on IS NULL OR e.ended_on >= %(f)s) "
            "GROUP BY s.id ORDER BY lower(s.full_name), s.id",
            {"g": gid, "f": first, "n": nxt},
        )
    return MonthReport(
        group_id=group_id,
        month=first,
        lessons=[LessonOut.model_validate(r) for r in lessons],
        students=[MonthStudent.model_validate(r) for r in studs],
        cells=[MonthCell.model_validate(r) for r in cells],
    )


class AbsenceRow(Out):
    student_id: uuid.UUID
    student_name: str
    absences: int
    lates: int


@router.get("/reports/absences", response_model=list[AbsenceRow], summary="Students with many absences")
async def absence_report(
    p: Annotated[Principal, Depends(require("attendance:read", "students:read"))],
    db: DB,
    date_from: date,
    date_to: date,
    min_absences: Annotated[int, Query(ge=1, le=1000)] = 3,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[AbsenceRow]:
    if date_to < date_from or (date_to - date_from).days > 366:
        raise Unprocessable("date range must be 0-366 days")
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            "SELECT s.public_id AS student_id, s.full_name AS student_name,"
            " count(*) FILTER (WHERE a.status = 'absent') AS absences, count(*) FILTER (WHERE a.status = 'late') AS lates "
            "FROM attendance a JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id "
            "JOIN students s ON s.org_id = a.org_id AND s.id = a.student_id "
            "WHERE l.lesson_date BETWEEN %s AND %s AND s.deleted_at IS NULL GROUP BY s.id "
            "HAVING count(*) FILTER (WHERE a.status = 'absent') >= %s ORDER BY absences DESC, lower(s.full_name) LIMIT %s",
            (date_from, date_to, min_absences, limit),
        )
    return [AbsenceRow.model_validate(r) for r in rows]
