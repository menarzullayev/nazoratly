"""Charges, payments, allocations (= debt), expenses and financial reports.

Debt is derived: charges minus payment allocations. Money is never deleted: charges/payments/expenses are voided
with a reason; allocations are the only rows removed (they are links). Allocation locks payment first, then charges
ordered by (due_date, id), so concurrent allocations serialise instead of deadlocking.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field, StringConstraints, model_validator

from nazoratly.db import Conn, execute, fetch_all, fetch_one, patch_row, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.schemas import Dec2, LongText, Model, Money, Out, Page, PositiveMoney, make_page

router = APIRouter(prefix="/v1", tags=["finance"], route_class=IdempotentRoute)

ChargeKind = Literal["tuition", "registration", "materials", "other"]
PayMethod = Literal["cash", "card", "bank_transfer", "payme", "click", "other"]
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=500)]
ExpenseCategory = Literal["rent", "utilities", "salary", "marketing", "equipment", "tax", "other"]
ZERO = Decimal(0)


def month_start(d: date) -> date:
    return d.replace(day=1)


def next_month(d: date) -> date:
    return date(d.year + (d.month == 12), d.month % 12 + 1, 1)


# ---- charges -------------------------------------------------------------------------------------------------
class ChargeIn(Model):
    student_id: uuid.UUID
    kind: ChargeKind
    period_month: date = Field(description="any date inside the billed month")
    amount: PositiveMoney
    due_date: date
    description: LongText | None = None
    enrollment_id: uuid.UUID | None = None


class ChargePatch(Model):
    amount: PositiveMoney | None = None
    due_date: date | None = None
    description: LongText | None = None


class VoidIn(Model):
    reason: Reason
    release_allocations: bool = Field(
        default=False, description="also remove payment allocations (returns the money to the payer's credit)"
    )


class ChargeOut(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    kind: str
    period_month: date
    description: str | None
    amount: Dec2
    due_date: date
    paid: Dec2
    outstanding: Dec2
    voided: bool
    void_reason: str | None


class GenerateChargesIn(Model):
    month: date = Field(description="any date inside the month to bill")
    due_day: Annotated[int, Field(ge=1, le=28)] = 10
    group_id: uuid.UUID | None = None


class GenerateChargesOut(Out):
    month: date
    created: int
    skipped_existing: int
    skipped_zero_fee: int


_CHARGE_SQL = (
    "SELECT c.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, c.kind, c.period_month, c.description,"
    " c.amount, c.due_date, COALESCE(a.paid, 0) AS paid, c.amount - COALESCE(a.paid, 0) AS outstanding,"
    " (c.voided_at IS NOT NULL) AS voided, c.void_reason "
    "FROM charges c JOIN students s ON s.org_id = c.org_id AND s.id = c.student_id "
    "LEFT JOIN LATERAL (SELECT sum(pa.amount) AS paid FROM payment_allocations pa WHERE pa.charge_id = c.id) a ON TRUE"
)


async def _charge(conn: Conn, cid: int) -> ChargeOut:
    row = await fetch_one(conn, f"{_CHARGE_SQL} WHERE c.id = %s", (cid,))
    assert row is not None
    return ChargeOut.model_validate(row)


@router.post("/charges", response_model=ChargeOut, status_code=201)
async def create_charge(
    body: ChargeIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> ChargeOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", body.student_id, what="student")
        eid = await resolve_opt(conn, "enrollments", body.enrollment_id, what="enrollment")
        row = await fetch_one(
            conn,
            "INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, description, amount, due_date, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                sid,
                eid,
                body.kind,
                month_start(body.period_month),
                body.description,
                body.amount,
                body.due_date,
                p.user_id,
            ),
        )
        assert row is not None
        return await _charge(conn, row["id"])


@router.post(
    "/charges/generate",
    response_model=GenerateChargesOut,
    summary="Bill monthly tuition (idempotent per enrollment+month)",
)
async def generate_charges(
    body: GenerateChargesIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> GenerateChargesOut:
    first = month_start(body.month)
    nxt = next_month(first)
    due = first.replace(day=body.due_day)
    async with db.tx(p.session()) as conn:
        gid = await resolve_opt(conn, "study_groups", body.group_id, what="group")
        rows = await fetch_all(
            conn,
            "SELECT e.id AS enrollment_id, e.student_id, round(COALESCE(e.monthly_fee_override, g.monthly_fee) * (1 - e.discount_percent / 100), 2) AS fee "
            "FROM enrollments e JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
            "JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
            "WHERE e.status IN ('active', 'finished') AND e.started_on < %(nxt)s AND (e.ended_on IS NULL OR e.ended_on >= %(first)s) "
            "AND g.deleted_at IS NULL AND g.status <> 'cancelled' AND s.deleted_at IS NULL AND (%(gid)s::bigint IS NULL OR e.group_id = %(gid)s) "
            "ORDER BY e.id",
            {"nxt": nxt, "first": first, "gid": gid},
        )
        created = existing = zero = 0
        for r in rows:
            if r["fee"] <= 0:
                zero += 1
                continue
            cur = await conn.execute(
                "INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, description, amount, due_date, created_by_user_id) "
                "VALUES (%s, %s, %s, 'tuition', %s, %s, %s, %s, %s) "
                "ON CONFLICT (enrollment_id, period_month) WHERE kind = 'tuition' AND voided_at IS NULL DO NOTHING",
                (
                    p.org_id,
                    r["student_id"],
                    r["enrollment_id"],
                    first,
                    f"Tuition {first:%Y-%m}",
                    r["fee"],
                    due,
                    p.user_id,
                ),
            )
            created += cur.rowcount
            existing += 1 - cur.rowcount
    return GenerateChargesOut(month=first, created=created, skipped_existing=existing, skipped_zero_fee=zero)


@router.get("/charges", response_model=Page[ChargeOut])
async def list_charges(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    pg: Paging,
    student_id: uuid.UUID | None = None,
    month: date | None = None,
    state: Literal["open", "settled", "overdue", "voided", "all"] = "all",
) -> Page[ChargeOut]:
    where: list[str] = []
    params: list[Any] = []
    if student_id:
        where.append("s.public_id = %s")
        params.append(student_id)
    if month:
        where.append("c.period_month = %s")
        params.append(month_start(month))
    if state == "voided":
        where.append("c.voided_at IS NOT NULL")
    else:
        where.append("c.voided_at IS NULL")
        if state == "open":
            where.append("c.amount - COALESCE(a.paid, 0) > 0")
        elif state == "settled":
            where.append("c.amount - COALESCE(a.paid, 0) = 0")
        elif state == "overdue":
            where.append("c.amount - COALESCE(a.paid, 0) > 0 AND c.due_date < CURRENT_DATE")
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_CHARGE_SQL} WHERE {' AND '.join(where) or 'TRUE'} ORDER BY c.due_date DESC, c.id DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, ChargeOut)


@router.get("/charges/{charge_id}", response_model=ChargeOut)
async def get_charge(
    charge_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> ChargeOut:
    async with db.tx(p.session()) as conn:
        return await _charge(conn, await resolve(conn, "charges", charge_id, what="charge"))


@router.patch("/charges/{charge_id}", response_model=ChargeOut)
async def patch_charge(
    charge_id: uuid.UUID,
    body: ChargePatch,
    p: Annotated[Principal, Depends(require("finance:write"))],
    db: DB,
) -> ChargeOut:
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "charges", charge_id, what="charge")
        cur = await fetch_one(conn, "SELECT voided_at FROM charges WHERE id = %s FOR UPDATE", (cid,))
        assert cur is not None
        if cur["voided_at"] is not None:
            raise Conflict("Charge is voided")
        await patch_row(
            conn, "charges", cid, body.model_dump(exclude_unset=True)
        )  # trigger: amount >= allocated
        return await _charge(conn, cid)


@router.post("/charges/{charge_id}/void", response_model=ChargeOut)
async def void_charge(
    charge_id: uuid.UUID, body: VoidIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> ChargeOut:
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "charges", charge_id, what="charge")
        cur = await fetch_one(conn, "SELECT voided_at FROM charges WHERE id = %s FOR UPDATE", (cid,))
        assert cur is not None
        if cur["voided_at"] is not None:
            raise Conflict("Charge is already voided")
        alloc = await fetch_one(
            conn, "SELECT COALESCE(sum(amount), 0) AS s FROM payment_allocations WHERE charge_id = %s", (cid,)
        )
        assert alloc is not None
        if alloc["s"] > 0:
            if not body.release_allocations:
                raise Conflict(
                    "Charge has payments allocated; set release_allocations to void it",
                    details={"allocated": str(alloc["s"])},
                )
            await execute(conn, "DELETE FROM payment_allocations WHERE charge_id = %s", (cid,))
        await execute(
            conn, "UPDATE charges SET voided_at = now(), void_reason = %s WHERE id = %s", (body.reason, cid)
        )
        return await _charge(conn, cid)


# ---- payments ------------------------------------------------------------------------------------------------
class AllocationIn(Model):
    charge_id: uuid.UUID
    amount: PositiveMoney


class PaymentIn(Model):
    student_id: uuid.UUID
    amount: PositiveMoney
    method: PayMethod
    paid_at: datetime | None = None
    external_ref: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)] | None
    ) = None
    payer_guardian_id: uuid.UUID | None = None
    note: LongText | None = None
    auto_allocate: bool = Field(
        default=True, description="apply to the oldest open charges when no explicit allocations are given"
    )
    allocations: list[AllocationIn] | None = None

    @model_validator(mode="after")
    def _paid_at_tz(self) -> PaymentIn:
        if self.paid_at is not None and self.paid_at.tzinfo is None:
            raise ValueError("paid_at must include a time zone offset")
        if self.allocations and sum((a.amount for a in self.allocations), ZERO) > self.amount:
            raise ValueError("allocations exceed the payment amount")
        return self


class AllocateIn(Model):
    allocations: list[AllocationIn] | None = None
    auto: bool = False

    @model_validator(mode="after")
    def _one(self) -> AllocateIn:
        if bool(self.allocations) == self.auto:
            raise ValueError("provide either allocations or auto=true")
        return self


class AllocationOut(Out):
    charge_id: uuid.UUID
    amount: Dec2
    period_month: date
    kind: str


class PaymentOut(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    amount: Dec2
    method: str
    paid_at: datetime
    external_ref: str | None
    note: str | None
    payer_guardian_id: uuid.UUID | None
    voided: bool
    void_reason: str | None
    allocated: Dec2
    unallocated: Dec2
    allocations: list[AllocationOut] = []


_PAY_SQL = (
    "SELECT p.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, p.amount, p.method, p.paid_at, p.external_ref,"
    " p.note, gu.public_id AS payer_guardian_id, (p.voided_at IS NOT NULL) AS voided, p.void_reason,"
    " COALESCE(a.allocated, 0) AS allocated, p.amount - COALESCE(a.allocated, 0) AS unallocated "
    "FROM payments p JOIN students s ON s.org_id = p.org_id AND s.id = p.student_id "
    "LEFT JOIN guardians gu ON gu.org_id = p.org_id AND gu.id = p.payer_guardian_id "
    "LEFT JOIN LATERAL (SELECT sum(pa.amount) AS allocated FROM payment_allocations pa WHERE pa.payment_id = p.id) a ON TRUE"
)


async def _payment(conn: Conn, pid: int, *, with_allocations: bool = True) -> PaymentOut:
    row = await fetch_one(conn, f"{_PAY_SQL} WHERE p.id = %s", (pid,))
    assert row is not None
    allocs: list[dict[str, Any]] = []
    if with_allocations:
        allocs = await fetch_all(
            conn,
            "SELECT c.public_id AS charge_id, pa.amount, c.period_month, c.kind FROM payment_allocations pa "
            "JOIN charges c ON c.org_id = pa.org_id AND c.id = pa.charge_id WHERE pa.payment_id = %s ORDER BY c.due_date, c.id",
            (pid,),
        )
    return PaymentOut(**{**row, "allocations": [AllocationOut.model_validate(a) for a in allocs]})


async def _insert_allocation(
    conn: Conn, org_id: int, payment_id: int, charge_id: int, amount: Decimal
) -> None:
    await execute(
        conn,
        "INSERT INTO payment_allocations (org_id, payment_id, charge_id, amount) VALUES (%s, %s, %s, %s) "
        "ON CONFLICT (payment_id, charge_id) DO UPDATE SET amount = payment_allocations.amount + EXCLUDED.amount",
        (org_id, payment_id, charge_id, amount),
    )


async def allocate_fifo(conn: Conn, org_id: int, payment_id: int) -> Decimal:
    """Apply a payment's unallocated remainder to the student's oldest open charges. Returns the amount applied."""
    pay = await fetch_one(
        conn, "SELECT student_id, amount, voided_at FROM payments WHERE id = %s FOR UPDATE", (payment_id,)
    )
    assert pay is not None
    if pay["voided_at"] is not None:
        raise Conflict("Payment is voided")
    done = await fetch_one(
        conn,
        "SELECT COALESCE(sum(amount), 0) AS s FROM payment_allocations WHERE payment_id = %s",
        (payment_id,),
    )
    assert done is not None
    remaining: Decimal = pay["amount"] - done["s"]
    # 1) lock the student's charges in a fixed order; 2) read outstanding in a NEW statement. Under READ COMMITTED a
    # statement waiting on a row lock keeps its old snapshot, so computing balances in the locking query would miss
    # allocations committed by the transaction we waited for.
    await execute(
        conn,
        "SELECT id FROM charges WHERE student_id = %s AND voided_at IS NULL ORDER BY due_date, id FOR UPDATE",
        (pay["student_id"],),
    )
    charges = await fetch_all(
        conn,
        "SELECT c.id, c.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.charge_id = c.id), 0) AS outstanding "
        "FROM charges c WHERE c.student_id = %s AND c.voided_at IS NULL ORDER BY c.due_date, c.id",
        (pay["student_id"],),
    )
    applied = ZERO
    for c in charges:
        if remaining <= 0:
            break
        take = min(remaining, c["outstanding"])
        if take > 0:
            await _insert_allocation(conn, org_id, payment_id, c["id"], take)
            remaining -= take
            applied += take
    return applied


@router.post(
    "/payments",
    response_model=PaymentOut,
    status_code=201,
    summary="Record a payment (idempotent by method + external_ref)",
)
async def create_payment(
    body: PaymentIn, response: Response, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> PaymentOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", body.student_id, what="student")
        gid = await resolve_opt(conn, "guardians", body.payer_guardian_id, what="guardian")
        row = await fetch_one(
            conn,
            "INSERT INTO payments (org_id, student_id, payer_guardian_id, amount, method, paid_at, external_ref, note, received_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, COALESCE(%s, now()), %s, %s, %s) "
            "ON CONFLICT (org_id, method, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id",
            (
                p.org_id,
                sid,
                gid,
                body.amount,
                body.method,
                body.paid_at,
                body.external_ref,
                body.note,
                p.user_id,
            ),
        )
        if row is None:  # same online payment delivered again: return the original, never a second one
            prev = await fetch_one(
                conn,
                "SELECT id, student_id, amount FROM payments WHERE method = %s AND external_ref = %s",
                (body.method, body.external_ref),
            )
            assert prev is not None
            if prev["student_id"] != sid or prev["amount"] != body.amount:
                raise Conflict("external_ref was already used for a different payment")
            response.status_code = 200
            return await _payment(conn, prev["id"])
        pid = row["id"]
        if body.allocations:
            for a in sorted(body.allocations, key=lambda x: str(x.charge_id)):
                cid = await resolve(conn, "charges", a.charge_id, what="charge")
                await _insert_allocation(conn, p.org_id, pid, cid, a.amount)
        elif body.auto_allocate:
            await allocate_fifo(conn, p.org_id, pid)
        return await _payment(conn, pid)


@router.get("/payments", response_model=Page[PaymentOut])
async def list_payments(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    pg: Paging,
    student_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    method: PayMethod | None = None,
    include_voided: bool = False,
) -> Page[PaymentOut]:
    where: list[str] = []
    params: list[Any] = []
    if not include_voided:
        where.append("p.voided_at IS NULL")
    if student_id:
        where.append("s.public_id = %s")
        params.append(student_id)
    if method:
        where.append("p.method = %s")
        params.append(method)
    if date_from:
        where.append(
            "p.paid_at >= (%s::date::timestamp AT TIME ZONE (SELECT timezone FROM organizations WHERE id = p.org_id))"
        )
        params.append(date_from)
    if date_to:
        where.append(
            "p.paid_at < ((%s::date + 1)::timestamp AT TIME ZONE (SELECT timezone FROM organizations WHERE id = p.org_id))"
        )
        params.append(date_to)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_PAY_SQL} WHERE {' AND '.join(where) or 'TRUE'} ORDER BY p.paid_at DESC, p.id DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, PaymentOut)


@router.get("/payments/{payment_id}", response_model=PaymentOut)
async def get_payment(
    payment_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> PaymentOut:
    async with db.tx(p.session()) as conn:
        return await _payment(conn, await resolve(conn, "payments", payment_id, what="payment"))


@router.post(
    "/payments/{payment_id}/allocate",
    response_model=PaymentOut,
    summary="Allocate (more of) a payment to charges",
)
async def allocate_payment(
    payment_id: uuid.UUID,
    body: AllocateIn,
    p: Annotated[Principal, Depends(require("finance:write"))],
    db: DB,
) -> PaymentOut:
    async with db.tx(p.session()) as conn:
        pid = await resolve(conn, "payments", payment_id, what="payment")
        if body.auto:
            await allocate_fifo(conn, p.org_id, pid)
        else:
            await fetch_one(conn, "SELECT 1 AS x FROM payments WHERE id = %s FOR UPDATE", (pid,))
            for a in sorted(body.allocations or [], key=lambda x: str(x.charge_id)):
                cid = await resolve(conn, "charges", a.charge_id, what="charge")
                await _insert_allocation(conn, p.org_id, pid, cid, a.amount)
        return await _payment(conn, pid)


@router.delete("/payments/{payment_id}/allocations/{charge_id}", response_model=PaymentOut)
async def remove_allocation(
    payment_id: uuid.UUID,
    charge_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("finance:write"))],
    db: DB,
) -> PaymentOut:
    async with db.tx(p.session()) as conn:
        pid = await resolve(conn, "payments", payment_id, what="payment")
        cid = await resolve(conn, "charges", charge_id, what="charge")
        n = await execute(
            conn, "DELETE FROM payment_allocations WHERE payment_id = %s AND charge_id = %s", (pid, cid)
        )
        if n == 0:
            raise NotFound("allocation not found")
        return await _payment(conn, pid)


@router.post(
    "/payments/{payment_id}/void",
    response_model=PaymentOut,
    summary="Void a payment (its allocations are released)",
)
async def void_payment(
    payment_id: uuid.UUID, body: VoidIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> PaymentOut:
    async with db.tx(p.session()) as conn:
        pid = await resolve(conn, "payments", payment_id, what="payment")
        cur = await fetch_one(conn, "SELECT voided_at FROM payments WHERE id = %s FOR UPDATE", (pid,))
        assert cur is not None
        if cur["voided_at"] is not None:
            raise Conflict("Payment is already voided")
        await execute(conn, "DELETE FROM payment_allocations WHERE payment_id = %s", (pid,))
        await execute(
            conn, "UPDATE payments SET voided_at = now(), void_reason = %s WHERE id = %s", (body.reason, pid)
        )
        return await _payment(conn, pid)


@router.post(
    "/students/{student_id}/allocate-credit",
    response_model=list[PaymentOut],
    summary="Apply a student's unallocated payments to open charges",
)
async def allocate_credit(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> list[PaymentOut]:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        pays = await fetch_all(
            conn,
            "SELECT p.id FROM payments p WHERE p.student_id = %s AND p.voided_at IS NULL "
            "AND p.amount > COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id = p.id), 0) ORDER BY p.paid_at, p.id",
            (sid,),
        )
        touched: list[PaymentOut] = []
        for r in pays:
            if await allocate_fifo(conn, p.org_id, r["id"]) > 0:
                touched.append(await _payment(conn, r["id"]))
    return touched


# ---- balances & debtors --------------------------------------------------------------------------------------
class OpenCharge(Out):
    id: uuid.UUID
    kind: str
    period_month: date
    due_date: date
    amount: Dec2
    paid: Dec2
    outstanding: Dec2
    overdue: bool


class StudentBalanceOut(Out):
    student_id: uuid.UUID
    outstanding_total: Dec2
    overdue_total: Dec2
    credit: Dec2
    open_charges: list[OpenCharge]


@router.get("/students/{student_id}/balance", response_model=StudentBalanceOut)
async def student_balance(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> StudentBalanceOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        bal = await fetch_one(
            conn,
            "SELECT outstanding_total, overdue_total, credit FROM v_student_balance WHERE student_id = %s",
            (sid,),
        )
        assert bal is not None
        charges = await fetch_all(
            conn,
            "SELECT c.public_id AS id, b.kind, b.period_month, b.due_date, b.amount, b.paid, b.outstanding, (b.due_date < CURRENT_DATE) AS overdue "
            "FROM v_charge_balance b JOIN charges c ON c.id = b.charge_id WHERE b.student_id = %s AND b.outstanding > 0 ORDER BY b.due_date, b.charge_id",
            (sid,),
        )
    return StudentBalanceOut(
        student_id=student_id, **bal, open_charges=[OpenCharge.model_validate(c) for c in charges]
    )


class DebtorRow(Out):
    student_id: uuid.UUID
    student_name: str
    phone: str | None
    open_charges: int
    overdue_total: Dec2
    outstanding_total: Dec2
    oldest_due_date: date
    max_days_overdue: int


@router.get("/reports/debtors", response_model=list[DebtorRow], summary="Students with overdue debt")
async def debtors(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    min_days_overdue: Annotated[int, Query(ge=0, le=3650)] = 1,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[DebtorRow]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            "SELECT s.public_id AS student_id, s.full_name AS student_name, s.phone, count(*) AS open_charges,"
            " sum(b.outstanding) FILTER (WHERE b.due_date < CURRENT_DATE) AS overdue_total, sum(b.outstanding) AS outstanding_total,"
            " min(b.due_date) AS oldest_due_date, (CURRENT_DATE - min(b.due_date)) AS max_days_overdue "
            "FROM v_charge_balance b JOIN students s ON s.org_id = b.org_id AND s.id = b.student_id "
            "WHERE b.outstanding > 0 AND s.deleted_at IS NULL GROUP BY s.id "
            "HAVING (CURRENT_DATE - min(b.due_date)) >= %s AND min(b.due_date) < CURRENT_DATE "
            "ORDER BY overdue_total DESC NULLS LAST, s.id LIMIT %s",
            (min_days_overdue, limit),
        )
    return [DebtorRow.model_validate(r) for r in rows]


# ---- expenses ------------------------------------------------------------------------------------------------
class ExpenseIn(Model):
    category: ExpenseCategory
    amount: PositiveMoney
    spent_at: date
    description: LongText | None = None
    branch_id: uuid.UUID | None = None


class ExpenseOut(Out):
    id: uuid.UUID
    category: str
    amount: Dec2
    spent_at: date
    description: str | None
    branch_id: uuid.UUID | None
    voided: bool
    void_reason: str | None


_EXP_SQL = (
    "SELECT e.public_id AS id, e.category, e.amount, e.spent_at, e.description, b.public_id AS branch_id,"
    " (e.voided_at IS NOT NULL) AS voided, e.void_reason FROM expenses e LEFT JOIN branches b ON b.org_id = e.org_id AND b.id = e.branch_id"
)


@router.post("/expenses", response_model=ExpenseOut, status_code=201)
async def create_expense(
    body: ExpenseIn, p: Annotated[Principal, Depends(require("expenses:write"))], db: DB
) -> ExpenseOut:
    async with db.tx(p.session()) as conn:
        bid = await resolve_opt(conn, "branches", body.branch_id, what="branch")
        row = await fetch_one(
            conn,
            "INSERT INTO expenses (org_id, branch_id, category, amount, spent_at, description, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, bid, body.category, body.amount, body.spent_at, body.description, p.user_id),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_EXP_SQL} WHERE e.id = %s", (row["id"],))
    assert out is not None
    return ExpenseOut.model_validate(out)


@router.get("/expenses", response_model=Page[ExpenseOut])
async def list_expenses(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    pg: Paging,
    date_from: date | None = None,
    date_to: date | None = None,
    category: ExpenseCategory | None = None,
    include_voided: bool = False,
) -> Page[ExpenseOut]:
    where: list[str] = []
    params: list[Any] = []
    if not include_voided:
        where.append("e.voided_at IS NULL")
    if date_from:
        where.append("e.spent_at >= %s")
        params.append(date_from)
    if date_to:
        where.append("e.spent_at <= %s")
        params.append(date_to)
    if category:
        where.append("e.category = %s")
        params.append(category)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_EXP_SQL} WHERE {' AND '.join(where) or 'TRUE'} ORDER BY e.spent_at DESC, e.id DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, ExpenseOut)


@router.post("/expenses/{expense_id}/void", response_model=ExpenseOut)
async def void_expense(
    expense_id: uuid.UUID, body: VoidIn, p: Annotated[Principal, Depends(require("expenses:write"))], db: DB
) -> ExpenseOut:
    async with db.tx(p.session()) as conn:
        eid = await resolve(conn, "expenses", expense_id, what="expense")
        cur = await fetch_one(conn, "SELECT voided_at FROM expenses WHERE id = %s FOR UPDATE", (eid,))
        assert cur is not None
        if cur["voided_at"] is not None:
            raise Conflict("Expense is already voided")
        await execute(
            conn, "UPDATE expenses SET voided_at = now(), void_reason = %s WHERE id = %s", (body.reason, eid)
        )
        out = await fetch_one(conn, f"{_EXP_SQL} WHERE e.id = %s", (eid,))
    assert out is not None
    return ExpenseOut.model_validate(out)


# ---- reports -------------------------------------------------------------------------------------------------
class RevenuePoint(Out):
    period: date
    method: str
    payments_count: int
    total: Dec2


@router.get(
    "/reports/revenue",
    response_model=list[RevenuePoint],
    summary="Received money by day or month (center time zone)",
)
async def revenue(
    p: Annotated[Principal, Depends(require("reports:read"))],
    db: DB,
    date_from: date,
    date_to: date,
    group_by: Literal["day", "month"] = "day",
) -> list[RevenuePoint]:
    if date_to < date_from or (date_to - date_from).days > 1830:
        raise Unprocessable("date range must be 0-1830 days")
    trunc = "day" if group_by == "day" else "month"
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"SELECT date_trunc('{trunc}', day)::date AS period, method, sum(payments_count)::int AS payments_count, sum(total) AS total "
            "FROM v_daily_revenue WHERE day BETWEEN %s AND %s GROUP BY 1, 2 ORDER BY 1, 2",
            (date_from, date_to),
        )
    return [RevenuePoint.model_validate(r) for r in rows]


class SummaryOut(Out):
    month: date
    charged: Dec2 = Field(description="tuition and other charges billed for the month (not voided)")
    revenue: Dec2 = Field(description="payments received during the month (not voided)")
    outstanding_now: Dec2 = Field(description="all open receivables right now, any month")
    overdue_now: Dec2
    expenses: Dec2 = Field(description="operating expenses of the month (not voided)")
    payroll: Dec2 = Field(description="teacher payroll of the month in status approved or paid")
    net: Dec2 = Field(description="revenue - expenses - payroll")


@router.get("/reports/summary", response_model=SummaryOut, summary="Monthly financial summary")
async def summary(
    p: Annotated[Principal, Depends(require("reports:read"))], db: DB, month: date
) -> SummaryOut:
    first = month_start(month)
    nxt = next_month(first)
    async with db.tx(p.session()) as conn:
        row = await fetch_one(
            conn,
            "SELECT"
            " (SELECT COALESCE(sum(amount), 0) FROM charges WHERE period_month = %(f)s AND voided_at IS NULL) AS charged,"
            " (SELECT COALESCE(sum(total), 0) FROM v_daily_revenue WHERE day >= %(f)s AND day < %(n)s) AS revenue,"
            " (SELECT COALESCE(sum(outstanding), 0) FROM v_charge_balance) AS outstanding_now,"
            " (SELECT COALESCE(sum(outstanding), 0) FROM v_charge_balance WHERE due_date < CURRENT_DATE) AS overdue_now,"
            " (SELECT COALESCE(sum(amount), 0) FROM expenses WHERE spent_at >= %(f)s AND spent_at < %(n)s AND voided_at IS NULL) AS expenses,"
            " (SELECT COALESCE(sum(total), 0) FROM v_teacher_payroll_totals WHERE period_month = %(f)s AND status IN ('approved','paid')) AS payroll",
            {"f": first, "n": nxt},
        )
    assert row is not None
    return SummaryOut(month=first, net=row["revenue"] - row["expenses"] - row["payroll"], **row)


_ = (Money, UTC)
