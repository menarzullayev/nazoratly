"""Lasting discounts: per-student rules (individual, scholarship, early payment) and the discount report.

The family discount is automatic (center settings `family_discount_*`), the three other kinds are rules created here.
Charge generation (`POST /v1/charges/generate`) applies them; rules/money.py holds the arithmetic (shared with Sheets).
Discounts never touch the journal: tuition income is booked when money is received."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, StringConstraints, model_validator

from nazoratly.accounting import org_today
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.schemas import Dec2, Model, Out, Page, PositiveMoney, make_page

router = APIRouter(prefix="/v1", tags=["discounts"], route_class=IdempotentRoute)

RuleKind = Literal["individual", "scholarship", "early_pay"]
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=500)]
Percent = Annotated[Decimal, Field(gt=0, le=100, max_digits=5, decimal_places=2)]


class DiscountIn(Model):
    student_id: uuid.UUID
    kind: RuleKind
    percent: Percent | None = Field(default=None, description="percent of the fee (scholarship: 100 = free)")
    amount: PositiveMoney | None = Field(default=None, description="so'm off ONE charge (individual only)")
    pay_by_day: Annotated[int, Field(ge=1, le=28)] | None = Field(
        default=None, description="early_pay: the day of the billed month the money must arrive by"
    )
    enrollment_id: uuid.UUID | None = Field(
        default=None,
        description="limit the rule to one enrollment (default: every tuition charge of the student)",
    )
    reason: Reason
    valid_from: date | None = Field(default=None, description="defaults to today (the center's date)")
    valid_to: date | None = Field(default=None, description="empty = until ended")

    @model_validator(mode="after")
    def _shape(self) -> DiscountIn:
        if (self.percent is None) == (self.amount is None):
            raise ValueError("give exactly one of percent or amount")
        if self.kind == "scholarship" and self.percent is None:
            raise ValueError("a scholarship is a percent (100 = free)")
        if self.kind == "early_pay":
            if self.percent is None or self.percent >= 100:
                raise ValueError("an early-payment discount is a percent below 100")
            if self.pay_by_day is None:
                raise ValueError("an early-payment discount needs pay_by_day")
        elif self.pay_by_day is not None:
            raise ValueError("pay_by_day is only for early_pay")
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            raise ValueError("valid_to is before valid_from")
        return self


class DiscountPatch(Model):
    valid_to: date | None = Field(default=None, description="end the rule (the last day it applies)")
    reason: Reason | None = None


class DiscountOut(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    enrollment_id: uuid.UUID | None
    kind: str
    percent: Dec2 | None
    amount: Dec2 | None
    pay_by_day: int | None
    reason: str
    valid_from: date
    valid_to: date | None
    active: bool = Field(description="valid today")


_SQL = (
    "SELECT d.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, e.public_id AS enrollment_id,"
    " d.kind, d.percent, d.amount, d.pay_by_day, d.reason, d.valid_from, d.valid_to,"
    " (d.valid_from <= %(today)s AND (d.valid_to IS NULL OR d.valid_to >= %(today)s)) AS active "
    "FROM student_discounts d JOIN students s ON s.org_id = d.org_id AND s.id = d.student_id "
    "LEFT JOIN enrollments e ON e.org_id = d.org_id AND e.id = d.enrollment_id"
)


async def _one(conn: Conn, did: int) -> DiscountOut:
    row = await fetch_one(conn, f"{_SQL} WHERE d.id = %(id)s", {"today": await org_today(conn), "id": did})
    assert row is not None
    return DiscountOut.model_validate(row)


@router.post("/discounts", response_model=DiscountOut, status_code=201, summary="Add a lasting discount rule")
async def create_discount(
    body: DiscountIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> DiscountOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", body.student_id, what="student")
        eid = await resolve_opt(conn, "enrollments", body.enrollment_id, what="enrollment")
        if eid is not None:
            owner = await fetch_one(conn, "SELECT student_id FROM enrollments WHERE id = %s", (eid,))
            assert owner is not None
            if owner["student_id"] != sid:
                raise Unprocessable("the enrollment belongs to another student")
        valid_from = body.valid_from or await org_today(conn)
        if body.valid_to is not None and body.valid_to < valid_from:
            raise Unprocessable("valid_to is before valid_from")
        row = await fetch_one(
            conn,
            "INSERT INTO student_discounts (org_id, student_id, enrollment_id, kind, percent, amount, pay_by_day, reason, valid_from, valid_to, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                sid,
                eid,
                body.kind,
                body.percent,
                body.amount,
                body.pay_by_day,
                body.reason,
                valid_from,
                body.valid_to,
                p.user_id,
            ),
        )
        assert row is not None
        return await _one(conn, row["id"])


@router.get("/discounts", response_model=Page[DiscountOut])
async def list_discounts(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    pg: Paging,
    student_id: uuid.UUID | None = None,
    kind: RuleKind | None = None,
    active_only: bool = False,
) -> Page[DiscountOut]:
    async with db.tx(p.session()) as conn:
        where: list[str] = []
        params: dict[str, Any] = {"today": await org_today(conn), "limit": pg.limit + 1, "offset": pg.offset}
        if student_id:
            where.append("s.public_id = %(student)s")
            params["student"] = student_id
        if kind:
            where.append("d.kind = %(kind)s")
            params["kind"] = kind
        if active_only:
            where.append("d.valid_from <= %(today)s AND (d.valid_to IS NULL OR d.valid_to >= %(today)s)")
        rows = await fetch_all(
            conn,
            f"{_SQL} WHERE {' AND '.join(where) or 'TRUE'} ORDER BY d.valid_from DESC, d.id DESC LIMIT %(limit)s OFFSET %(offset)s",
            params,
        )
    return make_page(rows, pg.limit, pg.offset, DiscountOut)


@router.patch(
    "/discounts/{discount_id}",
    response_model=DiscountOut,
    summary="End a rule (or fix its reason); amounts are never edited: add a new rule instead",
)
async def patch_discount(
    discount_id: uuid.UUID,
    body: DiscountPatch,
    p: Annotated[Principal, Depends(require("finance:write"))],
    db: DB,
) -> DiscountOut:
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    async with db.tx(p.session()) as conn:
        did = await resolve(conn, "student_discounts", discount_id, what="discount")
        cur = await fetch_one(
            conn, "SELECT valid_from, valid_to FROM student_discounts WHERE id = %s FOR UPDATE", (did,)
        )
        assert cur is not None
        if "valid_to" in changes:
            if changes["valid_to"] < cur["valid_from"]:
                raise Unprocessable("valid_to is before valid_from")
            if cur["valid_to"] is not None and changes["valid_to"] > cur["valid_to"]:
                raise Conflict("An ended rule cannot be extended: add a new rule")
        for column, value in changes.items():  # names come from the model above
            await execute(conn, f"UPDATE student_discounts SET {column} = %s WHERE id = %s", (value, did))
        return await _one(conn, did)


# ---- report ------------------------------------------------------------------------------------------------------
class DiscountKindRow(Out):
    kind: str
    lines: int
    students: int
    amount: Dec2


class DiscountReport(Out):
    month: date
    rows: list[DiscountKindRow]
    total: Dec2
    scholarship_total: Dec2 = Field(description="scholarships are shown separately from the other discounts")
    other_total: Dec2


@router.get(
    "/reports/discounts",
    response_model=DiscountReport,
    summary="Discounts given in a month by kind (scholarships separate)",
)
async def discount_report(
    p: Annotated[Principal, Depends(require("reports:read"))],
    db: DB,
    month: Annotated[date, Query(description="any date inside the month")],
) -> DiscountReport:
    first = month.replace(day=1)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            "SELECT l.kind, count(*)::int AS lines, count(DISTINCT l.student_id)::int AS students, sum(l.amount) AS amount "
            "FROM discount_lines l LEFT JOIN charges c ON c.org_id = l.org_id AND c.id = l.charge_id "
            "WHERE l.period_month = %s AND (l.charge_id IS NULL OR c.voided_at IS NULL) "
            "AND (l.kind <> 'early_pay' OR c.early_granted_at IS NOT NULL) GROUP BY l.kind ORDER BY l.kind",
            (first,),
        )
    total = sum((r["amount"] for r in rows), Decimal(0))
    scholarship = sum((r["amount"] for r in rows if r["kind"] == "scholarship"), Decimal(0))
    return DiscountReport(
        month=first,
        rows=[DiscountKindRow.model_validate(r) for r in rows],
        total=total,
        scholarship_total=scholarship,
        other_total=total - scholarship,
    )
