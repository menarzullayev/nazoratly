"""Accounting service: chart seeding, posting to the hash-chained journal, automatic postings of payments, expenses,
supplier settlements and teacher pay, reversals, and the catch-up `sync`.

Every posting runs inside the caller's transaction (the same transaction that created or voided the source document), so
a source and its entry commit or roll back together. The rules (which accounts, how a hash is computed, what is still
pending) live in `rules/accounting.py` and `rules/ledger.py` and are golden-tested against the Sheets edition; the database
re-checks the chain, the balance and the closed months (migration 0015)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from nazoratly.db import Conn, execute, fetch_all, fetch_one
from nazoratly.errors import Conflict, Unprocessable
from nazoratly.rules import accounting as R
from nazoratly.rules.ledger import Head, Line, Period, reverse_lines, seal_entry, validate_entry

Lines = list[tuple[str, Decimal, Decimal]]

_CODE_ERRORS = {
    "too_few_lines": "an entry needs at least two lines",
    "bad_line": "every line must have exactly one positive side (debit or credit)",
    "unknown_account": "an account code is not in the chart of accounts",
    "inactive_account": "an account is not active",
    "unbalanced": "the entry is not balanced (debit differs from credit)",
    "closed_period": "the month of the entry is closed",
}


class LedgerError(Unprocessable):
    """The entry cannot be posted; `details.errors` lists the machine-readable codes."""


async def ensure_chart(conn: Conn, org_id: int) -> None:
    """Seeds the chart template (accounts added to the template later too) and the two default cash accounts for a
    center (idempotent)."""
    have = await fetch_one(
        conn,
        "SELECT count(*) AS n FROM accounts WHERE org_id = %s AND code = ANY(%s)",
        (org_id, [code for code, _, _ in R.CHART]),
    )
    assert have is not None
    if have["n"] == len(R.CHART):
        return
    for code, name, kind in R.CHART:
        await execute(
            conn,
            "INSERT INTO accounts (org_id, code, name, type) VALUES (%s, %s, %s, %s) ON CONFLICT (org_id, code) DO NOTHING",
            (org_id, code, name, kind),
        )
    for code, name, kind in ((R.CASH, "Kassa", "cash"), (R.BANK, "Bank hisobi", "bank")):
        await execute(
            conn,
            "INSERT INTO cash_accounts (org_id, account_id, name, kind) "
            "SELECT %s, id, %s, %s FROM accounts WHERE org_id = %s AND code = %s ON CONFLICT (org_id, account_id) DO NOTHING",
            (org_id, name, kind, org_id, code),
        )


async def lock_ledger(conn: Conn, org_id: int) -> None:
    await execute(conn, "SELECT ledger_lock(%s)", (org_id,))


async def org_today(conn: Conn) -> date:
    row = await fetch_one(
        conn,
        "SELECT (now() AT TIME ZONE o.timezone)::date AS d FROM organizations o WHERE o.id = app_org_id()",
    )
    assert row is not None
    d: date = row["d"]
    return d


async def current_head(conn: Conn, org_id: int) -> Head:
    row = await fetch_one(
        conn,
        "SELECT l.seq, l.hash, e.entry_no FROM journal_lines l JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id "
        "WHERE l.org_id = %s ORDER BY l.seq DESC LIMIT 1",
        (org_id,),
    )
    return Head() if row is None else Head(int(row["seq"]), int(row["entry_no"]), str(row["hash"]))


async def closed_months(conn: Conn) -> set[str]:
    rows = await fetch_all(conn, "SELECT to_char(month, 'YYYY-MM') AS m FROM accounting_periods")
    return {r["m"] for r in rows}


async def account_ids(conn: Conn, org_id: int) -> dict[str, tuple[int, bool]]:
    rows = await fetch_all(conn, "SELECT id, code, active FROM accounts WHERE org_id = %s", (org_id,))
    return {r["code"]: (int(r["id"]), bool(r["active"])) for r in rows}


async def post_entry(
    conn: Conn,
    org_id: int,
    user_id: int | None,
    *,
    entry_date: date,
    memo: str,
    source_type: str,
    source_key: str,
    lines: Lines,
    reverses: int | None = None,
) -> int:
    """Validates, chains and inserts one entry; returns its id. Raises LedgerError (422) or Conflict (closed month)."""
    await ensure_chart(conn, org_id)
    await lock_ledger(conn, org_id)
    accounts = await account_ids(conn, org_id)
    errors = validate_entry(
        lines,
        {c: active for c, (_, active) in accounts.items()},
        date=entry_date.isoformat(),
        closed_months=await closed_months(conn),
    )
    if errors:
        text = "; ".join(_CODE_ERRORS[e] for e in errors)
        if errors == ["closed_period"]:
            raise Conflict(text, details={"errors": errors})
        raise LedgerError(text, details={"errors": errors})
    head = await current_head(conn, org_id)
    sealed = seal_entry(
        head,
        date=entry_date.isoformat(),
        memo=memo[:500],
        source_type=source_type,
        source_key=source_key,
        lines=lines,
    )
    entry = await fetch_one(
        conn,
        "INSERT INTO journal_entries (org_id, entry_no, entry_date, memo, source_type, source_key, line_count, reverses_entry_id, created_by_user_id) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (
            org_id,
            head.entry_no + 1,
            entry_date,
            memo[:500],
            source_type,
            source_key,
            len(lines),
            reverses,
            user_id,
        ),
    )
    assert entry is not None
    for ln in sealed:
        await execute(
            conn,
            "INSERT INTO journal_lines (org_id, seq, entry_id, account_id, debit, credit, prev_hash, hash) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                org_id,
                ln.seq,
                entry["id"],
                accounts[ln.account][0],
                ln.debit,
                ln.credit,
                ln.prev_hash,
                ln.hash,
            ),
        )
    return int(entry["id"])


async def entry_lines(conn: Conn, entry_id: int) -> Lines:
    rows = await fetch_all(
        conn,
        "SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.org_id = l.org_id AND a.id = l.account_id "
        "WHERE l.entry_id = %s ORDER BY l.seq",
        (entry_id,),
    )
    return [(r["code"], r["debit"], r["credit"]) for r in rows]


async def reverse_entry(
    conn: Conn,
    org_id: int,
    user_id: int | None,
    entry_id: int,
    *,
    entry_date: date,
    memo: str | None,
    source_type: str = "reversal",
    source_key: str | None = None,
) -> int:
    orig = await fetch_one(
        conn, "SELECT entry_no, memo, source_type FROM journal_entries WHERE id = %s", (entry_id,)
    )
    assert orig is not None
    if orig["source_type"] in ("reversal", "payment_void", "expense_void", "bill_payment_void"):
        raise Conflict("A reversing entry cannot be reversed again; post a new entry instead")
    if await fetch_one(conn, "SELECT 1 AS x FROM journal_entries WHERE reverses_entry_id = %s", (entry_id,)):
        raise Conflict("This entry is already reversed")
    return await post_entry(
        conn,
        org_id,
        user_id,
        entry_date=entry_date,
        memo=memo or f"Bekor qilish: #{orig['entry_no']} {orig['memo']}",
        source_type=source_type,
        source_key=source_key or str(orig["entry_no"]),
        lines=reverse_lines(await entry_lines(conn, entry_id)),
        reverses=entry_id,
    )


# ---- automatic postings ------------------------------------------------------------------------------------------
async def post_payment(conn: Conn, org_id: int, user_id: int | None, payment_id: int) -> int | None:
    row = await fetch_one(
        conn,
        "SELECT p.amount, p.method, (p.paid_at AT TIME ZONE o.timezone)::date AS d, s.full_name "
        "FROM payments p JOIN organizations o ON o.id = p.org_id JOIN students s ON s.org_id = p.org_id AND s.id = p.student_id "
        "WHERE p.id = %s",
        (payment_id,),
    )
    assert row is not None
    lines = R.posting_lines({"event": "payment", "method": row["method"], "amount": row["amount"]})
    if not lines:
        return None
    return await post_entry(
        conn,
        org_id,
        user_id,
        entry_date=row["d"],
        memo=f"To'lov: {row['full_name']} ({row['method']})",
        source_type="payment",
        source_key=str(payment_id),
        lines=lines,
    )


async def post_expense(conn: Conn, org_id: int, user_id: int | None, expense_id: int) -> int | None:
    row = await fetch_one(
        conn,
        "SELECT category, amount, spent_at, paid_from, (bill_id IS NOT NULL) AS bill, description FROM expenses WHERE id = %s",
        (expense_id,),
    )
    assert row is not None
    lines = R.posting_lines(
        {
            "event": "expense",
            "category": row["category"],
            "amount": row["amount"],
            "paid_from": row["paid_from"],
            "bill": row["bill"],
        }
    )
    if not lines:
        return None
    memo = f"Xarajat: {row['category']}" + (f" ({row['description']})" if row["description"] else "")
    return await post_entry(
        conn,
        org_id,
        user_id,
        entry_date=row["spent_at"],
        memo=memo,
        source_type="expense",
        source_key=str(expense_id),
        lines=lines,
    )


async def post_refund(conn: Conn, org_id: int, user_id: int | None, refund_id: int) -> int | None:
    """Money given back (cash or bank). A refund that stays as credit moves no money and posts nothing."""
    row = await fetch_one(
        conn,
        "SELECT r.amount, r.payout, r.kind, r.refunded_on, s.full_name FROM refunds r "
        "JOIN students s ON s.org_id = r.org_id AND s.id = r.student_id WHERE r.id = %s",
        (refund_id,),
    )
    assert row is not None
    lines = R.posting_lines({"event": "refund", "payout": row["payout"], "amount": row["amount"]})
    if not lines:
        return None
    return await post_entry(
        conn,
        org_id,
        user_id,
        entry_date=row["refunded_on"],
        memo=f"Qaytarish ({row['kind']}): {row['full_name']} ({row['payout']})",
        source_type="refund",
        source_key=str(refund_id),
        lines=lines,
    )


async def post_cash_difference(
    conn: Conn,
    org_id: int,
    user_id: int | None,
    *,
    close_id: int,
    entry_date: date,
    difference: Decimal,
) -> int | None:
    """Books the difference found at a cash close: more cash than booked is other income, less is a shortage."""
    lines = R.posting_lines(
        {
            "event": "cash_close",
            "direction": "over" if difference > 0 else "short",
            "amount": abs(difference),
        }
    )
    if not lines:
        return None
    return await post_entry(
        conn,
        org_id,
        user_id,
        entry_date=entry_date,
        memo=f"Kassa farqi ({'ortiqcha' if difference > 0 else 'kamomad'}): smena yopilishi #{close_id}",
        source_type="cash_close",
        source_key=str(close_id),
        lines=lines,
    )


async def cash_book_balance(conn: Conn, org_id: int, through: date) -> tuple[Decimal, int]:
    """What the books say the cash desk holds through `through` (all cash-kind accounts) and the journal head line."""
    row = await fetch_one(
        conn,
        "SELECT COALESCE(sum(l.debit - l.credit), 0) AS bal FROM journal_lines l "
        "JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id "
        "JOIN cash_accounts ca ON ca.org_id = l.org_id AND ca.account_id = l.account_id "
        "WHERE l.org_id = %s AND ca.kind = 'cash' AND e.entry_date <= %s",
        (org_id, through),
    )
    assert row is not None
    return Decimal(row["bal"]), (await current_head(conn, org_id)).seq


async def post_bill_payment(conn: Conn, org_id: int, user_id: int | None, bill_payment_id: int) -> int | None:
    row = await fetch_one(
        conn,
        "SELECT bp.amount, bp.paid_on, bp.paid_from, sb.number, s.name FROM bill_payments bp "
        "JOIN supplier_bills sb ON sb.org_id = bp.org_id AND sb.id = bp.bill_id "
        "JOIN suppliers s ON s.org_id = sb.org_id AND s.id = sb.supplier_id WHERE bp.id = %s",
        (bill_payment_id,),
    )
    assert row is not None
    lines = R.posting_lines({"event": "bill_payment", "amount": row["amount"], "paid_from": row["paid_from"]})
    if not lines:
        return None
    return await post_entry(
        conn,
        org_id,
        user_id,
        entry_date=row["paid_on"],
        memo=f"Yetkazib beruvchiga to'lov: {row['name']} #{row['number']}",
        source_type="bill_payment",
        source_key=str(bill_payment_id),
        lines=lines,
    )


async def _payroll_facts(conn: Conn, payroll_id: int) -> dict[str, Any]:
    row = await fetch_one(
        conn,
        "SELECT t.total, to_char(t.period_month, 'YYYY-MM') AS month, te.full_name, "
        "(tp.approved_at AT TIME ZONE o.timezone)::date AS approved_on, (tp.paid_at AT TIME ZONE o.timezone)::date AS paid_on "
        "FROM teacher_payrolls tp JOIN v_teacher_payroll_totals t ON t.payroll_id = tp.id "
        "JOIN teachers te ON te.org_id = tp.org_id AND te.id = tp.teacher_id JOIN organizations o ON o.id = tp.org_id "
        "WHERE tp.id = %s",
        (payroll_id,),
    )
    assert row is not None
    return row


async def post_payroll(
    conn: Conn, org_id: int, user_id: int | None, payroll_id: int, stage: str
) -> int | None:
    """stage: payroll_accrual (approved) or payroll_payment (paid)."""
    f = await _payroll_facts(conn, payroll_id)
    lines = R.posting_lines({"event": stage, "amount": f["total"]})
    if not lines:
        return None
    on = f["approved_on"] if stage == "payroll_accrual" else f["paid_on"]
    what = "hisoblandi" if stage == "payroll_accrual" else "to'landi"
    return await post_entry(
        conn,
        org_id,
        user_id,
        entry_date=on,
        memo=f"O'qituvchi oyligi {what}: {f['full_name']} ({f['month']})",
        source_type=stage,
        source_key=str(payroll_id),
        lines=lines,
    )


async def void_source(
    conn: Conn, org_id: int, user_id: int | None, source_type: str, source_key: str
) -> int | None:
    """Reverses the entry of a voided source document (dated today); nothing when it was never posted or is already
    reversed."""
    await ensure_chart(conn, org_id)
    await lock_ledger(conn, org_id)
    orig = await fetch_one(
        conn,
        "SELECT id FROM journal_entries WHERE org_id = %s AND source_type = %s AND source_key = %s",
        (org_id, source_type, source_key),
    )
    if orig is None:
        return None
    if await fetch_one(
        conn, "SELECT 1 AS x FROM journal_entries WHERE reverses_entry_id = %s", (orig["id"],)
    ):
        return None
    return await reverse_entry(
        conn,
        org_id,
        user_id,
        int(orig["id"]),
        entry_date=await org_today(conn),
        memo=None,
        source_type=f"{source_type}_void",
        source_key=source_key,
    )


# ---- catch-up ------------------------------------------------------------------------------------------------------
async def _sources(conn: Conn) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for r in await fetch_all(
        conn,
        "SELECT p.id, p.amount, p.method, (p.paid_at AT TIME ZONE o.timezone)::date AS d, (p.voided_at IS NOT NULL) AS voided "
        "FROM payments p JOIN organizations o ON o.id = p.org_id WHERE NOT p.is_demo",
    ):
        out.append(
            {"type": "payment", "key": str(r["id"]), "date": r["d"].isoformat(), "amount": r["amount"],
             "voided": r["voided"], "method": r["method"]}
        )  # fmt: skip
    for r in await fetch_all(
        conn,
        "SELECT id, category, amount, spent_at, paid_from, (bill_id IS NOT NULL) AS bill, (voided_at IS NOT NULL) AS voided FROM expenses WHERE NOT is_demo",
    ):
        out.append(
            {"type": "expense", "key": str(r["id"]), "date": r["spent_at"].isoformat(), "amount": r["amount"],
             "voided": r["voided"], "category": r["category"], "paid_from": r["paid_from"], "bill": r["bill"]}
        )  # fmt: skip
    for r in await fetch_all(
        conn, "SELECT id, amount, payout, refunded_on FROM refunds WHERE payout <> 'credit' AND amount > 0"
    ):
        out.append(
            {"type": "refund", "key": str(r["id"]), "date": r["refunded_on"].isoformat(), "amount": r["amount"],
             "voided": False, "payout": r["payout"]}
        )  # fmt: skip
    for r in await fetch_all(
        conn, "SELECT id, amount, paid_on, paid_from, (voided_at IS NOT NULL) AS voided FROM bill_payments"
    ):
        out.append(
            {"type": "bill_payment", "key": str(r["id"]), "date": r["paid_on"].isoformat(), "amount": r["amount"],
             "voided": r["voided"], "paid_from": r["paid_from"]}
        )  # fmt: skip
    for r in await fetch_all(
        conn,
        "SELECT tp.id, t.total, (tp.approved_at AT TIME ZONE o.timezone)::date AS approved_on, (tp.paid_at AT TIME ZONE o.timezone)::date AS paid_on "
        "FROM teacher_payrolls tp JOIN v_teacher_payroll_totals t ON t.payroll_id = tp.id JOIN organizations o ON o.id = tp.org_id "
        "WHERE tp.status IN ('approved','paid')",
    ):
        out.append(
            {"type": "payroll_accrual", "key": str(r["id"]), "date": r["approved_on"].isoformat(), "amount": r["total"], "voided": False}
        )  # fmt: skip
        if r["paid_on"] is not None:
            out.append(
                {"type": "payroll_payment", "key": str(r["id"]), "date": r["paid_on"].isoformat(), "amount": r["total"], "voided": False}
            )  # fmt: skip
    return out


async def pending(conn: Conn, org_id: int) -> list[dict[str, Any]]:
    posted = {
        (r["source_type"], r["source_key"])
        for r in await fetch_all(
            conn,
            "SELECT source_type, source_key FROM journal_entries WHERE org_id = %s AND source_type <> 'manual'",
            (org_id,),
        )
    }
    return R.pending_postings(await _sources(conn), posted, (await org_today(conn)).isoformat())


_POSTERS = {
    "payment": post_payment,
    "expense": post_expense,
    "bill_payment": post_bill_payment,
    "refund": post_refund,
}


async def sync(conn: Conn, org_id: int, user_id: int | None) -> dict[str, Any]:
    """Posts every source document that has no entry yet and reverses voided ones; entries that would land in a closed
    month are reported as blocked (nothing is changed for them)."""
    await ensure_chart(conn, org_id)
    await lock_ledger(conn, org_id)
    posted_n = reversed_n = 0
    blocked: list[dict[str, str]] = []
    closed = await closed_months(conn)
    for item in await pending(conn, org_id):
        t = item["source_type"]
        key = item["source_key"]
        if item["date"][:7] in closed:
            blocked.append(
                {"source_type": t, "source_key": key, "date": item["date"], "reason": "closed_period"}
            )
            continue
        if item["kind"] == "reverse":
            if await void_source(conn, org_id, user_id, t.removesuffix("_void"), key) is not None:
                reversed_n += 1
        elif t in _POSTERS:
            if await _POSTERS[t](conn, org_id, user_id, int(key)) is not None:
                posted_n += 1
        elif await post_payroll(conn, org_id, user_id, int(key), t) is not None:
            posted_n += 1
    return {"posted": posted_n, "reversed": reversed_n, "blocked": blocked}


# ---- reading the journal -----------------------------------------------------------------------------------------
async def load_chain(conn: Conn, org_id: int) -> list[Line]:
    rows = await fetch_all(
        conn,
        "SELECT l.seq, e.entry_no, e.entry_date, a.code AS account, l.debit, l.credit, e.source_type, e.source_key, e.memo, l.prev_hash, l.hash "
        "FROM journal_lines l JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id "
        "JOIN accounts a ON a.org_id = l.org_id AND a.id = l.account_id WHERE l.org_id = %s ORDER BY l.seq",
        (org_id,),
    )
    return [
        Line(
            seq=int(r["seq"]),
            entry_no=int(r["entry_no"]),
            date=r["entry_date"].isoformat(),
            account=r["account"],
            debit=r["debit"],
            credit=r["credit"],
            source_type=r["source_type"],
            source_key=r["source_key"],
            memo=r["memo"],
            prev_hash=r["prev_hash"],
            hash=r["hash"],
        )
        for r in rows
    ]


async def load_periods(conn: Conn, org_id: int) -> list[Period]:
    rows = await fetch_all(
        conn,
        "SELECT to_char(month, 'YYYY-MM') AS month, last_seq, head_hash, total_debit, total_credit, period_hash "
        "FROM accounting_periods WHERE org_id = %s ORDER BY month",
        (org_id,),
    )
    return [
        Period(
            r["month"],
            int(r["last_seq"]),
            r["head_hash"],
            r["total_debit"],
            r["total_credit"],
            r["period_hash"],
        )
        for r in rows
    ]


async def totals(conn: Conn, *, date_from: date | None, date_to: date) -> R.Totals:
    rows = await fetch_all(
        conn,
        "SELECT a.code, COALESCE(sum(l.debit), 0) AS d, COALESCE(sum(l.credit), 0) AS c "
        "FROM journal_lines l JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id "
        "JOIN accounts a ON a.org_id = l.org_id AND a.id = l.account_id "
        "WHERE e.entry_date <= %s AND (%s::date IS NULL OR e.entry_date >= %s::date) GROUP BY a.code",
        (date_to, date_from, date_from),
    )
    return {r["code"]: (r["d"], r["c"]) for r in rows}


async def chart(conn: Conn) -> list[dict[str, str]]:
    rows = await fetch_all(conn, "SELECT code, name, type FROM accounts ORDER BY code")
    return [{"code": r["code"], "name": r["name"], "type": r["type"]} for r in rows]
