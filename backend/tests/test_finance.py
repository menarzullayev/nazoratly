from __future__ import annotations

import asyncio
import uuid
from decimal import Decimal

import httpx

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, mk_teacher, ok
from tests.test_tenancy_and_staff import _add_staff, _login


async def _setup_billed(t: Tenant, fee: str = "500000", month: str = "2026-01-15") -> tuple[dict, dict, dict]:
    grp = await mk_group(t, monthly_fee=fee)
    st = await mk_student(t)
    enr = await enroll(t, grp["id"], st["id"], "2026-01-01")
    gen = await ok(await t.post("/v1/charges/generate", {"month": month, "due_day": 5}))
    assert gen["created"] == 1
    return grp, st, enr


async def test_generate_charges_is_idempotent_and_respects_discount_and_status(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="500000")
    s1, s2, s3 = [await mk_student(tenant) for _ in range(3)]
    await enroll(tenant, grp["id"], s1["id"], "2026-01-01", discount_percent="20")
    await enroll(tenant, grp["id"], s2["id"], "2026-01-01", monthly_fee_override="0")
    e3 = await enroll(tenant, grp["id"], s3["id"], "2026-01-01")
    await ok(await tenant.patch(f"/v1/enrollments/{e3['id']}", {"status": "frozen"}))
    gen = await ok(await tenant.post("/v1/charges/generate", {"month": "2026-02-20", "due_day": 10}))
    assert (gen["created"], gen["skipped_zero_fee"]) == (1, 1)
    again = await ok(await tenant.post("/v1/charges/generate", {"month": "2026-02-01"}))
    assert again["created"] == 0 and again["skipped_existing"] == 1
    charges = (await ok(await tenant.get("/v1/charges", params={"month": "2026-02-01"})))["items"]
    assert (
        len(charges) == 1 and charges[0]["amount"] == "400000.00" and charges[0]["due_date"] == "2026-02-10"
    )
    # an enrollment that started after the month is not billed
    later = await mk_student(tenant)
    await enroll(tenant, grp["id"], later["id"], "2026-03-01")
    assert (await ok(await tenant.post("/v1/charges/generate", {"month": "2026-02-01"})))["created"] == 0


async def test_payment_auto_allocates_oldest_first_and_overpayment_becomes_credit(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="300000")
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], "2026-01-01")
    for m in ("2026-01-01", "2026-02-01", "2026-03-01"):
        await ok(await tenant.post("/v1/charges/generate", {"month": m, "due_day": 5}))
    pay = await ok(
        await tenant.post("/v1/payments", {"student_id": st["id"], "amount": "450000", "method": "cash"}), 201
    )
    assert pay["allocated"] == "450000.00" and pay["unallocated"] == "0.00"
    amounts = [(a["period_month"], a["amount"]) for a in pay["allocations"]]
    assert amounts == [("2026-01-01", "300000.00"), ("2026-02-01", "150000.00")]
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert bal["outstanding_total"] == "450000.00" and [c["period_month"] for c in bal["open_charges"]] == [
        "2026-02-01",
        "2026-03-01",
    ]
    big = await ok(
        await tenant.post("/v1/payments", {"student_id": st["id"], "amount": "600000", "method": "card"}), 201
    )
    assert big["allocated"] == "450000.00" and big["unallocated"] == "150000.00"
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert bal["outstanding_total"] == "0.00" and bal["credit"] == "150000.00"
    # next month's charge is covered by the stored credit
    await ok(await tenant.post("/v1/charges/generate", {"month": "2026-04-01", "due_day": 5}))
    applied = await ok(await tenant.post(f"/v1/students/{st['id']}/allocate-credit"))
    assert len(applied) == 1
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert bal["outstanding_total"] == "150000.00" and bal["credit"] == "0.00"


