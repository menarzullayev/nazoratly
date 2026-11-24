"""Schedule checks shared by the lesson, group-schedule and calendar endpoints: room/teacher conflicts (rules in
nazoratly.rules.schedule, shared with the Sheets edition), who teaches a lesson, and the lesson-in-payroll guard."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, time
from decimal import Decimal
from typing import Any

from nazoratly.db import Conn, fetch_all, fetch_one
from nazoratly.errors import Conflict
from nazoratly.rules import schedule as R

# l = lessons, g = study_groups: the teacher who actually teaches (substitute > lesson teacher > group teacher)
EFFECTIVE_TEACHER_SQL = "COALESCE(l.substitute_teacher_id, l.teacher_id, g.teacher_id)"
NEW_LESSON_ID = "new"


class ScheduleConflict(Conflict):
    code = "schedule_conflict"


def hhmm(t: time) -> str:
    return t.strftime("%H:%M")


def parse_hhmm(s: str) -> time:
    return time.fromisoformat(s)


def slot_of(row: dict[str, Any]) -> R.Slot:
    """A rules Slot from a row with id, lesson_date, start_time, end_time, room_id, teacher_id, status."""
    return R.Slot(
        id=str(row["id"]),
        date=row["lesson_date"].isoformat(),
        start=hhmm(row["start_time"]),
        end=hhmm(row["end_time"]),
        room=None if row["room_id"] is None else str(row["room_id"]),
        teacher=None if row["teacher_id"] is None else str(row["teacher_id"]),
        cancelled=row["status"] == "cancelled",
    )


async def lesson_slots(conn: Conn, date_from: date, date_to: date) -> list[dict[str, Any]]:
    """Every lesson of the center in the range, with its effective teacher (RLS limits the rows to the center)."""
    return await fetch_all(
        conn,
        f"SELECT l.id, l.lesson_date, l.start_time, l.end_time, l.room_id, {EFFECTIVE_TEACHER_SQL} AS teacher_id, l.status "
        "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
        "WHERE l.lesson_date BETWEEN %s AND %s AND g.deleted_at IS NULL",
        (date_from, date_to),
    )


def conflicts_by_lesson(rows: list[dict[str, Any]]) -> dict[str, list[R.Conflict]]:
    """Clashes of every lesson in `rows` with the others of the same date, keyed by lesson id (as text)."""
    slots = [slot_of(r) for r in rows]
    by_date: dict[str, list[R.Slot]] = {}
    for sl in slots:
        by_date.setdefault(sl.date, []).append(sl)
    out: dict[str, list[R.Conflict]] = {}
    for sl in slots:
        found = R.find_conflicts(sl, by_date[sl.date])
        if found:
            out[sl.id] = found
    return out


async def lesson_conflicts(
    conn: Conn,
    *,
    lesson_id: int | None,
    day: date,
    start: time,
    end: time,
    room_id: int | None,
    teacher_id: int | None,
) -> list[R.Conflict]:
    others = [slot_of(r) for r in await lesson_slots(conn, day, day)]
    candidate = R.Slot(
        id=NEW_LESSON_ID if lesson_id is None else str(lesson_id),
        date=day.isoformat(),
        start=hhmm(start),
        end=hhmm(end),
        room=None if room_id is None else str(room_id),
        teacher=None if teacher_id is None else str(teacher_id),
    )
    return R.find_conflicts(candidate, others)


async def explain(conn: Conn, conflicts: list[R.Conflict]) -> list[dict[str, Any]]:
    """Human-readable details of the lessons a candidate clashes with."""
    if not conflicts:
        return []
    rows = await fetch_all(
        conn,
        "SELECT l.id, l.public_id, l.lesson_date, l.start_time, l.end_time, g.name AS group_name, r.name AS room_name, "
        "t.full_name AS teacher_name "
        "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
        "LEFT JOIN rooms r ON r.org_id = l.org_id AND r.id = l.room_id "
        f"LEFT JOIN teachers t ON t.org_id = l.org_id AND t.id = {EFFECTIVE_TEACHER_SQL} "
        "WHERE l.id = ANY(%s)",
        ([int(c.other_id) for c in conflicts],),
    )
    by_id = {str(r["id"]): r for r in rows}
    out: list[dict[str, Any]] = []
    for c in conflicts:
        r = by_id.get(c.other_id)
        if r is None:
            continue
        out.append(
            {
                "kind": c.kind,
                "lesson_id": str(r["public_id"]),
                "group": r["group_name"],
                "date": r["lesson_date"].isoformat(),
                "start_time": hhmm(r["start_time"]),
                "end_time": hhmm(r["end_time"]),
                "room": r["room_name"],
                "teacher": r["teacher_name"],
            }
        )
    return out


async def ensure_no_conflict(
    conn: Conn,
    *,
    lesson_id: int | None,
    day: date,
    start: time,
    end: time,
    room_id: int | None,
    teacher_id: int | None,
    allow: bool,
) -> list[dict[str, Any]]:
    """Raise 409 `schedule_conflict` when the lesson clashes, unless the caller allows it. Returns the (allowed) clashes."""
    found = await lesson_conflicts(
        conn, lesson_id=lesson_id, day=day, start=start, end=end, room_id=room_id, teacher_id=teacher_id
    )
    details = await explain(conn, found)
    if details and not allow:
        kinds = " and ".join(sorted({d["kind"] for d in details}))
        raise ScheduleConflict(
            f"The {kinds} is already busy at this time (pass allow_conflict=true to save anyway)",
            details={"conflicts": details},
        )
    return details


async def lesson_in_frozen_payroll(conn: Conn, lesson_id: int) -> bool:
    row = await fetch_one(
        conn,
        "SELECT 1 AS x FROM payroll_items pi JOIN teacher_payrolls tp ON tp.org_id = pi.org_id AND tp.id = pi.payroll_id "
        "WHERE pi.lesson_id = %s AND tp.status <> 'draft' LIMIT 1",
        (lesson_id,),
    )
    return row is not None


async def drop_draft_payroll_lines(conn: Conn, lesson_id: int) -> int:
    """A changed lesson's generated line leaves every DRAFT payroll; regenerating the payroll adds it back for whoever
    now earns it (the substitute, or the new month)."""
    cur = await conn.execute(
        "DELETE FROM payroll_items pi USING teacher_payrolls tp "
        "WHERE pi.lesson_id = %s AND pi.kind = 'lesson' AND tp.org_id = pi.org_id AND tp.id = pi.payroll_id AND tp.status = 'draft'",
        (lesson_id,),
    )
    return cur.rowcount


@dataclass(frozen=True)
class TeacherRow:
    id: int
    public_id: Any
    name: str
    pay: R.TeacherPay


async def teacher_pay(conn: Conn, teacher_id: int | None) -> TeacherRow | None:
    if teacher_id is None:
        return None
    row = await fetch_one(
        conn,
        "SELECT id, public_id, full_name, pay_model, pay_rate FROM teachers WHERE id = %s",
        (teacher_id,),
    )
    if row is None:
        return None
    return TeacherRow(
        id=int(row["id"]),
        public_id=row["public_id"],
        name=str(row["full_name"]),
        pay=R.TeacherPay(str(row["public_id"]), str(row["pay_model"]), Decimal(row["pay_rate"])),
    )


# ---- weekly template (group_schedules) ---------------------------------------------------------------------------
@dataclass(frozen=True)
class WeeklyCheck:
    conflicts: list[dict[str, Any]]
    capacity: list[dict[str, Any]]


async def weekly_check(
    conn: Conn,
    *,
    group_id: int,
    teacher_id: int | None,
    slots: list[tuple[int, time, time, int | None]],
) -> WeeklyCheck:
    """Clashes of a group's weekly slots with the weekly slots of every OTHER live group (same weekday, overlapping time,
    same room or same group teacher) and the room-capacity warnings of the slots' rooms."""
    others = await fetch_all(
        conn,
        "SELECT gs.id, gs.weekday, gs.start_time, gs.end_time, gs.room_id, g.teacher_id, g.name AS group_name, r.name AS room_name "
        "FROM group_schedules gs JOIN study_groups g ON g.org_id = gs.org_id AND g.id = gs.group_id "
        "LEFT JOIN rooms r ON r.org_id = gs.org_id AND r.id = gs.room_id "
        "WHERE gs.group_id <> %s AND g.deleted_at IS NULL AND g.status IN ('planned', 'active')",
        (group_id,),
    )
    other_slots = [
        R.Slot(
            id=str(o["id"]),
            date=str(o["weekday"]),
            start=hhmm(o["start_time"]),
            end=hhmm(o["end_time"]),
            room=None if o["room_id"] is None else str(o["room_id"]),
            teacher=None if o["teacher_id"] is None else str(o["teacher_id"]),
        )
        for o in others
    ]
    meta = {str(o["id"]): o for o in others}
    names = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}
    conflicts: list[dict[str, Any]] = []
    for i, (weekday, start, end, room_id) in enumerate(slots):
        cand = R.Slot(
            id=f"mine-{i}",
            date=str(weekday),
            start=hhmm(start),
            end=hhmm(end),
            room=None if room_id is None else str(room_id),
            teacher=None if teacher_id is None else str(teacher_id),
        )
        for c in R.find_conflicts(cand, other_slots):
            o = meta[c.other_id]
            conflicts.append(
                {
                    "kind": c.kind,
                    "weekday": names[weekday],
                    "start_time": hhmm(start),
                    "end_time": hhmm(end),
                    "group": o["group_name"],
                    "other_start_time": hhmm(o["start_time"]),
                    "other_end_time": hhmm(o["end_time"]),
                    "room": o["room_name"],
                }
            )
    capacity: list[dict[str, Any]] = []
    room_ids = sorted({r for *_, r in slots if r is not None})
    if room_ids:
        g = await fetch_one(
            conn,
            "SELECT capacity, (SELECT count(*) FROM enrollments e WHERE e.group_id = study_groups.id AND e.status IN ('trial','active')) AS enrolled "
            "FROM study_groups WHERE id = %s",
            (group_id,),
        )
        assert g is not None
        for r in await fetch_all(
            conn,
            "SELECT id, public_id, name, capacity FROM rooms WHERE id = ANY(%s) ORDER BY name",
            (room_ids,),
        ):
            verdict = R.capacity_check(
                group_capacity=g["capacity"], enrolled=int(g["enrolled"]), room_capacity=r["capacity"]
            )
            if verdict != "ok":
                capacity.append(
                    {
                        "problem": verdict,
                        "room_id": str(r["public_id"]),
                        "room": r["name"],
                        "room_capacity": r["capacity"],
                        "group_capacity": g["capacity"],
                        "enrolled": int(g["enrolled"]),
                    }
                )
    return WeeklyCheck(conflicts=conflicts, capacity=capacity)
