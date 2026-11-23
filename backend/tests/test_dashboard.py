"""Dashboard: paid vs unpaid students, new vs left students and trial conversion, six-month income/expenses/net, lead
funnel and the "waiting for a decision" lists. Facts are created through the real HTTP API; the numbers themselves are
the shared rules (tests/golden/dashboard.json), so these tests check that the facts are loaded correctly, tenant
isolation, permissions and validation."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, mk_teacher, ok
from tests.test_packages import CASH, attend, lesson, mark, pkg_group, sell, student_in
from tests.test_plans import THREE, charge, pay, put_plan
from tests.test_tenancy_and_staff import _add_staff, _login

TODAY = date.today()


def d(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


async def dash(t: Tenant, **params: Any) -> dict[str, Any]:
    return await ok(await t.get("/v1/dashboard", params=params))


async def student_with_fee_charge(t: Tenant, grp: dict[str, Any], name: str) -> dict[str, Any]:
    st = await mk_student(t, name)
    st["enrollment"] = await enroll(t, grp["id"], st["id"], d(-100))
    return st


PREV_MONTH = (TODAY.replace(day=1) - timedelta(days=1)).replace(day=1)


# ---- empty center -----------------------------------------------------------------------------------------
async def test_an_empty_center_returns_zeros_and_six_months(tenant: Tenant) -> None:
    r = await dash(tenant)
    assert r["payments"] == {"paid": 0, "unpaid": 0, "overdue": 0, "unpaid_students": [], "paid_students": []}
    assert r["movement"]["new"] == 0 and r["movement"]["left"] == 0 and r["movement"]["conversion"] == 0.0
    assert len(r["finance"]["months"]) == 6
    assert all(m["income"] == "0.00" and m["net"] == "0.00" for m in r["finance"]["months"])
    assert r["finance"]["months"][-1]["month"][:7] == r["as_of"][:7]
    assert r["finance"]["income"] == "0.00" and r["finance"]["net"] == "0.00"
    assert all(v == 0 for v in r["funnel"]["stages"].values())
    assert r["waiting"] == {"trials": [], "packages": [], "rights": [], "seats": [], "total": 0}
    assert r["range"]["date_from"] == r["as_of"][:8] + "01" and r["range"]["date_to"] == r["as_of"]
    assert r["window_days"] == 7


# ---- block 1 ----------------------------------------------------------------------------------------------
async def test_paid_and_unpaid_students_with_clickable_lists(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="200000")
    a = await student_with_fee_charge(tenant, grp, "Paid A")
    b = await student_with_fee_charge(tenant, grp, "Unpaid B")
    c = await student_with_fee_charge(tenant, grp, "Partial C")
    gone = await student_with_fee_charge(tenant, grp, "Left D")
    trial_only = await mk_student(tenant, "Trial E")
    await enroll(tenant, grp["id"], trial_only["id"], d(0), status="trial")
    await ok(await tenant.post("/v1/charges/generate", {"month": PREV_MONTH.isoformat(), "due_day": 5}))
    await pay(tenant, a["id"], "200000")
    await pay(tenant, c["id"], "50000")
    await ok(
        await tenant.patch(
            f"/v1/enrollments/{gone['enrollment']['id']}", {"status": "finished", "ended_on": d(-40)}
        )
    )
    p = (await dash(tenant))["payments"]
    # D has a debt but no open enrollment, E is only on trial: neither is in the population
    assert (p["paid"], p["unpaid"], p["overdue"]) == (1, 2, 2)
    assert [
        (s["id"], s["name"], s["outstanding"], s["overdue"], s["package_debt_lessons"])
        for s in p["unpaid_students"]
    ] == [
        (b["id"], "Unpaid B", "200000.00", "200000.00", 0),
        (c["id"], "Partial C", "150000.00", "150000.00", 0),
    ]
    assert p["paid_students"] == [{"id": a["id"], "name": "Paid A"}]


async def test_a_debt_that_is_only_in_a_later_installment_is_unpaid_not_overdue(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="900000")
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], d(-100))
    ch = await charge(tenant, st["id"], due=-40)
    await ok(await put_plan(tenant, ch["id"], THREE))
    await pay(tenant, st["id"], "450000")
    s = (await dash(tenant))["payments"]["unpaid_students"][0]
    assert (s["outstanding"], s["overdue"]) == ("450000.00", "150000.00")  # installment 2 is short by 150 000
    await pay(tenant, st["id"], "150000")
    p = (await dash(tenant))["payments"]
    assert (p["unpaid"], p["overdue"]) == (1, 0)  # only the third installment (due later) is open


async def test_package_debt_makes_a_student_unpaid_until_a_package_is_paid(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await attend(tenant, grp, st, ["present", "present"])
    p = (await dash(tenant))["payments"]
    assert (p["unpaid"], p["paid"]) == (1, 0)
    row = p["unpaid_students"][0]
    assert (row["outstanding"], row["package_debt_lessons"]) == ("0.00", 2)
    await sell(tenant, en["id"], pay=CASH)
    p = (await dash(tenant))["payments"]
    assert (p["unpaid"], p["paid"]) == (0, 1)


async def test_list_limit_truncates_lists_but_not_counts(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="100000")
    for i in range(3):
        await student_with_fee_charge(tenant, grp, f"Debtor {i}")
    await ok(await tenant.post("/v1/charges/generate", {"month": PREV_MONTH.isoformat(), "due_day": 5}))
    p = (await dash(tenant, list_limit=2))["payments"]
    assert p["unpaid"] == 3 and len(p["unpaid_students"]) == 2
    p = (await dash(tenant, list_limit=1))["payments"]
    assert p["unpaid"] == 3 and len(p["unpaid_students"]) == 1


# ---- block 2 ----------------------------------------------------------------------------------------------
async def test_new_left_and_trial_conversion(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="300000")
    plain = await mk_student(tenant, "Plain New")
    await enroll(tenant, grp["id"], plain["id"], d(0))
    accepted = await mk_student(tenant, "Accepted Trial")
    e1 = await enroll(tenant, grp["id"], accepted["id"], d(0), status="trial")
    await ok(await tenant.post(f"/v1/enrollments/{e1['id']}/accept", {"mode": "free_until_next"}))
    dropped = await mk_student(tenant, "Dropped Trial")
    e2 = await enroll(tenant, grp["id"], dropped["id"], d(0), status="trial")
    await ok(await tenant.post(f"/v1/enrollments/{e2['id']}/drop", {}))
    running = await mk_student(tenant, "Running Trial")
    await enroll(tenant, grp["id"], running["id"], d(0), status="trial")
    left = await mk_student(tenant, "Left Student")
    e3 = await enroll(tenant, grp["id"], left["id"], d(-100))
    await ok(await tenant.patch(f"/v1/enrollments/{e3['id']}", {"status": "finished", "ended_on": d(-2)}))
    back = await mk_student(tenant, "Left And Back")
    e4 = await enroll(tenant, grp["id"], back["id"], d(-100))
    await ok(await tenant.patch(f"/v1/enrollments/{e4['id']}", {"status": "finished", "ended_on": d(-3)}))
    grp2 = await mk_group(tenant, monthly_fee="300000")
    await enroll(tenant, grp2["id"], back["id"], d(-1))
    m = (await dash(tenant, date_from=d(-30), date_to=d(1)))["movement"]
    assert m["new"] == 2 and {s["name"] for s in m["new_students"]} == {"Plain New", "Accepted Trial"}
    assert m["left"] == 1 and [s["name"] for s in m["left_students"]] == ["Left Student"]
    assert (m["trials_started"], m["accepted"], m["dropped"], m["running"]) == (3, 1, 1, 1)
    assert m["conversion"] == 50.0
    # a range before everything happened sees none of it
    m = (await dash(tenant, date_from=d(-400), date_to=d(-200)))["movement"]
    assert (m["new"], m["left"], m["trials_started"]) == (0, 0, 0)


# ---- block 3 ----------------------------------------------------------------------------------------------
async def test_six_month_income_expenses_payroll_and_net(tenant: Tenant) -> None:
    teacher = await mk_teacher(tenant, pay_model="fixed", pay_rate="1000000")
    grp = await mk_group(tenant, teacher_id=teacher["id"], monthly_fee="300000")
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], d(-100))
    await pay(tenant, st["id"], "300000")
    await ok(
        await tenant.post("/v1/expenses", {"category": "rent", "amount": "120000", "spent_at": d(0)}), 201
    )
    await ok(
        await tenant.post("/v1/expenses", {"category": "rent", "amount": "50000", "spent_at": d(-70)}), 201
    )
    voided = await ok(
        await tenant.post("/v1/expenses", {"category": "other", "amount": "999", "spent_at": d(0)}), 201
    )
    await ok(await tenant.post(f"/v1/expenses/{voided['id']}/void", {"reason": "typo"}))
    cur = await ok(await tenant.post("/v1/payrolls/generate", {"teacher_id": teacher["id"], "month": d(0)}))
    await ok(await tenant.post(f"/v1/payrolls/{cur['id']}/approve"))
    await ok(
        await tenant.post(
            "/v1/payrolls/generate", {"teacher_id": teacher["id"], "month": PREV_MONTH.isoformat()}
        )
    )
    r = await dash(tenant)
    months = r["finance"]["months"]
    last = months[-1]
    assert (last["income"], last["operating"], last["payroll"], last["expenses"], last["net"]) == (
        "300000.00", "120000.00", "1000000.00", "1120000.00", "-820000.00",
    )  # fmt: skip
    old = next(m for m in months if m["month"][:7] == d(-70)[:7])
    assert (old["operating"], old["payroll"], old["net"]) == (
        "50000.00",
        "0.00",
        "-50000.00",
    )  # the previous month's draft payroll does not count
    assert (r["finance"]["income"], r["finance"]["expenses"], r["finance"]["net"]) == (
        "300000.00",
        "1170000.00",
        "-870000.00",
    )
    summary = await ok(await tenant.get("/v1/reports/summary", params={"month": d(0)}))
    assert summary["net"] == last["net"]  # same definition as the monthly summary report


# ---- block 4 ----------------------------------------------------------------------------------------------
async def test_the_lead_funnel_block_equals_the_funnel_report(tenant: Tenant) -> None:
    src = await ok(await tenant.post("/v1/lead-sources", {"name": "Instagram"}), 201)
    for name, stage in (("A", "new"), ("B", "contacted"), ("C", "contacted")):
        ld = await ok(await tenant.post("/v1/leads", {"full_name": name, "source_id": src["id"]}), 201)
        if stage != "new":
            await ok(await tenant.patch(f"/v1/leads/{ld['id']}", {"stage": stage}))
    await ok(await tenant.post("/v1/leads", {"full_name": "No source"}), 201)
    r = await dash(tenant)
    report = await ok(await tenant.get("/v1/reports/funnel", params=r["range"]))
    assert r["funnel"] == report
    assert r["funnel"]["stages"]["new"] == 2 and r["funnel"]["stages"]["contacted"] == 2


async def test_waiting_for_a_decision_lists_trials_expiring_packages_and_lapsing_rights(
    tenant: Tenant,
) -> None:
    await ok(await tenant.patch("/v1/settings", {"package_expiry_days": 3, "makeup_expiry_days": 2}))
    grp = await mk_group(tenant, monthly_fee="300000")
    old_trial = await mk_student(tenant, "Old Trial")
    await enroll(tenant, grp["id"], old_trial["id"], d(-10), status="trial")
    fresh_trial = await mk_student(tenant, "Fresh Trial")
    await enroll(tenant, grp["id"], fresh_trial["id"], d(0), status="trial")
    pgrp = await pkg_group(tenant)
    pst, pen = await student_in(tenant, pgrp)
    await sell(tenant, pen["id"], pay=CASH)
    ex = await mk_student(tenant, "Excused Student")
    await enroll(tenant, grp["id"], ex["id"], d(-100))
    les = await lesson(tenant, grp["id"], -1)
    await mark(tenant, les["id"], ex["id"], "excused")
    w = (await dash(tenant))["waiting"]
    assert [t["student_name"] for t in w["trials"]] == ["Old Trial"] and w["trials"][0]["reason"] == "days"
    assert [(p["student_id"], p["available"]) for p in w["packages"]] == [(pst["id"], 12)]
    assert w["packages"][0]["days_left"] in (2, 3)
    assert [r["student_name"] for r in w["rights"]] == ["Excused Student"]
    assert 0 <= w["rights"][0]["days_left"] <= 2
    assert w["total"] == 3
    narrow = (await dash(tenant, window_days=1))["waiting"]
    assert narrow["packages"] == [] and len(narrow["trials"]) == 1  # trials do not depend on the window
    # accepting the trial removes it from the list; nothing was accepted or billed by looking at the dashboard
    pending = (await ok(await tenant.get("/v1/trials/pending")))["items"]
    assert len(pending) == 1
    await ok(
        await tenant.post(
            f"/v1/enrollments/{pending[0]['enrollment_id']}/accept", {"mode": "free_until_next"}
        )
    )
    assert (await dash(tenant))["waiting"]["trials"] == []


async def test_lapsed_and_used_rights_and_a_credit_mode_do_not_wait(tenant: Tenant) -> None:
    await ok(await tenant.patch("/v1/settings", {"excused_mode": "credit"}))
    grp = await mk_group(tenant, monthly_fee="300000")
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], d(-100))
    les = await lesson(tenant, grp["id"], -1)
    await mark(tenant, les["id"], st["id"], "excused")
    assert (await dash(tenant))["waiting"]["rights"] == []  # a credit is not a make-up right


# ---- isolation, permissions, validation ------------------------------------------------------------------
async def test_tenant_b_never_sees_tenant_a_data(tenant: Tenant, tenant_b: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="200000")
    await student_with_fee_charge(tenant, grp, "Only A")
    await ok(await tenant.post("/v1/charges/generate", {"month": PREV_MONTH.isoformat(), "due_day": 5}))
    await ok(await tenant.post("/v1/expenses", {"category": "rent", "amount": "777", "spent_at": d(0)}), 201)
    await ok(await tenant.post("/v1/leads", {"full_name": "A lead"}), 201)
    assert (await dash(tenant))["payments"]["unpaid"] == 1
    r = await dash(tenant_b)
    assert r["payments"]["unpaid"] == 0 and r["payments"]["paid"] == 0
    assert r["finance"]["expenses"] == "0.00" and all(v == 0 for v in r["funnel"]["stages"].values())
    assert r["waiting"]["total"] == 0 and r["movement"]["new"] == 0


async def test_permissions(client: httpx.AsyncClient, tenant: Tenant) -> None:
    for role, expected in (("viewer", 200), ("manager", 200), ("accountant", 200), ("teacher", 403)):
        _, email = await _add_staff(tenant, role)
        who = await _login(client, email, "staff-password-123")
        assert (await who.get("/v1/dashboard")).status_code == expected, role
    assert (await client.get("/v1/dashboard")).status_code == 401


async def test_query_validation(tenant: Tenant) -> None:
    bad: list[dict[str, Any]] = [
        {"date_from": d(0), "date_to": d(-1)},
        {"date_from": d(-2000), "date_to": d(0)},
        {"window_days": 0},
        {"window_days": 61},
        {"list_limit": 0},
        {"list_limit": 1001},
        {"date_from": "2026-13-01"},
    ]
    for params in bad:
        assert (await tenant.get("/v1/dashboard", params=params)).status_code == 422, params
    ok_params = {"date_from": d(0), "date_to": d(0), "window_days": 60, "list_limit": 1000}
    assert (await tenant.get("/v1/dashboard", params=ok_params)).status_code == 200
    only_from = await dash(tenant, date_from=d(-5))
    assert only_from["range"]["date_from"] == d(-5)
