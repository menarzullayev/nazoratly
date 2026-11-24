"""Schedule rules: time overlap, room/teacher conflicts, room capacity fit, who teaches (substitute), the payroll effect
of cancelling/moving/substituting a lesson, guardian message drafts, and the weekly schedule text of the Sheets edition.
Pure functions, mirrored in TypeScript (sheets/src/domain/schedule.ts); both are checked against the same cases in
tests/golden/schedule.json. Times are "HH:MM" strings, dates ISO "YYYY-MM-DD"."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

DEFAULT_LESSON_MINUTES = 90
WEEKDAY_TOKENS = {"du": 1, "se": 2, "chor": 3, "pay": 4, "ju": 5, "sha": 6, "yak": 7}


def to_minutes(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def from_minutes(n: int) -> str:
    return f"{n // 60:02d}:{n % 60:02d}"


def overlaps(a_start: str, a_end: str, b_start: str, b_end: str) -> bool:
    """Intervals that only touch (one ends when the other starts) do not overlap."""
    return to_minutes(a_start) < to_minutes(b_end) and to_minutes(b_start) < to_minutes(a_end)


@dataclass(frozen=True)
class Slot:
    id: str
    date: str
    start: str
    end: str
    room: str | None
    teacher: str | None  # the EFFECTIVE teacher (see effective_teacher)
    cancelled: bool = False


@dataclass(frozen=True)
class Conflict:
    kind: str  # "room" | "teacher"
    other_id: str


def find_conflicts(candidate: Slot, others: list[Slot]) -> list[Conflict]:
    """Clashes of `candidate` with `others` on the same date. Cancelled lessons never clash; the candidate itself
    (same id) is ignored, so a lesson can be re-saved. Sorted by kind, then other id."""
    if candidate.cancelled:
        return []
    found: set[tuple[str, str]] = set()
    for o in others:
        if o.cancelled or o.id == candidate.id or o.date != candidate.date:
            continue
        if not overlaps(candidate.start, candidate.end, o.start, o.end):
            continue
        if candidate.room is not None and candidate.room == o.room:
            found.add(("room", o.id))
        if candidate.teacher is not None and candidate.teacher == o.teacher:
            found.add(("teacher", o.id))
    return [Conflict(k, i) for k, i in sorted(found)]


def capacity_check(*, group_capacity: int | None, enrolled: int, room_capacity: int | None) -> str:
    """`ok`, `group_capacity_over_room` (the group allows more students than the room holds) or `enrolled_over_room`
    (a group without a limit already has more students than the room holds). Unknown room size is never a problem."""
    if room_capacity is None:
        return "ok"
    if group_capacity is not None:
        return "group_capacity_over_room" if group_capacity > room_capacity else "ok"
    return "enrolled_over_room" if enrolled > room_capacity else "ok"


def effective_teacher(*, group: str | None, lesson: str | None, substitute: str | None) -> str | None:
    """Who actually teaches: the substitute, else the teacher set on the lesson, else the group's teacher."""
    return substitute or lesson or group


def lesson_pay(pay_model: str, pay_rate: Decimal) -> Decimal:
    """What ONE lesson changes in a teacher's pay: only per-lesson teachers are paid by the lesson."""
    return pay_rate if pay_model == "per_lesson" and pay_rate > 0 else Decimal(0)


@dataclass(frozen=True)
class TeacherPay:
    id: str
    pay_model: str
    pay_rate: Decimal


@dataclass(frozen=True)
class PayEffect:
    teacher: str
    month: str  # YYYY-MM
    delta: Decimal


