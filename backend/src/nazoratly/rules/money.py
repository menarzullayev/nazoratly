"""Money rules of group G1: lasting discounts, early-payment discount, refunds and the daily cash close. Pure
functions, mirrored in TypeScript (sheets/src/domain/money.ts); both are checked against tests/golden/money.json.

Amounts are whole so'm (`Decimal` with no fraction after rounding); every rounding is half up to a whole so'm.
There is deliberately NO late-payment penalty anywhere in the product: overdue money only triggers reminders."""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Literal

from nazoratly.rules.packages import lessons_money

ZERO = Decimal(0)
_WHOLE = Decimal(1)
_HUNDRED = Decimal(100)

DiscountKind = Literal["scholarship", "family", "individual"]
LASTING_ORDER: tuple[str, ...] = ("scholarship", "family", "individual")


def round_som(value: Decimal) -> Decimal:
    return value.quantize(_WHOLE, rounding=ROUND_HALF_UP)


# ---- lasting discounts ---------------------------------------------------------------------------------------------
def family_percent(*, rank: int, second: Decimal, third: Decimal) -> Decimal:
    """Percent for the child of a family at `rank` (1 = first billable child, by registration order): the first child
    pays the full price, the second gets `second`, the third and later get `third`."""
    if rank <= 1:
        return ZERO
    return second if rank == 2 else third


@dataclass(frozen=True)
class DiscountInput:
    kind: str
    percent: Decimal | None = None
    amount: Decimal | None = None


@dataclass(frozen=True)
class DiscountLine:
    index: int  # position of the rule in the input list
    kind: str
    amount: Decimal


@dataclass(frozen=True)
class DiscountResult:
    lines: list[DiscountLine]
    net: Decimal


def lasting_discounts(*, base: Decimal, discounts: list[DiscountInput]) -> DiscountResult:
    """Applies the lasting discounts to the base fee. Order: scholarship, family, individual (input order inside a
    kind). A percent is taken of the BASE, an amount is fixed; the running total is capped so the net never goes below
    zero (a later discount is truncated, one that takes nothing writes no line)."""
    remaining = max(base, ZERO)
    lines: list[DiscountLine] = []
    order = sorted(range(len(discounts)), key=lambda i: (LASTING_ORDER.index(discounts[i].kind), i))
    for i in order:
        d = discounts[i]
        if d.percent is not None:
            raw = round_som(max(base, ZERO) * d.percent / _HUNDRED)
        else:
            raw = d.amount if d.amount is not None else ZERO
        take = min(raw, remaining)
        if take <= 0:
            continue
        remaining -= take
        lines.append(DiscountLine(i, d.kind, take))
    return DiscountResult(lines, remaining)


# ---- early payment ---------------------------------------------------------------------------------------------------
def early_discount(*, net: Decimal, percent: Decimal) -> Decimal:
    """The early-payment discount of a charge: never the whole price (at least one so'm stays to pay)."""
    if net <= 1 or percent <= 0:
        return ZERO
    return min(round_som(net * percent / _HUNDRED), net - 1)


def early_pay_by(month: date, day: int) -> date:
    return month.replace(day=day)


@dataclass(frozen=True)
class EarlyResult:
    granted: bool
    on_time: Decimal
    excess: Decimal


def early_granted(
    *, pay_by: date, payments: list[tuple[date, Decimal]], amount: Decimal, early: Decimal
) -> EarlyResult:
    """Is the early discount earned? Money paid on or before `pay_by` must cover the reduced price
    (`amount - early`). `excess` is what was paid beyond the reduced price (it goes back to the student's credit)."""
    on_time = sum((a for d, a in payments if d <= pay_by), ZERO)
    total = sum((a for _, a in payments), ZERO)
    target = amount - early
    granted = early > 0 and on_time >= target
    return EarlyResult(granted, on_time, max(total - target, ZERO) if granted else ZERO)


# ---- refunds -------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class LeavingSplit:
    used: Decimal
    reduction: Decimal
    refund: Decimal


def leaving_split(*, amount: Decimal, paid: Decimal, left_on: date, month: date) -> LeavingSplit:
    """A student leaves: the month is charged proportionally to the days attended (the leave day counts). `reduction` is
    how much the charge shrinks, `refund` the money that was paid beyond the used part."""
    first = month.replace(day=1)
    days = calendar.monthrange(first.year, first.month)[1]
    if left_on < first:
        used = ZERO
    elif left_on >= first.replace(day=days):
        used = amount
    else:
        used = round_som(amount * left_on.day / days)
    return LeavingSplit(used, amount - used, max(min(paid, amount) - used, ZERO))


def package_remainder(
    *, price: Decimal, package_lessons: int, remaining_lessons: int, paid: Decimal, keep_lessons: int = 0
) -> Decimal:
    """Money value of the unused lessons of a package, never more than was paid for it. `keep_lessons` are lessons that
    must stay covered after the refund (the consumed ones): the money left in the package must still buy them, so the
    refund is also capped at `paid - ceil(keep_lessons * price / package_lessons)`."""
    left = max(min(remaining_lessons, package_lessons), 0)
    if left == 0 or package_lessons <= 0:
        return ZERO
    value = min(lessons_money(lessons=left, price=price, package_lessons=package_lessons), max(paid, ZERO))
    if keep_lessons > 0:
        needed = (Decimal(keep_lessons) * price / package_lessons).to_integral_value(rounding=ROUND_CEILING)
        value = min(value, paid - needed)
    return max(value, ZERO)


RefundKind = Literal["wrong_payment", "leaving", "package_remainder", "to_credit"]
_PAYOUTS: dict[str, tuple[str, ...]] = {
    "wrong_payment": ("cash", "bank"),
    "leaving": ("cash", "bank", "credit"),
    "package_remainder": ("cash", "bank", "credit"),
    "to_credit": ("credit",),
}


def refund_errors(*, kind: str, payout: str, amount: Decimal, available: Decimal) -> list[str]:
    """Machine-readable problems of a refund request; empty when it can be made."""
    if kind not in _PAYOUTS:
        return ["bad_kind"]
    errors: list[str] = []
    if amount <= 0:
        errors.append("not_positive")
    if payout not in _PAYOUTS[kind]:
        errors.append("bad_payout")
    if amount > 0 and amount > available:
        errors.append("exceeds_available")
    return errors


# ---- daily cash close ----------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class CashDifference:
    difference: Decimal
    status: Literal["ok", "over", "short"]


def cash_difference(*, book: Decimal, counted: Decimal) -> CashDifference:
    diff = counted - book
    return CashDifference(diff, "ok" if diff == 0 else "over" if diff > 0 else "short")


def cash_close_errors(*, counted: Decimal, difference: Decimal, note: str) -> list[str]:
    errors: list[str] = []
    if counted < 0:
        errors.append("negative_counted")
    if difference != 0 and not note.strip():
        errors.append("note_required")
    return errors
