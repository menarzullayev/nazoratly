"""Owner dashboard: one read endpoint with the four blocks (paid vs unpaid students, new vs left students with trial
conversion, six-month income/expenses/net, lead funnel plus "waiting for a decision").

This module only loads facts under row-level security and shapes the response. Every number comes from the shared
rules (`rules/dashboard.py`, golden-tested against the Sheets edition) or from the rules they reuse (funnel, trial
limits, package balance). Looking at the dashboard never accepts, sells, bills or sends anything."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query

from nazoratly.db import Conn, fetch_all, fetch_one
from nazoratly.deps import DB, Principal, require
from nazoratly.errors import Unprocessable
from nazoratly.packages import load_balances
from nazoratly.routers.finance import month_start, next_month
from nazoratly.routers.leads import FunnelOut, load_funnel
from nazoratly.routers.settings import SettingsOut, load_settings
from nazoratly.rules.dashboard import (
    MONTHS,
    EnrollmentFact,
    MoneyOn,
    PackageWait,
    PayrollMonth,
    RightWait,
    StudentMoney,
    TrialWait,
    monthly_finance,
    payment_status,
    student_movement,
    waiting_items,
)
from nazoratly.schemas import Dec2, Out
from nazoratly.waitlist import load_offers

router = APIRouter(prefix="/v1", tags=["dashboard"])

MAX_RANGE_DAYS = 1830


class StudentRef(Out):
    id: uuid.UUID
    name: str


class UnpaidStudent(StudentRef):
    outstanding: Dec2
    overdue: Dec2
    package_debt_lessons: int


class PaymentsBlock(Out):
    paid: int
    unpaid: int
    overdue: int
    unpaid_students: list[UnpaidStudent]
    paid_students: list[StudentRef]


class MovementBlock(Out):
    new: int
    left: int
    new_students: list[StudentRef]
    left_students: list[StudentRef]
    trials_started: int
    accepted: int
    dropped: int
    running: int
    conversion: float


class MonthPointOut(Out):
    month: date
    income: Dec2
    operating: Dec2
    payroll: Dec2
    expenses: Dec2
    net: Dec2


class FinanceBlock(Out):
    months: list[MonthPointOut]
    income: Dec2
    expenses: Dec2
    net: Dec2


class WaitingTrial(Out):
    enrollment_id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_name: str
    started_on: date
    lessons_attended: int
    days_elapsed: int
    reason: Literal["lessons", "days"]


class WaitingPackage(Out):
    enrollment_id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_name: str
    available: int
    next_expiry: date
    days_left: int


class WaitingRight(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_name: str
    expires_on: date
    days_left: int


class WaitingSeat(Out):
    """A seat that freed up: the next student in line for a group (the owner enrolls with one click)."""

    entry_id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_id: uuid.UUID
    group_name: str
    position: int
    free_seats: int


class WaitingBlock(Out):
    trials: list[WaitingTrial]
    packages: list[WaitingPackage]
    rights: list[WaitingRight]
    seats: list[WaitingSeat]
    total: int


class RangeOut(Out):
    date_from: date
    date_to: date


class DashboardOut(Out):
    as_of: date
    range: RangeOut
    window_days: int
    payments: PaymentsBlock
    movement: MovementBlock
    finance: FinanceBlock
    funnel: FunnelOut
    waiting: WaitingBlock


async def _today(conn: Conn, org_id: int) -> date:
    row = await fetch_one(
        conn,
        "SELECT (now() AT TIME ZONE timezone)::date AS today FROM organizations WHERE id = %s",
        (org_id,),
    )
    return row["today"] if row else date.today()


async def _student_names(conn: Conn, ids: set[int]) -> dict[int, tuple[uuid.UUID, str]]:
    if not ids:
        return {}
    rows = await fetch_all(
        conn, "SELECT id, public_id, full_name FROM students WHERE id = ANY(%s)", (sorted(ids),)
    )
    return {r["id"]: (r["public_id"], r["full_name"]) for r in rows}


async def _group_names(conn: Conn, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = await fetch_all(conn, "SELECT id, name FROM study_groups WHERE id = ANY(%s)", (sorted(ids),))
    return {r["id"]: r["name"] for r in rows}


async def _payments_block(conn: Conn, today: date, low_lessons: int, limit: int) -> PaymentsBlock:
    rows = await fetch_all(
        conn,
        "SELECT s.id, COALESCE(b.outstanding_total, 0) AS outstanding, COALESCE(b.overdue_total, 0) AS overdue "
        "FROM students s LEFT JOIN v_student_balance b ON b.student_id = s.id "
        "WHERE s.deleted_at IS NULL AND EXISTS (SELECT 1 FROM enrollments e WHERE e.org_id = s.org_id "
        "AND e.student_id = s.id AND e.status IN ('active', 'frozen'))",
    )
    debt: dict[int, int] = {}
    for bal in await load_balances(conn, today=today, low_lessons=low_lessons, statuses=("active", "frozen")):
        debt[bal.student_id] = debt.get(bal.student_id, 0) + bal.debt_lessons
    result = payment_status(
        [StudentMoney(str(r["id"]), r["outstanding"], r["overdue"], debt.get(r["id"], 0)) for r in rows]
    )
    shown_unpaid = result["unpaid_students"][:limit]
    shown_paid = result["paid_ids"][:limit]
    names = await _student_names(conn, {int(s["id"]) for s in shown_unpaid} | {int(i) for i in shown_paid})
    return PaymentsBlock(
        paid=result["paid"],
        unpaid=result["unpaid"],
        overdue=result["overdue"],
        unpaid_students=[
            UnpaidStudent(
                id=names[int(s["id"])][0],
                name=names[int(s["id"])][1],
                outstanding=s["outstanding"],
                overdue=s["overdue"],
                package_debt_lessons=s["package_debt_lessons"],
            )
            for s in shown_unpaid
        ],
        paid_students=[StudentRef(id=names[int(i)][0], name=names[int(i)][1]) for i in shown_paid],
    )


async def _movement_block(conn: Conn, date_from: date, date_to: date, limit: int) -> MovementBlock:
    rows = await fetch_all(
        conn,
        "SELECT e.student_id, e.status, e.started_on, e.accepted_on, e.ended_on, "
        "(e.status = 'finished' AND e.accepted_on IS NULL AND e.dropped_reason IS NOT NULL) AS dropped_trial "
        "FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id WHERE s.deleted_at IS NULL",
    )
    result = student_movement(
        [
            EnrollmentFact(
                str(r["student_id"]),
                r["status"],
                r["started_on"],
                r["accepted_on"],
                r["ended_on"],
                r["dropped_trial"],
            )
            for r in rows
        ],
        date_from=date_from,
        date_to=date_to,
    )
    new_ids = [int(i) for i in result["new_ids"][:limit]]
    left_ids = [int(i) for i in result["left_ids"][:limit]]
    names = await _student_names(conn, set(new_ids) | set(left_ids))
    return MovementBlock(
        new=result["new"],
        left=result["left"],
        new_students=[StudentRef(id=names[i][0], name=names[i][1]) for i in new_ids],
        left_students=[StudentRef(id=names[i][0], name=names[i][1]) for i in left_ids],
        trials_started=result["trials_started"],
        accepted=result["accepted"],
        dropped=result["dropped"],
        running=result["running"],
        conversion=result["conversion"],
    )


async def _finance_block(conn: Conn, today: date) -> FinanceBlock:
    first = month_start(today)
    for _ in range(MONTHS - 1):
        first = month_start(first - timedelta(days=1))
    end = next_month(month_start(today))
    payments = await fetch_all(
        conn,
        "SELECT day AS on_, sum(total) AS amount FROM v_daily_revenue WHERE day >= %s AND day < %s GROUP BY day",
        (first, end),
    )
    expenses = await fetch_all(
        conn,
        "SELECT spent_at AS on_, sum(amount) AS amount FROM expenses "
        "WHERE voided_at IS NULL AND spent_at >= %s AND spent_at < %s GROUP BY spent_at",
        (first, end),
    )
    payroll = await fetch_all(
        conn,
        "SELECT period_month AS month, sum(total) AS amount FROM v_teacher_payroll_totals "
        "WHERE status IN ('approved', 'paid') AND period_month >= %s AND period_month < %s GROUP BY period_month",
        (first, end),
    )
    result = monthly_finance(
        payments=[MoneyOn(r["on_"], r["amount"]) for r in payments],
        expenses=[MoneyOn(r["on_"], r["amount"]) for r in expenses],
        payroll=[PayrollMonth(r["month"], r["amount"]) for r in payroll],
        today=today,
    )
    return FinanceBlock.model_validate(result)


async def _waiting_block(
    conn: Conn, org_id: int, today: date, window_days: int, cfg: SettingsOut
) -> WaitingBlock:
    trial_rows = await fetch_all(
        conn,
        "SELECT e.id, e.public_id, e.student_id, e.group_id, e.started_on, "
        "(SELECT count(*) FROM attendance a JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id "
        "  WHERE a.student_id = e.student_id AND l.group_id = e.group_id AND l.lesson_date >= e.started_on "
        "  AND a.status IN ('present', 'late')) AS lessons_attended "
        "FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
        "WHERE e.status = 'trial' AND s.deleted_at IS NULL",
    )
    balances = await load_balances(conn, today=today, low_lessons=cfg.package_low_lessons)
    right_rows = await fetch_all(
        conn,
        "SELECT ae.id, ae.public_id, ae.student_id, ae.group_id, ae.kind, ae.status, ae.expires_on "
        "FROM absence_entitlements ae JOIN students s ON s.org_id = ae.org_id AND s.id = ae.student_id "
        "WHERE ae.kind = 'makeup' AND ae.status = 'open' AND s.deleted_at IS NULL "
        "AND ae.expires_on >= %s AND ae.expires_on <= %s",
        (today, today + timedelta(days=window_days)),
    )
    result = waiting_items(
        trials=[TrialWait(str(r["id"]), r["started_on"], int(r["lessons_attended"])) for r in trial_rows],
        packages=[
            PackageWait(str(b.enrollment_id), b.balance.available, b.balance.next_expiry) for b in balances
        ],
        rights=[RightWait(str(r["id"]), r["kind"], r["status"], r["expires_on"]) for r in right_rows],
        today=today,
        window_days=window_days,
        free_lessons=cfg.trial_free_lessons,
        free_days=cfg.trial_free_days,
        makeup_lapses=cfg.makeup_lapses,
    )
    trial_by_id = {str(r["id"]): r for r in trial_rows}
    balance_by_id = {str(b.enrollment_id): b for b in balances}
    right_by_id = {str(r["id"]): r for r in right_rows}
    student_ids = (
        {int(trial_by_id[t["id"]]["student_id"]) for t in result["trials"]}
        | {balance_by_id[p["id"]].student_id for p in result["packages"]}
        | {int(right_by_id[r["id"]]["student_id"]) for r in result["rights"]}
    )
    group_ids = {int(trial_by_id[t["id"]]["group_id"]) for t in result["trials"]} | {
        int(right_by_id[r["id"]]["group_id"]) for r in result["rights"]
    }
    names = await _student_names(conn, student_ids)
    groups = await _group_names(conn, group_ids)
    pkg_enrollments = {
        r["id"]: r["public_id"]
        for r in await fetch_all(
            conn,
            "SELECT id, public_id FROM enrollments WHERE id = ANY(%s)",
            ([balance_by_id[p["id"]].enrollment_id for p in result["packages"]],),
        )
    }
    trials = [
        WaitingTrial(
            enrollment_id=trial_by_id[t["id"]]["public_id"],
            student_id=names[int(trial_by_id[t["id"]]["student_id"])][0],
            student_name=names[int(trial_by_id[t["id"]]["student_id"])][1],
            group_name=groups[int(trial_by_id[t["id"]]["group_id"])],
            started_on=date.fromisoformat(t["started_on"]),
            lessons_attended=t["lessons_attended"],
            days_elapsed=t["days_elapsed"],
            reason=t["reason"],
        )
        for t in result["trials"]
    ]
    packages = [
        WaitingPackage(
            enrollment_id=pkg_enrollments[balance_by_id[p["id"]].enrollment_id],
            student_id=names[balance_by_id[p["id"]].student_id][0],
            student_name=names[balance_by_id[p["id"]].student_id][1],
            group_name=balance_by_id[p["id"]].group_name,
            available=p["available"],
            next_expiry=date.fromisoformat(p["next_expiry"]),
            days_left=p["days_left"],
        )
        for p in result["packages"]
    ]
    rights = [
        WaitingRight(
            id=right_by_id[r["id"]]["public_id"],
            student_id=names[int(right_by_id[r["id"]]["student_id"])][0],
            student_name=names[int(right_by_id[r["id"]]["student_id"])][1],
            group_name=groups[int(right_by_id[r["id"]]["group_id"])],
            expires_on=date.fromisoformat(r["expires_on"]),
            days_left=r["days_left"],
        )
        for r in result["rights"]
    ]
    seats = [
        WaitingSeat(
            entry_id=o.entry_public_id,
            student_id=o.student_public_id,
            student_name=o.student_name,
            group_id=o.group_public_id,
            group_name=o.group_name,
            position=o.position,
            free_seats=o.free_seats,
        )
        for o in await load_offers(conn, org_id)
    ]
    return WaitingBlock(
        trials=trials, packages=packages, rights=rights, seats=seats, total=result["total"] + len(seats)
    )


@router.get(
    "/dashboard",
    response_model=DashboardOut,
    summary="Owner dashboard: paid/unpaid, new/left and trial conversion, six-month finance, funnel and waiting items",
)
async def dashboard(
    p: Annotated[Principal, Depends(require("reports:read"))],
    db: DB,
    date_from: date | None = None,
    date_to: date | None = None,
    window_days: Annotated[
        int, Query(ge=1, le=60, description="look-ahead for expiring packages and rights")
    ] = 7,
    list_limit: Annotated[int, Query(ge=1, le=1000, description="max rows in each student list")] = 200,
) -> DashboardOut:
    async with db.tx(p.session()) as conn:
        today = await _today(conn, p.org_id)
        start = date_from or today.replace(day=1)
        end = date_to or today
        if end < start or (end - start).days > MAX_RANGE_DAYS:
            raise Unprocessable(f"date range must be 0-{MAX_RANGE_DAYS} days")
        cfg = await load_settings(conn, p.org_id)
        return DashboardOut(
            as_of=today,
            range=RangeOut(date_from=start, date_to=end),
            window_days=window_days,
            payments=await _payments_block(conn, today, cfg.package_low_lessons, list_limit),
            movement=await _movement_block(conn, start, end, list_limit),
            finance=await _finance_block(conn, today),
            funnel=await load_funnel(conn, start, end),
            waiting=await _waiting_block(conn, p.org_id, today, window_days, cfg),
        )