def payroll_effect(
    *,
    kind: str,
    old_date: str,
    new_date: str | None,
    teacher: TeacherPay | None,
    substitute: TeacherPay | None = None,
) -> list[PayEffect]:
    """Change of per-lesson pay caused by a change of ONE planned lesson, per teacher and month.
    cancel: `teacher` loses the lesson. substitute: `teacher` loses it, `substitute` gains it (same month).
    move: the lesson leaves its month and enters the new one (zero net effect inside one month)."""
    effects: dict[tuple[str, str], Decimal] = {}

    def add(t: TeacherPay | None, month: str, amount: Decimal) -> None:
        if t is None or amount == 0:
            return
        effects[(t.id, month)] = effects.get((t.id, month), Decimal(0)) + amount

    old_month = old_date[:7]
    if kind == "cancel":
        add(teacher, old_month, -lesson_pay(teacher.pay_model, teacher.pay_rate) if teacher else Decimal(0))
    elif kind == "substitute":
        if teacher is not None:
            add(teacher, old_month, -lesson_pay(teacher.pay_model, teacher.pay_rate))
        if substitute is not None:
            add(substitute, old_month, lesson_pay(substitute.pay_model, substitute.pay_rate))
    elif kind == "move":
        if new_date is not None and teacher is not None and new_date[:7] != old_month:
            pay = lesson_pay(teacher.pay_model, teacher.pay_rate)
            add(teacher, old_month, -pay)
            add(teacher, new_date[:7], pay)
    else:
        raise ValueError(f"unknown change kind: {kind}")
    return [PayEffect(t, m, d) for (t, m), d in sorted(effects.items()) if d != 0]


def _uz_date(iso: str) -> str:
    return f"{iso[8:10]}.{iso[5:7]}.{iso[0:4]}"


def change_message(
    *,
    kind: str,
    guardian: str,
    student: str,
    group: str,
    old_date: str,
    old_start: str,
    new_date: str | None,
    new_start: str | None,
    reason: str | None,
    center: str,
) -> str:
    """Guardian message DRAFT for a cancelled or moved lesson (a person approves it before anything is sent)."""
    why = f" Sabab: {reason.strip().rstrip('.')}." if reason and reason.strip() else ""
    old = f"{_uz_date(old_date)} {old_start}"
    if kind == "cancel":
        return (
            f"Assalomu alaykum, {guardian}! {student} o'qiydigan {group} guruhining {old} dagi darsi bekor "
            f"qilindi.{why} Keyingi dars jadval bo'yicha o'tadi. {center}"
        )
    if kind == "move" and new_date is not None and new_start is not None:
        return (
            f"Assalomu alaykum, {guardian}! {student} o'qiydigan {group} guruhining {old} dagi darsi "
            f"ko'chirildi: yangi vaqt {_uz_date(new_date)} {new_start}.{why} {center}"
        )
    raise ValueError(f"no guardian message for change kind: {kind}")


@dataclass(frozen=True)
class WeeklySlot:
    weekday: int  # 1 = Monday
    start: str
    end: str


def parse_schedule(text: str) -> list[WeeklySlot] | None:
    """`Du-Chor-Ju 18:00` or `Se, Pay 17:30-19:00` -> weekly slots; a missing end time means 90 minutes. None when the
    text is not a valid schedule (unknown day, bad time, end before start, no day)."""
    m = re.fullmatch(r"\s*(.+?)\s+(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?\s*", text or "")
    if not m:
        return None
    days: list[int] = []
    for tok in re.split(r"[-,/\s]+", m.group(1).strip().lower()):
        if not tok:
            continue
        wd = WEEKDAY_TOKENS.get(tok)
        if wd is None:
            return None
        if wd not in days:
            days.append(wd)
    if not days:
        return None
    try:
        start_min = to_minutes(m.group(2))
        end_min = to_minutes(m.group(3)) if m.group(3) else start_min + DEFAULT_LESSON_MINUTES
    except ValueError:
        return None
    if start_min >= 24 * 60 or end_min > 24 * 60 or end_min <= start_min:
        return None
    if int(m.group(2).split(":")[1]) > 59 or (m.group(3) and int(m.group(3).split(":")[1]) > 59):
        return None
    return [WeeklySlot(d, from_minutes(start_min), from_minutes(end_min)) for d in sorted(days)]


def week_range(day: str) -> tuple[str, str]:
    """Monday and Sunday of the week that contains `day`."""
    d = date.fromisoformat(day)
    monday = d - timedelta(days=d.isoweekday() - 1)
    return monday.isoformat(), (monday + timedelta(days=6)).isoformat()
