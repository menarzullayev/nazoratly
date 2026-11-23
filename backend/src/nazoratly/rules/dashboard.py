"""Dashboard rules: paid vs unpaid students, student movement and trial conversion, six-month finance and the
"waiting for a decision" lists. Pure functions, mirrored in TypeScript (sheets/src/domain/dashboard.ts); both are checked
against the same cases in tests/golden/dashboard.json. The lead funnel (rules/funnel.py), trial limits
(rules/lifecycle.py) and package balances (rules/packages.py) are reused, never recomputed. Dates in results are ISO
strings so the JSON golden file and the API payload carry the same values."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from nazoratly.rules.lifecycle import trial_status

_OPEN = ("trial", "active", "frozen")


def _pct(part: int, whole: int) -> float:
    if whole == 0:
        return 0.0
    return float((Decimal(part) * 100 / Decimal(whole)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


# ---- block 1: paid vs unpaid -----------------------------------------------------------------------------------
@dataclass(frozen=True)
class StudentMoney:
    id: str
    outstanding: Decimal
    overdue: Decimal
    package_debt_lessons: int


def _is_unpaid(s: StudentMoney) -> bool:
    return s.outstanding > 0 or s.package_debt_lessons > 0


def payment_status(students: list[StudentMoney]) -> dict[str, Any]:
    """Unpaid = open money (installments included) or negative lessons in a package group; overdue is the subset with
    an overdue amount. Unpaid students are ordered by outstanding (desc), then id; paid ids by id."""
    unpaid = sorted((s for s in students if _is_unpaid(s)), key=lambda s: (-s.outstanding, s.id))
    paid = sorted(s.id for s in students if not _is_unpaid(s))
    return {
        "paid": len(paid),
        "unpaid": len(unpaid),
        "overdue": sum(1 for s in unpaid if s.overdue > 0),
        "unpaid_students": [
            {
                "id": s.id,
                "outstanding": s.outstanding,
                "overdue": s.overdue,
                "package_debt_lessons": s.package_debt_lessons,
            }
            for s in unpaid
        ],
        "paid_ids": paid,
    }


# ---- block 2: movement and trial conversion --------------------------------------------------------------------
@dataclass(frozen=True)
class EnrollmentFact:
    student: str
    status: str
    started_on: date
    accepted_on: date | None
    ended_on: date | None
    dropped_trial: bool


def student_movement(enrollments: list[EnrollmentFact], *, date_from: date, date_to: date) -> dict[str, Any]:
    """New = first real join (accepted_on, else started_on) in the range; left = no open enrollment now and the latest
    real end date in the range. A dropped trial and a running trial are not real enrollments. The trial cohort is the
    enrollments that went through a trial and started in the range; conversion = accepted / (accepted + dropped)."""
    joined: dict[str, date] = {}
    left_on: dict[str, date] = {}
    has_open: set[str] = set()
    for e in enrollments:
        if e.status in _OPEN:
            has_open.add(e.student)
        if e.dropped_trial or e.status == "trial":
            continue
        become = e.accepted_on or e.started_on
        if e.student not in joined or become < joined[e.student]:
            joined[e.student] = become
        if (
            e.status == "finished"
            and e.ended_on is not None
            and (e.student not in left_on or e.ended_on > left_on[e.student])
        ):
            left_on[e.student] = e.ended_on
    new_ids = sorted(s for s, d in joined.items() if date_from <= d <= date_to)
    left_ids = sorted(s for s, d in left_on.items() if s not in has_open and date_from <= d <= date_to)
    cohort = [
        e
        for e in enrollments
        if date_from <= e.started_on <= date_to and (e.status == "trial" or e.accepted_on or e.dropped_trial)
    ]
    accepted = sum(1 for e in cohort if e.accepted_on)
    dropped = sum(1 for e in cohort if e.dropped_trial)
    running = sum(1 for e in cohort if e.status == "trial" and not e.dropped_trial)
    return {
        "new": len(new_ids),
        "left": len(left_ids),
        "new_ids": new_ids,
        "left_ids": left_ids,
        "trials_started": len(cohort),
        "accepted": accepted,
        "dropped": dropped,
        "running": running,
        "conversion": _pct(accepted, accepted + dropped),
    }


# ---- block 3: six-month finance --------------------------------------------------------------------------------
@dataclass(frozen=True)
class MoneyOn:
    on: date
    amount: Decimal


@dataclass(frozen=True)
class PayrollMonth:
    month: date
    amount: Decimal


MONTHS = 6


def monthly_finance(
    *, payments: list[MoneyOn], expenses: list[MoneyOn], payroll: list[PayrollMonth], today: date
) -> dict[str, Any]:
    """The six calendar months ending with the month of `today`: income, operating expenses, payroll,
    expenses = operating + payroll, net = income - expenses. Voided rows and payroll drafts are filtered by the caller."""
    keys: list[tuple[int, int]] = []
    y, m = today.year, today.month
    for _ in range(MONTHS):
        keys.append((y, m))
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    keys.reverse()
    zero = Decimal(0)
    income = dict.fromkeys(keys, zero)
    operating = dict.fromkeys(keys, zero)
    pay = dict.fromkeys(keys, zero)
    for p in payments:
        if (p.on.year, p.on.month) in income:
            income[(p.on.year, p.on.month)] += p.amount
    for x in expenses:
        if (x.on.year, x.on.month) in operating:
            operating[(x.on.year, x.on.month)] += x.amount
    for r in payroll:
        if (r.month.year, r.month.month) in pay:
            pay[(r.month.year, r.month.month)] += r.amount
    points = [
        {
            "month": f"{k[0]:04d}-{k[1]:02d}-01",
            "income": income[k],
            "operating": operating[k],
            "payroll": pay[k],
            "expenses": operating[k] + pay[k],
            "net": income[k] - operating[k] - pay[k],
        }
        for k in keys
    ]
    total_income = sum(income.values(), zero)
    total_expenses = sum(operating.values(), zero) + sum(pay.values(), zero)
    return {
        "months": points,
        "income": total_income,
        "expenses": total_expenses,
        "net": total_income - total_expenses,
    }


# ---- block 4: waiting for a decision ---------------------------------------------------------------------------
@dataclass(frozen=True)
class TrialWait:
    id: str
    started_on: date
    lessons_attended: int


@dataclass(frozen=True)
class PackageWait:
    id: str
    available: int
    next_expiry: date | None


@dataclass(frozen=True)
class RightWait:
    id: str
    kind: str
    status: str
    expires_on: date


def waiting_items(
    *,
    trials: list[TrialWait],
    packages: list[PackageWait],
    rights: list[RightWait],
    today: date,
    window_days: int,
    free_lessons: int,
    free_days: int,
    makeup_lapses: bool,
) -> dict[str, Any]:
    """Trials whose limit is reached, packages with lessons left that expire within the window, open make-up rights that
    lapse within the window (today through today + window inclusive). Each list is ordered by urgency, then id."""
    last = today + timedelta(days=window_days)
    due_trials = [
        {
            "id": t.id,
            "started_on": t.started_on.isoformat(),
            "lessons_attended": t.lessons_attended,
            "days_elapsed": (today - t.started_on).days,
            "reason": "lessons" if t.lessons_attended >= free_lessons else "days",
        }
        for t in sorted(trials, key=lambda t: (t.started_on, t.id))
        if trial_status(
            started_on=t.started_on,
            today=today,
            lessons_attended=t.lessons_attended,
            free_lessons=free_lessons,
            free_days=free_days,
        )
        == "decision_needed"
    ]
    expiring = [
        {
            "id": p.id,
            "available": p.available,
            "next_expiry": p.next_expiry.isoformat(),
            "days_left": (p.next_expiry - today).days,
        }
        for p in sorted(packages, key=lambda p: (p.next_expiry or date.max, p.id))
        if p.next_expiry is not None and p.available > 0 and today <= p.next_expiry <= last
    ]
    lapsing = [
        {"id": r.id, "expires_on": r.expires_on.isoformat(), "days_left": (r.expires_on - today).days}
        for r in sorted(rights, key=lambda r: (r.expires_on, r.id))
        if makeup_lapses and r.kind == "makeup" and r.status == "open" and today <= r.expires_on <= last
    ]
    return {
        "trials": due_trials,
        "packages": expiring,
        "rights": lapsing,
        "total": len(due_trials) + len(expiring) + len(lapsing),
    }
