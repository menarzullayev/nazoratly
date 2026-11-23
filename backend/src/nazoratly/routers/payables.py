"""Payables: suppliers, supplier bills (invoices), partial settlement, due dates and the aging report.

A bill accrues an expense (`expenses.bill_id`: the dashboard counts it and the journal credits 2000 payables); every
settlement is a bill payment that debits payables and credits cash or bank. Voiding follows the immutable-journal rule:
the document is flagged and its entry is reversed, never edited."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import Field, StringConstraints

from nazoratly import accounting as svc
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.rules import accounting as R
from nazoratly.schemas import Dec2, LongText, Model, Out, Page, PositiveMoney, make_page

router = APIRouter(prefix="/v1/accounting", tags=["payables"], route_class=IdempotentRoute)

ExpenseCategory = Literal["rent", "utilities", "salary", "marketing", "equipment", "tax", "other"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=500)]
Day = date


# ---- suppliers ---------------------------------------------------------------------------------------------------
class SupplierIn(Model):
    name: Name
    phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] | None = None
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None = None


class SupplierPatch(Model):
    name: Name | None = None
    phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] | None = None
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None = None
    active: bool | None = None


class SupplierOut(Out):
    id: uuid.UUID
    name: str
    phone: str | None
    note: str | None
    active: bool
    outstanding: Dec2 = Field(description="unpaid amount of its bills")


_SUP_SQL = (
    "SELECT s.public_id AS id, s.name, s.phone, s.note, s.active, "
    "COALESCE((SELECT sum(b.amount) - COALESCE(sum((SELECT sum(bp.amount) FROM bill_payments bp WHERE bp.bill_id = b.id AND bp.voided_at IS NULL)), 0) "
    "FROM supplier_bills b WHERE b.supplier_id = s.id AND b.voided_at IS NULL), 0) AS outstanding FROM suppliers s"
)


@router.get("/suppliers", response_model=list[SupplierOut])
async def list_suppliers(
    p: Annotated[Principal, Depends(require("accounting:read"))], db: DB
) -> list[SupplierOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(conn, f"{_SUP_SQL} ORDER BY s.name")
    return [SupplierOut.model_validate(r) for r in rows]


@router.post("/suppliers", response_model=SupplierOut, status_code=201)
async def create_supplier(
    body: SupplierIn, p: Annotated[Principal, Depends(require("accounting:write"))], db: DB
) -> SupplierOut:
    async with db.tx(p.session()) as conn:
        if await fetch_one(
            conn, "SELECT 1 AS x FROM suppliers WHERE org_id = %s AND name = %s", (p.org_id, body.name)
        ):
            raise Conflict("A supplier with this name already exists")
        row = await fetch_one(
            conn,
            "INSERT INTO suppliers (org_id, name, phone, note) VALUES (%s, %s, %s, %s) RETURNING id",
            (p.org_id, body.name, body.phone, body.note),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_SUP_SQL} WHERE s.id = %s", (row["id"],))
    assert out is not None
    return SupplierOut.model_validate(out)


@router.patch("/suppliers/{supplier_id}", response_model=SupplierOut)
async def patch_supplier(
    supplier_id: uuid.UUID,
    body: SupplierPatch,
    p: Annotated[Principal, Depends(require("accounting:write"))],
    db: DB,
) -> SupplierOut:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "suppliers", supplier_id, what="supplier")
        for column, value in changes.items():  # column names come from the model above, never from the client
            await execute(conn, f"UPDATE suppliers SET {column} = %s WHERE id = %s", (value, sid))
        out = await fetch_one(conn, f"{_SUP_SQL} WHERE s.id = %s", (sid,))
    assert out is not None
    return SupplierOut.model_validate(out)


# ---- bills ---------------------------------------------------------------------------------------------------------
class BillIn(Model):
    supplier_id: uuid.UUID
    number: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    bill_date: Day
    due_date: Day
    category: ExpenseCategory
    amount: PositiveMoney
    description: LongText | None = None


class BillPaymentIn(Model):
    amount: PositiveMoney
    paid_on: Day
    paid_from: Literal["cash", "bank"] = "cash"
    note: LongText | None = None


class VoidIn(Model):
    reason: Reason


class BillPaymentOut(Out):
    id: uuid.UUID
    bill_id: uuid.UUID
    amount: Dec2
    paid_on: date
    paid_from: str
    note: str | None
    voided: bool
    void_reason: str | None


class BillOut(Out):
    id: uuid.UUID
    supplier_id: uuid.UUID
    supplier_name: str
    number: str
    bill_date: date
    due_date: date
    category: str
    amount: Dec2
    paid: Dec2
    outstanding: Dec2
    status: Literal["open", "partial", "overdue", "paid", "voided"]
    description: str | None
    voided: bool
    void_reason: str | None
    payments: list[BillPaymentOut] = []


_BILL_SQL = (
    "SELECT b.id AS _id, b.public_id AS id, s.public_id AS supplier_id, s.name AS supplier_name, b.number, b.bill_date, b.due_date,"
    " b.category, b.amount, COALESCE(pp.paid, 0) AS paid, b.amount - COALESCE(pp.paid, 0) AS outstanding, b.description,"
    " (b.voided_at IS NOT NULL) AS voided, b.void_reason FROM supplier_bills b "
    "JOIN suppliers s ON s.org_id = b.org_id AND s.id = b.supplier_id "
    "LEFT JOIN LATERAL (SELECT sum(bp.amount) AS paid FROM bill_payments bp WHERE bp.bill_id = b.id AND bp.voided_at IS NULL) pp ON TRUE"
)


def _status(r: dict[str, Any], today: date) -> str:
    if r["voided"]:
        return "voided"
    if r["outstanding"] <= 0:
        return "paid"
    if r["due_date"] < today:
        return "overdue"
    return "partial" if r["paid"] > 0 else "open"


async def _bills(conn: Conn, rows: list[dict[str, Any]]) -> list[BillOut]:
    if not rows:
        return []
    today = await svc.org_today(conn)
    pays = await fetch_all(
        conn,
        "SELECT bp.bill_id AS _bill, bp.public_id AS id, b.public_id AS bill_id, bp.amount, bp.paid_on, bp.paid_from, bp.note,"
        " (bp.voided_at IS NOT NULL) AS voided, bp.void_reason FROM bill_payments bp "
        "JOIN supplier_bills b ON b.org_id = bp.org_id AND b.id = bp.bill_id WHERE bp.bill_id = ANY(%s) ORDER BY bp.paid_on, bp.id",
        ([r["_id"] for r in rows],),
    )
    by: dict[int, list[BillPaymentOut]] = {}
    for x in pays:
        by.setdefault(x["_bill"], []).append(BillPaymentOut.model_validate(x))
    return [
        BillOut(
            **{k: v for k, v in r.items() if k != "_id"},
            status=_status(r, today),
            payments=by.get(r["_id"], []),
        )
        for r in rows
    ]


async def _bill(conn: Conn, bid: int) -> BillOut:
    return (await _bills(conn, await fetch_all(conn, f"{_BILL_SQL} WHERE b.id = %s", (bid,))))[0]


@router.post(
    "/bills",
    response_model=BillOut,
    status_code=201,
    summary="Record a supplier bill (it accrues an expense)",
)
async def create_bill(
    body: BillIn, p: Annotated[Principal, Depends(require("accounting:write"))], db: DB
) -> BillOut:
    if body.due_date < body.bill_date:
        raise Unprocessable("due_date is before bill_date")
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "suppliers", body.supplier_id, what="supplier")
        sup = await fetch_one(conn, "SELECT name, active FROM suppliers WHERE id = %s", (sid,))
        assert sup is not None
        if not sup["active"]:
            raise Conflict("The supplier is not active")
        if await fetch_one(
            conn,
            "SELECT 1 AS x FROM supplier_bills WHERE org_id = %s AND supplier_id = %s AND number = %s",
            (p.org_id, sid, body.number),
        ):
            raise Conflict("This supplier already has a bill with this number")
        bill = await fetch_one(
            conn,
            "INSERT INTO supplier_bills (org_id, supplier_id, number, bill_date, due_date, category, amount, description, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                sid,
                body.number,
                body.bill_date,
                body.due_date,
                body.category,
                body.amount,
                body.description,
                p.user_id,
            ),
        )
        assert bill is not None
        exp = await fetch_one(
            conn,
            "INSERT INTO expenses (org_id, category, amount, spent_at, description, created_by_user_id, bill_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                body.category,
                body.amount,
                body.bill_date,
                f"{sup['name']} #{body.number}",
                p.user_id,
                bill["id"],
            ),
        )
        assert exp is not None
        await svc.post_expense(conn, p.org_id, p.user_id, exp["id"])
        return await _bill(conn, bill["id"])


@router.get("/bills", response_model=Page[BillOut], summary="Supplier bills ordered by due date")
async def list_bills(
    p: Annotated[Principal, Depends(require("accounting:read"))],
    db: DB,
    pg: Paging,
    supplier_id: uuid.UUID | None = None,
    status: Literal["open", "partial", "overdue", "paid", "voided"] | None = None,
) -> Page[BillOut]:
    async with db.tx(p.session()) as conn:
        today = await svc.org_today(conn)
        where = ["TRUE"]
        params: list[Any] = []
        if supplier_id:
            where.append("s.public_id = %s")
            params.append(supplier_id)
        if status == "voided":
            where.append("b.voided_at IS NOT NULL")
        elif status:
            where.append("b.voided_at IS NULL")
            if status == "paid":
                where.append("b.amount - COALESCE(pp.paid, 0) <= 0")
            else:
                where.append("b.amount - COALESCE(pp.paid, 0) > 0")
                if status == "overdue":
                    where.append("b.due_date < %s")
                    params.append(today)
                elif status == "partial":
                    where.append("COALESCE(pp.paid, 0) > 0 AND b.due_date >= %s")
                    params.append(today)
                else:
                    where.append("COALESCE(pp.paid, 0) = 0 AND b.due_date >= %s")
                    params.append(today)
        rows = await fetch_all(
            conn,
            f"{_BILL_SQL} WHERE {' AND '.join(where)} ORDER BY b.due_date, b.id LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
        items = await _bills(conn, rows[: pg.limit])
    return Page[BillOut](items=items, limit=pg.limit, offset=pg.offset, has_more=len(rows) > pg.limit)


@router.get("/bills/{bill_id}", response_model=BillOut)
async def get_bill(
    bill_id: uuid.UUID, p: Annotated[Principal, Depends(require("accounting:read"))], db: DB
) -> BillOut:
    async with db.tx(p.session()) as conn:
        bid = await resolve(conn, "supplier_bills", bill_id, what="bill")
        return await _bill(conn, bid)


@router.post(
    "/bills/{bill_id}/payments",
    response_model=BillOut,
    status_code=201,
    summary="Settle a bill (partly or fully)",
)
async def pay_bill(
    bill_id: uuid.UUID,
    body: BillPaymentIn,
    p: Annotated[Principal, Depends(require("accounting:write"))],
    db: DB,
) -> BillOut:
    async with db.tx(p.session()) as conn:
        bid = await resolve(conn, "supplier_bills", bill_id, what="bill")
        cur = await fetch_one(
            conn,
            "SELECT b.amount, b.voided_at, b.bill_date, COALESCE((SELECT sum(amount) FROM bill_payments WHERE bill_id = b.id AND voided_at IS NULL), 0) AS paid "
            "FROM supplier_bills b WHERE b.id = %s FOR UPDATE",
            (bid,),
        )
        assert cur is not None
        if cur["voided_at"] is not None:
            raise Conflict("The bill is voided")
        if body.amount > cur["amount"] - cur["paid"]:
            raise Unprocessable(
                "The settlement exceeds what is still owed",
                details={"outstanding": str(cur["amount"] - cur["paid"])},
            )
        if body.paid_on > await svc.org_today(conn):
            raise Unprocessable("A settlement cannot be dated in the future")
        if body.paid_on < cur["bill_date"]:
            raise Unprocessable("A settlement cannot be dated before the bill")
        row = await fetch_one(
            conn,
            "INSERT INTO bill_payments (org_id, bill_id, amount, paid_on, paid_from, note, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, bid, body.amount, body.paid_on, body.paid_from, body.note, p.user_id),
        )
        assert row is not None
        await svc.post_bill_payment(conn, p.org_id, p.user_id, row["id"])
        return await _bill(conn, bid)


@router.post(
    "/bill-payments/{payment_id}/void",
    response_model=BillOut,
    summary="Void a settlement (its entry is reversed)",
)
async def void_bill_payment(
    payment_id: uuid.UUID, body: VoidIn, p: Annotated[Principal, Depends(require("accounting:write"))], db: DB
) -> BillOut:
    async with db.tx(p.session()) as conn:
        pid = await resolve(conn, "bill_payments", payment_id, what="settlement")
        cur = await fetch_one(
            conn, "SELECT bill_id, voided_at FROM bill_payments WHERE id = %s FOR UPDATE", (pid,)
        )
        assert cur is not None
        if cur["voided_at"] is not None:
            raise Conflict("The settlement is already voided")
        await execute(
            conn,
            "UPDATE bill_payments SET voided_at = now(), void_reason = %s WHERE id = %s",
            (body.reason, pid),
        )
        await svc.void_source(conn, p.org_id, p.user_id, "bill_payment", str(pid))
        return await _bill(conn, cur["bill_id"])


@router.post(
    "/bills/{bill_id}/void", response_model=BillOut, summary="Void a bill that has no live settlements"
)
async def void_bill(
    bill_id: uuid.UUID, body: VoidIn, p: Annotated[Principal, Depends(require("accounting:write"))], db: DB
) -> BillOut:
    async with db.tx(p.session()) as conn:
        bid = await resolve(conn, "supplier_bills", bill_id, what="bill")
        cur = await fetch_one(conn, "SELECT voided_at FROM supplier_bills WHERE id = %s FOR UPDATE", (bid,))
        assert cur is not None
        if cur["voided_at"] is not None:
            raise Conflict("The bill is already voided")
        if await fetch_one(
            conn, "SELECT 1 AS x FROM bill_payments WHERE bill_id = %s AND voided_at IS NULL", (bid,)
        ):
            raise Conflict("Void the settlements of this bill first")
        await execute(
            conn,
            "UPDATE supplier_bills SET voided_at = now(), void_reason = %s WHERE id = %s",
            (body.reason, bid),
        )
        exp = await fetch_one(conn, "SELECT id FROM expenses WHERE bill_id = %s", (bid,))
        if exp is not None:
            await execute(
                conn,
                "UPDATE expenses SET voided_at = now(), void_reason = %s WHERE id = %s",
                (f"bill voided: {body.reason}", exp["id"]),
            )
            await svc.void_source(conn, p.org_id, p.user_id, "expense", str(exp["id"]))
        return await _bill(conn, bid)


# ---- aging ---------------------------------------------------------------------------------------------------------
class AgingRow(Out):
    id: uuid.UUID
    supplier_name: str
    number: str
    due_date: date
    outstanding: Dec2
    days_overdue: int
    bucket: str


class AgingOut(Out):
    as_of: date
    rows: list[AgingRow]
    buckets: dict[str, Dec2]
    total: Dec2


@router.get(
    "/reports/payables-aging", response_model=AgingOut, summary="What is owed to suppliers, by days overdue"
)
async def payables_aging(
    p: Annotated[Principal, Depends(require("accounting:read"))], db: DB, as_of: date | None = None
) -> AgingOut:
    async with db.tx(p.session()) as conn:
        end = as_of or await svc.org_today(conn)
        rows = await fetch_all(
            conn,
            "SELECT b.public_id AS id, s.name, b.number, b.due_date, b.amount, "
            "COALESCE((SELECT sum(bp.amount) FROM bill_payments bp WHERE bp.bill_id = b.id AND bp.voided_at IS NULL AND bp.paid_on <= %s), 0) AS paid "
            "FROM supplier_bills b JOIN suppliers s ON s.org_id = b.org_id AND s.id = b.supplier_id "
            "WHERE b.voided_at IS NULL AND b.bill_date <= %s",
            (end, end),
        )
    meta = {str(r["id"]): r for r in rows}
    res = R.payables_aging(
        [
            {
                "id": str(r["id"]),
                "due_date": r["due_date"].isoformat(),
                "amount": r["amount"],
                "paid": r["paid"],
            }
            for r in rows
        ],
        end.isoformat(),
    )
    out = [
        AgingRow(
            id=uuid.UUID(x["id"]), supplier_name=meta[x["id"]]["name"], number=meta[x["id"]]["number"],
            due_date=date.fromisoformat(x["due_date"]), outstanding=x["outstanding"], days_overdue=x["days_overdue"], bucket=x["bucket"],
        )
        for x in res["rows"]
    ]  # fmt: skip
    return AgingOut(
        as_of=end, rows=out, buckets={k: Decimal(v) for k, v in res["buckets"].items()}, total=res["total"]
    )


_ = make_page
