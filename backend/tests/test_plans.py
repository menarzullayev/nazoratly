"""Payment plans: a charge split into dated installments; debt and overdue are computed per installment."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest

from tests.conftest import Tenant
from tests.helpers import mk_student, ok

TODAY = datetime.now(UTC).date()


def d(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


async def charge(t: Tenant, student_id: str, amount: str = "900000", due: int = -40) -> dict[str, Any]:
    return await ok(
        await t.post(
            "/v1/charges",
            {
                "student_id": student_id,
                "kind": "tuition",
                "period_month": TODAY.replace(day=1).isoformat(),
                "amount": amount,
                "due_date": d(due),
            },
        ),
        201,
    )


async def put_plan(t: Tenant, charge_id: str, rows: list[tuple[str, int]]) -> Any:
    return await t.put(
        f"/v1/charges/{charge_id}/plan",
        {"installments": [{"amount": a, "due_date": d(o)} for a, o in rows]},
    )


async def pay(t: Tenant, student_id: str, amount: str) -> dict[str, Any]:
    return await ok(
        await t.post("/v1/payments", {"student_id": student_id, "amount": amount, "method": "cash"}), 201
    )


THREE = [("300000", -40), ("300000", -10), ("300000", 20)]


async def test_overdue_is_per_installment_everywhere(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"])
    plan = await ok(await put_plan(tenant, ch["id"], THREE))
    assert [i["seq"] for i in plan["installments"]] == [1, 2, 3]
    assert plan["outstanding"] == "900000.00"
    await pay(tenant, st["id"], "450000")

    plan = await ok(await tenant.get(f"/v1/charges/{ch['id']}/plan"))
    assert [(i["paid"], i["outstanding"], i["overdue"]) for i in plan["installments"]] == [
        ("300000.00", "0.00", False),
        ("150000.00", "150000.00", True),
        ("0.00", "300000.00", False),
    ]
    one = await ok(await tenant.get(f"/v1/charges/{ch['id']}"))
    assert (one["installments_count"], one["overdue"], one["outstanding"]) == (3, "150000.00", "450000.00")
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert (bal["outstanding_total"], bal["overdue_total"]) == ("450000.00", "150000.00")
    oc = bal["open_charges"][0]
    assert (oc["overdue"], oc["overdue_amount"], oc["next_due"]) == (True, "150000.00", d(-10))
    debtors = [r for r in await ok(await tenant.get("/v1/reports/debtors")) if r["student_id"] == st["id"]]
    assert (debtors[0]["overdue_total"], debtors[0]["max_days_overdue"], debtors[0]["oldest_due_date"]) == (
        "150000.00",
        10,
        d(-10),
    )
    overdue = (await ok(await tenant.get("/v1/charges", params={"state": "overdue"})))["items"]
    assert [c["id"] for c in overdue] == [ch["id"]]
    summary = await ok(await tenant.get("/v1/reports/summary", params={"month": TODAY.isoformat()}))
    assert summary["overdue_now"] == "150000.00"


@pytest.mark.parametrize(
    ("paid", "expected_paid", "expected_overdue"),
    [
        ("100000", ["100000.00", "0.00", "0.00"], "500000.00"),  # less than the first installment
        ("300000", ["300000.00", "0.00", "0.00"], "300000.00"),  # exactly the first
        ("600000", ["300000.00", "300000.00", "0.00"], "0.00"),  # the two due ones
        ("900000", ["300000.00", "300000.00", "300000.00"], "0.00"),
        ("1000000", ["300000.00", "300000.00", "300000.00"], "0.00"),  # beyond the charge: credit
    ],
)
async def test_payment_sizes_against_installments(
    tenant: Tenant, paid: str, expected_paid: list[str], expected_overdue: str
) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"])
    await ok(await put_plan(tenant, ch["id"], THREE))
    await pay(tenant, st["id"], paid)
    plan = await ok(await tenant.get(f"/v1/charges/{ch['id']}/plan"))
    assert [i["paid"] for i in plan["installments"]] == expected_paid
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert bal["overdue_total"] == expected_overdue
    if paid == "1000000":
        assert bal["credit"] == "100000.00"


async def test_due_today_is_not_overdue_but_yesterday_is(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"], "600000", due=-3)
    await ok(await put_plan(tenant, ch["id"], [("300000", 0), ("300000", 30)]))
    assert (await ok(await tenant.get(f"/v1/students/{st['id']}/balance")))["overdue_total"] == "0.00"
    assert [r for r in await ok(await tenant.get("/v1/reports/debtors")) if r["student_id"] == st["id"]] == []
    st2 = await mk_student(tenant)
    ch2 = await charge(tenant, st2["id"], "600000", due=-3)
    await ok(await put_plan(tenant, ch2["id"], [("300000", -1), ("300000", 30)]))
    assert (await ok(await tenant.get(f"/v1/students/{st2['id']}/balance")))["overdue_total"] == "300000.00"


async def test_equal_split_puts_the_remainder_on_the_last(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"], "1000000", due=5)
    plan = await ok(
        await tenant.put(f"/v1/charges/{ch['id']}/plan", {"equal": {"count": 3, "first_due": "2099-01-31"}})
    )
    assert [(i["amount"], i["due_date"]) for i in plan["installments"]] == [
        ("333333.00", "2099-01-31"),
        ("333333.00", "2099-02-28"),
        ("333334.00", "2099-03-31"),
    ]
    assert (await ok(await tenant.get(f"/v1/charges/{ch['id']}")))[
        "due_date"
    ] == "2099-01-31"  # FIFO key = first installment


async def test_invalid_plans_are_rejected_with_the_rule_code(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"], "600000")

    async def code(rows: list[tuple[str, int]]) -> str:
        r = await put_plan(tenant, ch["id"], rows)
        assert r.status_code == 422, r.text
        return str(r.json()["error"]["details"].get("rule", r.json()["error"]["code"]))

    assert await code([("600000", 0)]) == "count"
    assert await code([("1", i) for i in range(25)]) == "count"
    assert await code([("300000", 0), ("299999", 1)]) == "sum_mismatch"
    assert await code([("300000", 0), ("300001", 1)]) == "sum_mismatch"
    assert await code([("300000", 5), ("300000", 1)]) == "dates_not_increasing"
    assert await code([("300000", 1), ("300000", 1)]) == "dates_not_increasing"
    assert await code([("600000", 0), ("0", 5)]) == "validation_error"  # zero amount fails model validation
    r = await tenant.put(f"/v1/charges/{ch['id']}/plan", {"equal": {"count": 1, "first_due": d(0)}})
    assert r.status_code == 422 and r.json()["error"]["details"]["rule"] == "count"
    r = await tenant.put(f"/v1/charges/{ch['id']}/plan", {})  # neither installments nor equal
    assert r.status_code == 422
    r = await tenant.put(
        f"/v1/charges/{ch['id']}/plan",
        {"equal": {"count": 2, "first_due": d(0)}, "installments": [{"amount": "1", "due_date": d(0)}]},
    )
    assert r.status_code == 422
    assert (await tenant.get(f"/v1/charges/{ch['id']}/plan")).status_code == 404  # nothing was saved


async def test_replacing_a_plan_after_a_partial_payment_keeps_the_paid_money(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"])
    await ok(await put_plan(tenant, ch["id"], THREE))
    await pay(tenant, st["id"], "450000")
    plan = await ok(await put_plan(tenant, ch["id"], [("450000", 1), ("450000", 30)]))
    assert (plan["paid"], plan["outstanding"]) == ("450000.00", "450000.00")
    assert [i["paid"] for i in plan["installments"]] == ["450000.00", "0.00"]
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert bal["overdue_total"] == "0.00" and bal["outstanding_total"] == "450000.00"


async def test_removing_a_plan_returns_to_a_single_due_date(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"], "600000")
    await ok(await put_plan(tenant, ch["id"], [("300000", -20), ("300000", 10)]))
    r = await tenant.delete(f"/v1/charges/{ch['id']}/plan")
    assert r.status_code == 204
    assert (await tenant.get(f"/v1/charges/{ch['id']}/plan")).status_code == 404
    assert (await tenant.delete(f"/v1/charges/{ch['id']}/plan")).status_code == 404
    one = await ok(await tenant.get(f"/v1/charges/{ch['id']}"))
    assert (one["installments_count"], one["due_date"], one["overdue"]) == (0, d(-20), "600000.00")


async def test_planned_charge_cannot_drift_and_void_removes_the_plan(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"], "600000")
    await ok(await put_plan(tenant, ch["id"], [("300000", 5), ("300000", 35)]))
    for body in ({"amount": "700000"}, {"due_date": d(99)}):
        r = await tenant.patch(f"/v1/charges/{ch['id']}", body)
        assert r.status_code == 409, r.text
    assert (await tenant.patch(f"/v1/charges/{ch['id']}", {"description": "note"})).status_code == 200
    await ok(await tenant.post(f"/v1/charges/{ch['id']}/void", {"reason": "entered twice"}))
    assert (await tenant.get(f"/v1/charges/{ch['id']}/plan")).status_code == 404
    again = await put_plan(tenant, ch["id"], [("300000", 5), ("300000", 35)])
    assert again.status_code == 409  # a voided charge has no plan


async def test_installments_report_and_isolation(tenant: Tenant, tenant_b: Tenant) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"])
    await ok(await put_plan(tenant, ch["id"], THREE))
    await pay(tenant, st["id"], "300000")

    def mine(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [r for r in rows if r["charge_id"] == ch["id"]]

    soon = mine(await ok(await tenant.get("/v1/reports/installments", params={"days_ahead": 30})))
    assert [(r["seq"], r["installments_count"], r["outstanding"], r["days_overdue"]) for r in soon] == [
        (2, 3, "300000.00", 10),
        (3, 3, "300000.00", -20),
    ]
    late = mine(await ok(await tenant.get("/v1/reports/installments", params={"only_overdue": True})))
    assert [r["seq"] for r in late] == [2]
    assert mine(await ok(await tenant.get("/v1/reports/installments", params={"days_ahead": 5}))) == late
    assert late[0]["student_name"] == st["full_name"]

    # another center sees nothing and cannot touch the plan
    assert (await tenant_b.get(f"/v1/charges/{ch['id']}/plan")).status_code == 404
    assert (await put_plan(tenant_b, ch["id"], THREE)).status_code == 404
    assert (await tenant_b.delete(f"/v1/charges/{ch['id']}/plan")).status_code == 404
    assert mine(await ok(await tenant_b.get("/v1/reports/installments", params={"days_ahead": 365}))) == []


async def test_plan_changes_are_audited(tenant: Tenant, super_dsn: str) -> None:
    st = await mk_student(tenant)
    ch = await charge(tenant, st["id"], "600000")
    await ok(await put_plan(tenant, ch["id"], [("300000", 5), ("300000", 35)]))
    await ok(await put_plan(tenant, ch["id"], [("200000", 5), ("400000", 35)]))
    async with await psycopg.AsyncConnection.connect(super_dsn) as conn:
        cur = await conn.execute(
            "SELECT action, count(*) FROM audit_log WHERE entity_type = 'charge_installments' "
            "AND org_id = (SELECT id FROM organizations WHERE public_id = %s) GROUP BY action ORDER BY action",
            (tenant.org_id,),
        )
        counts = dict(await cur.fetchall())
    assert counts == {"delete": 2, "insert": 4}
