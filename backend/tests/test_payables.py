"""Payables through the real HTTP API: suppliers, bills (they accrue an expense and credit 2000 payables), partial
settlement from cash or bank, voiding, due dates, aging (the numbers are the shared rules in tests/golden/accounting.json)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import ok, org_today
from tests.test_accounting import A, entries, shape
from tests.test_tenancy_and_staff import _add_staff, _login

TODAY = org_today()


def d(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


async def supplier(t: Tenant, name: str = "Ofis do'koni") -> dict[str, Any]:
    return await ok(await t.post(f"{A}/suppliers", {"name": name, "phone": "+998901112233"}), 201)


async def bill(
    t: Tenant, sup: dict[str, Any], number: str = "A-1", amount: str = "1000", due: int = 10, **kw: Any
) -> dict[str, Any]:
    body = {
        "supplier_id": sup["id"],
        "number": number,
        "bill_date": d(-5),
        "due_date": d(due),
        "category": "equipment",
        "amount": amount,
        **kw,
    }
    return await ok(await t.post(f"{A}/bills", body), 201)


async def settle(t: Tenant, b: dict[str, Any], amount: str, **kw: Any) -> dict[str, Any]:
    return await ok(
        await t.post(f"{A}/bills/{b['id']}/payments", {"amount": amount, "paid_on": d(-1), **kw}), 201
    )


async def test_supplier_management(tenant: Tenant) -> None:
    s = await supplier(tenant)
    assert s["outstanding"] == "0.00" and s["active"] is True
    assert (await tenant.post(f"{A}/suppliers", {"name": "Ofis do'koni"})).status_code == 409
    assert (await tenant.post(f"{A}/suppliers", {"name": ""})).status_code == 422
    p = await ok(
        await tenant.patch(f"{A}/suppliers/{s['id']}", {"note": "yaxshi narx", "phone": "+998909998877"})
    )
    assert p["note"] == "yaxshi narx" and p["name"] == "Ofis do'koni"
    assert [x["name"] for x in await ok(await tenant.get(f"{A}/suppliers"))] == ["Ofis do'koni"]
    assert (
        await tenant.patch(f"{A}/suppliers/00000000-0000-0000-0000-000000000000", {"note": "x"})
    ).status_code == 404


async def test_a_bill_accrues_an_expense_and_a_payable(tenant: Tenant) -> None:
    s = await supplier(tenant)
    b = await bill(tenant, s, amount="1000")
    assert (b["amount"], b["paid"], b["outstanding"], b["status"]) == ("1000.00", "0.00", "1000.00", "open")
    es = await entries(tenant)
    assert [shape(e) for e in es] == [[("5040", "1000.00", "0.00"), ("2000", "0.00", "1000.00")]]
    exp = (await ok(await tenant.get("/v1/expenses")))["items"]
    assert len(exp) == 1 and exp[0]["supplier_bill_id"] == b["id"] and exp[0]["category"] == "equipment"
    assert (await ok(await tenant.get(f"{A}/suppliers")))[0]["outstanding"] == "1000.00"
    bs = await ok(await tenant.get(f"{A}/reports/balance-sheet"))
    assert [(x["code"], x["amount"]) for x in bs["liabilities"]] == [("2000", "1000.00")] and bs[
        "balanced"
    ] is True
    assert bs["current_result"] == "-1000.00"
    # an expense of a bill is voided through the bill, never on its own
    assert (await tenant.post(f"/v1/expenses/{exp[0]['id']}/void", {"reason": "mistake"})).status_code == 409


async def test_bill_validation(tenant: Tenant) -> None:
    s = await supplier(tenant)
    await bill(tenant, s, "A-1")
    base = {"supplier_id": s["id"], "bill_date": d(-5), "due_date": d(5), "category": "rent", "amount": "10"}
    assert (await tenant.post(f"{A}/bills", {**base, "number": "A-1"})).status_code == 409
    assert (await tenant.post(f"{A}/bills", {**base, "number": "B", "due_date": d(-9)})).status_code == 422
    assert (await tenant.post(f"{A}/bills", {**base, "number": "B", "amount": "0"})).status_code == 422
    assert (await tenant.post(f"{A}/bills", {**base, "number": "B", "category": "fun"})).status_code == 422
    assert (
        await tenant.post(
            f"{A}/bills", {**base, "number": "B", "supplier_id": "00000000-0000-0000-0000-000000000000"}
        )
    ).status_code == 404
    await ok(await tenant.patch(f"{A}/suppliers/{s['id']}", {"active": False}))
    assert (await tenant.post(f"{A}/bills", {**base, "number": "C"})).status_code == 409
    assert len(await entries(tenant)) == 1  # nothing was posted for the refused bills
    assert len((await ok(await tenant.get("/v1/expenses")))["items"]) == 1


async def test_partial_settlement_from_cash_and_bank(tenant: Tenant) -> None:
    s = await supplier(tenant)
    b = await bill(tenant, s, amount="1000")
    b = await settle(tenant, b, "400", paid_from="bank")
    assert (b["paid"], b["outstanding"], b["status"]) == ("400.00", "600.00", "partial")
    assert shape((await entries(tenant))[0]) == [("2000", "400.00", "0.00"), ("1010", "0.00", "400.00")]
    over = await tenant.post(f"{A}/bills/{b['id']}/payments", {"amount": "600.01", "paid_on": d(-1)})
    assert over.status_code == 422 and over.json()["error"]["details"]["outstanding"] == "600.00"
    assert (
        await tenant.post(f"{A}/bills/{b['id']}/payments", {"amount": "1", "paid_on": d(3)})
    ).status_code == 422  # future
    assert (
        await tenant.post(f"{A}/bills/{b['id']}/payments", {"amount": "1", "paid_on": d(-30)})
    ).status_code == 422  # before the bill
    assert (
        await tenant.post(f"{A}/bills/{b['id']}/payments", {"amount": "0", "paid_on": d(-1)})
    ).status_code == 422
    b = await settle(tenant, b, "600")
    assert (b["paid"], b["outstanding"], b["status"]) == ("1000.00", "0.00", "paid")
    assert shape((await entries(tenant))[0]) == [("2000", "600.00", "0.00"), ("1000", "0.00", "600.00")]
    assert len(b["payments"]) == 2
    assert (
        await tenant.post(f"{A}/bills/{b['id']}/payments", {"amount": "1", "paid_on": d(-1)})
    ).status_code == 422  # nothing left
    bs = await ok(await tenant.get(f"{A}/reports/balance-sheet"))
    assert bs["liabilities"] == [] and bs["balanced"] is True and bs["total_assets"] == "-1000.00"
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


async def test_voiding_settlements_and_bills(tenant: Tenant) -> None:
    s = await supplier(tenant)
    b = await bill(tenant, s, amount="1000")
    b = await settle(tenant, b, "300")
    assert (
        await tenant.post(f"{A}/bills/{b['id']}/void", {"reason": "duplicate"})
    ).status_code == 409  # settle first
    pay_id = b["payments"][0]["id"]
    b = await ok(await tenant.post(f"{A}/bill-payments/{pay_id}/void", {"reason": "wrong bill"}))
    assert b["paid"] == "0.00" and b["payments"][0]["voided"] is True and b["status"] == "open"
    es = await entries(tenant)
    assert es[0]["source_type"] == "bill_payment_void" and shape(es[0]) == [
        ("2000", "0.00", "300.00"),
        ("1000", "300.00", "0.00"),
    ]
    assert (await tenant.post(f"{A}/bill-payments/{pay_id}/void", {"reason": "again"})).status_code == 409
    assert (
        await tenant.post(f"{A}/bill-payments/{pay_id}/void", {"reason": "x"})
    ).status_code == 422  # reason too short
    b = await settle(tenant, b, "1000")  # the voided settlement freed its amount
    assert b["status"] == "paid"
    await ok(await tenant.post(f"{A}/bill-payments/{b['payments'][-1]['id']}/void", {"reason": "bounced"}))
    b = await ok(await tenant.post(f"{A}/bills/{b['id']}/void", {"reason": "supplier cancelled"}))
    assert b["status"] == "voided" and b["voided"] is True and b["void_reason"] == "supplier cancelled"
    assert (await tenant.post(f"{A}/bills/{b['id']}/void", {"reason": "again"})).status_code == 409
    assert (
        await tenant.post(f"{A}/bills/{b['id']}/payments", {"amount": "1", "paid_on": d(-1)})
    ).status_code == 409
    es = await entries(tenant)
    assert es[0]["source_type"] == "expense_void" and shape(es[0]) == [
        ("5040", "0.00", "1000.00"),
        ("2000", "1000.00", "0.00"),
    ]
    tb = await ok(await tenant.get(f"{A}/reports/trial-balance"))
    assert all(r["balance_debit"] == "0.00" == r["balance_credit"] for r in tb["rows"])
    assert (await ok(await tenant.get("/v1/expenses")))["items"] == []  # the expense is voided with its bill
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


async def test_listing_bills_by_status_and_due_date(tenant: Tenant) -> None:
    s = await supplier(tenant)
    await bill(tenant, s, "OPEN", due=10)
    late = await bill(tenant, s, "LATE", due=-2)
    part = await bill(tenant, s, "PART", due=20)
    await settle(tenant, part, "5")
    paid = await bill(tenant, s, "PAID", due=1)
    await settle(tenant, paid, "1000")
    voided = await bill(tenant, s, "VOID", due=3)
    await ok(await tenant.post(f"{A}/bills/{voided['id']}/void", {"reason": "not ours"}))

    async def numbers(**params: Any) -> list[str]:
        return [x["number"] for x in (await ok(await tenant.get(f"{A}/bills", params=params)))["items"]]

    assert await numbers() == ["LATE", "PAID", "VOID", "OPEN", "PART"]  # by due date
    assert await numbers(status="open") == ["OPEN"] and await numbers(status="partial") == ["PART"]
    assert await numbers(status="overdue") == ["LATE"] and await numbers(status="paid") == ["PAID"]
    assert await numbers(status="voided") == ["VOID"]
    assert await numbers(supplier_id=s["id"], limit=2) == ["LATE", "PAID"]
    one = await ok(await tenant.get(f"{A}/bills/{late['id']}"))
    assert one["status"] == "overdue" and one["supplier_name"] == "Ofis do'koni"
    assert (await tenant.get(f"{A}/bills/00000000-0000-0000-0000-000000000000")).status_code == 404


async def test_aging_report_buckets(tenant: Tenant) -> None:
    s = await supplier(tenant)
    due = {
        "B01": 5,
        "B02": 0,
        "B03": -1,
        "B04": -30,
        "B05": -31,
        "B06": -60,
        "B07": -61,
        "B08": -90,
        "B09": -91,
    }
    for n, off in due.items():
        await bill(tenant, s, n, amount="10", due=off, bill_date=d(-120))
    part = await bill(tenant, s, "P", amount="100", due=-5, bill_date=d(-120))
    await settle(tenant, part, "40.50", paid_on=d(-100))
    r = await ok(await tenant.get(f"{A}/reports/payables-aging"))
    assert r["buckets"] == {
        "not_due": "20.00",
        "d1_30": "79.50",
        "d31_60": "20.00",
        "d61_90": "20.00",
        "d90_plus": "10.00",
    }
    by = {x["number"]: (x["days_overdue"], x["bucket"]) for x in r["rows"]}
    assert (
        by["B01"] == (0, "not_due")
        and by["B02"] == (0, "not_due")
        and by["B03"] == (1, "d1_30")
        and by["B04"] == (30, "d1_30")
    )
    assert by["B05"] == (31, "d31_60") and by["B06"] == (60, "d31_60") and by["B07"] == (61, "d61_90")
    assert by["B08"] == (90, "d61_90") and by["B09"] == (91, "d90_plus") and by["P"] == (5, "d1_30")
    assert [x["outstanding"] for x in r["rows"] if x["number"] == "P"] == ["59.50"]
    assert r["total"] == "149.50" and r["rows"][0]["number"] == "B09"  # the oldest first
    earlier = await ok(await tenant.get(f"{A}/reports/payables-aging", params={"as_of": d(-130)}))
    assert earlier["rows"] == []  # none of the bills existed yet


async def test_payables_are_per_center_and_per_role(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    s = await supplier(tenant)
    b = await bill(tenant, s)
    assert (await ok(await tenant_b.get(f"{A}/suppliers"))) == []
    assert (await ok(await tenant_b.get(f"{A}/bills")))["items"] == []
    assert (await tenant_b.get(f"{A}/bills/{b['id']}")).status_code == 404
    assert (
        await tenant_b.post(f"{A}/bills/{b['id']}/payments", {"amount": "1", "paid_on": d(-1)})
    ).status_code == 404
    assert (
        await tenant_b.post(
            f"{A}/bills",
            {
                "supplier_id": s["id"],
                "number": "X",
                "bill_date": d(-1),
                "due_date": d(1),
                "category": "rent",
                "amount": "1",
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
        assert (await t.get(f"{A}/bills")).status_code == (200 if can_read else 403), role
        assert (await t.get(f"{A}/reports/payables-aging")).status_code == (200 if can_read else 403), role
        r = await t.post(f"{A}/bills/{b['id']}/payments", {"amount": "1", "paid_on": d(-1)})
        assert r.status_code == (201 if can_write else 403), role
