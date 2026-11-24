"""Teacher payroll: generate a draft from lessons/fees, adjust with bonus/penalty lines, approve, mark paid.

Generated lines ('base', 'lesson') are recomputed on regeneration; manual lines ('bonus', 'penalty',
'adjustment') are preserved. After approval the database freezes all lines.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import Field, model_validator

from nazoratly.accounting import post_payroll
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.finance import month_start, next_month
from nazoratly.schemas import Dec2, LongText, Model, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["payroll"], route_class=IdempotentRoute)

PayrollStatus = Literal["draft", "approved", "paid"]


class GeneratePayrollIn(Model):
    teacher_id: uuid.UUID
    month: date = Field(description="any date inside the month")


class ItemIn(Model):
    kind: Literal["bonus", "penalty", "adjustment"]
    amount: Annotated[Decimal, Field(max_digits=14, decimal_places=2)] = Field(
        description="bonus/penalty: positive number (a penalty is stored as a deduction); adjustment: signed, non-zero"
    )
    description: LongText | None = None

    @model_validator(mode="after")
    def _sign(self) -> ItemIn:
        if self.amount == 0:
            raise ValueError("amount cannot be zero")
        if self.kind in ("bonus", "penalty") and self.amount < 0:
            raise ValueError("bonus and penalty amounts are given as positive numbers")
        return self


class ItemOut(Out):
    id: uuid.UUID
    kind: str
    amount: Dec2
    description: str | None
    lesson_id: uuid.UUID | None


class PayrollOut(Out):
    id: uuid.UUID
    teacher_id: uuid.UUID
    teacher_name: str
    period_month: date
    status: str
    total: Dec2
    approved_at: datetime | None
    paid_at: datetime | None
    note: str | None


class PayrollDetail(PayrollOut):
    items: list[ItemOut]


_PAYROLL_SQL = (
    "SELECT tp.public_id AS id, t.public_id AS teacher_id, t.full_name AS teacher_name, tp.period_month, tp.status, v.total,"
    " tp.approved_at, tp.paid_at, tp.note FROM teacher_payrolls tp "
    "JOIN teachers t ON t.org_id = tp.org_id AND t.id = tp.teacher_id JOIN v_teacher_payroll_totals v ON v.payroll_id = tp.id"
)


async def _detail(conn: Conn, pid: int) -> PayrollDetail:
    row = await fetch_one(conn, f"{_PAYROLL_SQL} WHERE tp.id = %s", (pid,))
    if row is None:
        raise NotFound("payroll not found")
    items = await fetch_all(
        conn,
        "SELECT pi.public_id AS id, pi.kind, pi.amount, pi.description, l.public_id AS lesson_id FROM payroll_items pi "
        "LEFT JOIN lessons l ON l.org_id = pi.org_id AND l.id = pi.lesson_id WHERE pi.payroll_id = %s ORDER BY pi.id",
        (pid,),
    )
    return PayrollDetail(
        **PayrollOut.model_validate(row).model_dump(), items=[ItemOut.model_validate(i) for i in items]
    )


async def _draft(conn: Conn, payroll_public: uuid.UUID) -> int:
    pid = await resolve(conn, "teacher_payrolls", payroll_public, what="payroll")
    cur = await fetch_one(conn, "SELECT status FROM teacher_payrolls WHERE id = %s FOR UPDATE", (pid,))
    assert cur is not None
    if cur["status"] != "draft":
        raise Conflict(f"Payroll is {cur['status']}; only drafts can be changed")
    return pid


@router.post(
    "/payrolls/generate",
    response_model=PayrollDetail,
    summary="Create or recompute a teacher's draft payroll for a month",
)
async def generate_payroll(
    body: GeneratePayrollIn, p: Annotated[Principal, Depends(require("payroll:write"))], db: DB
) -> PayrollDetail:
    first, nxt = month_start(body.month), next_month(month_start(body.month))
    async with db.tx(p.session()) as conn:
        tid = await resolve(conn, "teachers", body.teacher_id, what="teacher")
        teacher = await fetch_one(conn, "SELECT pay_model, pay_rate FROM teachers WHERE id = %s", (tid,))
        assert teacher is not None
        pay = await fetch_one(
            conn,
            "INSERT INTO teacher_payrolls (org_id, teacher_id, period_month) VALUES (%s, %s, %s) "
            "ON CONFLICT (teacher_id, period_month) DO UPDATE SET teacher_id = EXCLUDED.teacher_id RETURNING id, status",
            (p.org_id, tid, first),
        )
        assert pay is not None
        pid = pay["id"]
        await fetch_one(conn, "SELECT 1 AS x FROM teacher_payrolls WHERE id = %s FOR UPDATE", (pid,))
        if pay["status"] != "draft":
            raise Conflict(f"Payroll for this month is already {pay['status']}")
        await execute(
            conn, "DELETE FROM payroll_items WHERE payroll_id = %s AND kind IN ('base', 'lesson')", (pid,)
        )
        rate: Decimal = teacher["pay_rate"]
        if teacher["pay_model"] == "fixed" and rate > 0:
            await execute(
                conn,
                "INSERT INTO payroll_items (org_id, payroll_id, kind, amount, description) VALUES (%s, %s, 'base', %s, %s)",
                (p.org_id, pid, rate, f"Fixed salary {first:%Y-%m}"),
            )
        elif teacher["pay_model"] == "per_lesson" and rate > 0:
            await execute(
                conn,
                "INSERT INTO payroll_items (org_id, payroll_id, kind, lesson_id, amount, description) "
                "SELECT l.org_id, %(pid)s, 'lesson', l.id, %(rate)s, 'Lesson ' || l.lesson_date::text || ' ' || g.name "
                "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
                "WHERE l.status = 'held' AND l.lesson_date >= %(f)s AND l.lesson_date < %(n)s "
                "AND (l.kind <> 'makeup' OR EXISTS (SELECT 1 FROM attendance a WHERE a.lesson_id = l.id AND a.status IN ('present', 'late'))) "
                "AND COALESCE(l.substitute_teacher_id, l.teacher_id, g.teacher_id) = %(tid)s ORDER BY l.lesson_date, l.start_time, l.id",
                {"pid": pid, "rate": rate, "f": first, "n": nxt, "tid": tid},
            )
        elif teacher["pay_model"] == "percent" and rate > 0:
            base = await fetch_one(
                conn,
                "SELECT COALESCE(sum(pa.amount), 0) AS collected FROM payment_allocations pa "
                "JOIN charges c ON c.org_id = pa.org_id AND c.id = pa.charge_id "
                "JOIN enrollments e ON e.org_id = c.org_id AND e.id = c.enrollment_id "
                "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
                "WHERE c.kind IN ('tuition', 'package') AND c.voided_at IS NULL AND c.period_month = %s AND g.teacher_id = %s",
                (first, tid),
            )
            assert base is not None
            share = (base["collected"] * rate / 100).quantize(Decimal("0.01"))
            if share > 0:
                await execute(
                    conn,
                    "INSERT INTO payroll_items (org_id, payroll_id, kind, amount, description) VALUES (%s, %s, 'base', %s, %s)",
                    (
                        p.org_id,
                        pid,
                        share,
                        f"{rate}% of tuition collected {first:%Y-%m} ({base['collected']})",
                    ),
                )
        return await _detail(conn, pid)


@router.get("/payrolls", response_model=Page[PayrollOut])
async def list_payrolls(
    p: Annotated[Principal, Depends(require("payroll:read"))],
    db: DB,
    pg: Paging,
    month: date | None = None,
    teacher_id: uuid.UUID | None = None,
    status: PayrollStatus | None = None,
) -> Page[PayrollOut]:
    where: list[str] = []
    params: list[Any] = []
    if month:
        where.append("tp.period_month = %s")
        params.append(month_start(month))
    if teacher_id:
        where.append("t.public_id = %s")
        params.append(teacher_id)
    if status:
        where.append("tp.status = %s")
        params.append(status)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_PAYROLL_SQL} WHERE {' AND '.join(where) or 'TRUE'} ORDER BY tp.period_month DESC, lower(t.full_name), tp.id LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, PayrollOut)


@router.get("/payrolls/{payroll_id}", response_model=PayrollDetail)
async def get_payroll(
    payroll_id: uuid.UUID, p: Annotated[Principal, Depends(require("payroll:read"))], db: DB
) -> PayrollDetail:
    async with db.tx(p.session()) as conn:
        return await _detail(conn, await resolve(conn, "teacher_payrolls", payroll_id, what="payroll"))


@router.post(
    "/payrolls/{payroll_id}/items",
    response_model=PayrollDetail,
    status_code=201,
    summary="Add a bonus/penalty/adjustment line",
)
async def add_item(
    payroll_id: uuid.UUID, body: ItemIn, p: Annotated[Principal, Depends(require("payroll:write"))], db: DB
) -> PayrollDetail:
    amount = -body.amount if body.kind == "penalty" else body.amount
    async with db.tx(p.session()) as conn:
        pid = await _draft(conn, payroll_id)
        await execute(
            conn,
            "INSERT INTO payroll_items (org_id, payroll_id, kind, amount, description) VALUES (%s, %s, %s, %s, %s)",
            (p.org_id, pid, body.kind, amount, body.description),
        )
        return await _detail(conn, pid)


@router.delete("/payrolls/{payroll_id}/items/{item_id}", response_model=PayrollDetail)
async def remove_item(
    payroll_id: uuid.UUID,
    item_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("payroll:write"))],
    db: DB,
) -> PayrollDetail:
    async with db.tx(p.session()) as conn:
        pid = await _draft(conn, payroll_id)
        iid = await resolve(conn, "payroll_items", item_id, what="item")
        n = await execute(conn, "DELETE FROM payroll_items WHERE id = %s AND payroll_id = %s", (iid, pid))
        if n == 0:
            raise NotFound("item not found in this payroll")
        return await _detail(conn, pid)


@router.post(
    "/payrolls/{payroll_id}/approve",
    response_model=PayrollDetail,
    summary="Approve a draft (freezes its lines)",
)
async def approve(
    payroll_id: uuid.UUID, p: Annotated[Principal, Depends(require("payroll:approve"))], db: DB
) -> PayrollDetail:
    async with db.tx(p.session()) as conn:
        pid = await _draft(conn, payroll_id)
        tot = await fetch_one(
            conn,
            "SELECT count(*) AS n, COALESCE(sum(amount), 0) AS total FROM payroll_items WHERE payroll_id = %s",
            (pid,),
        )
        assert tot is not None
        if tot["n"] == 0:
            raise Unprocessable("Payroll has no lines")
        if tot["total"] <= 0:
            raise Unprocessable("Payroll total must be positive")
        await execute(
            conn,
            "UPDATE teacher_payrolls SET status = 'approved', approved_by_user_id = %s, approved_at = now() WHERE id = %s",
            (p.user_id, pid),
        )
        await post_payroll(conn, p.org_id, p.user_id, pid, "payroll_accrual")
        return await _detail(conn, pid)


@router.post(
    "/payrolls/{payroll_id}/pay", response_model=PayrollDetail, summary="Mark an approved payroll as paid"
)
async def mark_paid(
    payroll_id: uuid.UUID, p: Annotated[Principal, Depends(require("payroll:write"))], db: DB
) -> PayrollDetail:
    async with db.tx(p.session()) as conn:
        pid = await resolve(conn, "teacher_payrolls", payroll_id, what="payroll")
        cur = await fetch_one(conn, "SELECT status FROM teacher_payrolls WHERE id = %s FOR UPDATE", (pid,))
        assert cur is not None
        if cur["status"] != "approved":
            raise Conflict(f"Payroll is {cur['status']}; only approved payrolls can be paid")
        await execute(
            conn, "UPDATE teacher_payrolls SET status = 'paid', paid_at = now() WHERE id = %s", (pid,)
        )
        await post_payroll(conn, p.org_id, p.user_id, pid, "payroll_payment")
        return await _detail(conn, pid)
