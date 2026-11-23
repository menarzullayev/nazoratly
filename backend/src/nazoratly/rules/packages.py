"""Lesson package rules (abonement). Pure functions, mirrored in TypeScript (sheets/src/domain/packages.ts); both are
checked against the same cases in tests/golden/packages.json.

A package is bought as an ordinary charge; the lessons it gives are what has been PAID on that charge. Attendance
consumes lessons, a package burns at its expiry, and lessons attended without cover are negative lessons (debt)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from nazoratly.rules.documents import format_som

AttStatus = Literal["present", "absent", "late", "excused"]
ExcusedMode = Literal["makeup", "credit", "none"]
Need = Literal["ok", "low", "exhausted", "debt"]


def credited_lessons(*, paid: Decimal, price: Decimal, lessons: int) -> int:
    """Lessons a package has earned so far: proportional to the money paid, never above the package size."""
    if paid <= 0:
        return 0
    return min(lessons, int((paid * lessons) // price))


def package_expires_on(purchased_on: date, expiry_days: int) -> date:
    return purchased_on + timedelta(days=expiry_days)


def consumes_lesson(*, status: AttStatus, is_makeup: bool, excused_mode: ExcusedMode) -> bool:
    """Does one attendance mark use up a lesson of the package?

    Present, late and unexcused absent do. An excused absence does only when the center gives nothing for it (`none`):
    with a make-up right or a credit the lesson stays in the balance. A make-up lesson is paid by its right."""
    if is_makeup:
        return False
    if status == "excused":
        return excused_mode == "none"
    return True


@dataclass(frozen=True)
class PackageInput:
    credited: int
    purchased_on: date
    expires_on: date


@dataclass(frozen=True)
class Balance:
    available: int
    burned: int
    uncovered: int
    balance: int
    next_expiry: date | None


def package_balance(*, packages: list[PackageInput], consumed_on: list[date], today: date) -> Balance:
    """Lesson balance of one enrollment.

    Each consumed lesson (oldest first) takes a lesson from the first package that has lessons left and was valid on
    that day (purchased on or before, not yet expired); a lesson nobody covered is `uncovered`. Uncovered lessons are
    then paid from any package that has not expired today (a late payment clears old debt). Lessons left in a package
    that expired before today are `burned`. `balance = available - uncovered`: negative means debt."""
    pk = sorted(packages, key=lambda p: p.purchased_on)
    left = [p.credited for p in pk]
    uncovered = 0
    for day in sorted(consumed_on):
        for i, p in enumerate(pk):
            if left[i] > 0 and p.purchased_on <= day <= p.expires_on:
                left[i] -= 1
                break
        else:
            uncovered += 1
    for i, p in enumerate(pk):
        if uncovered == 0:
            break
        if p.expires_on >= today:
            take = min(left[i], uncovered)
            left[i] -= take
            uncovered -= take
    available = sum(n for n, p in zip(left, pk, strict=True) if p.expires_on >= today)
    burned = sum(n for n, p in zip(left, pk, strict=True) if p.expires_on < today)
    live = [p.expires_on for n, p in zip(left, pk, strict=True) if n > 0 and p.expires_on >= today]
    return Balance(available, burned, uncovered, available - uncovered, min(live) if live else None)


def lessons_money(*, lessons: int, price: Decimal, package_lessons: int) -> Decimal:
    """Money value of some lessons at the package's price per lesson, rounded half up to a whole so'm."""
    return (Decimal(lessons) * price / package_lessons).quantize(Decimal(1), rounding=ROUND_HALF_UP)


def payment_need(*, balance: int, low_lessons: int) -> Need:
    if balance < 0:
        return "debt"
    if balance == 0:
        return "exhausted"
    if balance <= low_lessons:
        return "low"
    return "ok"


def package_reminder_text(
    *, need: Need, guardian: str, student: str, balance: int, debt_amount: Decimal, center: str
) -> str:
    """Reminder DRAFT text (a person approves it before anything is sent); empty when nothing is needed."""
    hello = f"Assalomu alaykum, {guardian}!"
    if need == "low":
        return (
            f"{hello} {student} uchun abonementda {balance} ta dars qoldi. "
            f"Darslar to'xtab qolmasligi uchun to'lovni oldindan amalga oshiring. {center}"
        )
    if need == "exhausted":
        return (
            f"{hello} {student} uchun abonementdagi darslar tugadi. "
            f"Davom etish uchun yangi abonement to'lovini amalga oshiring. {center}"
        )
    if need == "debt":
        return (
            f"{hello} {student} {-balance} ta darsda to'lovsiz qatnashdi ({format_som(debt_amount)} so'm). "
            f"Iltimos, abonement to'lovini amalga oshiring. {center}"
        )
    return ""
