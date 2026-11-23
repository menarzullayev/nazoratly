"""Excused-absence entitlements: make-up rights and credits, make-up scheduling, cancellation."""

from __future__ import annotations

import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import model_validator

from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotOpen, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.settings import load_settings
from nazoratly.rules.entitlements import entitlement_expires_on, entitlement_state, lesson_credit_amount
from nazoratly.schemas import Dec2, Model, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["make-up"], route_class=IdempotentRoute)


# ---- hook used by the attendance endpoints -------------------------------------------------------------------
async def sync_entitlement(
    conn: Conn, *, org_id: int, lesson: dict[str, Any], student_id: int, new_status: str | None
) -> None:
    """Keep entitlements in step with one attendance mark (`new_status` None = the mark was removed)."""
    if lesson["kind"] == "makeup":
        ent = await fetch_one(
            conn,
            "SELECT id FROM absence_entitlements WHERE makeup_lesson_id = %s AND student_id = %s FOR UPDATE",
            (lesson["id"], student_id),
        )
        if ent is None:
            return
        if new_status in ("present", "late"):
            await execute(
                conn,
                "UPDATE absence_entitlements SET status = 'used', used_on = %s WHERE id = %s",
                (lesson["lesson_date"], ent["id"]),
            )
        else:  # absent again, excused, or the mark was removed: the right goes back to the owner
            await execute(
                conn,
                "UPDATE absence_entitlements SET status = 'open', makeup_lesson_id = NULL, used_on = NULL WHERE id = %s",
                (ent["id"],),
            )
        return

    if new_status != "excused":
        await execute(
            conn,
            "UPDATE absence_entitlements SET status = 'cancelled' "
            "WHERE missed_lesson_id = %s AND student_id = %s AND status = 'open'",
            (lesson["id"], student_id),
        )
        return

    cfg = await load_settings(conn, org_id)
    if cfg.excused_mode == "none":
        return
    enr = await fetch_one(
        conn,
        "SELECT e.id, g.billing_mode, round(COALESCE(e.monthly_fee_override, g.monthly_fee) * (1 - e.discount_percent / 100), 2) AS fee "
        "FROM enrollments e JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
        "WHERE e.student_id = %s AND e.group_id = %s AND e.status = 'active'",
        (student_id, lesson["group_id"]),
    )
    if enr is None:  # trials, frozen and finished enrollments earn nothing
        return
    if enr["billing_mode"] == "package" and cfg.excused_mode == "credit":
        return  # in a package group not consuming the lesson IS the credit (see rules/packages.py)
    kind: Literal["makeup", "credit"] = "makeup" if cfg.excused_mode == "makeup" else "credit"
    amount: Decimal | None = None
    if kind == "credit":
        first = lesson["lesson_date"].replace(day=1)
        n = await fetch_one(
            conn,
            "SELECT count(*) AS n FROM lessons WHERE group_id = %s AND status <> 'cancelled' AND kind = 'regular' "
            "AND date_trunc('month', lesson_date) = %s",
            (lesson["group_id"], first),
        )
        assert n is not None
        amount = lesson_credit_amount(monthly_fee=Decimal(enr["fee"]), lessons_in_month=int(n["n"]))
        if amount <= 0:
            return
    await execute(
        conn,
        "INSERT INTO absence_entitlements (org_id, student_id, enrollment_id, group_id, missed_lesson_id, kind, amount, expires_on) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
        "ON CONFLICT (missed_lesson_id, student_id) DO UPDATE SET status = 'open', kind = EXCLUDED.kind, "
        "amount = EXCLUDED.amount, expires_on = EXCLUDED.expires_on, makeup_lesson_id = NULL, used_on = NULL, "
        "applied_charge_id = NULL WHERE absence_entitlements.status = 'cancelled'",
        (
            org_id,
            student_id,
            enr["id"],
            lesson["group_id"],
            lesson["id"],
            kind,
            amount,
            entitlement_expires_on(lesson["lesson_date"], cfg.makeup_expiry_days),
        ),
    )


# ---- API -----------------------------------------------------------------------------------------------------
EffStatus = Literal["open", "scheduled", "used", "cancelled", "lapsed"]