async def test_explicit_allocation_rules_and_void_flow(tenant: Tenant) -> None:
    _, st, _ = await _setup_billed(tenant)
    other = await mk_student(tenant)
    ch = (await ok(await tenant.get("/v1/charges", params={"student_id": st["id"]})))["items"][0]
    pay = await ok(
        await tenant.post(
            "/v1/payments",
            {"student_id": st["id"], "amount": "200000", "method": "cash", "auto_allocate": False},
        ),
        201,
    )
    assert pay["allocated"] == "0.00"
    # over-allocation beyond the payment is refused
    assert (
        await tenant.post(
            f"/v1/payments/{pay['id']}/allocate",
            {"allocations": [{"charge_id": ch["id"], "amount": "200000.01"}]},
        )
    ).status_code == 422
    pay = await ok(
        await tenant.post(
            f"/v1/payments/{pay['id']}/allocate",
            {"allocations": [{"charge_id": ch["id"], "amount": "150000"}]},
        )
    )
    assert pay["allocated"] == "150000.00"
    # a payment of another student cannot pay this charge
    foreign = await ok(
        await tenant.post(
            "/v1/payments",
            {"student_id": other["id"], "amount": "10000", "method": "cash", "auto_allocate": False},
        ),
        201,
    )
    assert (
        await tenant.post(
            f"/v1/payments/{foreign['id']}/allocate",
            {"allocations": [{"charge_id": ch["id"], "amount": "1000"}]},
        )
    ).status_code == 422
    # charge: cannot void while paid unless releasing; amount cannot drop below allocated
    assert (await tenant.patch(f"/v1/charges/{ch['id']}", {"amount": "100000"})).status_code == 422
    assert (await tenant.post(f"/v1/charges/{ch['id']}/void", {"reason": "mistake"})).status_code == 409
    voided = await ok(
        await tenant.post(f"/v1/charges/{ch['id']}/void", {"reason": "mistake", "release_allocations": True})
    )
    assert voided["voided"] is True
    assert (await tenant.post(f"/v1/charges/{ch['id']}/void", {"reason": "again"})).status_code == 409
    pay_after = await ok(await tenant.get(f"/v1/payments/{pay['id']}"))
    assert pay_after["allocated"] == "0.00"
    # voiding a payment releases its allocations and keeps the row
    v = await ok(await tenant.post(f"/v1/payments/{pay['id']}/void", {"reason": "bounced"}))
    assert v["voided"] and v["void_reason"] == "bounced"
    assert (await tenant.post(f"/v1/payments/{pay['id']}/allocate", {"auto": True})).status_code == 409
    listed = (await ok(await tenant.get("/v1/payments", params={"student_id": st["id"]})))["items"]
    assert listed == []
    assert (
        len(
            (
                await ok(
                    await tenant.get("/v1/payments", params={"student_id": st["id"], "include_voided": True})
                )
            )["items"]
        )
        == 1
    )


async def test_online_payment_is_idempotent_by_external_ref(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    body = {"student_id": st["id"], "amount": "100000", "method": "payme", "external_ref": "payme-tx-1"}
    first = await tenant.post("/v1/payments", body)
    second = await tenant.post("/v1/payments", body)
    assert first.status_code == 201 and second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert (await tenant.post("/v1/payments", {**body, "amount": "100001"})).status_code == 409
    assert len((await ok(await tenant.get("/v1/payments", params={"method": "payme"})))["items"]) == 1


async def test_concurrent_payments_never_overallocate(client: httpx.AsyncClient, tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="1000000")
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], "2026-01-01")
    await ok(await tenant.post("/v1/charges/generate", {"month": "2026-01-01"}))
    results = await asyncio.gather(
        *[
            tenant.post("/v1/payments", {"student_id": st["id"], "amount": "300000", "method": "cash"})
            for _ in range(8)
        ]
    )
    assert all(r.status_code == 201 for r in results), [r.text for r in results if r.status_code != 201]
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert bal["outstanding_total"] == "0.00"
    assert Decimal(bal["credit"]) == Decimal("1400000.00")  # 8 * 300k paid, 1M debt cleared, rest is credit
    charge = (await ok(await tenant.get("/v1/charges", params={"student_id": st["id"]})))["items"][0]
    assert charge["paid"] == "1000000.00"


async def test_debtors_revenue_expenses_summary(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="200000")
    a, b = await mk_student(tenant, "Debtor A"), await mk_student(tenant, "Payer B")
    await enroll(tenant, grp["id"], a["id"], "2025-01-01")
    await enroll(tenant, grp["id"], b["id"], "2025-01-01")
    await ok(await tenant.post("/v1/charges/generate", {"month": "2025-06-01", "due_day": 5}))
    await ok(
        await tenant.post(
            "/v1/payments",
            {
                "student_id": b["id"],
                "amount": "200000",
                "method": "cash",
                "paid_at": "2025-06-07T10:00:00+05:00",
            },
        ),
        201,
    )
    debtors = await ok(await tenant.get("/v1/reports/debtors"))
    assert [d["student_name"] for d in debtors] == ["Debtor A"]
    assert debtors[0]["overdue_total"] == "200000.00" and debtors[0]["max_days_overdue"] > 30
    assert await ok(await tenant.get("/v1/reports/debtors", params={"min_days_overdue": 3650})) == []
    exp = await ok(
        await tenant.post("/v1/expenses", {"category": "rent", "amount": "50000", "spent_at": "2025-06-10"}),
        201,
    )
    ex2 = await ok(
        await tenant.post("/v1/expenses", {"category": "other", "amount": "999", "spent_at": "2025-06-11"}),
        201,
    )
    await ok(await tenant.post(f"/v1/expenses/{ex2['id']}/void", {"reason": "typo"}))
    rev = await ok(
        await tenant.get(
            "/v1/reports/revenue",
            params={"date_from": "2025-06-01", "date_to": "2025-06-30", "group_by": "month"},
        )
    )
    assert [(r["period"], r["total"]) for r in rev] == [("2025-06-01", "200000.00")]
    summ = await ok(await tenant.get("/v1/reports/summary", params={"month": "2025-06-10"}))
    assert (summ["charged"], summ["revenue"], summ["expenses"], summ["net"]) == (
        "400000.00",
        "200000.00",
        "50000.00",
        "150000.00",
    )
    assert summ["outstanding_now"] == "200000.00"
    assert exp["id"]


