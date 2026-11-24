"""Lasting discounts (G1): per-student rules, the family discount, charge generation with discounts in the shared order
(scholarship, family, individual), the early-payment discount that is earned and lost again, the discount report, and the
fact that nothing ever adds a late-payment penalty. The arithmetic itself is the shared golden file (tests/golden/money.json);
these tests prove the plumbing: validation, permissions, tenant isolation, idempotency and the database."""

from __future__ import annotations

from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_guardian, mk_student, ok
from tests.test_tenancy_and_staff import _add_staff, _login

MONTH = "2026-01-01"
FROM = "2026-01-01"


async def rule(t: Tenant, student_id: str, kind: str, **kw: Any) -> dict[str, Any]:
    body = {"student_id": student_id, "kind": kind, "reason": "test reason", "valid_from": FROM, **kw}
    return await ok(await t.post("/v1/discounts", body), 201)


async def generate(t: Tenant, month: str = MONTH, **kw: Any) -> dict[str, Any]:
    return await ok(await t.post("/v1/charges/generate", {"month": month, "due_day": 10, **kw}))


async def charges(t: Tenant, student_id: str | None = None, month: str = MONTH) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"month": month}
    if student_id:
        params["student_id"] = student_id
    return (await ok(await t.get("/v1/charges", params=params)))["items"]


async def pay(t: Tenant, student_id: str, amount: str, paid_at: str, **kw: Any) -> dict[str, Any]:
    body = {"student_id": student_id, "amount": amount, "method": "cash", "paid_at": paid_at, **kw}
    return await ok(await t.post("/v1/payments", body), 201)


