"""Refunds, four kinds, all through the journal (migration 0022).

  wrong_payment      a mistaken payment: money goes back in cash or to the bank (the payment is not voided)
  leaving            a student leaves: the month is charged for the days attended, the rest is refunded or kept as credit
  package_remainder  value of the unused lessons of a package, refunded or kept as credit
  to_credit          paid money kept as the student's credit, no cash moves

Cash and bank payouts post `Dr 4200 Qaytarilgan to'lovlar / Cr 1000|1010`; a payout that stays as credit moves no money
and posts nothing. Refunds are append-only. The rules (amounts, caps, which payouts are allowed) are in rules/money.py and
shared with the Sheets edition (tests/golden/money.json)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import Field, StringConstraints, model_validator

from nazoratly.accounting import org_today, post_refund
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.money import release_from_charge, release_from_payment, revoke_unearned_early
from nazoratly.packages import load_balances
from nazoratly.rules.money import leaving_split, package_remainder, refund_errors
from nazoratly.rules.packages import credited_lessons
from nazoratly.schemas import Dec2, Model, Out, Page, PositiveMoney

router = APIRouter(prefix="/v1", tags=["refunds"], route_class=IdempotentRoute)

Kind = Literal["wrong_payment", "leaving", "package_remainder", "to_credit"]
Payout = Literal["cash", "bank", "credit"]
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=500)]
ZERO = Decimal(0)


class RefundIn(Model):
    kind: Kind
    student_id: uuid.UUID
    payout: Payout = Field(
        description="cash or bank = money leaves; credit = it stays as the student's credit"
    )
    reason: Reason
    payment_id: uuid.UUID | None = Field(default=None, description="wrong_payment: the mistaken payment")
    amount: PositiveMoney | None = Field(
        default=None,
        description="wrong_payment: so'm to give back (default: all refundable); to_credit: so'm to move to credit",
    )
    charge_id: uuid.UUID | None = Field(default=None, description="leaving, to_credit: the tuition charge")
    left_on: date | None = Field(default=None, description="leaving: last day attended (default today)")
    package_id: uuid.UUID | None = Field(default=None, description="package_remainder: the package")

    @model_validator(mode="after")
    def _shape(self) -> RefundIn:
        need = {
            "wrong_payment": ("payment_id",),
            "leaving": ("charge_id",),
            "package_remainder": ("package_id",),
            "to_credit": ("charge_id", "amount"),
        }[self.kind]
        for name in need:
            if getattr(self, name) is None:
                raise ValueError(f"{name} is required for {self.kind}")
        allowed = {
            "payment_id": {"wrong_payment"},
            "charge_id": {"leaving", "to_credit"},
            "package_id": {"package_remainder"},
            "left_on": {"leaving"},
            "amount": {"wrong_payment", "to_credit"},
        }
        for name, kinds in allowed.items():
            if getattr(self, name) is not None and self.kind not in kinds:
                raise ValueError(f"{name} does not apply to {self.kind}")
        return self


class RefundPreview(Out):
    kind: str
    payout: str
    amount: Dec2 = Field(description="money that leaves (cash/bank) or becomes credit")
    charge_reduction: Dec2 = Field(description="how much the tuition charge shrinks")
    available: Dec2
    errors: list[str] = Field(description="empty when the refund can be made")


class RefundPaymentOut(Out):
    payment_id: uuid.UUID
    amount: Dec2


class RefundOut(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    kind: str
    payout: str
    amount: Dec2
    charge_reduction: Dec2
    charge_id: uuid.UUID | None
    payment_id: uuid.UUID | None
    package_id: uuid.UUID | None
    left_on: date | None
    reason: str
    refunded_on: date
    payments: list[RefundPaymentOut] = []


@dataclass
class Plan:
    kind: str
    payout: str
    student_id: int
    money: Decimal = ZERO
    reduction: Decimal = ZERO
    available: Decimal = ZERO
    charge_id: int | None = None
    payment_id: int | None = None
    package_id: int | None = None
    left_on: date | None = None
    errors: list[str] = field(default_factory=list)


async def _paid_on(conn: Conn, charge_id: int) -> Decimal:
    row = await fetch_one(
        conn,
        "SELECT COALESCE(sum(amount), 0) AS s FROM payment_allocations WHERE charge_id = %s",
        (charge_id,),
    )
    assert row is not None
    return Decimal(row["s"])


async def _live_charge(conn: Conn, charge_id: int, student_id: int, lock: bool) -> dict[str, Any]:
    c = await fetch_one(
        conn,
        "SELECT id, student_id, kind, period_month, amount, voided_at, early_discount, early_granted_at FROM charges "
        f"WHERE id = %s{' FOR UPDATE' if lock else ''}",
        (charge_id,),
    )
    assert c is not None
    if c["student_id"] != student_id:
        raise Unprocessable("the charge belongs to another student")
    if c["voided_at"] is not None:
        raise Conflict("The charge is voided")
    if await fetch_one(
        conn, "SELECT 1 AS x FROM charge_installments WHERE charge_id = %s LIMIT 1", (charge_id,)
    ):
        raise Conflict("The charge has a payment plan: remove the plan first")
    return c


async def _plan(conn: Conn, body: RefundIn, *, lock: bool) -> Plan:
    sid = await resolve(conn, "students", body.student_id, what="student")
    plan = Plan(body.kind, body.payout, sid)
    if body.kind == "wrong_payment":
        assert body.payment_id is not None
        plan.payment_id = await resolve(conn, "payments", body.payment_id, what="payment")
        pay = await fetch_one(
            conn,
            f"SELECT student_id, amount, refunded, voided_at FROM payments WHERE id = %s{' FOR UPDATE' if lock else ''}",
            (plan.payment_id,),
        )
        assert pay is not None
        if pay["student_id"] != sid:
            raise Unprocessable("the payment belongs to another student")
        if pay["voided_at"] is not None:
            raise Conflict("The payment is voided: nothing to give back")
        plan.available = pay["amount"] - pay["refunded"]
        plan.money = body.amount if body.amount is not None else plan.available
    elif body.kind == "leaving":
        assert body.charge_id is not None
        plan.charge_id = await resolve(conn, "charges", body.charge_id, what="charge")
        c = await _live_charge(conn, plan.charge_id, sid, lock)
        if c["kind"] != "tuition":
            raise Unprocessable("only a tuition charge can be reduced for a leaving student")
        if await fetch_one(
            conn, "SELECT 1 AS x FROM refunds WHERE kind = 'leaving' AND charge_id = %s", (plan.charge_id,)
        ):
            raise Conflict("A leaving refund was already made for this charge")
        plan.left_on = body.left_on or await org_today(conn)
        split = leaving_split(
            amount=c["amount"],
            paid=await _paid_on(conn, plan.charge_id),
            left_on=plan.left_on,
            month=c["period_month"],
        )
        plan.money, plan.reduction, plan.available = split.refund, split.reduction, split.refund
        if split.reduction <= 0:
            plan.errors.append("nothing_to_reduce")  # the student attended the whole month
        elif split.refund <= 0:
            plan.errors.append(
                "nothing_to_refund"
            )  # not paid beyond the used part: reduce the charge instead
    elif body.kind == "package_remainder":
        assert body.package_id is not None
        plan.package_id = await resolve(conn, "lesson_packages", body.package_id, what="package")
        pkg = await fetch_one(
            conn,
            "SELECT student_id, enrollment_id, charge_id, lessons, price FROM lesson_packages WHERE id = %s",
            (plan.package_id,),
        )
        assert pkg is not None
        plan.charge_id = int(pkg["charge_id"])
        await _live_charge(conn, plan.charge_id, sid, lock)
        paid = await _paid_on(conn, plan.charge_id)
        credited = credited_lessons(paid=paid, price=pkg["price"], lessons=pkg["lessons"])
        balances = await load_balances(
            conn,
            today=await org_today(conn),
            low_lessons=0,
            student_id=sid,
            statuses=("active", "frozen", "finished"),
        )
        mine = next((b for b in balances if b.enrollment_id == pkg["enrollment_id"]), None)
        remaining = min(mine.balance.available, credited) if mine else 0
        plan.money = package_remainder(
            price=pkg["price"],
            package_lessons=pkg["lessons"],
            remaining_lessons=remaining,
            paid=paid,
            keep_lessons=credited - remaining,
        )
        plan.reduction = plan.available = plan.money
        if plan.money <= 0:
            plan.errors.append("nothing_to_refund")
    else:  # to_credit
        assert body.charge_id is not None and body.amount is not None
        plan.charge_id = await resolve(conn, "charges", body.charge_id, what="charge")
        await _live_charge(conn, plan.charge_id, sid, lock)
        plan.available = await _paid_on(conn, plan.charge_id)
        plan.money = plan.reduction = body.amount
    if not plan.errors:  # a specific reason (nothing to reduce / refund) already explains why it is zero
        plan.errors += refund_errors(
            kind=plan.kind, payout=plan.payout, amount=plan.money, available=plan.available
        )
    return plan


@router.post(
    "/refunds/preview",
    response_model=RefundPreview,
    summary="What a refund would do (amounts and problems), nothing is written",
)
async def preview_refund(
    body: RefundIn, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> RefundPreview:
    async with db.tx(p.session()) as conn:
        plan = await _plan(conn, body, lock=False)
    return RefundPreview(
        kind=plan.kind,
        payout=plan.payout,
        amount=plan.money,
        charge_reduction=plan.reduction,
        available=plan.available,
        errors=plan.errors,
    )


_SQL = (
    "SELECT r.id AS rid, r.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, r.kind, r.payout, r.amount,"
    " r.charge_reduction, c.public_id AS charge_id, py.public_id AS payment_id, lp.public_id AS package_id, r.left_on,"
    " r.reason, r.refunded_on FROM refunds r JOIN students s ON s.org_id = r.org_id AND s.id = r.student_id"
    " LEFT JOIN charges c ON c.org_id = r.org_id AND c.id = r.charge_id"
    " LEFT JOIN payments py ON py.org_id = r.org_id AND py.id = r.payment_id"
    " LEFT JOIN lesson_packages lp ON lp.org_id = r.org_id AND lp.id = r.package_id"
)


async def _out(conn: Conn, row: dict[str, Any]) -> RefundOut:
    parts = await fetch_all(
        conn,
        "SELECT py.public_id AS payment_id, rp.amount FROM refund_payments rp "
        "JOIN payments py ON py.org_id = rp.org_id AND py.id = rp.payment_id WHERE rp.refund_id = %s ORDER BY rp.id",
        (row["rid"],),
    )
    return RefundOut(
        **{k: v for k, v in row.items() if k != "rid"},
        payments=[RefundPaymentOut.model_validate(x) for x in parts],
    )


@router.post("/refunds", response_model=RefundOut, status_code=201, summary="Make a refund")
async def create_refund(
    body: RefundIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> RefundOut:
    async with db.tx(p.session()) as conn:
        plan = await _plan(conn, body, lock=True)
        if plan.errors:
            raise Unprocessable(
                "The refund cannot be made: " + ", ".join(plan.errors), details={"errors": plan.errors}
            )
        today = await org_today(conn)
        cash_out = plan.payout in ("cash", "bank")
        split: list[tuple[int, Decimal]] = []  # (payment id, amount) the money is taken from
        touched: list[int] = []
        if plan.kind == "wrong_payment":
            assert plan.payment_id is not None
            alloc = await fetch_one(
                conn,
                "SELECT COALESCE(sum(amount), 0) AS s FROM payment_allocations WHERE payment_id = %s",
                (plan.payment_id,),
            )
            pay = await fetch_one(
                conn, "SELECT amount, refunded FROM payments WHERE id = %s", (plan.payment_id,)
            )
            assert alloc is not None and pay is not None
            need = plan.money - (pay["amount"] - pay["refunded"] - alloc["s"])
            if need > 0:  # the money was applied to charges: they become open debt again
                touched = await release_from_payment(conn, plan.payment_id, need)
            split = [(plan.payment_id, plan.money)]
        else:
            assert plan.charge_id is not None
            c = await fetch_one(
                conn,
                "SELECT amount, early_discount, early_granted_at FROM charges WHERE id = %s",
                (plan.charge_id,),
            )
            assert c is not None
            released = await release_from_charge(conn, plan.charge_id, plan.money)
            by_payment: dict[int, Decimal] = {}
            for pid, amt in released:
                by_payment[pid] = by_payment.get(pid, ZERO) + amt
            split = list(by_payment.items())
            new_amount = c["amount"] - plan.reduction
            if new_amount <= 0:
                await execute(
                    conn,
                    "UPDATE charges SET voided_at = now(), void_reason = %s WHERE id = %s",
                    (f"{plan.kind}: {body.reason}"[:500], plan.charge_id),
                )
            elif c["early_discount"] > 0 and c["early_granted_at"] is None:
                # the early offer was computed on the old price: it lapses with the reduction
                await execute(
                    conn,
                    "UPDATE charges SET amount = %s, early_discount = 0, early_pay_by = NULL, early_source_id = NULL WHERE id = %s",
                    (new_amount, plan.charge_id),
                )
            else:
                await execute(
                    conn, "UPDATE charges SET amount = %s WHERE id = %s", (new_amount, plan.charge_id)
                )
        row = await fetch_one(
            conn,
            "INSERT INTO refunds (org_id, student_id, kind, payout, amount, charge_reduction, charge_id, payment_id, package_id, left_on, reason, refunded_on, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                plan.student_id,
                plan.kind,
                plan.payout,
                plan.money,
                plan.reduction,
                plan.charge_id if plan.kind != "wrong_payment" else None,
                plan.payment_id,
                plan.package_id,
                plan.left_on,
                body.reason,
                today,
                p.user_id,
            ),
        )
        assert row is not None
        rid = int(row["id"])
        if cash_out:
            for pid, amt in split:
                await execute(
                    conn,
                    "INSERT INTO refund_payments (org_id, refund_id, payment_id, amount) VALUES (%s, %s, %s, %s)",
                    (p.org_id, rid, pid, amt),
                )
                await execute(conn, "UPDATE payments SET refunded = refunded + %s WHERE id = %s", (amt, pid))
            await post_refund(conn, p.org_id, p.user_id, rid)
        if touched:
            await revoke_unearned_early(conn, touched)
        out = await fetch_one(conn, f"{_SQL} WHERE r.id = %s", (rid,))
        assert out is not None
        return await _out(conn, out)


@router.get("/refunds", response_model=Page[RefundOut])
async def list_refunds(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    pg: Paging,
    student_id: uuid.UUID | None = None,
    kind: Kind | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> Page[RefundOut]:
    where: list[str] = []
    params: list[Any] = []
    if student_id:
        where.append("s.public_id = %s")
        params.append(student_id)
    if kind:
        where.append("r.kind = %s")
        params.append(kind)
    if date_from:
        where.append("r.refunded_on >= %s")
        params.append(date_from)
    if date_to:
        where.append("r.refunded_on <= %s")
        params.append(date_to)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_SQL} WHERE {' AND '.join(where) or 'TRUE'} ORDER BY r.refunded_on DESC, r.id DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
        items = [await _out(conn, r) for r in rows[: pg.limit]]
    return Page[RefundOut](items=items, limit=pg.limit, offset=pg.offset, has_more=len(rows) > pg.limit)


@router.get("/refunds/{refund_id}", response_model=RefundOut)
async def get_refund(
    refund_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> RefundOut:
    async with db.tx(p.session()) as conn:
        rid = await resolve(conn, "refunds", refund_id, what="refund")
        row = await fetch_one(conn, f"{_SQL} WHERE r.id = %s", (rid,))
        assert row is not None
        return await _out(conn, row)
