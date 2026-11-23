"""Accounting through the real HTTP API on a real PostgreSQL: automatic postings (payments, refunds, expenses, teacher pay,
online payments, package purchases), manual entries and reversals, ledger and the three reports, period closing,
verification of the hash chain (including tampering done behind the application's back), the catch-up sync, tenant
isolation and permissions. The accounting numbers themselves are the shared rules (tests/golden/*.json)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx
import psycopg

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, mk_teacher, ok, org_today
from tests.test_packages import CASH, pkg_group, sell, student_in
from tests.test_pay import CLICK_KEY, PAYME_KEY, _billed_student, _connect, click, click_form, payme
from tests.test_tenancy_and_staff import _add_staff, _login

A = "/v1/accounting"
TODAY = org_today()


async def entries(t: Tenant, **params: Any) -> list[dict[str, Any]]:
    return (await ok(await t.get(f"{A}/entries", params={"limit": 200, **params})))["items"]


def shape(e: dict[str, Any]) -> list[tuple[str, str, str]]:
    return [(ln["account_code"], ln["debit"], ln["credit"]) for ln in e["lines"]]


async def pay(
    t: Tenant, student_id: str, amount: str = "300000", method: str = "cash", **kw: Any
) -> dict[str, Any]:
    return await ok(
        await t.post("/v1/payments", {"student_id": student_id, "amount": amount, "method": method, **kw}),
        201,
    )


async def manual(
    t: Tenant, on: str, lines: list[tuple[str, str, str]], memo: str = "manual"
) -> dict[str, Any]:
    body = {"date": on, "memo": memo, "lines": [{"account": a, "debit": d, "credit": c} for a, d, c in lines]}
    return await ok(await t.post(f"{A}/entries", body), 201)


async def su(dsn: str, *statements: tuple[str, tuple[Any, ...]]) -> None:
    async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as c:
        for sql, params in statements:
            await c.execute(sql, params)  # type: ignore[arg-type]


async def tamper(dsn: str, org_public_id: str, seq: int, debit: str) -> None:
    org = "(SELECT id FROM organizations WHERE public_id = %s)"
    await su(
        dsn,
        ("ALTER TABLE journal_lines DISABLE TRIGGER USER", ()),
        (
            f"UPDATE journal_lines SET debit = %s WHERE seq = %s AND org_id = {org}",
            (debit, seq, org_public_id),
        ),
        ("ALTER TABLE journal_lines ENABLE TRIGGER USER", ()),
    )


async def raw_payment(
    dsn: str, org_public: str, student_public: str, amount: str, paid_at: str, voided: bool = False
) -> None:
    """A payment that exists without a journal entry (what a center has from before accounting was switched on)."""
    await su(
        dsn,
        (
            "INSERT INTO payments (org_id, student_id, amount, method, paid_at, voided_at, void_reason) "
            "SELECT o.id, s.id, %s, 'cash', %s, CASE WHEN %s THEN now() END, CASE WHEN %s THEN 'old void' END "
            "FROM organizations o JOIN students s ON s.org_id = o.id WHERE o.public_id = %s AND s.public_id = %s",
            (amount, paid_at, voided, voided, org_public, student_public),
        ),
    )


# ---- chart, cash accounts -----------------------------------------------------------------------------------
async def test_the_chart_and_the_two_cash_accounts_are_seeded(tenant: Tenant) -> None:
    chart = await ok(await tenant.get(f"{A}/accounts"))
    assert [a["code"] for a in chart][:3] == ["1000", "1010", "2000"] and len(chart) == 15
    assert {a["code"]: a["normal_side"] for a in chart}["4000"] == "credit"
    cash = await ok(await tenant.get(f"{A}/cash-accounts"))
    assert [(c["account_code"], c["kind"], c["balance"]) for c in cash] == [
        ("1000", "cash", "0.00"),
        ("1010", "bank", "0.00"),
    ]


async def test_account_management_rules(tenant: Tenant) -> None:
    new = await ok(
        await tenant.post(f"{A}/accounts", {"code": "5200", "name": "Transport", "type": "expense"}), 201
    )
    assert new["normal_side"] == "debit"
    assert (
        await tenant.post(f"{A}/accounts", {"code": "5200", "name": "Again", "type": "expense"})
    ).status_code == 409
    assert (
        await tenant.post(f"{A}/accounts", {"code": "52", "name": "Short", "type": "expense"})
    ).status_code == 422
    assert (
        await tenant.post(f"{A}/accounts", {"code": "5201", "name": "x", "type": "revenue"})
    ).status_code == 422
    renamed = await ok(await tenant.patch(f"{A}/accounts/{new['id']}", {"name": "Transport va yo'l"}))
    assert renamed["name"] == "Transport va yo'l" and renamed["code"] == "5200"
    assert (await ok(await tenant.patch(f"{A}/accounts/{new['id']}", {"active": False})))["active"] is False
    r = await tenant.post(
        f"{A}/entries",
        {
            "date": TODAY.isoformat(),
            "memo": "x",
            "lines": [{"account": "5200", "debit": "5"}, {"account": "1000", "credit": "5"}],
        },
    )
    assert r.status_code == 422 and "inactive_account" in r.json()["error"]["details"]["errors"]
    # an account with a balance cannot be deactivated
    chart = {a["code"]: a for a in await ok(await tenant.get(f"{A}/accounts"))}
    await manual(tenant, TODAY.isoformat(), [("1000", "100", "0"), ("3000", "0", "100")])
    assert (await tenant.patch(f"{A}/accounts/{chart['1000']['id']}", {"active": False})).status_code == 409
    # a new cash account: a new asset account is created for it, an income account cannot be one
    bank2 = await ok(
        await tenant.post(f"{A}/cash-accounts", {"name": "Ikkinchi bank", "kind": "bank", "code": "1020"}),
        201,
    )
    assert bank2["account_code"] == "1020"
    assert (
        await tenant.post(f"{A}/cash-accounts", {"name": "x", "kind": "bank", "code": "1020"})
    ).status_code == 409
    assert (
        await tenant.post(f"{A}/cash-accounts", {"name": "x", "kind": "bank", "code": "4000"})
    ).status_code == 422


# ---- automatic postings ----------------------------------------------------------------------------------------
async def test_payments_post_cash_and_bank(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    await pay(tenant, st["id"], "300000", "cash")
    await pay(tenant, st["id"], "250000.50", "card")
    es = await entries(tenant)
    assert [shape(e) for e in es] == [
        [("1010", "250000.50", "0.00"), ("4000", "0.00", "250000.50")],
        [("1000", "300000.00", "0.00"), ("4000", "0.00", "300000.00")],
    ]
    assert es[0]["source_type"] == "payment" and es[1]["entry_no"] == 1
    cash = {c["account_code"]: c["balance"] for c in await ok(await tenant.get(f"{A}/cash-accounts"))}
    assert cash == {"1000": "300000.00", "1010": "250000.50"}
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


async def test_a_retried_online_payment_posts_once(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    body = {"student_id": st["id"], "amount": "1000", "method": "click", "external_ref": "tx-1"}
    await ok(await tenant.post("/v1/payments", body), 201)
    await ok(await tenant.post("/v1/payments", body), 200)
    assert len(await entries(tenant)) == 1


async def test_voiding_a_payment_posts_its_exact_reversal(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    p1 = await pay(tenant, st["id"], "300000")
    await ok(await tenant.post(f"/v1/payments/{p1['id']}/void", {"reason": "entered twice"}))
    es = await entries(tenant)
    assert len(es) == 2 and es[0]["source_type"] == "payment_void"
    assert shape(es[0]) == [("1000", "0.00", "300000.00"), ("4000", "300000.00", "0.00")]
    assert es[0]["reverses_entry_id"] == es[1]["id"] and es[1]["reversed_by_entry_id"] == es[0]["id"]
    assert (await tenant.post(f"/v1/payments/{p1['id']}/void", {"reason": "again"})).status_code == 409
    assert len(await entries(tenant)) == 2
    tb = await ok(await tenant.get(f"{A}/reports/trial-balance"))
    assert tb["balanced"] is True and all(
        r["balance_debit"] == "0.00" == r["balance_credit"] for r in tb["rows"]
    )
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


async def test_expenses_post_from_cash_or_bank_and_reverse_on_void(tenant: Tenant) -> None:
    e1 = await ok(
        await tenant.post(
            "/v1/expenses", {"category": "rent", "amount": "1000000", "spent_at": TODAY.isoformat()}
        ),
        201,
    )
    assert e1["paid_from"] == "cash"
    e2 = await ok(
        await tenant.post(
            "/v1/expenses",
            {"category": "utilities", "amount": "85000", "spent_at": TODAY.isoformat(), "paid_from": "bank"},
        ),
        201,
    )
    assert (
        await tenant.post(
            "/v1/expenses",
            {"category": "rent", "amount": "5", "spent_at": TODAY.isoformat(), "paid_from": "wallet"},
        )
    ).status_code == 422
    es = await entries(tenant)
    assert [shape(e) for e in es] == [
        [("5010", "85000.00", "0.00"), ("1010", "0.00", "85000.00")],
        [("5000", "1000000.00", "0.00"), ("1000", "0.00", "1000000.00")],
    ]
    await ok(await tenant.post(f"/v1/expenses/{e2['id']}/void", {"reason": "wrong amount"}))
    es = await entries(tenant)
    assert es[0]["source_type"] == "expense_void" and shape(es[0]) == [
        ("5010", "0.00", "85000.00"),
        ("1010", "85000.00", "0.00"),
    ]
    inc = await ok(
        await tenant.get(
            f"{A}/reports/income-statement",
            params={"date_from": (TODAY - timedelta(days=1)).isoformat(), "date_to": TODAY.isoformat()},
        )
    )
    assert inc["total_expenses"] == "1000000.00" and [r["code"] for r in inc["expenses"]] == ["5000"]
    _ = e1


async def test_teacher_pay_posts_on_approval_and_on_payment(tenant: Tenant) -> None:
    teacher = await mk_teacher(tenant, pay_model="fixed", pay_rate="500000")
    pr = await ok(
        await tenant.post("/v1/payrolls/generate", {"teacher_id": teacher["id"], "month": "2026-03-01"})
    )
    assert pr["total"] == "500000.00" and await entries(tenant) == []  # a draft posts nothing
    await ok(await tenant.post(f"/v1/payrolls/{pr['id']}/approve"))
    es = await entries(tenant)
    assert [e["source_type"] for e in es] == ["payroll_accrual"] and shape(es[0]) == [
        ("5100", "500000.00", "0.00"),
        ("2100", "0.00", "500000.00"),
    ]
    await ok(await tenant.post(f"/v1/payrolls/{pr['id']}/pay"))
    es = await entries(tenant)
    assert [e["source_type"] for e in es] == ["payroll_payment", "payroll_accrual"]
    assert shape(es[0]) == [("2100", "500000.00", "0.00"), ("1000", "0.00", "500000.00")]
    bs = await ok(await tenant.get(f"{A}/reports/balance-sheet"))
    assert (
        bs["balanced"] is True and bs["current_result"] == "-500000.00" and bs["total_liabilities"] == "0.00"
    )
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


async def test_package_purchase_with_payment_posts(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    _, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    es = await entries(tenant)
    assert [shape(e) for e in es] == [[("1000", "600000.00", "0.00"), ("4000", "0.00", "600000.00")]]


async def test_online_payments_post_to_the_bank_and_a_cancellation_reverses(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    await _connect(tenant, "click", CLICK_KEY, "98765")
    await _connect(tenant, "payme", PAYME_KEY, "m1")
    org, st = tenant.org_id, await _billed_student(tenant)
    prep = await click(client, org, click_form(CLICK_KEY, "98765", 0, st["id"], 3001, "100000.00"))
    await click(
        client,
        org,
        click_form(
            CLICK_KEY, "98765", 1, st["id"], 3001, "100000.00", prepare_id=prep["merchant_prepare_id"]
        ),
    )
    es = await entries(tenant)
    assert [shape(e) for e in es] == [[("1010", "100000.00", "0.00"), ("4000", "0.00", "100000.00")]]
    tx_id = "5f3a9c1e2b4d6f708192a3b4"
    acct = {"student": st["id"]}
    await payme(
        client,
        org,
        "CreateTransaction",
        {"id": tx_id, "time": 1_790_000_000_000, "amount": 4_000_000, "account": acct},
    )
    await payme(client, org, "PerformTransaction", {"id": tx_id})
    assert len(await entries(tenant)) == 2
    await payme(
        client, org, "CancelTransaction", {"id": tx_id, "reason": 5}
    )  # a refund voids the payment: its entry is reversed
    es = await entries(tenant)
    assert [e["source_type"] for e in es] == ["payment_void", "payment", "payment"]
    assert shape(es[0]) == [("1010", "0.00", "40000.00"), ("4000", "40000.00", "0.00")]
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


# ---- manual entries and reversals -------------------------------------------------------------------------------
async def test_manual_entry_validation(tenant: Tenant) -> None:
    today = TODAY.isoformat()
    ok_entry = await manual(
        tenant, today, [("1000", "1000", "0"), ("3000", "0", "1000")], "boshlang'ich qoldiq"
    )
    assert ok_entry["entry_no"] == 1 and ok_entry["source_type"] == "manual"

    async def bad(lines: list[dict[str, Any]], on: str = today, expect: int = 422) -> dict[str, Any]:
        r = await tenant.post(f"{A}/entries", {"date": on, "memo": "x", "lines": lines})
        assert r.status_code == expect, r.text
        return r.json()  # type: ignore[no-any-return]

    e = await bad([{"account": "1000", "debit": "10"}, {"account": "3000", "credit": "9"}])
    assert e["error"]["details"]["errors"] == ["unbalanced"]
    e = await bad([{"account": "1000", "debit": "10", "credit": "10"}, {"account": "3000"}])
    assert "bad_line" in e["error"]["details"]["errors"]
    e = await bad([{"account": "1000", "debit": "10"}, {"account": "7777", "credit": "10"}])
    assert e["error"]["details"]["errors"] == ["unknown_account"]
    await bad([{"account": "1000", "debit": "10"}])  # one line
    await bad([{"account": "1000", "debit": "-10"}, {"account": "3000", "credit": "-10"}])
    await bad(
        [{"account": "1000", "debit": "10"}, {"account": "3000", "credit": "10"}],
        on=(TODAY + timedelta(days=2)).isoformat(),
    )
    await bad([{"account": "1000", "debit": "10.001"}, {"account": "3000", "credit": "10.001"}])
    assert len(await entries(tenant)) == 1
    two = await manual(tenant, today, [("1000", "7", "0"), ("1010", "3", "0"), ("3000", "0", "10")])
    assert [ln["seq"] for ln in two["lines"]] == [3, 4, 5]


async def test_reversal_rules(tenant: Tenant) -> None:
    today = TODAY.isoformat()
    m = await manual(tenant, today, [("1000", "50", "0"), ("3000", "0", "50")])
    rev = await ok(await tenant.post(f"{A}/entries/{m['id']}/reverse", {"memo": "xato"}), 201)
    assert (
        shape(rev) == [("1000", "0.00", "50.00"), ("3000", "50.00", "0.00")]
        and rev["reverses_entry_id"] == m["id"]
    )
    assert rev["memo"] == "xato"
    assert (await tenant.post(f"{A}/entries/{m['id']}/reverse", {})).status_code == 409  # once per entry
    assert (
        await tenant.post(f"{A}/entries/{rev['id']}/reverse", {})
    ).status_code == 409  # a reversal is never reversed
    again = await manual(tenant, today, [("1000", "50", "0"), ("3000", "0", "50")])
    assert (
        await tenant.post(
            f"{A}/entries/{again['id']}/reverse", {"date": (TODAY + timedelta(days=3)).isoformat()}
        )
    ).status_code == 422
    # entries made by a document are corrected by voiding the document
    st = await mk_student(tenant)
    await pay(tenant, st["id"], "10")
    auto = (await entries(tenant, source_type="payment"))[0]
    assert (await tenant.post(f"{A}/entries/{auto['id']}/reverse", {})).status_code == 409
    assert (await tenant.get(f"{A}/entries/00000000-0000-0000-0000-000000000000")).status_code == 404


async def test_there_is_no_way_to_edit_or_delete_an_entry_through_the_api(tenant: Tenant) -> None:
    m = await manual(tenant, TODAY.isoformat(), [("1000", "5", "0"), ("3000", "0", "5")])
    for method in ("patch", "put", "delete"):
        r = await getattr(tenant, method)(f"{A}/entries/{m['id']}")
        assert r.status_code in (404, 405)
    assert (await ok(await tenant.get(f"{A}/entries/{m['id']}")))["memo"] == "manual"


# ---- ledger and reports ------------------------------------------------------------------------------------------
async def test_ledger_and_reports(tenant: Tenant) -> None:
    d1, d2 = (TODAY - timedelta(days=3)).isoformat(), (TODAY - timedelta(days=1)).isoformat()
    await manual(tenant, d1, [("1000", "1000", "0"), ("3000", "0", "1000")], "kapital")
    st = await mk_student(tenant)
    await pay(tenant, st["id"], "600", paid_at=f"{d2}T10:00:00+05:00")
    await ok(await tenant.post("/v1/expenses", {"category": "rent", "amount": "250", "spent_at": d2}), 201)
    led = await ok(await tenant.get(f"{A}/ledger", params={"account": "1000"}))
    assert [(r["debit"], r["credit"], r["balance"]) for r in led["rows"]] == [
        ("1000.00", "0.00", "1000.00"),
        ("600.00", "0.00", "1600.00"),
        ("0.00", "250.00", "1350.00"),
    ]
    assert led["closing"] == "1350.00" and led["side"] == "debit" and led["opening"] == "0.00"
    part = await ok(await tenant.get(f"{A}/ledger", params={"account": "1000", "date_from": d2}))
    assert part["opening"] == "1000.00" and len(part["rows"]) == 2 and part["closing"] == "1350.00"
    cap = await ok(await tenant.get(f"{A}/ledger", params={"account": "3000"}))
    assert cap["side"] == "credit" and cap["closing"] == "1000.00"
    assert (await tenant.get(f"{A}/ledger", params={"account": "9999"})).status_code == 404
    tb = await ok(await tenant.get(f"{A}/reports/trial-balance"))
    assert tb["balanced"] is True and tb["total_debit"] == tb["total_credit"] == "1850.00"
    assert {r["code"]: r["balance_debit"] for r in tb["rows"] if r["balance_debit"] != "0.00"} == {
        "1000": "1350.00",
        "5000": "250.00",
    }
    moved = await ok(
        await tenant.get(f"{A}/reports/trial-balance", params={"date_from": d2, "as_of": TODAY.isoformat()})
    )
    assert moved["total_debit"] == "850.00"
    inc = await ok(
        await tenant.get(
            f"{A}/reports/income-statement", params={"date_from": d1, "date_to": TODAY.isoformat()}
        )
    )
    assert (inc["total_income"], inc["total_expenses"], inc["net"]) == ("600.00", "250.00", "350.00")
    bs = await ok(await tenant.get(f"{A}/reports/balance-sheet"))
    assert bs["balanced"] is True and (bs["total_assets"], bs["current_result"], bs["total_equity"]) == (
        "1350.00",
        "350.00",
        "1350.00",
    )
    old = await ok(await tenant.get(f"{A}/reports/balance-sheet", params={"as_of": d1}))
    assert old["total_assets"] == "1000.00" and old["current_result"] == "0.00"
    assert (
        await tenant.get(f"{A}/reports/income-statement", params={"date_from": d2, "date_to": d1})
    ).status_code == 422
    assert (
        await tenant.get(
            f"{A}/reports/income-statement", params={"date_from": "2000-01-01", "date_to": TODAY.isoformat()}
        )
    ).status_code == 422
    empty = await ok(await tenant.get(f"{A}/reports/trial-balance", params={"as_of": "2001-01-01"}))
    assert empty["rows"] == [] and empty["balanced"] is True


async def test_the_income_statement_agrees_with_the_dashboard_numbers(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    await pay(tenant, st["id"], "700000")
    await ok(
        await tenant.post(
            "/v1/expenses", {"category": "marketing", "amount": "200000", "spent_at": TODAY.isoformat()}
        ),
        201,
    )
    first = TODAY.replace(day=1).isoformat()
    inc = await ok(
        await tenant.get(
            f"{A}/reports/income-statement", params={"date_from": first, "date_to": TODAY.isoformat()}
        )
    )
    summary = await ok(await tenant.get("/v1/reports/summary", params={"month": first}))
    assert inc["total_income"] == summary["revenue"] and inc["total_expenses"] == summary["expenses"]


# ---- verification and tampering -----------------------------------------------------------------------------------
async def test_verify_finds_the_first_broken_row_after_tampering_behind_the_application(
    tenant: Tenant, super_dsn: str
) -> None:
    st = await mk_student(tenant)
    for amount in ("100", "200", "300"):
        await pay(tenant, st["id"], amount)
    v = await ok(await tenant.get(f"{A}/verify"))
    assert v == {"ok": True, "lines": 6, "broken_seq": None, "reason": None, "period_issues": []}
    await tamper(super_dsn, tenant.org_id, 3, "250")  # the second payment now says 250 on one side
    v = await ok(await tenant.get(f"{A}/verify"))
    assert v["ok"] is False and v["broken_seq"] == 3 and v["reason"] == "hash_mismatch"


# ---- closing periods ----------------------------------------------------------------------------------------------
async def test_closing_a_month_locks_it(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    await pay(tenant, st["id"], "1000", paid_at="2026-01-15T10:00:00+05:00")
    await pay(tenant, st["id"], "500", paid_at="2026-02-10T10:00:00+05:00")
    await ok(await tenant.post(f"{A}/periods/2026-01/close"), 201)
    periods = await ok(await tenant.get(f"{A}/periods"))
    assert (
        [p["month"] for p in periods] == ["2026-01"]
        and periods[0]["last_seq"] == 4
        and periods[0]["total_debit"] == "1500.00"
    )
    assert (await tenant.post(f"{A}/periods/2026-01/close")).status_code == 409  # already closed
    assert (await tenant.post(f"{A}/periods/{TODAY.strftime('%Y-%m')}/close")).status_code == 409  # not ended
    assert (await tenant.post(f"{A}/periods/2999-01/close")).status_code == 409
    assert (await tenant.post(f"{A}/periods/2026-13/close")).status_code == 422
    # nothing can be posted into the closed month, and the payment is not created either (one transaction)
    r = await tenant.post(
        "/v1/payments",
        {"student_id": st["id"], "amount": "7", "method": "cash", "paid_at": "2026-01-20T10:00:00+05:00"},
    )
    assert r.status_code == 409
    assert (
        await tenant.post(
            f"{A}/entries",
            {
                "date": "2026-01-31",
                "memo": "late",
                "lines": [{"account": "1000", "debit": "1"}, {"account": "3000", "credit": "1"}],
            },
        )
    ).status_code == 409
    assert len((await ok(await tenant.get("/v1/payments", params={"student_id": st["id"]})))["items"]) == 2
    # the open months keep working, and voiding an old payment reverses it in the open month
    p_jan = (await ok(await tenant.get("/v1/payments", params={"student_id": st["id"]})))["items"]
    jan = next(p for p in p_jan if p["amount"] == "1000.00")
    await ok(await tenant.post(f"/v1/payments/{jan['id']}/void", {"reason": "bounced"}))
    rev = (await entries(tenant, source_type="payment_void"))[0]
    assert rev["date"] == TODAY.isoformat()
    v = await ok(await tenant.get(f"{A}/verify"))
    assert v["ok"] is True


async def test_tampering_with_a_closed_period_is_reported(tenant: Tenant, super_dsn: str) -> None:
    st = await mk_student(tenant)
    await pay(tenant, st["id"], "1000", paid_at="2026-01-15T10:00:00+05:00")
    await ok(await tenant.post(f"{A}/periods/2026-01/close"), 201)
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True
    await tamper(super_dsn, tenant.org_id, 1, "999")
    v = await ok(await tenant.get(f"{A}/verify"))
    assert v["ok"] is False and v["broken_seq"] == 1 and v["reason"] == "hash_mismatch"
    # a closing of a journal that does not verify is refused
    assert (await tenant.post(f"{A}/periods/2026-02/close")).status_code == 409


async def test_closing_needs_the_close_permission(client: httpx.AsyncClient, tenant: Tenant) -> None:
    st = await mk_student(tenant)
    await pay(tenant, st["id"], "1000", paid_at="2026-01-15T10:00:00+05:00")
    _, email = await _add_staff(tenant, "accountant")
    acc = await _login(client, email, "staff-password-123")
    assert (await acc.post(f"{A}/periods/2026-01/close")).status_code == 403
    assert (await tenant.post(f"{A}/periods/2026-01/close")).status_code == 201


# ---- catch-up sync ------------------------------------------------------------------------------------------------
async def test_sync_posts_what_existed_before_and_is_idempotent(tenant: Tenant, super_dsn: str) -> None:
    st = await mk_student(tenant)
    await raw_payment(super_dsn, tenant.org_id, st["id"], "400", "2026-02-03T10:00:00+05:00")
    await raw_payment(super_dsn, tenant.org_id, st["id"], "90", "2026-02-04T10:00:00+05:00", voided=True)
    await raw_payment(super_dsn, tenant.org_id, st["id"], "250", "2026-02-05T10:00:00+05:00")
    assert await entries(tenant) == []
    pend = await ok(await tenant.get(f"{A}/pending"))
    assert [(p["kind"], p["source_type"]) for p in pend] == [
        ("post", "payment"),
        ("post", "payment"),
    ]  # the voided one was never posted
    first = await ok(await tenant.post(f"{A}/sync"))
    assert first == {"posted": 2, "reversed": 0, "blocked": []}
    assert [e["date"] for e in reversed(await entries(tenant))] == ["2026-02-03", "2026-02-05"]
    assert await ok(await tenant.post(f"{A}/sync")) == {"posted": 0, "reversed": 0, "blocked": []}
    assert await ok(await tenant.get(f"{A}/pending")) == []
    # a posted payment that is voided later behind the scenes is reversed by the next sync
    await su(
        super_dsn,
        (
            "UPDATE payments SET voided_at = now(), void_reason = 'late void' WHERE amount = 400 AND org_id = (SELECT id FROM organizations WHERE public_id = %s)",
            (tenant.org_id,),
        ),
    )
    assert [p["kind"] for p in await ok(await tenant.get(f"{A}/pending"))] == ["reverse"]
    assert await ok(await tenant.post(f"{A}/sync")) == {"posted": 0, "reversed": 1, "blocked": []}
    assert await ok(await tenant.post(f"{A}/sync")) == {"posted": 0, "reversed": 0, "blocked": []}
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


async def test_an_unposted_document_blocks_closing_and_a_closed_month_blocks_the_sync(
    tenant: Tenant, super_dsn: str
) -> None:
    st = await mk_student(tenant)
    await raw_payment(super_dsn, tenant.org_id, st["id"], "400", "2026-01-03T10:00:00+05:00")
    r = await tenant.post(f"{A}/periods/2026-01/close")
    assert r.status_code == 409 and r.json()["error"]["details"]["unposted"] == 1
    await ok(await tenant.post(f"{A}/sync"))
    await ok(await tenant.post(f"{A}/periods/2026-01/close"), 201)
    await raw_payment(
        super_dsn, tenant.org_id, st["id"], "60", "2026-01-20T10:00:00+05:00"
    )  # lands in the closed month
    res = await ok(await tenant.post(f"{A}/sync"))
    assert res["posted"] == 0 and [(b["source_type"], b["date"], b["reason"]) for b in res["blocked"]] == [
        ("payment", "2026-01-20", "closed_period")
    ]


# ---- isolation, permissions ---------------------------------------------------------------------------------------
async def test_tenants_have_separate_charts_journals_and_chains(tenant: Tenant, tenant_b: Tenant) -> None:
    sa, sb = await mk_student(tenant), await mk_student(tenant_b)
    await pay(tenant, sa["id"], "100")
    await pay(tenant_b, sb["id"], "999")
    ea = await entries(tenant)
    assert len(ea) == 1 and len(await entries(tenant_b)) == 1
    assert (await tenant_b.get(f"{A}/entries/{ea[0]['id']}")).status_code == 404
    assert (await tenant_b.post(f"{A}/entries/{ea[0]['id']}/reverse", {})).status_code == 404
    tb_b = await ok(await tenant_b.get(f"{A}/reports/trial-balance"))
    assert tb_b["total_debit"] == "999.00"
    first = lambda e: e["lines"][0]["seq"]  # noqa: E731
    assert (
        first(ea[0]) == 1 and first((await entries(tenant_b))[0]) == 1
    )  # each center has its own chain from 1
    chart_a = {a["id"] for a in await ok(await tenant.get(f"{A}/accounts"))}
    assert chart_a.isdisjoint({a["id"] for a in await ok(await tenant_b.get(f"{A}/accounts"))})


async def test_permissions_per_role(client: httpx.AsyncClient, tenant: Tenant) -> None:
    today = TODAY.isoformat()
    body = {
        "date": today,
        "memo": "x",
        "lines": [{"account": "1000", "debit": "5"}, {"account": "3000", "credit": "5"}],
    }
    roles: dict[str, tuple[bool, bool]] = {  # role: (can read, can write)
        "accountant": (True, True),
        "manager": (True, False),
        "viewer": (False, False),
        "teacher": (False, False),
        "admin": (True, True),
    }
    assert (await client.get(f"{A}/accounts")).status_code == 401
    for role, (can_read, can_write) in roles.items():
        _, email = await _add_staff(tenant, role)
        t = await _login(client, email, "staff-password-123")
        assert (await t.get(f"{A}/accounts")).status_code == (200 if can_read else 403), role
        assert (await t.get(f"{A}/verify")).status_code == (200 if can_read else 403), role
        assert (await t.post(f"{A}/entries", body)).status_code == (201 if can_write else 403), role
        assert (await t.post(f"{A}/sync")).status_code == (200 if can_write else 403), role
        assert (await t.post(f"{A}/suppliers", {"name": f"S {role}"})).status_code == (
            201 if can_write else 403
        ), role


_ = (enroll, mk_group)
