"""Payment plans: split ONE charge into dated installments. Debt and overdue are computed per installment (the charge's
allocated money is applied oldest installment first, see rules/installments.py); partial payments and FIFO between
charges stay as they are. The charge's own due_date follows its first installment so FIFO ordering keeps working."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field, model_validator

from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.rules.installments import (
    Installment,
    InstallmentBalance,
    PlanRuleError,
    equal_installments,
    installment_balances,
    validate_plan,
)
from nazoratly.schemas import Dec2, Model, Out, PositiveMoney

router = APIRouter(prefix="/v1", tags=["payment plans"], route_class=IdempotentRoute)


class InstallmentIn(Model):
    amount: PositiveMoney
    due_date: date


class EqualSplitIn(Model):
    count: int = Field(description="2..24 installments")
    first_due: date = Field(description="monthly from this date, the day clamped to the month end")


class PlanIn(Model):
    installments: list[InstallmentIn] | None = Field(default=None, max_length=100)
    equal: EqualSplitIn | None = None

    @model_validator(mode="after")
    def _one_of(self) -> PlanIn:
        if (self.installments is None) == (self.equal is None):
            raise ValueError("provide either installments or equal")
        return self


class InstallmentOut(Out):
    seq: int
    due_date: date
    amount: Dec2
    paid: Dec2
    outstanding: Dec2
    overdue: bool


class PlanOut(Out):
    charge_id: uuid.UUID
    amount: Dec2
    paid: Dec2
    outstanding: Dec2
    installments: list[InstallmentOut]


def _rule_error(err: PlanRuleError | str) -> Unprocessable:
    code = err.code if isinstance(err, PlanRuleError) else err
    return Unprocessable(f"Invalid payment plan: {code}", details={"rule": code})


async def _locked_charge(conn: Conn, charge_public: uuid.UUID) -> dict[str, Any]:
    cid = await resolve(conn, "charges", charge_public, what="charge")
    row = await fetch_one(conn, "SELECT id, amount, voided_at FROM charges WHERE id = %s FOR UPDATE", (cid,))
    assert row is not None
    return row


async def _plan(conn: Conn, charge_id: int, charge_public: uuid.UUID) -> PlanOut | None:
    rows = await fetch_all(
        conn,
        "SELECT amount, due_date FROM charge_installments WHERE charge_id = %s ORDER BY seq",
        (charge_id,),
    )
    if not rows:
        return None
    paid_row = await fetch_one(
        conn,
        "SELECT COALESCE(sum(amount), 0) AS s FROM payment_allocations WHERE charge_id = %s",
        (charge_id,),
    )
    today_row = await fetch_one(conn, "SELECT CURRENT_DATE AS d")
    assert paid_row is not None and today_row is not None
    balances: list[InstallmentBalance] = installment_balances(
        installments=[Installment(r["amount"], r["due_date"]) for r in rows],
        paid=paid_row["s"],
        today=today_row["d"],
    )
    total: Decimal = sum((b.amount for b in balances), Decimal(0))
    paid: Decimal = sum((b.paid for b in balances), Decimal(0))
    return PlanOut(
        charge_id=charge_public,
        amount=total,
        paid=paid,
        outstanding=total - paid,
        installments=[
            InstallmentOut(
                seq=i,
                due_date=b.due_date,
                amount=b.amount,
                paid=b.paid,
                outstanding=b.outstanding,
                overdue=b.overdue,
            )
            for i, b in enumerate(balances, start=1)
        ],
    )


@router.put(
    "/charges/{charge_id}/plan",
    response_model=PlanOut,
    summary="Set (or replace) the payment plan of a charge",
)
async def put_plan(
    charge_id: uuid.UUID, body: PlanIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> PlanOut:
    async with db.tx(p.session()) as conn:
        charge = await _locked_charge(conn, charge_id)
        if charge["voided_at"] is not None:
            raise Conflict("Charge is voided; it cannot have a payment plan")
        total: Decimal = charge["amount"]
        try:
            if body.equal is not None:
                rows = equal_installments(total=total, count=body.equal.count, first_due=body.equal.first_due)
            else:
                rows = [Installment(i.amount, i.due_date) for i in body.installments or []]
                error = validate_plan(total=total, installments=rows)
                if error is not None:
                    raise PlanRuleError(error)
        except PlanRuleError as exc:
            raise _rule_error(exc) from exc
        await execute(conn, "DELETE FROM charge_installments WHERE charge_id = %s", (charge["id"],))
        for seq, row in enumerate(rows, start=1):
            await execute(
                conn,
                "INSERT INTO charge_installments (org_id, charge_id, seq, due_date, amount) VALUES (%s, %s, %s, %s, %s)",
                (p.org_id, charge["id"], seq, row.due_date, row.amount),
            )
        await execute(
            conn, "UPDATE charges SET due_date = %s WHERE id = %s", (rows[0].due_date, charge["id"])
        )
        plan = await _plan(conn, charge["id"], charge_id)
    assert plan is not None
    return plan


@router.get("/charges/{charge_id}/plan", response_model=PlanOut)
async def get_plan(
    charge_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> PlanOut:
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "charges", charge_id, what="charge")
        plan = await _plan(conn, cid, charge_id)
    if plan is None:
        raise NotFound("charge has no payment plan")
    return plan


@router.delete(
    "/charges/{charge_id}/plan",
    status_code=204,
    summary="Remove the plan (the charge keeps the due date of its first installment)",
)
async def delete_plan(
    charge_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> Response:
    async with db.tx(p.session()) as conn:
        charge = await _locked_charge(conn, charge_id)
        if await execute(conn, "DELETE FROM charge_installments WHERE charge_id = %s", (charge["id"],)) == 0:
            raise NotFound("charge has no payment plan")
    return Response(status_code=204)


class InstallmentDueRow(Out):
    student_id: uuid.UUID
    student_name: str
    phone: str | None
    charge_id: uuid.UUID
    seq: int
    installments_count: int
    due_date: date
    amount: Dec2
    outstanding: Dec2
    days_overdue: int = Field(description="positive = overdue, negative = days until due")


@router.get(
    "/reports/installments",
    response_model=list[InstallmentDueRow],
    summary="Open installments overdue or due soon (what reminders follow)",
)
async def installments_due(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    days_ahead: Annotated[int, Query(ge=0, le=365)] = 7,
    only_overdue: bool = False,
    limit: Annotated[int, Query(ge=1, le=1000)] = 500,
) -> list[InstallmentDueRow]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            "SELECT s.public_id AS student_id, s.full_name AS student_name, s.phone, c.public_id AS charge_id, ib.seq,"
            " (SELECT count(*) FROM charge_installments x WHERE x.charge_id = ib.charge_id)::int AS installments_count,"
            " ib.due_date, ib.amount, ib.outstanding, (CURRENT_DATE - ib.due_date) AS days_overdue "
            "FROM v_installment_balance ib JOIN charges c ON c.id = ib.charge_id "
            "JOIN students s ON s.org_id = c.org_id AND s.id = c.student_id "
            "WHERE ib.outstanding > 0 AND s.deleted_at IS NULL "
            "AND ((%s AND ib.due_date < CURRENT_DATE) OR (NOT %s AND ib.due_date <= CURRENT_DATE + %s)) "
            "ORDER BY ib.due_date, c.id, ib.seq LIMIT %s",
            (only_overdue, only_overdue, days_ahead, limit),
        )
    return [InstallmentDueRow.model_validate(r) for r in rows]