async def billed(
    t: Tenant, fee: str = "500000", **kw: Any
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    grp = await mk_group(t, monthly_fee=fee)
    st = await mk_student(t)
    en = await enroll(t, grp["id"], st["id"], "2026-01-01", **kw)
    return grp, st, en


# ---- rule validation ------------------------------------------------------------------------------------------------
async def test_rule_validation_rejects_every_malformed_rule(tenant: Tenant, tenant_b: Tenant) -> None:
    _, st, en = await billed(tenant)
    other = await mk_student(tenant)
    other_en = await enroll(tenant, (await billed(tenant))[0]["id"], other["id"], "2026-01-01")
    base = {"student_id": st["id"], "reason": "valid reason", "valid_from": FROM}
    bad: list[dict[str, Any]] = [
        {"kind": "individual", "percent": "10", "amount": "5000"},  # both
        {"kind": "individual"},  # neither
        {"kind": "scholarship", "amount": "5000"},  # a scholarship is a percent
        {"kind": "early_pay", "percent": "5"},  # needs the day
        {"kind": "early_pay", "amount": "5000", "pay_by_day": 5},  # early is a percent
        {"kind": "early_pay", "percent": "100", "pay_by_day": 5},  # never the whole price
        {"kind": "early_pay", "percent": "5", "pay_by_day": 29},  # day out of range
        {"kind": "early_pay", "percent": "5", "pay_by_day": 0},
        {"kind": "individual", "percent": "5", "pay_by_day": 5},  # pay-by is for early only
        {"kind": "individual", "percent": "0"},
        {"kind": "individual", "percent": "100.01"},
        {"kind": "individual", "amount": "0"},
        {"kind": "individual", "amount": "-5"},
        {"kind": "individual", "percent": "5", "reason": "x"},  # reason too short
        {"kind": "individual", "percent": "5", "valid_to": "2025-12-31"},  # ends before it starts
        {"kind": "gift", "percent": "5"},
        {"kind": "individual", "percent": "5", "surprise": 1},  # unknown field
        {
            "kind": "individual",
            "percent": "5",
            "enrollment_id": other_en["id"],
        },  # another student's enrollment
    ]
    for extra in bad:
        r = await tenant.post("/v1/discounts", {**base, **extra})
        assert r.status_code == 422, (extra, r.text)
    # a student of another center does not exist for this one
    assert (
        await tenant.post(
            "/v1/discounts",
            {**base, "student_id": (await mk_student(tenant_b))["id"], "kind": "individual", "percent": "5"},
        )
    ).status_code == 404
    assert (await tenant.get("/v1/discounts", params={"student_id": st["id"]})).json()["items"] == []
    _ = en


async def test_rules_list_end_and_never_extend(tenant: Tenant) -> None:
    _, st, _ = await billed(tenant)
    r1 = await rule(tenant, st["id"], "individual", percent="10")
    r2 = await rule(tenant, st["id"], "scholarship", percent="50", valid_to="2026-03-31")
    assert (r1["kind"], r1["percent"], r1["amount"], r1["valid_to"]) == ("individual", "10.00", None, None)
    listed = await ok(await tenant.get("/v1/discounts", params={"student_id": st["id"]}))
    assert {x["id"] for x in listed["items"]} == {r1["id"], r2["id"]}
    only = await ok(await tenant.get("/v1/discounts", params={"kind": "scholarship"}))
    assert [x["id"] for x in only["items"]] == [r2["id"]]
    assert r2["active"] is False  # ended in March 2026, today is later
    ended = await ok(
        await tenant.patch(
            f"/v1/discounts/{r1['id']}", {"valid_to": "2026-02-28", "reason": "ended by owner"}
        )
    )
    assert (ended["valid_to"], ended["reason"]) == ("2026-02-28", "ended by owner")
    assert (
        await tenant.patch(f"/v1/discounts/{r1['id']}", {"valid_to": "2026-06-30"})
    ).status_code == 409  # not extended
    assert (
        await tenant.patch(f"/v1/discounts/{r1['id']}", {"valid_to": "2025-01-01"})
    ).status_code == 422  # before it started
    assert (
        await tenant.patch(f"/v1/discounts/{r1['id']}", {"percent": "90"})
    ).status_code == 422  # amounts are never edited
    active = await ok(await tenant.get("/v1/discounts", params={"active_only": True, "student_id": st["id"]}))
    assert active["items"] == []


async def test_permissions_and_tenant_isolation(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    _, st, _ = await billed(tenant)
    r = await rule(tenant, st["id"], "individual", percent="10")
    viewer_data, v_email = await _add_staff(tenant, "viewer")
    viewer = await _login(client, v_email, "staff-password-123")
    assert viewer_data["role"] == "viewer"
    assert (await viewer.get("/v1/discounts")).status_code == 403
    assert (
        await viewer.post(
            "/v1/discounts",
            {"student_id": st["id"], "kind": "individual", "percent": "5", "reason": "no right"},
        )
    ).status_code == 403
    assert (
        await viewer.get("/v1/reports/discounts", params={"month": MONTH})
    ).status_code == 200  # reports:read
    _, a_email = await _add_staff(tenant, "accountant")
    acc = await _login(client, a_email, "staff-password-123")
    assert (await acc.get("/v1/discounts")).status_code == 200
    assert (await tenant_b.get("/v1/discounts")).json()["items"] == []
    assert (await tenant_b.patch(f"/v1/discounts/{r['id']}", {"valid_to": "2026-02-01"})).status_code == 404
    assert (await tenant_b.get("/v1/reports/discounts", params={"month": MONTH})).json()["total"] == "0.00"


# ---- generation ------------------------------------------------------------------------------------------------------
async def test_individual_percent_and_amount_apply_on_top_of_the_enrollment_discount(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="500000")
    a, b = await mk_student(tenant), await mk_student(tenant)
    await enroll(tenant, grp["id"], a["id"], "2026-01-01", discount_percent="20")  # 400000 base
    await enroll(tenant, grp["id"], b["id"], "2026-01-01")
    await rule(tenant, a["id"], "individual", percent="10")  # 10 percent of the 400000 base
    await rule(tenant, b["id"], "individual", amount="80000")
    res = await generate(tenant)
    assert (res["created"], res["discounted"], res["skipped_free"]) == (2, 2, 0)
    ca = (await charges(tenant, a["id"]))[0]
    cb = (await charges(tenant, b["id"]))[0]
    assert (ca["amount"], ca["gross_amount"]) == ("360000.00", "400000.00")
    assert (cb["amount"], cb["gross_amount"]) == ("420000.00", "500000.00")
    rep = await ok(await tenant.get("/v1/reports/discounts", params={"month": MONTH}))
    assert [(r["kind"], r["lines"], r["students"], r["amount"]) for r in rep["rows"]] == [
        ("individual", 2, 2, "120000.00")
    ]
    assert (rep["total"], rep["scholarship_total"], rep["other_total"]) == ("120000.00", "0.00", "120000.00")


async def test_the_three_lasting_discounts_stack_in_the_shared_order(tenant: Tenant) -> None:
    await ok(
        await tenant.patch(
            "/v1/settings", {"family_discount_2nd_percent": "10", "family_discount_3rd_percent": "20"}
        )
    )
    grp = await mk_group(tenant, monthly_fee="500000")
    mother = await mk_guardian(tenant)
    first, second = await mk_student(tenant), await mk_student(tenant)
    for s in (first, second):
        await ok(
            await tenant.post(
                f"/v1/students/{s['id']}/guardians", {"guardian_id": mother["id"], "relation": "mother"}
            ),
            201,
        )
        await enroll(tenant, grp["id"], s["id"], "2026-01-01")
    # the second child: scholarship 50 + family 10 + individual 5 percent, all of the 500000 base (golden case)
    await rule(tenant, second["id"], "scholarship", percent="50", reason="olympiad winner")
    await rule(tenant, second["id"], "individual", percent="5", reason="staff relative")
    res = await generate(tenant)
    assert (res["created"], res["discounted"]) == (2, 1)
    assert (await charges(tenant, first["id"]))[0]["amount"] == "500000.00"  # the first child pays in full
    assert (await charges(tenant, second["id"]))[0]["amount"] == "175000.00"
    rep = await ok(await tenant.get("/v1/reports/discounts", params={"month": MONTH}))
    assert {r["kind"]: r["amount"] for r in rep["rows"]} == {
        "family": "50000.00",
        "individual": "25000.00",
        "scholarship": "250000.00",
    }
    assert (rep["scholarship_total"], rep["other_total"], rep["total"]) == (
        "250000.00",
        "75000.00",
        "325000.00",
    )


async def test_family_discount_follows_registration_order_and_shared_guardians(tenant: Tenant) -> None:
    await ok(
        await tenant.patch(
            "/v1/settings", {"family_discount_2nd_percent": "10", "family_discount_3rd_percent": "20"}
        )
    )
    grp = await mk_group(tenant, monthly_fee="100000")
    mother, aunt = await mk_guardian(tenant), await mk_guardian(tenant)
    kids = [await mk_student(tenant) for _ in range(4)]
    stranger = await mk_student(tenant)
    links = [
        (0, mother),
        (1, mother),
        (2, aunt),
        (3, aunt),
        (2, mother),
    ]  # the aunt joins the mother's family through kid 2
    for i, g in links:
        await ok(
            await tenant.post(
                f"/v1/students/{kids[i]['id']}/guardians", {"guardian_id": g["id"], "relation": "other"}
            ),
            201,
        )
    for s in (*kids, stranger):
        await enroll(tenant, grp["id"], s["id"], "2026-01-01")
    await generate(tenant)
    got = [(await charges(tenant, k["id"]))[0]["amount"] for k in kids]
    assert got == [
        "100000.00",
        "90000.00",
        "80000.00",
        "80000.00",
    ]  # 1st, 2nd, then 3rd and later at 20 percent
    assert (await charges(tenant, stranger["id"]))[0]["amount"] == "100000.00"
    # switched off by default: another center gets nothing
    s = await ok(await tenant.get("/v1/settings"))
    assert (s["family_discount_2nd_percent"], s["family_discount_3rd_percent"]) == ("10.00", "20.00")


async def test_family_percent_settings_are_validated(tenant: Tenant) -> None:
    for bad in (
        {"family_discount_2nd_percent": "101"},
        {"family_discount_3rd_percent": "-1"},
        {"family_discount_2nd_percent": "abc"},
    ):
        assert (await tenant.patch("/v1/settings", bad)).status_code == 422
    s = await ok(await tenant.get("/v1/settings"))
    assert (s["family_discount_2nd_percent"], s["family_discount_3rd_percent"]) == ("0.00", "0.00")


async def test_full_scholarship_makes_a_free_month_without_a_charge_and_stays_in_the_report(
    tenant: Tenant,
) -> None:
    _, st, _ = await billed(tenant)
    await rule(tenant, st["id"], "scholarship", percent="100", reason="need-based, full")
    res = await generate(tenant)
    assert (res["created"], res["skipped_free"], res["discounted"]) == (0, 1, 0)
    assert await charges(tenant, st["id"]) == []
    again = await generate(tenant)  # idempotent: no second line
    assert again["skipped_free"] == 1
    rep = await ok(await tenant.get("/v1/reports/discounts", params={"month": MONTH}))
    assert [(r["kind"], r["lines"], r["amount"]) for r in rep["rows"]] == [("scholarship", 1, "500000.00")]
    assert rep["scholarship_total"] == "500000.00" and rep["other_total"] == "0.00"


async def test_generation_is_idempotent_and_a_later_rule_does_not_rewrite_a_billed_month(
    tenant: Tenant,
) -> None:
    _, st, _ = await billed(tenant)
    r = await rule(tenant, st["id"], "individual", percent="10")
    assert (await generate(tenant))["created"] == 1
    again = await generate(tenant)
    assert (again["created"], again["skipped_existing"], again["discounted"]) == (0, 1, 0)
    await rule(tenant, st["id"], "scholarship", percent="50")
    assert (await generate(tenant))["created"] == 0
    assert (await charges(tenant, st["id"]))[0]["amount"] == "450000.00"
    rep = await ok(await tenant.get("/v1/reports/discounts", params={"month": MONTH}))
    assert rep["total"] == "50000.00"  # no line was added for the second rule
    # a voided charge leaves the report
    c = (await charges(tenant, st["id"]))[0]
    await ok(await tenant.post(f"/v1/charges/{c['id']}/void", {"reason": "billed by mistake"}))
    assert (await ok(await tenant.get("/v1/reports/discounts", params={"month": MONTH})))["total"] == "0.00"
    _ = r


async def test_rules_apply_only_inside_their_validity_and_enrollment_scope(tenant: Tenant) -> None:
    grp1 = await mk_group(tenant, monthly_fee="200000")
    grp2 = await mk_group(tenant, monthly_fee="300000")
    st = await mk_student(tenant)
    e1 = await enroll(tenant, grp1["id"], st["id"], "2026-01-01")
    await enroll(tenant, grp2["id"], st["id"], "2026-01-01")
    await rule(tenant, st["id"], "individual", percent="50", enrollment_id=e1["id"])  # only the first group
    await rule(
        tenant, st["id"], "individual", percent="99", valid_from="2026-02-01"
    )  # not yet valid in January
    await rule(
        tenant, st["id"], "individual", percent="99", valid_from="2025-01-01", valid_to="2025-12-31"
    )  # already over
    await generate(tenant)
    amounts = sorted(c["amount"] for c in await charges(tenant, st["id"]))
    assert amounts == ["100000.00", "300000.00"]
    feb = await generate(tenant, "2026-02-01")  # the 99 percent rule is valid from February
    # group 1: 50 percent then 99 percent are capped at the fee (free month); group 2: 1 percent of 300000 is left
    assert (feb["created"], feb["skipped_free"]) == (1, 1)
    assert [c["amount"] for c in await charges(tenant, st["id"], "2026-02-01")] == ["3000.00"]


async def test_the_discount_never_exceeds_the_fee(tenant: Tenant) -> None:
    _, st, _ = await billed(tenant, fee="100000")
    await rule(tenant, st["id"], "individual", amount="250000")
    res = await generate(tenant)
    assert (res["created"], res["skipped_free"]) == (0, 1)  # capped at the fee: a free month, no charge


# ---- early payment -------------------------------------------------------------------------------------------------------
async def early_setup(
    t: Tenant, fee: str = "500000", percent: str = "5", day: int = 5
) -> tuple[dict[str, Any], dict[str, Any]]:
    _, st, _ = await billed(t, fee=fee)
    await rule(t, st["id"], "early_pay", percent=percent, pay_by_day=day, reason="pays early")
    await generate(t)
    c = (await charges(t, st["id"]))[0]
    return st, c


async def test_early_offer_is_stored_on_the_charge_and_earned_by_paying_on_time(tenant: Tenant) -> None:
    st, c = await early_setup(tenant)
    assert (c["amount"], c["early_discount"], c["early_pay_by"], c["early_granted"]) == (
        "500000.00",
        "25000.00",
        "2026-01-05",
        False,
    )
    p = await pay(tenant, st["id"], "475000", "2026-01-05T09:00:00+05:00")
    assert p["allocated"] == "475000.00" and p["unallocated"] == "0.00"
    c = await ok(await tenant.get(f"/v1/charges/{c['id']}"))
    assert (c["amount"], c["outstanding"], c["early_granted"]) == ("475000.00", "0.00", True)
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert (bal["outstanding_total"], bal["credit"]) == ("0.00", "0.00")
    rep = await ok(await tenant.get("/v1/reports/discounts", params={"month": MONTH}))
    assert [(r["kind"], r["amount"]) for r in rep["rows"]] == [("early_pay", "25000.00")]


async def test_paying_after_the_deadline_earns_nothing(tenant: Tenant) -> None:
    st, c = await early_setup(tenant)
    await pay(tenant, st["id"], "475000", "2026-01-06T09:00:00+05:00")
    c = await ok(await tenant.get(f"/v1/charges/{c['id']}"))
    assert (c["amount"], c["outstanding"], c["early_granted"]) == ("500000.00", "25000.00", False)
    assert (await ok(await tenant.get("/v1/reports/discounts", params={"month": MONTH})))["rows"] == []


async def test_part_on_time_and_the_rest_late_earns_nothing_but_two_on_time_payments_add_up(
    tenant: Tenant,
) -> None:
    st, c = await early_setup(tenant)
    await pay(tenant, st["id"], "200000", "2026-01-02T09:00:00+05:00")
    await pay(tenant, st["id"], "275000", "2026-01-09T09:00:00+05:00")  # the rest after the deadline
    assert (await ok(await tenant.get(f"/v1/charges/{c['id']}")))["early_granted"] is False
    st2, c2 = await early_setup(tenant)
    await pay(tenant, st2["id"], "400000", "2026-01-01T09:00:00+05:00")
    assert (await ok(await tenant.get(f"/v1/charges/{c2['id']}")))["early_granted"] is False
    await pay(tenant, st2["id"], "75000", "2026-01-05T23:00:00+05:00")  # the last day
    c2 = await ok(await tenant.get(f"/v1/charges/{c2['id']}"))
    assert (c2["early_granted"], c2["amount"], c2["outstanding"]) == (True, "475000.00", "0.00")


async def test_paying_the_full_price_on_time_gives_the_surplus_back_as_credit(tenant: Tenant) -> None:
    st, c = await early_setup(tenant)
    p = await pay(tenant, st["id"], "500000", "2026-01-03T09:00:00+05:00")
    assert (p["allocated"], p["unallocated"]) == ("475000.00", "25000.00")
    c = await ok(await tenant.get(f"/v1/charges/{c['id']}"))
    assert (c["amount"], c["outstanding"]) == ("475000.00", "0.00")
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert bal["credit"] == "25000.00"


async def test_voiding_the_payment_that_earned_the_discount_takes_it_back(tenant: Tenant) -> None:
    st, c = await early_setup(tenant)
    p = await pay(tenant, st["id"], "475000", "2026-01-04T09:00:00+05:00")
    assert (await ok(await tenant.get(f"/v1/charges/{c['id']}")))["early_granted"] is True
    await ok(await tenant.post(f"/v1/payments/{p['id']}/void", {"reason": "entered twice"}))
    c = await ok(await tenant.get(f"/v1/charges/{c['id']}"))
    assert (c["amount"], c["outstanding"], c["early_granted"]) == ("500000.00", "500000.00", False)
    assert (await ok(await tenant.get("/v1/reports/discounts", params={"month": MONTH})))["rows"] == []
    # paying again on time earns it again (the discount line is not duplicated)
    await pay(tenant, st["id"], "475000", "2026-01-05T09:00:00+05:00")
    assert (await ok(await tenant.get(f"/v1/charges/{c['id']}")))["early_granted"] is True
    rep = await ok(await tenant.get("/v1/reports/discounts", params={"month": MONTH}))
    assert [(r["kind"], r["lines"], r["amount"]) for r in rep["rows"]] == [("early_pay", 1, "25000.00")]


async def test_removing_the_allocation_takes_the_early_discount_back_too(tenant: Tenant) -> None:
    st, c = await early_setup(tenant)
    p = await pay(tenant, st["id"], "475000", "2026-01-04T09:00:00+05:00")
    await ok(await tenant.delete(f"/v1/payments/{p['id']}/allocations/{c['id']}"))
    c = await ok(await tenant.get(f"/v1/charges/{c['id']}"))
    assert (c["amount"], c["early_granted"]) == ("500000.00", False)


async def test_a_charge_with_a_payment_plan_never_gets_the_early_discount(tenant: Tenant) -> None:
    st, c = await early_setup(tenant)
    await ok(
        await tenant.put(
            f"/v1/charges/{c['id']}/plan",
            {
                "installments": [
                    {"due_date": "2026-01-10", "amount": "250000"},
                    {"due_date": "2026-02-10", "amount": "250000"},
                ]
            },
        )
    )
    await pay(tenant, st["id"], "475000", "2026-01-04T09:00:00+05:00")
    c = await ok(await tenant.get(f"/v1/charges/{c['id']}"))
    assert (c["early_granted"], c["amount"], c["outstanding"]) == (False, "500000.00", "25000.00")


async def test_the_best_early_offer_wins_when_there_are_several(tenant: Tenant) -> None:
    _, st, _ = await billed(tenant)
    await rule(tenant, st["id"], "early_pay", percent="3", pay_by_day=10)
    await rule(tenant, st["id"], "early_pay", percent="6", pay_by_day=4)
    await generate(tenant)
    c = (await charges(tenant, st["id"]))[0]
    assert (c["early_discount"], c["early_pay_by"]) == ("30000.00", "2026-01-04")


# ---- no late-payment penalty ---------------------------------------------------------------------------------------------
async def test_overdue_money_never_grows_and_there_is_no_penalty_kind(tenant: Tenant) -> None:
    _, st, _ = await billed(tenant, fee="300000")
    await generate(tenant)
    for m in ("2026-02-01", "2026-03-01", "2026-04-01"):
        await generate(tenant, m)
    items = (await ok(await tenant.get("/v1/charges", params={"student_id": st["id"], "state": "all"})))[
        "items"
    ]
    assert sorted((c["period_month"], c["amount"], c["kind"]) for c in items) == [
        ("2026-01-01", "300000.00", "tuition"),
        ("2026-02-01", "300000.00", "tuition"),
        ("2026-03-01", "300000.00", "tuition"),
        ("2026-04-01", "300000.00", "tuition"),
    ]
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert (bal["outstanding_total"], bal["overdue_total"]) == (
        "1200000.00",
        "1200000.00",
    )  # the overdue part is exactly the debt
    for kind in ("penalty", "late_fee", "fine"):
        r = await tenant.post(
            "/v1/charges",
            {
                "student_id": st["id"],
                "kind": kind,
                "period_month": MONTH,
                "amount": "1000",
                "due_date": "2026-01-10",
            },
        )
        assert r.status_code == 422
