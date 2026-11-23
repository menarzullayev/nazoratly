"""Reconciliation of a cash/bank account with its statement through the real HTTP API (matching and the reconciled test are
the shared rules in tests/golden/accounting.json; the freeze after finalizing is enforced by the database)."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import mk_student, ok
from tests.test_accounting import A, manual, pay
from tests.test_tenancy_and_staff import _add_staff, _login

TODAY = date.today()


def d(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


async def cash_account(t: Tenant, code: str = "1000") -> dict[str, Any]:
    return next(c for c in await ok(await t.get(f"{A}/cash-accounts")) if c["account_code"] == code)


async def seqs(t: Tenant, account: str = "1000") -> list[int]:
    return [r["seq"] for r in (await ok(await t.get(f"{A}/ledger", params={"account": account})))["rows"]]


async def ledger_setup(t: Tenant) -> None:
    """Cash: +500000 (day -10), +200000 (day -8), -50000 (day -6)."""
    st = await mk_student(t)
    await pay(t, st["id"], "500000", paid_at=f"{d(-10)}T10:00:00+05:00")
    await pay(t, st["id"], "200000", paid_at=f"{d(-8)}T10:00:00+05:00")
    await ok(await t.post("/v1/expenses", {"category": "rent", "amount": "50000", "spent_at": d(-6)}), 201)


async def new_statement(t: Tenant, closing: str = "650000", opening: str = "0", **kw: Any) -> dict[str, Any]:
    ca = await cash_account(t)
    body = {
        "cash_account_id": ca["id"],
        "period_from": d(-12),
        "period_to": d(0),
        "opening_balance": opening,
        "closing_balance": closing,
        **kw,
    }
    return await ok(await t.post(f"{A}/statements", body), 201)


async def add_lines(t: Tenant, st: dict[str, Any], lines: list[tuple[int, str]]) -> dict[str, Any]:
    body = {
        "lines": [
            {"date": d(off), "description": f"line {i}", "amount": amount}
            for i, (off, amount) in enumerate(lines)
        ]
    }
    return await ok(await t.post(f"{A}/statements/{st['id']}/lines", body), 201)


async def test_full_reconciliation_flow(tenant: Tenant) -> None:
    await ledger_setup(tenant)
    st = await new_statement(tenant)
    assert (
        st["status"] == "open" and st["lines"] == [] and st["reconciliation"]["ledger_balance"] == "650000.00"
    )
    st = await add_lines(
        tenant, st, [(-10, "500000"), (-7, "200000"), (-6, "-50000")]
    )  # the 200000 is booked a day later by the bank
    rec = st["reconciliation"]
    assert (rec["foots"], rec["unmatched_statement"], rec["reconciled"], rec["difference"]) == (
        True,
        3,
        False,
        "0.00",
    )
    assert len(rec["unmatched_ledger"]) == 3
    # auto-match with no tolerance leaves the line that the bank booked a day late
    st = await ok(await tenant.post(f"{A}/statements/{st['id']}/auto-match", {"tolerance_days": 0}))
    assert [ln["matched_seq"] is not None for ln in st["lines"]] == [True, False, True]
    assert st["reconciliation"]["unmatched_statement"] == 1 and [
        u["amount"] for u in st["reconciliation"]["unmatched_ledger"]
    ] == ["200000.00"]
    r = await tenant.post(f"{A}/statements/{st['id']}/finalize")
    assert r.status_code == 409 and r.json()["error"]["details"]["unmatched_statement"] == 1
    # a tolerance of one day finds it (and a second run changes nothing already matched)
    st = await ok(await tenant.post(f"{A}/statements/{st['id']}/auto-match", {"tolerance_days": 1}))
    assert (
        all(ln["matched_seq"] is not None for ln in st["lines"])
        and st["reconciliation"]["reconciled"] is True
    )
    done = await ok(await tenant.post(f"{A}/statements/{st['id']}/finalize"))
    assert done["status"] == "finalized" and done["reconciliation"]["reconciled"] is True
    # a finalized statement is frozen everywhere
    line = done["lines"][0]
    assert (
        await tenant.post(f"{A}/statements/{st['id']}/lines", {"lines": [{"date": d(-1), "amount": "5"}]})
    ).status_code == 409
    assert (await tenant.post(f"{A}/statements/{st['id']}/lines/{line['id']}/unmatch")).status_code == 409
    assert (
        await tenant.post(f"{A}/statements/{st['id']}/lines/{line['id']}/match", {"seq": 1})
    ).status_code == 409
    assert (await tenant.post(f"{A}/statements/{st['id']}/auto-match", {})).status_code == 409
    assert (await tenant.post(f"{A}/statements/{st['id']}/finalize")).status_code == 409
    listed = (await ok(await tenant.get(f"{A}/statements")))["items"]
    assert [(s["id"], s["status"], s["lines"]) for s in listed] == [(st["id"], "finalized", [])]
    assert (await ok(await tenant.get(f"{A}/statements/{st['id']}")))["lines"].__len__() == 3


async def test_manual_matching_and_unmatching(tenant: Tenant) -> None:
    await ledger_setup(tenant)
    st = await add_lines(tenant, await new_statement(tenant), [(-10, "500000")])
    line = st["lines"][0]
    s = await seqs(tenant)
    base = f"{A}/statements/{st['id']}/lines/{line['id']}"
    assert (await tenant.post(f"{base}/match", {"seq": 9999})).status_code == 422  # no such journal line
    revenue_seq = (await ok(await tenant.get(f"{A}/ledger", params={"account": "4000"})))["rows"][0]["seq"]
    assert (
        await tenant.post(f"{base}/match", {"seq": revenue_seq})
    ).status_code == 422  # another account's line
    assert (await tenant.post(f"{base}/match", {"seq": 0})).status_code == 422
    got = await ok(
        await tenant.post(f"{base}/match", {"seq": s[1]})
    )  # a deliberate (even if odd) match is allowed
    assert got["lines"][0]["matched_seq"] == s[1]
    assert (await tenant.post(f"{base}/match", {"seq": s[0]})).status_code == 409  # already matched
    other = await add_lines(tenant, st, [(-9, "1")])
    second = other["lines"][-1]
    assert (
        await tenant.post(f"{A}/statements/{st['id']}/lines/{second['id']}/match", {"seq": s[1]})
    ).status_code == 409  # a ledger line once
    back = await ok(await tenant.post(f"{base}/unmatch"))
    assert back["lines"][0]["matched_seq"] is None
    assert (await ok(await tenant.post(f"{base}/match", {"seq": s[0]})))["lines"][0]["matched_seq"] == s[0]
    assert (
        await tenant.post(
            f"{A}/statements/{st['id']}/lines/00000000-0000-0000-0000-000000000000/match", {"seq": s[0]}
        )
    ).status_code == 404


async def test_a_statement_that_does_not_foot_or_differs_from_the_ledger_cannot_be_finalized(
    tenant: Tenant,
) -> None:
    await ledger_setup(tenant)
    st = await add_lines(
        tenant,
        await new_statement(tenant, closing="651000"),
        [(-10, "500000"), (-8, "200000"), (-6, "-50000")],
    )
    st = await ok(await tenant.post(f"{A}/statements/{st['id']}/auto-match", {"tolerance_days": 0}))
    rec = st["reconciliation"]
    assert (
        rec["foots"] is False
        and rec["difference"] == "1000.00"
        and rec["unmatched_statement"] == 0
        and rec["reconciled"] is False
    )
    r = await tenant.post(f"{A}/statements/{st['id']}/finalize")
    assert r.status_code == 409 and r.json()["error"]["details"]["foots"] is False
    # an unmatched ledger line (a cheque not yet cleared) also blocks it
    ok_st = await add_lines(
        tenant, await new_statement(tenant), [(-10, "500000"), (-8, "200000"), (-6, "-50000")]
    )
    await manual(tenant, d(-5), [("1000", "10", "0"), ("3000", "0", "10")])
    ok_st = await ok(await tenant.post(f"{A}/statements/{ok_st['id']}/auto-match", {"tolerance_days": 0}))
    assert (
        ok_st["reconciliation"]["unmatched_ledger"][0]["amount"] == "10.00"
        and ok_st["reconciliation"]["difference"] == "-10.00"
    )
    assert (await tenant.post(f"{A}/statements/{ok_st['id']}/finalize")).status_code == 409


async def test_money_out_and_duplicate_amounts_match_one_to_one(tenant: Tenant) -> None:
    st0 = await mk_student(tenant)
    for off in (-4, -3):
        await pay(tenant, st0["id"], "100", paid_at=f"{d(off)}T10:00:00+05:00")
    await ok(await tenant.post("/v1/expenses", {"category": "tax", "amount": "30", "spent_at": d(-3)}), 201)
    st = await add_lines(
        tenant, await new_statement(tenant, closing="170"), [(-3, "100"), (-4, "100"), (-3, "-30")]
    )
    st = await ok(await tenant.post(f"{A}/statements/{st['id']}/auto-match", {"tolerance_days": 0}))
    assert all(ln["matched_seq"] is not None for ln in st["lines"])
    assert len({ln["matched_seq"] for ln in st["lines"]}) == 3
    by_amount = {ln["amount"]: ln for ln in st["lines"]}
    assert by_amount["-30.00"]["matched_seq"] is not None and st["reconciliation"]["reconciled"] is True


async def test_statement_validation(tenant: Tenant) -> None:
    ca = await cash_account(tenant)
    ok_body = {
        "cash_account_id": ca["id"],
        "period_from": d(-10),
        "period_to": d(0),
        "opening_balance": "0",
        "closing_balance": "0",
    }
    assert (await tenant.post(f"{A}/statements", {**ok_body, "period_from": d(1)})).status_code == 422
    assert (await tenant.post(f"{A}/statements", {**ok_body, "period_from": d(-900)})).status_code == 422
    assert (
        await tenant.post(
            f"{A}/statements", {**ok_body, "cash_account_id": "00000000-0000-0000-0000-000000000000"}
        )
    ).status_code == 404
    st = await ok(
        await tenant.post(f"{A}/statements", {**ok_body, "opening_balance": "-500.50"}), 201
    )  # an overdraft is allowed
    assert st["opening_balance"] == "-500.50"
    assert (
        await tenant.post(f"{A}/statements/{st['id']}/lines", {"lines": [{"date": d(-1), "amount": "0"}]})
    ).status_code == 422
    assert (await tenant.post(f"{A}/statements/{st['id']}/lines", {"lines": []})).status_code == 422
    too_many = {"lines": [{"date": d(-1), "amount": "1"}] * 501}
    assert (await tenant.post(f"{A}/statements/{st['id']}/lines", too_many)).status_code == 422
    assert (
        await tenant.post(f"{A}/statements/{st['id']}/auto-match", {"tolerance_days": 31})
    ).status_code == 422
    assert (await tenant.get(f"{A}/statements/00000000-0000-0000-0000-000000000000")).status_code == 404
    # an empty statement whose balances agree with an empty ledger reconciles at once
    empty = await ok(await tenant.post(f"{A}/statements", {**ok_body}), 201)
    assert empty["reconciliation"]["reconciled"] is True
    assert (await ok(await tenant.post(f"{A}/statements/{empty['id']}/finalize")))["status"] == "finalized"


async def test_statements_are_per_center_and_per_role(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    await ledger_setup(tenant)
    st = await add_lines(tenant, await new_statement(tenant), [(-10, "500000")])
    assert (await ok(await tenant_b.get(f"{A}/statements")))["items"] == []
    assert (await tenant_b.get(f"{A}/statements/{st['id']}")).status_code == 404
    assert (await tenant_b.post(f"{A}/statements/{st['id']}/finalize")).status_code == 404
    assert (
        await tenant_b.post(
            f"{A}/statements",
            {
                "cash_account_id": (await cash_account(tenant))["id"],
                "period_from": d(-1),
                "period_to": d(0),
                "opening_balance": "0",
                "closing_balance": "0",
            },
        )
    ).status_code == 404
    for role, can_read, can_write in (
        ("manager", True, False),
        ("viewer", False, False),
        ("accountant", True, True),
    ):
        _, email = await _add_staff(tenant, role)
        t = await _login(client, email, "staff-password-123")
        assert (await t.get(f"{A}/statements/{st['id']}")).status_code == (200 if can_read else 403), role
        r = await t.post(f"{A}/statements/{st['id']}/auto-match", {})
        assert r.status_code == (200 if can_write else 403), role