class EntitlementOut(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_id: uuid.UUID
    group_name: str
    kind: Literal["makeup", "credit"]
    amount: Dec2 | None
    missed_on: date
    expires_on: date
    status: Literal["open", "scheduled", "used", "cancelled"]
    effective_status: EffStatus
    makeup_lesson_id: uuid.UUID | None
    makeup_date: date | None
    used_on: date | None
    created_at: datetime


_SQL = (
    "SELECT ae.id AS iid, ae.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, "
    "g.public_id AS group_id, g.name AS group_name, g.teacher_id AS group_teacher_id, ae.kind, ae.amount, "
    "ml.lesson_date AS missed_on, ae.expires_on, ae.status, xl.public_id AS makeup_lesson_id, "
    "xl.lesson_date AS makeup_date, ae.used_on, ae.created_at "
    "FROM absence_entitlements ae JOIN students s ON s.org_id = ae.org_id AND s.id = ae.student_id "
    "JOIN study_groups g ON g.org_id = ae.org_id AND g.id = ae.group_id "
    "JOIN lessons ml ON ml.org_id = ae.org_id AND ml.id = ae.missed_lesson_id "
    "LEFT JOIN lessons xl ON xl.org_id = ae.org_id AND xl.id = ae.makeup_lesson_id"
)


def _with_state(row: dict[str, Any], today: date, lapses: bool) -> dict[str, Any]:
    row["effective_status"] = entitlement_state(
        status=row["status"], expires_on=row["expires_on"], today=today, lapses=lapses
    )
    return row


@router.get("/entitlements", response_model=Page[EntitlementOut], summary="Make-up rights and credits")
async def list_entitlements(
    p: Annotated[Principal, Depends(require("attendance:read"))],
    db: DB,
    pg: Paging,
    status: EffStatus | None = None,
    student_id: uuid.UUID | None = None,
) -> Page[EntitlementOut]:
    where: list[str] = []
    params: list[Any] = []
    if student_id:
        where.append("s.public_id = %s")
        params.append(student_id)
    async with db.tx(p.session()) as conn:
        cfg = await load_settings(conn, p.org_id)
        if p.role == "teacher":
            mine = await fetch_one(
                conn, "SELECT id FROM teachers WHERE user_id = %s AND deleted_at IS NULL", (p.user_id,)
            )
            where.append("g.teacher_id = %s")
            params.append(mine["id"] if mine else -1)
        clause = f" WHERE {' AND '.join(where)}" if where else ""
        rows = await fetch_all(conn, f"{_SQL}{clause} ORDER BY ml.lesson_date, ae.id LIMIT 1000", params)
    today = date.today()
    rows = [_with_state(r, today, cfg.makeup_lapses) for r in rows]
    if status:
        rows = [r for r in rows if r["effective_status"] == status]
    return make_page(rows[pg.offset : pg.offset + pg.limit + 1], pg.limit, pg.offset, EntitlementOut)


class ScheduleIn(Model):
    lesson_date: date
    start_time: time
    end_time: time
    teacher_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _order(self) -> ScheduleIn:
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


async def _one(conn: Conn, iid: int, lapses: bool) -> EntitlementOut:
    row = await fetch_one(conn, f"{_SQL} WHERE ae.id = %s", (iid,))
    assert row is not None
    return EntitlementOut.model_validate(_with_state(row, date.today(), lapses))


@router.post(
    "/entitlements/{entitlement_id}/schedule",
    response_model=EntitlementOut,
    summary="Schedule the make-up lesson of an open right",
)
async def schedule(
    entitlement_id: uuid.UUID,
    body: ScheduleIn,
    p: Annotated[Principal, Depends(require("academics:write"))],
    db: DB,
) -> EntitlementOut:
    async with db.tx(p.session()) as conn:
        iid = await resolve(conn, "absence_entitlements", entitlement_id, what="entitlement")
        cfg = await load_settings(conn, p.org_id)
        ae = await fetch_one(
            conn,
            "SELECT ae.id, ae.kind, ae.status, ae.expires_on, ae.group_id, ae.enrollment_id, g.teacher_id AS group_teacher_id "
            "FROM absence_entitlements ae JOIN study_groups g ON g.org_id = ae.org_id AND g.id = ae.group_id "
            "WHERE ae.id = %s FOR UPDATE OF ae",
            (iid,),
        )
        assert ae is not None
        if ae["kind"] != "makeup":
            raise NotOpen("A credit is applied to tuition; it cannot be scheduled")
        state = entitlement_state(
            status=ae["status"], expires_on=ae["expires_on"], today=date.today(), lapses=cfg.makeup_lapses
        )
        if state != "open":
            raise NotOpen(f"This right is {state}")
        if body.lesson_date < date.today():
            raise Unprocessable("A make-up lesson cannot be scheduled in the past")
        active = await fetch_one(
            conn,
            "SELECT 1 AS ok FROM enrollments WHERE id = %s AND status = 'active'",
            (ae["enrollment_id"],),
        )
        if active is None:
            raise Conflict("The student is no longer actively enrolled in this group")
        teacher = (
            await resolve_opt(conn, "teachers", body.teacher_id, what="teacher") or ae["group_teacher_id"]
        )
        row = await fetch_one(
            conn,
            "INSERT INTO lessons (org_id, group_id, teacher_id, lesson_date, start_time, end_time, kind) "
            "VALUES (%s, %s, %s, %s, %s, %s, 'makeup') RETURNING id",
            (p.org_id, ae["group_id"], teacher, body.lesson_date, body.start_time, body.end_time),
        )
        assert row is not None
        await execute(
            conn,
            "UPDATE absence_entitlements SET status = 'scheduled', makeup_lesson_id = %s WHERE id = %s",
            (row["id"], iid),
        )
        return await _one(conn, iid, cfg.makeup_lapses)


@router.post("/entitlements/{entitlement_id}/cancel", response_model=EntitlementOut, summary="Cancel a right")
async def cancel(
    entitlement_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> EntitlementOut:
    async with db.tx(p.session()) as conn:
        iid = await resolve(conn, "absence_entitlements", entitlement_id, what="entitlement")
        cfg = await load_settings(conn, p.org_id)
        ae = await fetch_one(
            conn, "SELECT status, makeup_lesson_id FROM absence_entitlements WHERE id = %s FOR UPDATE", (iid,)
        )
        assert ae is not None
        if ae["status"] not in ("open", "scheduled"):
            raise NotOpen(f"This right is already {ae['status']}")
        if ae["makeup_lesson_id"] is not None:
            await execute(
                conn, "UPDATE lessons SET status = 'cancelled' WHERE id = %s", (ae["makeup_lesson_id"],)
            )
        await execute(conn, "UPDATE absence_entitlements SET status = 'cancelled' WHERE id = %s", (iid,))
        return await _one(conn, iid, cfg.makeup_lapses)
