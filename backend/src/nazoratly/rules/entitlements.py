"""Excused-absence entitlement rules. Pure functions, mirrored in TypeScript (sheets/src/domain/entitlements.ts); both
are checked against the same cases in tests/golden/entitlements.json."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

Status = Literal["open", "scheduled", "used", "cancelled"]
EffectiveStatus = Literal["open", "scheduled", "used", "cancelled", "lapsed"]

_WHOLE = Decimal(1)


def entitlement_expires_on(missed_on: date, expiry_days: int) -> date:
    return missed_on + timedelta(days=expiry_days)


def entitlement_state(*, status: Status, expires_on: date, today: date, lapses: bool) -> EffectiveStatus:
    """Only an `open` right can lapse: the day after its expiry, and only when the center lets rights lapse."""
    if status == "open" and lapses and today > expires_on:
        return "lapsed"
    return status


def lesson_credit_amount(*, monthly_fee: Decimal, lessons_in_month: int) -> Decimal:
    """Money value of one lesson: the monthly fee split over the month's lessons, rounded half up to a whole so'm."""
    if lessons_in_month <= 0:
        return Decimal(0)
    return (monthly_fee / lessons_in_month).quantize(_WHOLE, rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class AppliedCredits:
    amount: Decimal
    used: int


def apply_credits(*, fee: Decimal, credits: list[Decimal]) -> AppliedCredits:
    """Subtract credits (oldest first) from a tuition fee. A credit is always consumed fully, even when it is larger
    than what is left of the fee (the excess is lost); consumption stops as soon as the amount reaches zero."""
    amount = max(fee, Decimal(0))
    used = 0
    for credit in credits:
        if amount <= 0:
            break
        amount = max(amount - credit, Decimal(0))
        used += 1
    return AppliedCredits(amount, used)