async def test_finance_rbac(client: httpx.AsyncClient, tenant: Tenant) -> None:
    st = await mk_student(tenant)
    _, mgr_email = await _add_staff(tenant, "manager")
    _, acc_email = await _add_staff(tenant, "accountant")
    _, view_email = await _add_staff(tenant, "viewer")
    mgr, acc, viewer = [
        await _login(client, e, "staff-password-123") for e in (mgr_email, acc_email, view_email)
    ]
    assert (await viewer.get("/v1/payments")).status_code == 403
    assert (
        await viewer.get("/v1/reports/summary", params={"month": "2026-01-01"})
    ).status_code == 200  # aggregates only
    assert (await viewer.get("/v1/reports/debtors")).status_code == 403
    assert (
        await mgr.post("/v1/payments", {"student_id": st["id"], "amount": "1000", "method": "cash"})
    ).status_code == 201
    assert (
        await mgr.post("/v1/expenses", {"category": "rent", "amount": "1", "spent_at": "2026-01-01"})
    ).status_code == 403
    assert (
        await acc.post("/v1/expenses", {"category": "rent", "amount": "1", "spent_at": "2026-01-01"})
    ).status_code == 201
    assert (await acc.post("/v1/students", {"full_name": "nope"})).status_code == 403
    assert (
        await tenant.post("/v1/payments", {"student_id": st["id"], "amount": "-5", "method": "cash"})
    ).status_code == 422
    assert (
        await tenant.post("/v1/payments", {"student_id": st["id"], "amount": "1.234", "method": "cash"})
    ).status_code == 422
    assert (
        await tenant.post("/v1/payments", {"student_id": st["id"], "amount": "5", "method": "bitcoin"})
    ).status_code == 422
    assert (
        await tenant.post(
            "/v1/payments",
            {"student_id": st["id"], "amount": "5", "method": "cash", "paid_at": "2026-01-01T10:00:00"},
        )
    ).status_code == 422


async def test_cross_tenant_finance_isolation(tenant: Tenant, tenant_b: Tenant) -> None:
    _, st, _ = await _setup_billed(tenant)
    pay = await ok(
        await tenant.post("/v1/payments", {"student_id": st["id"], "amount": "1000", "method": "cash"}), 201
    )
    ch = (await ok(await tenant.get("/v1/charges")))["items"][0]
    assert (await tenant_b.get(f"/v1/payments/{pay['id']}")).status_code == 404
    assert (await tenant_b.get(f"/v1/charges/{ch['id']}")).status_code == 404
    assert (
        await tenant_b.post("/v1/payments", {"student_id": st["id"], "amount": "5", "method": "cash"})
    ).status_code == 404
    assert (await ok(await tenant_b.get("/v1/reports/summary", params={"month": "2026-01-01"})))[
        "revenue"
    ] == "0.00"


async def test_delete_student_blocked_by_debt(tenant: Tenant) -> None:
    _, st, enr = await _setup_billed(tenant)
    assert (await tenant.delete(f"/v1/students/{st['id']}")).status_code == 409
    _ = enr, uuid


