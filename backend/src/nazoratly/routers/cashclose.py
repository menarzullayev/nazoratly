"""Daily cash close (smena): the cashier counts the cash, the books say what the cash desk should hold, the difference needs
a note, and the close points at the journal head of that moment. With `post_difference` the difference is booked as an
adjusting journal entry (more cash than booked = other income, less = shortage). Closes are append-only; the monthly
period close of the journal (`/v1/accounting/periods`) is separate and stays.

Rules (difference, when a note is required) are in rules/money.py, shared with the Sheets edition."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, StringConstraints

from nazoratly.accounting import cash_book_balance, lock_ledger, org_today, post_cash_difference
from nazoratly.branches import branch_for_cash
from nazoratly.db import Conn, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Forbidden, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.rules.money import cash_close_errors, cash_difference
from nazoratly.schemas import Dec2, Model, Money, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["cash close"], route_class=IdempotentRoute)

Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class CashCloseIn(Model):
    close_date: date | None = Field(
        default=None, description="defaults to today (the center's date); not in the future"
    )
    counted: Money = Field(description="the cash actually counted in the drawer, so'm")
    note: Note | None = Field(default=None, description="required when counted differs from the books")
    post_difference: bool = Field(
        default=False,
        description="also book the difference in the journal (needs the accounting:write right)",
    )
    branch_id: uuid.UUID | None = Field(
        default=None,
        description="the branch of the cash desk: required for center-wide staff when the center has several active "
        "branches (or send the X-Branch header); staff of a branch always close their own",
    )


class CashPreview(Out):
    branch_id: uuid.UUID = Field(description="the branch whose cash desk this is")
    close_date: date
    book_balance: Dec2 = Field(description="what the books say the cash desk holds through the date")
    cash_in: Dec2 = Field(description="cash received on the date (journal debits of the cash accounts)")
    cash_out: Dec2 = Field(description="cash paid out on the date (journal credits of the cash accounts)")
    journal_seq: int
    next_shift_no: int


class CashCloseOut(Out):
    id: uuid.UUID
    branch_id: uuid.UUID
    close_date: date
    shift_no: int
    counted: Dec2
    book_balance: Dec2
    difference: Dec2
    status: Literal["ok", "over", "short"]
    note: str | None
    journal_seq: int = Field(description="last journal line number when the close was made")
    adjustment_entry_no: int | None = Field(description="the journal entry that booked the difference")


_SQL = (
    "SELECT c.public_id AS id, b.public_id AS branch_id, c.close_date, c.shift_no, c.counted, c.book_balance, c.difference,"
    " CASE WHEN c.difference = 0 THEN 'ok' WHEN c.difference > 0 THEN 'over' ELSE 'short' END AS status,"
    " c.note, c.journal_seq, e.entry_no AS adjustment_entry_no FROM cash_closes c"
    " JOIN branches b ON b.org_id = c.org_id AND b.id = c.branch_id"
    " LEFT JOIN journal_entries e ON e.org_id = c.org_id AND e.id = c.adjustment_entry_id"
)


async def _movements(conn: Conn, org_id: int, day: date) -> tuple[Decimal, Decimal]:
    row = await fetch_one(
        conn,
        "SELECT COALESCE(sum(l.debit), 0) AS din, COALESCE(sum(l.credit), 0) AS dout FROM journal_lines l "
        "JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id "
        "JOIN cash_accounts ca ON ca.org_id = l.org_id AND ca.account_id = l.account_id "
        "WHERE l.org_id = %s AND ca.kind = 'cash' AND e.entry_date = %s",
        (org_id, day),
    )
    assert row is not None
    return Decimal(row["din"]), Decimal(row["dout"])


async def _scope_public(conn: Conn) -> uuid.UUID:
    """Public id of the branch this transaction is narrowed to (set by branch_for_cash)."""
    row = await fetch_one(conn, "SELECT public_id FROM branches WHERE id = app_branch_id()")
    assert row is not None
    return uuid.UUID(str(row["public_id"]))


async def _next_shift(conn: Conn, day: date) -> int:
    row = await fetch_one(
        conn, "SELECT COALESCE(max(shift_no), 0) + 1 AS n FROM cash_closes WHERE close_date = %s", (day,)
    )
    assert row is not None
    return int(row["n"])


@router.get(
    "/cash-close/preview",
    response_model=CashPreview,
    summary="What the books say the cash desk holds (for the count before closing)",
)
async def preview(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    close_date: Annotated[date | None, Query(description="defaults to today")] = None,
    branch_id: Annotated[uuid.UUID | None, Query(description="the branch of the cash desk")] = None,
) -> CashPreview:
    async with db.tx(p.session()) as conn:
        await branch_for_cash(conn, p, branch_id)
        day = close_date or await org_today(conn)
        book, seq = await cash_book_balance(conn, p.org_id, day)
        din, dout = await _movements(conn, p.org_id, day)
        return CashPreview(
            branch_id=await _scope_public(conn),
            close_date=day,
            book_balance=book,
            cash_in=din,
            cash_out=dout,
            journal_seq=seq,
            next_shift_no=await _next_shift(conn, day),
        )


@router.post(
    "/cash-close",
    response_model=CashCloseOut,
    status_code=201,
    summary="Close the cash desk of a day (smena)",
)
async def close_cash(
    body: CashCloseIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> CashCloseOut:
    if body.post_difference and not p.can("accounting:write"):
        raise Forbidden("Booking the difference in the journal needs the accounting:write right")
    async with db.tx(p.session()) as conn:
        branch = await branch_for_cash(conn, p, body.branch_id)
        today = await org_today(conn)
        day = body.close_date or today
        if day > today:
            raise Unprocessable("A cash close cannot be dated in the future")
        await lock_ledger(
            conn, p.org_id
        )  # serialises closes and keeps the journal head stable while we read it
        book, seq = await cash_book_balance(conn, p.org_id, day)
        diff = cash_difference(book=book, counted=body.counted)
        errors = cash_close_errors(counted=body.counted, difference=diff.difference, note=body.note or "")
        if body.post_difference and diff.difference == 0:
            errors.append("nothing_to_post")
        if errors:
            raise Unprocessable(
                "The cash close cannot be saved: " + ", ".join(errors), details={"errors": errors}
            )
        row = await fetch_one(
            conn,
            "INSERT INTO cash_closes (org_id, branch_id, close_date, shift_no, counted, book_balance, difference, note, journal_seq, closed_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                branch,
                day,
                await _next_shift(conn, day),
                body.counted,
                book,
                diff.difference,
                body.note or None,
                seq,
                p.user_id,
            ),
        )
        assert row is not None
        if body.post_difference:
            entry_id = await post_cash_difference(
                conn, p.org_id, p.user_id, close_id=int(row["id"]), entry_date=day, difference=diff.difference
            )
            await conn.execute(
                "UPDATE cash_closes SET adjustment_entry_id = %s WHERE id = %s", (entry_id, row["id"])
            )
        out = await fetch_one(conn, f"{_SQL} WHERE c.id = %s", (row["id"],))
        assert out is not None
        return CashCloseOut.model_validate(out)


@router.get("/cash-close", response_model=Page[CashCloseOut])
async def list_closes(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    pg: Paging,
    date_from: date | None = None,
    date_to: date | None = None,
) -> Page[CashCloseOut]:
    where: list[str] = []
    params: list[Any] = []
    if date_from:
        where.append("c.close_date >= %s")
        params.append(date_from)
    if date_to:
        where.append("c.close_date <= %s")
        params.append(date_to)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_SQL} WHERE {' AND '.join(where) or 'TRUE'} ORDER BY c.close_date DESC, c.shift_no DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, CashCloseOut)


@router.get("/cash-close/{close_id}", response_model=CashCloseOut)
async def get_close(
    close_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> CashCloseOut:
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "cash_closes", close_id, what="cash close")
        row = await fetch_one(conn, f"{_SQL} WHERE c.id = %s", (cid,))
        assert row is not None
        return CashCloseOut.model_validate(row)
