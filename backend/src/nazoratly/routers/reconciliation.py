"""Reconciliation of a cash or bank account with its statement.

A statement (opening and closing balance, period) holds lines with signed amounts (money in positive, out negative).
Lines are matched to journal lines of the account, automatically (`rules/accounting.py: match_statement`, golden-tested
against the Sheets edition) or by hand, and a statement is finalized only when it foots, everything is matched and the
closing balance equals the ledger balance. A finalized statement is frozen by the database."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import Field, StringConstraints

from nazoratly import accounting as svc
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.rules import accounting as R
from nazoratly.schemas import Dec2, Model, Out, Page

router = APIRouter(prefix="/v1/accounting", tags=["reconciliation"], route_class=IdempotentRoute)

Day = date
SignedMoney = Annotated[
    Decimal, Field(max_digits=14, decimal_places=2, description="UZS amount, 2 decimals, may be negative")
]
NonZeroMoney = Annotated[
    Decimal, Field(max_digits=14, decimal_places=2, description="money in positive, out negative; not zero")
]
MAX_LINES = 500


class StatementIn(Model):
    cash_account_id: uuid.UUID
    period_from: Day
    period_to: Day
    opening_balance: SignedMoney
    closing_balance: SignedMoney


class StatementLineIn(Model):
    date: Day
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""
    amount: NonZeroMoney


class StatementLinesIn(Model):
    lines: list[StatementLineIn] = Field(min_length=1, max_length=MAX_LINES)


class AutoMatchIn(Model):
    tolerance_days: Annotated[int, Field(ge=0, le=30)] = 3


class MatchIn(Model):
    seq: int = Field(ge=1, description="journal line number (seq) on the statement account")


class StatementLineOut(Out):
    id: uuid.UUID
    date: date
    description: str
    amount: Dec2
    matched_seq: int | None


class UnmatchedLedgerLine(Out):
    seq: int
    date: date
    memo: str
    amount: Dec2


class ReconciliationOut(Out):
    ledger_balance: Dec2
    difference: Dec2
    foots: bool
    unmatched_statement: int
    unmatched_ledger: list[UnmatchedLedgerLine]
    reconciled: bool


class StatementOut(Out):
    id: uuid.UUID
    cash_account_id: uuid.UUID
    cash_account: str
    account_code: str
    period_from: date
    period_to: date
    opening_balance: Dec2
    closing_balance: Dec2
    status: Literal["open", "finalized"]
    lines: list[StatementLineOut] = []
    reconciliation: ReconciliationOut | None = None


_ST_SQL = (
    "SELECT s.id AS _id, s.public_id AS id, c.public_id AS cash_account_id, c.name AS cash_account, a.code AS account_code,"
    " a.id AS _account, s.period_from, s.period_to, s.opening_balance, s.closing_balance, s.status "
    "FROM bank_statements s JOIN cash_accounts c ON c.org_id = s.org_id AND c.id = s.cash_account_id "
    "JOIN accounts a ON a.org_id = c.org_id AND a.id = c.account_id"
)


async def _unmatched_ledger(conn: Conn, st: dict[str, Any]) -> list[dict[str, Any]]:
    return await fetch_all(
        conn,
        "SELECT l.seq, e.entry_date AS date, e.memo, l.debit - l.credit AS amount FROM journal_lines l "
        "JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id "
        "WHERE l.account_id = %s AND e.entry_date BETWEEN %s AND %s "
        "AND NOT EXISTS (SELECT 1 FROM statement_lines x WHERE x.org_id = l.org_id AND x.matched_seq = l.seq) ORDER BY l.seq",
        (st["_account"], st["period_from"], st["period_to"]),
    )


async def _statement(conn: Conn, sid: int, *, with_lines: bool = True) -> StatementOut:
    st = await fetch_one(conn, f"{_ST_SQL} WHERE s.id = %s", (sid,))
    assert st is not None
    lines = await fetch_all(
        conn,
        "SELECT public_id AS id, line_date AS date, description, amount, matched_seq FROM statement_lines WHERE statement_id = %s ORDER BY line_date, id",
        (sid,),
    )
    bal = await fetch_one(
        conn,
        "SELECT COALESCE(sum(l.debit), 0) - COALESCE(sum(l.credit), 0) AS b FROM journal_lines l "
        "JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id WHERE l.account_id = %s AND e.entry_date <= %s",
        (st["_account"], st["period_to"]),
    )
    assert bal is not None
    unmatched_ledger = await _unmatched_ledger(conn, st)
    foots = R.statement_foots(
        st["opening_balance"], st["closing_balance"], [{"amount": x["amount"]} for x in lines]
    )
    unmatched_stmt = sum(1 for x in lines if x["matched_seq"] is None)
    summary = R.reconciliation_summary(
        st["closing_balance"], bal["b"], unmatched_stmt, len(unmatched_ledger), foots
    )
    rec = ReconciliationOut(
        ledger_balance=bal["b"],
        difference=summary["difference"],
        foots=foots,
        unmatched_statement=unmatched_stmt,
        unmatched_ledger=[UnmatchedLedgerLine.model_validate(x) for x in unmatched_ledger],
        reconciled=summary["reconciled"],
    )
    return StatementOut(
        **{k: v for k, v in st.items() if not k.startswith("_")},
        lines=[StatementLineOut.model_validate(x) for x in lines] if with_lines else [],
        reconciliation=rec,
    )


async def _open_statement(conn: Conn, statement_id: uuid.UUID) -> tuple[int, dict[str, Any]]:
    sid = await resolve(conn, "bank_statements", statement_id, what="statement")
    st = await fetch_one(conn, f"{_ST_SQL} WHERE s.id = %s FOR UPDATE OF s", (sid,))
    assert st is not None
    if st["status"] == "finalized":
        raise Conflict("The statement is finalized")
    return sid, st


@router.post(
    "/statements", response_model=StatementOut, status_code=201, summary="Start a statement reconciliation"
)
async def create_statement(
    body: StatementIn, p: Annotated[Principal, Depends(require("accounting:write"))], db: DB
) -> StatementOut:
    if body.period_to < body.period_from or (body.period_to - body.period_from).days > 366:
        raise Unprocessable("period must be 0-366 days")
    async with db.tx(p.session()) as conn:
        await svc.ensure_chart(conn, p.org_id)
        cid = await resolve(conn, "cash_accounts", body.cash_account_id, what="cash account")
        row = await fetch_one(
            conn,
            "INSERT INTO bank_statements (org_id, cash_account_id, period_from, period_to, opening_balance, closing_balance, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                cid,
                body.period_from,
                body.period_to,
                body.opening_balance,
                body.closing_balance,
                p.user_id,
            ),
        )
        assert row is not None
        return await _statement(conn, row["id"])


@router.get(
    "/statements",
    response_model=Page[StatementOut],
    summary="Statements (lines are not included in the list)",
)
async def list_statements(
    p: Annotated[Principal, Depends(require("accounting:read"))],
    db: DB,
    pg: Paging,
    cash_account_id: uuid.UUID | None = None,
) -> Page[StatementOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_ST_SQL} WHERE (%s::uuid IS NULL OR c.public_id = %s::uuid) ORDER BY s.period_to DESC, s.id DESC LIMIT %s OFFSET %s",
            (cash_account_id, cash_account_id, pg.limit + 1, pg.offset),
        )
        items = [await _statement(conn, r["_id"], with_lines=False) for r in rows[: pg.limit]]
    return Page[StatementOut](items=items, limit=pg.limit, offset=pg.offset, has_more=len(rows) > pg.limit)


@router.get(
    "/statements/{statement_id}",
    response_model=StatementOut,
    summary="A statement with its lines and the reconciliation state",
)
async def get_statement(
    statement_id: uuid.UUID, p: Annotated[Principal, Depends(require("accounting:read"))], db: DB
) -> StatementOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "bank_statements", statement_id, what="statement")
        return await _statement(conn, sid)


@router.post(
    "/statements/{statement_id}/lines",
    response_model=StatementOut,
    status_code=201,
    summary="Add statement lines",
)
async def add_lines(
    statement_id: uuid.UUID,
    body: StatementLinesIn,
    p: Annotated[Principal, Depends(require("accounting:write"))],
    db: DB,
) -> StatementOut:
    async with db.tx(p.session()) as conn:
        sid, _ = await _open_statement(conn, statement_id)
        count = await fetch_one(
            conn, "SELECT count(*) AS n FROM statement_lines WHERE statement_id = %s", (sid,)
        )
        assert count is not None
        if count["n"] + len(body.lines) > 5000:
            raise Unprocessable("A statement holds at most 5000 lines")
        for ln in body.lines:
            await execute(
                conn,
                "INSERT INTO statement_lines (org_id, statement_id, line_date, description, amount) VALUES (%s, %s, %s, %s, %s)",
                (p.org_id, sid, ln.date, ln.description, ln.amount),
            )
        return await _statement(conn, sid)


async def _candidates(conn: Conn, st: dict[str, Any], tolerance: int) -> list[dict[str, Any]]:
    rows = await fetch_all(
        conn,
        "SELECT l.seq, e.entry_date AS date, l.debit - l.credit AS amount FROM journal_lines l "
        "JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id "
        "WHERE l.account_id = %s AND e.entry_date BETWEEN %s AND %s "
        "AND NOT EXISTS (SELECT 1 FROM statement_lines x WHERE x.org_id = l.org_id AND x.matched_seq = l.seq) ORDER BY l.seq",
        (
            st["_account"],
            st["period_from"] - timedelta(days=tolerance),
            st["period_to"] + timedelta(days=tolerance),
        ),
    )
    return [{"seq": r["seq"], "date": r["date"].isoformat(), "amount": r["amount"]} for r in rows]


@router.post(
    "/statements/{statement_id}/auto-match",
    response_model=StatementOut,
    summary="Match lines to the ledger automatically",
)
async def auto_match(
    statement_id: uuid.UUID,
    body: AutoMatchIn,
    p: Annotated[Principal, Depends(require("accounting:write"))],
    db: DB,
) -> StatementOut:
    async with db.tx(p.session()) as conn:
        sid, st = await _open_statement(conn, statement_id)
        lines = await fetch_all(
            conn,
            "SELECT id, line_date, amount FROM statement_lines WHERE statement_id = %s AND matched_seq IS NULL",
            (sid,),
        )
        res = R.match_statement(
            [{"id": str(x["id"]), "date": x["line_date"].isoformat(), "amount": x["amount"]} for x in lines],
            await _candidates(conn, st, body.tolerance_days),
            body.tolerance_days,
        )
        for m in res["matches"]:
            await execute(
                conn,
                "UPDATE statement_lines SET matched_seq = %s, matched_by_user_id = %s, matched_at = now() WHERE id = %s",
                (m["seq"], p.user_id, int(m["statement_line"])),
            )
        return await _statement(conn, sid)


async def _line_of(conn: Conn, sid: int, line_id: uuid.UUID) -> dict[str, Any]:
    row = await fetch_one(
        conn,
        "SELECT id, matched_seq FROM statement_lines WHERE statement_id = %s AND public_id = %s FOR UPDATE",
        (sid, line_id),
    )
    if row is None:
        raise NotFound("statement line not found")
    return row


@router.post(
    "/statements/{statement_id}/lines/{line_id}/match",
    response_model=StatementOut,
    summary="Match one line by hand",
)
async def match_line(
    statement_id: uuid.UUID,
    line_id: uuid.UUID,
    body: MatchIn,
    p: Annotated[Principal, Depends(require("accounting:write"))],
    db: DB,
) -> StatementOut:
    async with db.tx(p.session()) as conn:
        sid, st = await _open_statement(conn, statement_id)
        line = await _line_of(conn, sid, line_id)
        if line["matched_seq"] is not None:
            raise Conflict("The line is already matched; unmatch it first")
        target = await fetch_one(
            conn,
            "SELECT l.account_id FROM journal_lines l WHERE l.org_id = %s AND l.seq = %s",
            (p.org_id, body.seq),
        )
        if target is None or target["account_id"] != st["_account"]:
            raise Unprocessable("That journal line is not on the statement's account")
        if await fetch_one(
            conn,
            "SELECT 1 AS x FROM statement_lines WHERE org_id = %s AND matched_seq = %s",
            (p.org_id, body.seq),
        ):
            raise Conflict("That journal line is already matched to a statement line")
        await execute(
            conn,
            "UPDATE statement_lines SET matched_seq = %s, matched_by_user_id = %s, matched_at = now() WHERE id = %s",
            (body.seq, p.user_id, line["id"]),
        )
        return await _statement(conn, sid)


@router.post(
    "/statements/{statement_id}/lines/{line_id}/unmatch",
    response_model=StatementOut,
    summary="Remove a match",
)
async def unmatch_line(
    statement_id: uuid.UUID,
    line_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("accounting:write"))],
    db: DB,
) -> StatementOut:
    async with db.tx(p.session()) as conn:
        sid, _ = await _open_statement(conn, statement_id)
        line = await _line_of(conn, sid, line_id)
        await execute(
            conn,
            "UPDATE statement_lines SET matched_seq = NULL, matched_by_user_id = NULL, matched_at = NULL WHERE id = %s",
            (line["id"],),
        )
        return await _statement(conn, sid)


@router.post(
    "/statements/{statement_id}/finalize",
    response_model=StatementOut,
    summary="Finalize: only when it foots, everything is matched and the balance equals the ledger",
)
async def finalize(
    statement_id: uuid.UUID, p: Annotated[Principal, Depends(require("accounting:write"))], db: DB
) -> StatementOut:
    async with db.tx(p.session()) as conn:
        sid, _ = await _open_statement(conn, statement_id)
        cur = await _statement(conn, sid)
        rec = cur.reconciliation
        assert rec is not None
        if not rec.reconciled:
            raise Conflict(
                "The statement is not reconciled yet",
                details={
                    "foots": rec.foots,
                    "difference": str(rec.difference),
                    "unmatched_statement": rec.unmatched_statement,
                    "unmatched_ledger": len(rec.unmatched_ledger),
                },
            )
        await execute(
            conn,
            "UPDATE bank_statements SET status = 'finalized', finalized_at = now(), finalized_by_user_id = %s WHERE id = %s",
            (p.user_id, sid),
        )
        return await _statement(conn, sid)
