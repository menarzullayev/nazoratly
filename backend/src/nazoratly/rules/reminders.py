"""Debt reminder drafts. Pure functions, mirrored in TypeScript (sheets/src/domain/reminders.ts: `planReminders` and
`planUpcomingReminders`); both are checked against the same cases in tests/golden/reminders.json.

Nothing is sent from here: a person reads each draft and approves it. A student is skipped without a notifications
consent or a linked Telegram chat, after leaving or pausing, below the debt threshold, or when a reminder was already
made within the cooldown."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Final, Literal

DEFAULT_TEMPLATE: Final = (
    "Assalomu alaykum, {guardian}! {student} uchun {amount} so'm to'lov muddati {days} kun oldin o'tgan. "
    "Iltimos, to'lovni amalga oshiring. Savollar bo'lsa, markazga murojaat qiling. {center}"
)
INSTALLMENT_TEMPLATE: Final = (
    "Assalomu alaykum, {guardian}! {student} uchun {installment}-to'lov ({amount} so'm) muddati {due} edi "
    "({days} kun o'tdi). Jami muddati o'tgan qarz: {total} so'm. Iltimos, to'lovni amalga oshiring. "
    "Savollar bo'lsa, markazga murojaat qiling. {center}"
)
UPCOMING_TEMPLATE: Final = (
    "Assalomu alaykum, {guardian}! {student} uchun {installment}-to'lov ({amount} so'm) muddati {due} ({left}). "
    "Iltimos, to'lovni o'z vaqtida amalga oshiring. Savollar bo'lsa, markazga murojaat qiling. {center}"
)

Kind = Literal["overdue", "upcoming"]
SkipReason = Literal[
    "no_consent", "no_chat", "cooldown", "below_threshold", "student_inactive", "already_overdue"
]
_PLACEHOLDER = re.compile(r"\{(\w+)\}", re.ASCII)


@dataclass(frozen=True)
class InstallmentRef:
    seq: int
    count: int
    due_date: date
    outstanding: Decimal


@dataclass(frozen=True)
class StudentFacts:
    id: str
    name: str
    status: str
    guardian_name: str | None
    has_chat: bool
    consent: bool
    last_reminded_on: date | None


@dataclass(frozen=True)
class DebtFacts:
    student_id: str
    overdue: Decimal
    max_days_overdue: int
    overdue_installment: InstallmentRef | None = None  # set when the oldest debt is an installment of a plan
    next_installment: InstallmentRef | None = None  # the earliest open installment not yet past due


@dataclass(frozen=True)
class Draft:
    student_id: str
    kind: Kind
    text: str


@dataclass(frozen=True)
class Skip:
    student_id: str
    reason: SkipReason


def format_dmy(day: date) -> str:
    return f"{day.day:02d}.{day.month:02d}.{day.year:04d}"


def format_som(amount: Decimal) -> str:
    return f"{int(amount.quantize(Decimal(1), rounding=ROUND_HALF_UP)):,}".replace(",", " ")


def render(template: str, values: Mapping[str, str]) -> str:
    return _PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), template)


def _inactive(student: StudentFacts | None) -> bool:
    return student is None or student.status in ("left", "paused")


def _blocked(student: StudentFacts, today: date, cooldown_days: int) -> SkipReason | None:
    if not student.consent:
        return "no_consent"
    if not student.has_chat:
        return "no_chat"
    last = student.last_reminded_on
    return "cooldown" if last is not None and (today - last).days < cooldown_days else None


def plan(
    *,
    debts: list[DebtFacts],
    students: Mapping[str, StudentFacts],
    today: date,
    cooldown_days: int,
    min_overdue: Decimal,
    remind_days: int,
    template: str,
    center: str,
) -> tuple[list[Draft], list[Skip]]:
    """Overdue reminders first (debtors in the given order), then reminders ahead of an installment that is due within
    `remind_days` days (0 = off). A student drafted for the overdue debt gets no second draft."""
    drafts: list[Draft] = []
    skipped: list[Skip] = []
    for debt in debts:
        if debt.overdue <= 0 or debt.max_days_overdue < 1:
            continue
        student = students.get(debt.student_id)
        if student is None or _inactive(student):
            skipped.append(Skip(debt.student_id, "student_inactive"))
            continue
        if debt.overdue < min_overdue:
            skipped.append(Skip(debt.student_id, "below_threshold"))
            continue
        reason = _blocked(student, today, cooldown_days)
        if reason is not None:
            skipped.append(Skip(debt.student_id, reason))
            continue
        ref = debt.overdue_installment
        text = render(
            INSTALLMENT_TEMPLATE if ref else template,
            {
                "guardian": student.guardian_name or "ota-ona",
                "student": student.name,
                "amount": format_som(ref.outstanding if ref else debt.overdue),
                "total": format_som(debt.overdue),
                "days": str(debt.max_days_overdue),
                "installment": f"{ref.seq}/{ref.count}" if ref else "",
                "due": format_dmy(ref.due_date) if ref else "",
                "center": center,
            },
        )
        drafts.append(Draft(student.id, "overdue", text))

    if remind_days <= 0:
        return drafts, skipped
    drafted = {d.student_id for d in drafts}
    for debt in debts:
        ref = debt.next_installment
        if ref is None:
            continue
        left = (ref.due_date - today).days
        if left < 0 or left > remind_days or debt.student_id in drafted:
            continue
        student = students.get(debt.student_id)
        if student is None or _inactive(student):
            skipped.append(Skip(debt.student_id, "student_inactive"))
            continue
        reason = "already_overdue" if debt.overdue > 0 else _blocked(student, today, cooldown_days)
        if reason is not None:
            skipped.append(Skip(debt.student_id, reason))
            continue
        text = render(
            UPCOMING_TEMPLATE,
            {
                "guardian": student.guardian_name or "ota-ona",
                "student": student.name,
                "amount": format_som(ref.outstanding),
                "installment": f"{ref.seq}/{ref.count}",
                "due": format_dmy(ref.due_date),
                "left": "bugun" if left == 0 else f"{left} kun qoldi",
                "center": center,
            },
        )
        drafts.append(Draft(student.id, "upcoming", text))
    return drafts, skipped
