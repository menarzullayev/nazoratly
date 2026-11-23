"""Payment-plan (installment) rules. Pure functions, mirrored in TypeScript (sheets/src/domain/installments.ts); both
are checked against the same cases in tests/golden/installments.json."""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from itertools import pairwise
from typing import Literal

PlanError = Literal["count", "non_positive", "sum_mismatch", "dates_not_increasing"]
MIN_INSTALLMENTS = 2
MAX_INSTALLMENTS = 24
_ZERO = Decimal(0)


class PlanRuleError(ValueError):
    def __init__(self, code: PlanError) -> None:
        super().__init__(code)
        self.code: PlanError = code


@dataclass(frozen=True)
class Installment:
    amount: Decimal
    due_date: date


@dataclass(frozen=True)
class InstallmentBalance:
    amount: Decimal
    due_date: date
    paid: Decimal
    outstanding: Decimal
    overdue: bool


def _add_months(first: date, months: int) -> date:
    index = first.month - 1 + months
    year, month = first.year + index // 12, index % 12 + 1
    return date(year, month, min(first.day, calendar.monthrange(year, month)[1]))


def equal_installments(*, total: Decimal, count: int, first_due: date) -> list[Installment]:
    """Whole-so'm base amounts, the remainder goes to the last installment; monthly dates, day clamped to month end."""
    if not MIN_INSTALLMENTS <= count <= MAX_INSTALLMENTS:
        raise PlanRuleError("count")
    base = (total / count).to_integral_value(rounding="ROUND_FLOOR")
    if base < 1:
        raise PlanRuleError("non_positive")
    amounts = [base] * count
    amounts[-1] = total - base * (count - 1)
    return [Installment(a, _add_months(first_due, i)) for i, a in enumerate(amounts)]


def validate_plan(*, total: Decimal, installments: list[Installment]) -> PlanError | None:
    if not MIN_INSTALLMENTS <= len(installments) <= MAX_INSTALLMENTS:
        return "count"
    if any(i.amount <= 0 for i in installments):
        return "non_positive"
    if sum((i.amount for i in installments), _ZERO) != total:
        return "sum_mismatch"
    if any(b.due_date <= a.due_date for a, b in pairwise(installments)):
        return "dates_not_increasing"
    return None


def installment_balances(
    *, installments: list[Installment], paid: Decimal, today: date
) -> list[InstallmentBalance]:
    """The charge's allocated money is applied oldest installment first; the excess over the total is credit."""
    remaining = max(paid, _ZERO)
    rows: list[InstallmentBalance] = []
    for i in installments:
        applied = min(remaining, i.amount)
        remaining -= applied
        outstanding = i.amount - applied
        rows.append(
            InstallmentBalance(
                i.amount, i.due_date, applied, outstanding, outstanding > 0 and i.due_date < today
            )
        )
    return rows


def plan_overdue(rows: list[InstallmentBalance]) -> Decimal:
    return sum((r.outstanding for r in rows if r.overdue), _ZERO)


def next_open_due(rows: list[InstallmentBalance]) -> date | None:
    return next((r.due_date for r in rows if r.outstanding > 0), None)
