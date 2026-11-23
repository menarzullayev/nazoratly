"""Accounting: chart of accounts, cash/bank accounts, the immutable hash-chained journal (manual entries, reversals),
ledger, trial balance, income statement, balance sheet, period closing, journal verification and the catch-up sync.

Money rules (accounts, hashes, reports) come from `rules/accounting.py` and `rules/ledger.py`, golden-tested against the
Sheets edition. The database enforces immutability, balance, the hash chain and closed months (migration 0015)."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, StringConstraints

from nazoratly import accounting as svc
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.rules import accounting as R
from nazoratly.rules.ledger import make_period, verify_chain
from nazoratly.schemas import Dec2, Model, Money, Out, Page

router = APIRouter(prefix="/v1/accounting", tags=["accounting"], route_class=IdempotentRoute)

AccountType = Literal["asset", "liability", "equity", "income", "expense"]
Code = Annotated[str, StringConstraints(pattern=r"^[0-9]{3,8}$", strip_whitespace=True)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
MAX_RANGE_DAYS = 1830
ZERO = Decimal(0)


# ---- chart of accounts -----------------------------------------------------------------------------------------
class AccountIn(Model):
    code: Code
    name: Text
    type: AccountType


class AccountPatch(Model):
    name: Text | None = None
    active: bool | None = None


class AccountOut(Out):
    id: uuid.UUID
    code: str
    name: str
    type: AccountType
    normal_side: Literal["debit", "credit"]
    active: bool


_ACC_SQL = "SELECT public_id AS id, code, name, type, active FROM accounts"


def _account_out(r: dict[str, Any]) -> AccountOut:
    return AccountOut(**r, normal_side=R.normal_side(r["type"]))


@router.get("/accounts", response_model=list[AccountOut], summary="Chart of accounts")
async def list_accounts(
    p: Annotated[Principal, Depends(require("accounting:read"))], db: DB, include_inactive: bool = True
) -> list[AccountOut]:
    async with db.tx(p.session()) as conn:
        await svc.ensure_chart(conn, p.org_id)
        rows = await fetch_all(conn, f"{_ACC_SQL} WHERE (%s OR active) ORDER BY code", (include_inactive,))
    return [_account_out(r) for r in rows]


@router.post("/accounts", response_model=AccountOut, status_code=201, summary="Add an account to the chart")
async def create_account(
    body: AccountIn, p: Annotated[Principal, Depends(require("accounting:write"))], db: DB
) -> AccountOut:
    async with db.tx(p.session()) as conn:
        await svc.ensure_chart(conn, p.org_id)
        if await fetch_one(
            conn, "SELECT 1 AS x FROM accounts WHERE org_id = %s AND code = %s", (p.org_id, body.code)
        ):
            raise Conflict(f"Account {body.code} already exists")
        row = await fetch_one(
            conn,
            "INSERT INTO accounts (org_id, code, name, type) VALUES (%s, %s, %s, %s) RETURNING public_id AS id, code, name, type, active",
            (p.org_id, body.code, body.name, body.type),
        )
    assert row is not None
    return _account_out(row)


@router.patch("/accounts/{account_id}", response_model=AccountOut, summary="Rename or deactivate an account")
async def patch_account(
    account_id: uuid.UUID,
    body: AccountPatch,
    p: Annotated[Principal, Depends(require("accounting:write"))],
    db: DB,
) -> AccountOut:
    async with db.tx(p.session()) as conn:
        aid = await resolve(conn, "accounts", account_id, what="account")
        if body.active is False:
            bal = await fetch_one(
                conn,
                "SELECT COALESCE(sum(debit), 0) - COALESCE(sum(credit), 0) AS net FROM journal_lines WHERE account_id = %s",
                (aid,),
            )
            if bal is not None and bal["net"] != 0:
                raise Conflict("An account with a non-zero balance cannot be deactivated")
        if body.name is not None:
            await execute(conn, "UPDATE accounts SET name = %s WHERE id = %s", (body.name, aid))
        if body.active is not None:
            await execute(conn, "UPDATE accounts SET active = %s WHERE id = %s", (body.active, aid))
        row = await fetch_one(conn, f"{_ACC_SQL} WHERE id = %s", (aid,))
    assert row is not None
    return _account_out(row)


# ---- cash and bank accounts ------------------------------------------------------------------------------------
class CashAccountIn(Model):
    name: Text
    kind: Literal["cash", "bank"]
    code: Code = Field(
        description="ledger account code; an existing unused asset account is reused, else it is created"
    )


class CashAccountOut(Out):
    id: uuid.UUID
    name: str
    kind: str
    account_code: str
    balance: Dec2 = Field(description="debit minus credit of the ledger account")


_CASH_SQL = (
    "SELECT c.public_id AS id, c.name, c.kind, a.code AS account_code, "
    "COALESCE((SELECT sum(l.debit) - sum(l.credit) FROM journal_lines l WHERE l.account_id = a.id), 0) AS balance "
    "FROM cash_accounts c JOIN accounts a ON a.org_id = c.org_id AND a.id = c.account_id"
)


@router.get("/cash-accounts", response_model=list[CashAccountOut], summary="Cash desks and bank accounts")
async def list_cash_accounts(
    p: Annotated[Principal, Depends(require("accounting:read"))], db: DB
) -> list[CashAccountOut]:
    async with db.tx(p.session()) as conn:
        await svc.ensure_chart(conn, p.org_id)
        rows = await fetch_all(conn, f"{_CASH_SQL} ORDER BY a.code")
    return [CashAccountOut.model_validate(r) for r in rows]


@router.post(
    "/cash-accounts",
    response_model=CashAccountOut,
    status_code=201,
    summary="Add a cash desk or bank account",
)
async def create_cash_account(
    body: CashAccountIn, p: Annotated[Principal, Depends(require("accounting:write"))], db: DB
) -> CashAccountOut:
    async with db.tx(p.session()) as conn:
        await svc.ensure_chart(conn, p.org_id)
        acc = await fetch_one(
            conn, "SELECT id, type FROM accounts WHERE org_id = %s AND code = %s", (p.org_id, body.code)
        )
        if acc is None:
            acc = await fetch_one(
                conn,
                "INSERT INTO accounts (org_id, code, name, type) VALUES (%s, %s, %s, 'asset') RETURNING id, type",
                (p.org_id, body.code, body.name),
            )
        assert acc is not None
        if acc["type"] != "asset":
            raise Unprocessable("A cash or bank account must be an asset account")
        if await fetch_one(
            conn,
            "SELECT 1 AS x FROM cash_accounts WHERE org_id = %s AND account_id = %s",
            (p.org_id, acc["id"]),
        ):
            raise Conflict("This ledger account is already a cash or bank account")
        row = await fetch_one(
            conn,
            "INSERT INTO cash_accounts (org_id, account_id, name, kind) VALUES (%s, %s, %s, %s) RETURNING id",
            (p.org_id, acc["id"], body.name, body.kind),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_CASH_SQL} WHERE c.id = %s", (row["id"],))
    assert out is not None
    return CashAccountOut.model_validate(out)


# ---- journal ---------------------------------------------------------------------------------------------------
class EntryLineIn(Model):
    account: Code = Field(description="account code")
    debit: Money = ZERO
    credit: Money = ZERO


class EntryIn(Model):
    date: date
    memo: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    lines: list[EntryLineIn] = Field(min_length=2, max_length=100)


Day = date


class ReverseIn(Model):
    date: Day | None = Field(default=None, description="defaults to today; must be in an open month")
    memo: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None


class LineOut(Out):
    seq: int
    account_code: str
    account_name: str
    debit: Dec2
    credit: Dec2


class EntryOut(Out):
    id: uuid.UUID
    entry_no: int
    date: date
    memo: str
    source_type: str
    source_key: str
    reverses_entry_id: uuid.UUID | None
    reversed_by_entry_id: uuid.UUID | None
    lines: list[LineOut]


_ENTRY_SQL = (
    "SELECT e.id AS _id, e.public_id AS id, e.entry_no, e.entry_date AS date, e.memo, e.source_type, e.source_key,"
    " r.public_id AS reverses_entry_id, rb.public_id AS reversed_by_entry_id "
    "FROM journal_entries e LEFT JOIN journal_entries r ON r.org_id = e.org_id AND r.id = e.reverses_entry_id "
    "LEFT JOIN journal_entries rb ON rb.org_id = e.org_id AND rb.reverses_entry_id = e.id"
)


async def _entries(conn: Conn, rows: list[dict[str, Any]]) -> list[EntryOut]:
    if not rows:
        return []
    lines = await fetch_all(
        conn,
        "SELECT l.entry_id, l.seq, a.code AS account_code, a.name AS account_name, l.debit, l.credit "
        "FROM journal_lines l JOIN accounts a ON a.org_id = l.org_id AND a.id = l.account_id "
        "WHERE l.entry_id = ANY(%s) ORDER BY l.seq",
        ([r["_id"] for r in rows],),
    )
    by: dict[int, list[LineOut]] = {}
    for ln in lines:
        by.setdefault(ln["entry_id"], []).append(LineOut.model_validate(ln))
    return [EntryOut(**{k: v for k, v in r.items() if k != "_id"}, lines=by.get(r["_id"], [])) for r in rows]


@router.get("/entries", response_model=Page[EntryOut], summary="Journal entries, newest first")
async def list_entries(
    p: Annotated[Principal, Depends(require("accounting:read"))],
    db: DB,
    pg: Paging,
    date_from: date | None = None,
    date_to: date | None = None,
    account: Annotated[str | None, Query(description="only entries that touch this account code")] = None,
    source_type: str | None = None,
) -> Page[EntryOut]:
    where = ["TRUE"]
    params: list[Any] = []
    if date_from:
        where.append("e.entry_date >= %s")
        params.append(date_from)
    if date_to:
        where.append("e.entry_date <= %s")
        params.append(date_to)
    if source_type:
        where.append("e.source_type = %s")
        params.append(source_type)
    if account:
        where.append(
            "EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.org_id = l.org_id AND a.id = l.account_id "
            "WHERE l.entry_id = e.id AND a.code = %s)"
        )
        params.append(account)
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_ENTRY_SQL} WHERE {' AND '.join(where)} ORDER BY e.entry_no DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
        shown = rows[: pg.limit]
        entries = await _entries(conn, shown)
    return Page[EntryOut](items=entries, limit=pg.limit, offset=pg.offset, has_more=len(rows) > pg.limit)


@router.get("/entries/{entry_id}", response_model=EntryOut)
async def get_entry(
    entry_id: uuid.UUID, p: Annotated[Principal, Depends(require("accounting:read"))], db: DB
) -> EntryOut:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(conn, f"{_ENTRY_SQL} WHERE e.public_id = %s", (entry_id,))
        if not rows:
            raise NotFound("entry not found")
        return (await _entries(conn, rows))[0]


async def _entry_by_id(conn: Conn, eid: int) -> EntryOut:
    return (await _entries(conn, await fetch_all(conn, f"{_ENTRY_SQL} WHERE e.id = %s", (eid,))))[0]


@router.post("/entries", response_model=EntryOut, status_code=201, summary="Post a manual balanced entry")
async def create_entry(
    body: EntryIn, p: Annotated[Principal, Depends(require("accounting:write"))], db: DB
) -> EntryOut:
    async with db.tx(p.session()) as conn:
        if body.date > await svc.org_today(conn):
            raise Unprocessable("An entry cannot be dated in the future")
        eid = await svc.post_entry(
            conn,
            p.org_id,
            p.user_id,
            entry_date=body.date,
            memo=body.memo,
            source_type="manual",
            source_key="",
            lines=[(ln.account, ln.debit, ln.credit) for ln in body.lines],
        )
        return await _entry_by_id(conn, eid)


@router.post(
    "/entries/{entry_id}/reverse",
    response_model=EntryOut,
    status_code=201,
    summary="Correct an entry: post its exact reversal (entries are never edited or deleted)",
)
async def reverse_entry(
    entry_id: uuid.UUID,
    body: ReverseIn,
    p: Annotated[Principal, Depends(require("accounting:write"))],
    db: DB,
) -> EntryOut:
    async with db.tx(p.session()) as conn:
        eid = await resolve(conn, "journal_entries", entry_id, what="entry")
        await svc.lock_ledger(conn, p.org_id)
        today = await svc.org_today(conn)
        on = body.date or today
        if on > today:
            raise Unprocessable("A reversal cannot be dated in the future")
        src = await fetch_one(conn, "SELECT source_type FROM journal_entries WHERE id = %s", (eid,))
        assert src is not None
        if src["source_type"] not in ("manual",):
            raise Conflict(
                "Entries created from a payment, expense, settlement or payroll are corrected by voiding that document"
            )
        new = await svc.reverse_entry(conn, p.org_id, p.user_id, eid, entry_date=on, memo=body.memo)
        return await _entry_by_id(conn, new)


# ---- ledger and reports ----------------------------------------------------------------------------------------
class StatementRow(Out):
    seq: int
    entry_no: int
    date: date
    memo: str
    debit: Dec2
    credit: Dec2
    balance: Dec2


class LedgerOut(Out):
    account: str
    name: str
    side: Literal["debit", "credit"]
    opening: Dec2
    rows: list[StatementRow]
    closing: Dec2


@router.get("/ledger", response_model=LedgerOut, summary="Account statement with a running balance")
async def ledger(
    p: Annotated[Principal, Depends(require("accounting:read"))],
    db: DB,
    account: Code,
    date_from: date | None = None,
    date_to: date | None = None,
) -> LedgerOut:
    async with db.tx(p.session()) as conn:
        today = await svc.org_today(conn)
        end = date_to or today
        if date_from and (end < date_from or (end - date_from).days > MAX_RANGE_DAYS):
            raise Unprocessable("date range must be 0-1830 days")
        acc = await fetch_one(
            conn, "SELECT id, name, type FROM accounts WHERE org_id = %s AND code = %s", (p.org_id, account)
        )
        if acc is None:
            raise NotFound("account not found")
        side = R.normal_side(acc["type"])
        opening = ZERO
        if date_from:
            o = await fetch_one(
                conn,
                "SELECT COALESCE(sum(l.debit), 0) AS d, COALESCE(sum(l.credit), 0) AS c FROM journal_lines l "
                "JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id WHERE l.account_id = %s AND e.entry_date < %s",
                (acc["id"], date_from),
            )
            assert o is not None
            opening = o["d"] - o["c"] if side == "debit" else o["c"] - o["d"]
        rows = await fetch_all(
            conn,
            "SELECT l.seq, e.entry_no, e.entry_date, e.memo, l.debit, l.credit FROM journal_lines l "
            "JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id WHERE l.account_id = %s AND e.entry_date <= %s "
            "AND (%s::date IS NULL OR e.entry_date >= %s::date) ORDER BY l.seq",
            (acc["id"], end, date_from, date_from),
        )
    stmt = R.account_statement(
        opening,
        side,
        [
            {"seq": r["seq"], "date": r["entry_date"].isoformat(), "debit": r["debit"], "credit": r["credit"]}
            for r in rows
        ],
    )
    meta = {r["seq"]: r for r in rows}
    out_rows = [
        StatementRow(
            seq=x["seq"], entry_no=meta[x["seq"]]["entry_no"], date=date.fromisoformat(x["date"]), memo=meta[x["seq"]]["memo"],
            debit=x["debit"], credit=x["credit"], balance=x["balance"],
        )
        for x in stmt["rows"]
    ]  # fmt: skip
    return LedgerOut(
        account=account,
        name=acc["name"],
        side=side,
        opening=stmt["opening"],
        rows=out_rows,
        closing=stmt["closing"],
    )


class TrialRow(Out):
    code: str
    name: str
    type: str
    debit: Dec2
    credit: Dec2
    balance_debit: Dec2
    balance_credit: Dec2


class TrialBalanceOut(Out):
    as_of: date
    date_from: date | None
    rows: list[TrialRow]
    total_debit: Dec2
    total_credit: Dec2
    total_balance_debit: Dec2
    total_balance_credit: Dec2
    balanced: bool


@router.get("/reports/trial-balance", response_model=TrialBalanceOut, summary="Trial balance")
async def trial_balance(
    p: Annotated[Principal, Depends(require("accounting:read"))],
    db: DB,
    as_of: date | None = None,
    date_from: Annotated[
        date | None, Query(description="only movements from this date (default: from the start)")
    ] = None,
) -> TrialBalanceOut:
    async with db.tx(p.session()) as conn:
        await svc.ensure_chart(conn, p.org_id)
        end = as_of or await svc.org_today(conn)
        if date_from and date_from > end:
            raise Unprocessable("date_from is after as_of")
        t = await svc.totals(conn, date_from=date_from, date_to=end)
        chart = await svc.chart(conn)
    return TrialBalanceOut(as_of=end, date_from=date_from, **R.trial_balance(t, chart))


class NamedAmount(Out):
    code: str
    name: str
    amount: Dec2


class IncomeStatementOut(Out):
    date_from: date
    date_to: date
    income: list[NamedAmount]
    expenses: list[NamedAmount]
    total_income: Dec2
    total_expenses: Dec2
    net: Dec2


@router.get(
    "/reports/income-statement", response_model=IncomeStatementOut, summary="Income statement for a period"
)
async def income_statement(
    p: Annotated[Principal, Depends(require("accounting:read"))], db: DB, date_from: date, date_to: date
) -> IncomeStatementOut:
    if date_to < date_from or (date_to - date_from).days > MAX_RANGE_DAYS:
        raise Unprocessable("date range must be 0-1830 days")
    async with db.tx(p.session()) as conn:
        await svc.ensure_chart(conn, p.org_id)
        t = await svc.totals(conn, date_from=date_from, date_to=date_to)
        chart = await svc.chart(conn)
    return IncomeStatementOut(date_from=date_from, date_to=date_to, **R.income_statement(t, chart))


class BalanceSheetOut(Out):
    as_of: date
    assets: list[NamedAmount]
    liabilities: list[NamedAmount]
    equity: list[NamedAmount]
    current_result: Dec2
    total_assets: Dec2
    total_liabilities: Dec2
    total_equity: Dec2
    balanced: bool


@router.get("/reports/balance-sheet", response_model=BalanceSheetOut, summary="Balance sheet as of a date")
async def balance_sheet(
    p: Annotated[Principal, Depends(require("accounting:read"))], db: DB, as_of: date | None = None
) -> BalanceSheetOut:
    async with db.tx(p.session()) as conn:
        await svc.ensure_chart(conn, p.org_id)
        end = as_of or await svc.org_today(conn)
        t = await svc.totals(conn, date_from=None, date_to=end)
        chart = await svc.chart(conn)
    return BalanceSheetOut(as_of=end, **R.balance_sheet(t, chart))


# ---- periods, verification, sync -------------------------------------------------------------------------------
class PeriodOut(Out):
    month: str
    last_seq: int
    head_hash: str
    total_debit: Dec2
    total_credit: Dec2
    period_hash: str


@router.get("/periods", response_model=list[PeriodOut], summary="Closed months")
async def list_periods(
    p: Annotated[Principal, Depends(require("accounting:read"))], db: DB
) -> list[PeriodOut]:
    async with db.tx(p.session()) as conn:
        periods = await svc.load_periods(conn, p.org_id)
    return [PeriodOut(**vars(x)) for x in periods]


@router.post(
    "/periods/{month}/close",
    response_model=PeriodOut,
    status_code=201,
    summary="Close a month that has ended (final: corrections are reversing entries in an open month)",
)
async def close_period(
    month: Annotated[str, Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")],
    p: Annotated[Principal, Depends(require("accounting:close"))],
    db: DB,
) -> PeriodOut:
    first = date.fromisoformat(f"{month}-01")
    async with db.tx(p.session()) as conn:
        await svc.ensure_chart(conn, p.org_id)
        await svc.lock_ledger(conn, p.org_id)
        today = await svc.org_today(conn)
        if first >= today.replace(day=1):
            raise Conflict("Only a month that has ended can be closed")
        if month in await svc.closed_months(conn):
            raise Conflict(f"{month} is already closed")
        missing = [
            i for i in await svc.pending(conn, p.org_id) if i["kind"] == "post" and i["date"][:7] <= month
        ]
        if missing:
            raise Conflict(
                f"{len(missing)} source document(s) of {month} or earlier are not posted yet: run the sync first",
                details={"unposted": len(missing)},
            )
        lines = await svc.load_chain(conn, p.org_id)
        verdict = verify_chain(lines, await svc.load_periods(conn, p.org_id))
        if not verdict.ok:
            raise Conflict("The journal does not verify; it cannot be closed", details=verdict.as_dict())
        period = make_period(month, lines)
        await execute(
            conn,
            "INSERT INTO accounting_periods (org_id, month, last_seq, head_hash, total_debit, total_credit, period_hash, closed_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                p.org_id,
                first,
                period.last_seq,
                period.head_hash,
                period.total_debit,
                period.total_credit,
                period.period_hash,
                p.user_id,
            ),
        )
    return PeriodOut(**vars(period))


class VerifyOut(Out):
    ok: bool
    lines: int
    broken_seq: int | None = Field(description="the first broken journal line")
    reason: str | None
    period_issues: list[dict[str, Any]]


@router.get("/verify", response_model=VerifyOut, summary="Verify the hash chain and the closed periods")
async def verify(p: Annotated[Principal, Depends(require("accounting:read"))], db: DB) -> VerifyOut:
    async with db.tx(p.session()) as conn:
        lines = await svc.load_chain(conn, p.org_id)
        v = verify_chain(lines, await svc.load_periods(conn, p.org_id))
    return VerifyOut(lines=len(lines), **v.as_dict())


class PendingOut(Out):
    kind: Literal["post", "reverse"]
    source_type: str
    source_key: str
    date: date


@router.get(
    "/pending", response_model=list[PendingOut], summary="Source documents without a journal entry yet"
)
async def pending(p: Annotated[Principal, Depends(require("accounting:read"))], db: DB) -> list[PendingOut]:
    async with db.tx(p.session()) as conn:
        items = await svc.pending(conn, p.org_id)
    return [PendingOut.model_validate(i) for i in items]


class BlockedOut(Out):
    source_type: str
    source_key: str
    date: str
    reason: str


class SyncOut(Out):
    posted: int
    reversed: int
    blocked: list[BlockedOut]


@router.post(
    "/sync", response_model=SyncOut, summary="Post what is missing (idempotent: a second run posts nothing)"
)
async def sync(p: Annotated[Principal, Depends(require("accounting:write"))], db: DB) -> SyncOut:
    async with db.tx(p.session()) as conn:
        result = await svc.sync(conn, p.org_id, p.user_id)
    return SyncOut.model_validate(result)
