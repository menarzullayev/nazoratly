"""Admission lifecycle rules. Pure functions, mirrored in TypeScript (sheets/src/domain/lifecycle.ts); both are checked
against the same cases in tests/golden/lifecycle.json."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

TrialState = Literal["running", "decision_needed"]
FirstMonthMode = Literal["full", "prorated", "free_until_next"]


def trial_status(
    *, started_on: date, today: date, lessons_attended: int, free_lessons: int, free_days: int
) -> TrialState:
    """A trial needs a decision once the free lessons are used up OR the free days have passed, whichever is first.

    Reaching the limit never accepts, drops or bills anything: it only asks the owner to decide.
    """
    days = (today - started_on).days
    if lessons_attended >= free_lessons or days >= free_days:
        return "decision_needed"
    return "running"


@dataclass(frozen=True)
class FirstMonth:
    amount: Decimal
    fallback_to_full: bool


_WHOLE = Decimal(1)


def first_month_charge(
    *, mode: FirstMonthMode, monthly_fee: Decimal, accepted_on: date, lesson_dates: list[date]
) -> FirstMonth:
    """Amount of the first tuition charge for the month in which a trial is accepted.

    `lesson_dates` are all lessons of that month. `prorated` charges the share of lessons on or after `accepted_on`,
    rounded half up to a whole so'm; a month with no lessons at all falls back to the full fee and says so.
    """
    if mode == "free_until_next":
        return FirstMonth(Decimal(0), False)
    full = monthly_fee.quantize(_WHOLE, rounding=ROUND_HALF_UP)
    if mode == "full":
        return FirstMonth(full, False)
    total = len(lesson_dates)
    if total == 0:
        return FirstMonth(full, True)
    remaining = sum(1 for d in lesson_dates if d >= accepted_on)
    return FirstMonth((monthly_fee * remaining / total).quantize(_WHOLE, rounding=ROUND_HALF_UP), False)
