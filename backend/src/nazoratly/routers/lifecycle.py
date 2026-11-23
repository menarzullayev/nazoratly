"""Admission lifecycle: pending trial decisions, accepting a trial (first-month rule) and dropping it."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import Field

from nazoratly.accounting import org_today
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import AlreadyAccepted, EnrollmentNotTrial, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.academics import _ENR_SQL, EnrollmentOut
from nazoratly.routers.finance import month_start, next_month
from nazoratly.routers.settings import load_settings
from nazoratly.rules.lifecycle import FirstMonth, FirstMonthMode, first_month_charge, trial_status
from nazoratly.schemas import Dec2, LongText, Model, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["admission"], route_class=IdempotentRoute)

DUE_DAY = 10  # first-month charges are due on the 10th, or on the acceptance day when that is later


class AcceptIn(Model):
    mode: FirstMonthMode
    accepted_on: date | None = Field(default=None, description="defaults to today")


class AcceptOut(EnrollmentOut):
    fallback_to_full: bool
    charge_amount: Dec2


class DropIn(Model):
    reason: LongText | None = None


class PendingTrial(Out):
    enrollment_id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_id: uuid.UUID
    group_name: str
    started_on: date
    lessons_attended: int
    days_elapsed: int
    reason: Literal["lessons", "days"]


async def _lesson_dates(conn: Conn, group_id: int, first: date) -> list[date]:
    """Lessons of the group in the month; when none exist yet, the dates its weekly schedule would produce."""
    nxt = next_month(first)
    rows = await fetch_all(
        conn,
        "SELECT lesson_date FROM lessons WHERE group_id = %s AND lesson_date >= %s AND lesson_date < %s "
        "AND status <> 'cancelled' ORDER BY lesson_date",
        (group_id, first, nxt),
    )
    if rows:
        return [r["lesson_date"] for r in rows]
    weekdays = {
        r["weekday"]
        for r in await fetch_all(conn, "SELECT weekday FROM group_schedules WHERE group_id = %s", (group_id,))
    }
    days = [first + timedelta(days=i) for i in range((nxt - first).days)]
    return [d for d in days if d.isoweekday() in weekdays]


@router.get(
    "/trials/pending", response_model=Page[PendingTrial], summary="Trials waiting for the owner's decision"
)
async def pending_trials(
    p: Annotated[Principal, Depends(require("academics:write"))], db: DB, pg: Paging
) -> Page[PendingTrial]:
    async with db.tx(p.session()) as conn:
        today = await org_today(conn)
        cfg = await load_settings(conn, p.org_id)
        rows = await fetch_all(
            conn,
            "SELECT e.public_id AS enrollment_id, s.public_id AS student_id, s.full_name AS student_name, "
            "g.public_id AS group_id, g.name AS group_name, e.started_on, "
            "(SELECT count(*) FROM attendance a JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id "
            "  WHERE a.student_id = e.student_id AND l.group_id = e.group_id AND l.lesson_date >= e.started_on "
            "  AND a.status IN ('present', 'late')) AS lessons_attended "
            "FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
            "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
            "WHERE e.status = 'trial' AND s.deleted_at IS NULL ORDER BY e.started_on, e.id LIMIT 1000",
        )
    due: list[dict[str, object]] = []
    for r in rows:
        attended = int(r["lessons_attended"])
        state = trial_status(
            started_on=r["started_on"],
            today=today,
            lessons_attended=attended,
            free_lessons=cfg.trial_free_lessons,
            free_days=cfg.trial_free_days,
        )
        if state == "decision_needed":
            r["days_elapsed"] = (today - r["started_on"]).days
            r["reason"] = "lessons" if attended >= cfg.trial_free_lessons else "days"
            due.append(r)
    window = due[pg.offset : pg.offset + pg.limit + 1]
    return make_page(window, pg.limit, pg.offset, PendingTrial)


@router.post(
    "/enrollments/{enrollment_id}/accept",
    response_model=AcceptOut,
    summary="Accept a trial: becomes active and the first month is billed by the chosen mode",
)
async def accept_trial(
    enrollment_id: uuid.UUID,
    body: AcceptIn,
    p: Annotated[Principal, Depends(require("academics:write", "finance:write"))],
    db: DB,
) -> AcceptOut:
    async with db.tx(p.session()) as conn:
        accepted_on = body.accepted_on or await org_today(conn)
        eid = await resolve(conn, "enrollments", enrollment_id, what="enrollment")
        e = await fetch_one(
            conn,
            "SELECT e.id, e.status, e.started_on, e.accepted_on, e.student_id, e.group_id, g.billing_mode, "
            "round(COALESCE(e.monthly_fee_override, g.monthly_fee) * (1 - e.discount_percent / 100), 2) AS fee "
            "FROM enrollments e JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
            "WHERE e.id = %s FOR UPDATE OF e",
            (eid,),
        )
        assert e is not None
        if e["status"] != "trial":
            if e["accepted_on"] is not None:
                raise AlreadyAccepted("This enrollment was already accepted")
            raise EnrollmentNotTrial("Only a trial enrollment can be accepted")
        if accepted_on < e["started_on"]:
            raise Unprocessable("accepted_on cannot be before the trial started")
        first = month_start(accepted_on)
        if e["billing_mode"] == "package":  # a package group bills when a package is sold, never by the month
            result = FirstMonth(Decimal(0), False)
        else:
            result = first_month_charge(
                mode=body.mode,
                monthly_fee=Decimal(e["fee"]),
                accepted_on=accepted_on,
                lesson_dates=await _lesson_dates(conn, e["group_id"], first),
            )
        if result.amount > 0:
            due = max(accepted_on, first.replace(day=DUE_DAY))
            await execute(
                conn,
                "INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, description, amount, due_date, "
                "created_by_user_id) VALUES (%s, %s, %s, 'tuition', %s, %s, %s, %s, %s) "
                "ON CONFLICT (enrollment_id, period_month) WHERE kind = 'tuition' AND voided_at IS NULL DO NOTHING",
                (
                    p.org_id,
                    e["student_id"],
                    eid,
                    first,
                    f"Tuition {first:%Y-%m} (first month, {body.mode})",
                    result.amount,
                    due,
                    p.user_id,
                ),
            )
        await execute(
            conn,
            "UPDATE enrollments SET status = 'active', accepted_on = %s, first_month_mode = %s WHERE id = %s",
            (accepted_on, body.mode, eid),
        )
        out = await fetch_one(conn, f"{_ENR_SQL} WHERE e.id = %s", (eid,))
    assert out is not None
    return AcceptOut.model_validate(
        {**out, "fallback_to_full": result.fallback_to_full, "charge_amount": result.amount}
    )


@router.post("/enrollments/{enrollment_id}/drop", response_model=EnrollmentOut, summary="Drop a trial")
async def drop_trial(
    enrollment_id: uuid.UUID,
    body: DropIn,
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
) -> EnrollmentOut:
    async with db.tx(p.session()) as conn:
        eid = await resolve(conn, "enrollments", enrollment_id, what="enrollment")
        e = await fetch_one(
            conn, "SELECT status, started_on FROM enrollments WHERE id = %s FOR UPDATE", (eid,)
        )
        assert e is not None
        if e["status"] != "trial":
            raise EnrollmentNotTrial("Only a trial enrollment can be dropped")
        ended = max(await org_today(conn), e["started_on"])
        await execute(
            conn,
            "UPDATE enrollments SET status = 'finished', ended_on = %s, dropped_reason = %s WHERE id = %s",
            (ended, body.reason or "", eid),  # '' marks a dropped trial even without a reason
        )
        out = await fetch_one(conn, f"{_ENR_SQL} WHERE e.id = %s", (eid,))
    assert out is not None
    return EnrollmentOut.model_validate(out)