async def test_payroll_flow_per_lesson_fixed_percent(client: httpx.AsyncClient, tenant: Tenant) -> None:
    t_lesson = await mk_teacher(tenant, pay_model="per_lesson", pay_rate="100000")
    grp = await mk_group(tenant, teacher_id=t_lesson["id"], monthly_fee="1000000")
    await ok(
        await tenant.put(
            f"/v1/groups/{grp['id']}/schedule",
            [{"weekday": 1, "start_time": "10:00:00", "end_time": "11:00:00"}],
        )
    )
    await ok(
        await tenant.post(
            f"/v1/groups/{grp['id']}/lessons/generate", {"date_from": "2026-03-01", "date_to": "2026-03-31"}
        )
    )
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], "2026-01-01")
    lessons = (
        await ok(await tenant.get("/v1/lessons", params={"date_from": "2026-03-01", "date_to": "2026-03-31"}))
    )["items"]
    for les in lessons[:3]:  # three lessons actually held
        await ok(
            await tenant.put(
                f"/v1/lessons/{les['id']}/attendance",
                {"records": [{"student_id": st["id"], "status": "present"}]},
            )
        )
    pr = await ok(
        await tenant.post("/v1/payrolls/generate", {"teacher_id": t_lesson["id"], "month": "2026-03-10"})
    )
    assert pr["status"] == "draft" and pr["total"] == "300000.00" and len(pr["items"]) == 3
    again = await ok(
        await tenant.post("/v1/payrolls/generate", {"teacher_id": t_lesson["id"], "month": "2026-03-10"})
    )
    assert again["id"] == pr["id"] and again["total"] == "300000.00"  # recomputed, not duplicated
    pr = await ok(
        await tenant.post(
            f"/v1/payrolls/{pr['id']}/items", {"kind": "penalty", "amount": "50000", "description": "late x2"}
        ),
        201,
    )
    pr = await ok(
        await tenant.post(f"/v1/payrolls/{pr['id']}/items", {"kind": "bonus", "amount": "20000"}), 201
    )
    assert pr["total"] == "270000.00"
    regen = await ok(
        await tenant.post("/v1/payrolls/generate", {"teacher_id": t_lesson["id"], "month": "2026-03-01"})
    )
    assert regen["total"] == "270000.00"  # manual lines survive regeneration
    assert (
        await tenant.post(f"/v1/payrolls/{pr['id']}/items", {"kind": "bonus", "amount": "-5"})
    ).status_code == 422
    assert (await tenant.post(f"/v1/payrolls/{pr['id']}/pay")).status_code == 409  # not approved yet

    _, acc_email = await _add_staff(tenant, "accountant")
    acc = await _login(client, acc_email, "staff-password-123")
    assert (
        await acc.post(f"/v1/payrolls/{pr['id']}/approve")
    ).status_code == 403  # approval is owner/admin only
    approved = await ok(await tenant.post(f"/v1/payrolls/{pr['id']}/approve"))
    assert approved["status"] == "approved" and approved["approved_at"]
    assert (
        await tenant.post(f"/v1/payrolls/{pr['id']}/items", {"kind": "bonus", "amount": "1"})
    ).status_code == 409
    assert (
        await tenant.post("/v1/payrolls/generate", {"teacher_id": t_lesson["id"], "month": "2026-03-01"})
    ).status_code == 409
    paid = await ok(await acc.post(f"/v1/payrolls/{pr['id']}/pay"))
    assert paid["status"] == "paid" and paid["paid_at"]
    summ = await ok(await tenant.get("/v1/reports/summary", params={"month": "2026-03-01"}))
    assert summ["payroll"] == "270000.00"

    fixed = await mk_teacher(tenant, pay_model="fixed", pay_rate="3000000")
    fp = await ok(
        await tenant.post("/v1/payrolls/generate", {"teacher_id": fixed["id"], "month": "2026-03-01"})
    )
    assert fp["total"] == "3000000.00"
    pct = await mk_teacher(tenant, pay_model="percent", pay_rate="40")
    pgrp = await mk_group(tenant, teacher_id=pct["id"], monthly_fee="500000")
    ps = await mk_student(tenant)
    await enroll(tenant, pgrp["id"], ps["id"], "2026-01-01")
    await ok(await tenant.post("/v1/charges/generate", {"month": "2026-03-01", "group_id": pgrp["id"]}))
    await ok(
        await tenant.post("/v1/payments", {"student_id": ps["id"], "amount": "500000", "method": "cash"}), 201
    )
    pp = await ok(
        await tenant.post("/v1/payrolls/generate", {"teacher_id": pct["id"], "month": "2026-03-01"})
    )
    assert pp["total"] == "200000.00"
    empty = await mk_teacher(tenant, pay_model="per_lesson", pay_rate="1")
    ep = await ok(
        await tenant.post("/v1/payrolls/generate", {"teacher_id": empty["id"], "month": "2026-03-01"})
    )
    assert ep["total"] == "0" or Decimal(ep["total"]) == 0
    assert (await tenant.post(f"/v1/payrolls/{ep['id']}/approve")).status_code == 422
    listing = (await ok(await tenant.get("/v1/payrolls", params={"month": "2026-03-01", "status": "paid"})))[
        "items"
    ]
    assert [x["id"] for x in listing] == [pr["id"]]
