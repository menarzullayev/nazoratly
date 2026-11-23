"""Accounting rules around the journal: chart template, automatic posting rules, pending postings, the three reports,
the account statement, payables aging and bank statement matching. Pure functions, mirrored in TypeScript
(sheets/src/domain/accounting.ts) and checked against tests/golden/accounting.json.

Management accounting (not a statutory chart, see the design spec section 6). Amounts are exact decimals; dates are
ISO strings. Lines are `(account_code, debit, credit)` tuples."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from nazoratly.rules.ledger import ZERO, fmt, money, reverse_lines

Lines = list[tuple[str, Decimal, Decimal]]

CASH = "1000"
BANK = "1010"
PAYABLES = "2000"
SALARY_PAYABLE = "2100"
CAPITAL = "3000"
TUITION_INCOME = "4000"
TEACHER_PAY = "5100"

# (code, name, type); the normal side follows from the type: asset and expense are debit, the rest credit
CHART: tuple[tuple[str, str, str], ...] = (
    ("1000", "Kassa", "asset"),
    ("1010", "Bank hisobi", "asset"),
    ("2000", "Yetkazib beruvchilarga qarz", "liability"),
    ("2100", "O'qituvchilarga oylik qarzi", "liability"),
    ("3000", "Egasi kapitali", "equity"),
    ("4000", "O'quv to'lovlari", "income"),
    ("4100", "Boshqa daromadlar", "income"),
    ("5000", "Ijara", "expense"),
    ("5010", "Kommunal xizmatlar", "expense"),
    ("5020", "Boshqa xodimlar maoshi", "expense"),
    ("5030", "Reklama", "expense"),
    ("5040", "Jihoz", "expense"),
    ("5050", "Soliqlar", "expense"),
    ("5090", "Boshqa xarajatlar", "expense"),
    ("5100", "O'qituvchilar oyligi", "expense"),
)
ACCOUNT_TYPES = ("asset", "liability", "equity", "income", "expense")
EXPENSE_ACCOUNT = {
    "rent": "5000",
    "utilities": "5010",
    "salary": "5020",
    "marketing": "5030",
    "equipment": "5040",
    "tax": "5050",
    "other": "5090",
}


def normal_side(account_type: str) -> str:
    return "debit" if account_type in ("asset", "expense") else "credit"


def cash_account(method: str) -> str:
    """Cash goes to the cash desk; every other payment method is a bank-side movement."""
    return CASH if method == "cash" else BANK


def posting_lines(event: dict[str, Any]) -> Lines:
    """The journal lines of a source document; empty when the amount is not positive (nothing to post)."""
    amount = money(event["amount"])
    if amount <= 0:
        return []
    kind = event["event"]
    if kind == "payment":
        return [(cash_account(event["method"]), amount, ZERO), (TUITION_INCOME, ZERO, amount)]
    if kind == "expense":
        credit = PAYABLES if event.get("bill") else CASH if event.get("paid_from", "cash") == "cash" else BANK
        return [(EXPENSE_ACCOUNT[event["category"]], amount, ZERO), (credit, ZERO, amount)]
    if kind == "bill_payment":
        return [
            (PAYABLES, amount, ZERO),
            (CASH if event.get("paid_from", "cash") == "cash" else BANK, ZERO, amount),
        ]
    if kind == "payroll_accrual":
        return [(TEACHER_PAY, amount, ZERO), (SALARY_PAYABLE, ZERO, amount)]
    if kind == "payroll_payment":
        return [(SALARY_PAYABLE, amount, ZERO), (CASH, ZERO, amount)]
    raise ValueError(f"unknown posting event {kind!r}")


_EVENT_OF = {
    "payment": "payment",
    "expense": "expense",
    "bill_payment": "bill_payment",
    "payroll_accrual": "payroll_accrual",
    "payroll_payment": "payroll_payment",
}
_ORDER = {t: i for i, t in enumerate(_EVENT_OF)}


def pending_postings(
    sources: list[dict[str, Any]], posted: set[tuple[str, str]], today: str
) -> list[dict[str, Any]]:
    """What is still missing in the journal. A source is a document with `type` (payment, expense, bill_payment,
    payroll_accrual, payroll_payment), `key`, `date`, `amount`, `voided` and the posting facts (method, category,
    paid_from, bill). `posted` holds `(source_type, source_key)` of existing entries, reversals of voided sources use
    `<type>_void`. Result items: `post` (dated by the source) or `reverse` (dated today; the caller reverses the entry
    that was really posted, so `lines` is empty)."""
    out: list[dict[str, Any]] = []
    for s in sources:
        t, key = s["type"], s["key"]
        lines = posting_lines({"event": _EVENT_OF[t], **s})
        if not lines:
            continue
        if (t, key) not in posted:
            if not s.get("voided"):
                out.append(
                    {
                        "kind": "post",
                        "source_type": t,
                        "source_key": key,
                        "date": s["date"],
                        "lines": [[a, fmt(d), fmt(c)] for a, d, c in lines],
                    }
                )
        elif s.get("voided") and (f"{t}_void", key) not in posted:
            out.append(
                {"kind": "reverse", "source_type": f"{t}_void", "source_key": key, "date": today, "lines": []}
            )
    out.sort(
        key=lambda i: (i["date"], _ORDER[i["source_type"].removesuffix("_void")], i["source_key"], i["kind"])
    )
    return out


# ---- reports -----------------------------------------------------------------------------------------------------
Totals = dict[str, tuple[Decimal, Decimal]]  # account code -> (sum debit, sum credit)


def _info(chart: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    return {a["code"]: a for a in chart}


def trial_balance(totals: Totals, chart: list[dict[str, str]]) -> dict[str, Any]:
    info = _info(chart)
    rows: list[dict[str, str]] = []
    sd = sc = sbd = sbc = ZERO
    for code in sorted(totals):
        d, c = totals[code]
        if d == 0 and c == 0:
            continue
        net = d - c
        bd, bc = (net, ZERO) if net > 0 else (ZERO, -net)
        a = info.get(code, {"name": code, "type": "?"})
        rows.append(
            {
                "code": code,
                "name": a["name"],
                "type": a["type"],
                "debit": fmt(d),
                "credit": fmt(c),
                "balance_debit": fmt(bd),
                "balance_credit": fmt(bc),
            }
        )
        sd, sc, sbd, sbc = sd + d, sc + c, sbd + bd, sbc + bc
    return {
        "rows": rows,
        "total_debit": fmt(sd),
        "total_credit": fmt(sc),
        "total_balance_debit": fmt(sbd),
        "total_balance_credit": fmt(sbc),
        "balanced": sd == sc,
    }


def _natural(totals: Totals, code: str, account_type: str) -> Decimal:
    d, c = totals.get(code, (ZERO, ZERO))
    return d - c if normal_side(account_type) == "debit" else c - d


def income_statement(totals: Totals, chart: list[dict[str, str]]) -> dict[str, Any]:
    """`totals` are the sums of the period (the caller sums lines dated inside it)."""
    income: list[dict[str, str]] = []
    expenses: list[dict[str, str]] = []
    ti = te = ZERO
    for a in sorted(chart, key=lambda x: x["code"]):
        if a["type"] not in ("income", "expense"):
            continue
        amount = _natural(totals, a["code"], a["type"])
        if amount == 0:
            continue
        row = {"code": a["code"], "name": a["name"], "amount": fmt(amount)}
        if a["type"] == "income":
            income.append(row)
            ti += amount
        else:
            expenses.append(row)
            te += amount
    return {
        "income": income,
        "expenses": expenses,
        "total_income": fmt(ti),
        "total_expenses": fmt(te),
        "net": fmt(ti - te),
    }


def balance_sheet(totals: Totals, chart: list[dict[str, str]]) -> dict[str, Any]:
    """`totals` are cumulative through the as-of date. Income and expense accounts fold into one equity line,
    the current result, so the sheet balances without closing entries."""
    groups: dict[str, list[dict[str, str]]] = {"asset": [], "liability": [], "equity": []}
    sums: dict[str, Decimal] = {"asset": ZERO, "liability": ZERO, "equity": ZERO}
    result = ZERO
    for a in sorted(chart, key=lambda x: x["code"]):
        amount = _natural(totals, a["code"], a["type"])
        if a["type"] in groups:
            if amount == 0:
                continue
            groups[a["type"]].append({"code": a["code"], "name": a["name"], "amount": fmt(amount)})
            sums[a["type"]] += amount
        else:
            result += amount if a["type"] == "income" else -amount
    equity_total = sums["equity"] + result
    return {
        "assets": groups["asset"],
        "liabilities": groups["liability"],
        "equity": groups["equity"],
        "current_result": fmt(result),
        "total_assets": fmt(sums["asset"]),
        "total_liabilities": fmt(sums["liability"]),
        "total_equity": fmt(equity_total),
        "balanced": sums["asset"] == sums["liability"] + equity_total,
    }


def account_statement(opening: Decimal, side: str, lines: list[dict[str, Any]]) -> dict[str, Any]:
    """Running balance of one account in its natural side (debit-normal: debit - credit)."""
    bal = opening
    rows: list[dict[str, Any]] = []
    for ln in sorted(lines, key=lambda x: x["seq"]):
        d, c = money(ln["debit"]), money(ln["credit"])
        bal += d - c if side == "debit" else c - d
        rows.append(
            {"seq": ln["seq"], "date": ln["date"], "debit": fmt(d), "credit": fmt(c), "balance": fmt(bal)}
        )
    return {"opening": fmt(opening), "rows": rows, "closing": fmt(bal)}


# ---- payables aging ------------------------------------------------------------------------------------------------
BUCKETS = ("not_due", "d1_30", "d31_60", "d61_90", "d90_plus")


def _bucket(days_overdue: int) -> str:
    if days_overdue <= 0:
        return "not_due"
    if days_overdue <= 30:
        return "d1_30"
    if days_overdue <= 60:
        return "d31_60"
    if days_overdue <= 90:
        return "d61_90"
    return "d90_plus"


def payables_aging(bills: list[dict[str, Any]], as_of: str) -> dict[str, Any]:
    """Outstanding amount of each bill in its overdue bucket; fully paid bills are left out."""
    rows: list[dict[str, Any]] = []
    totals = {b: ZERO for b in BUCKETS}
    for b in sorted(bills, key=lambda x: (x["due_date"], x["id"])):
        left = money(b["amount"]) - money(b["paid"])
        if left <= 0:
            continue
        days = (date.fromisoformat(as_of) - date.fromisoformat(b["due_date"])).days
        bucket = _bucket(days)
        totals[bucket] += left
        rows.append(
            {
                "id": b["id"],
                "due_date": b["due_date"],
                "outstanding": fmt(left),
                "days_overdue": max(days, 0),
                "bucket": bucket,
            }
        )
    return {
        "rows": rows,
        "buckets": {k: fmt(v) for k, v in totals.items()},
        "total": fmt(sum(totals.values(), ZERO)),
    }


# ---- bank statement reconciliation ---------------------------------------------------------------------------------
def statement_foots(opening: Decimal, closing: Decimal, lines: list[dict[str, Any]]) -> bool:
    return opening + sum((money(x["amount"]) for x in lines), ZERO) == closing


def match_statement(
    statement: list[dict[str, Any]], ledger: list[dict[str, Any]], tolerance_days: int
) -> dict[str, Any]:
    """Pairs statement lines with ledger lines on the account: same signed amount (money in positive, out negative,
    ledger amount = debit - credit), dates at most `tolerance_days` apart. Statement lines go in (date, id) order; each
    takes the unused ledger line with the smallest date distance, then the earlier date, then the lower seq."""
    used: set[int] = set()
    matches: list[dict[str, Any]] = []
    unmatched_statement: list[str] = []
    for s in sorted(statement, key=lambda x: (x["date"], x["id"])):
        sd = date.fromisoformat(s["date"])
        best: tuple[int, str, int] | None = None
        for ln in ledger:
            if ln["seq"] in used or money(ln["amount"]) != money(s["amount"]):
                continue
            dist = abs((date.fromisoformat(ln["date"]) - sd).days)
            if dist > tolerance_days:
                continue
            key = (dist, ln["date"], ln["seq"])
            if best is None or key < best:
                best = key
        if best is None:
            unmatched_statement.append(s["id"])
        else:
            used.add(best[2])
            matches.append({"statement_line": s["id"], "seq": best[2]})
    return {
        "matches": matches,
        "unmatched_statement": unmatched_statement,
        "unmatched_ledger": sorted(ln["seq"] for ln in ledger if ln["seq"] not in used),
    }


def reconciliation_summary(
    closing_balance: Decimal,
    ledger_balance: Decimal,
    unmatched_statement: int,
    unmatched_ledger: int,
    foots: bool,
) -> dict[str, Any]:
    diff = closing_balance - ledger_balance
    return {
        "difference": fmt(diff),
        "reconciled": foots and diff == 0 and unmatched_statement == 0 and unmatched_ledger == 0,
    }


__all__ = ["reverse_lines"]
