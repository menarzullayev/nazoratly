"""Demo mode: flagged sample data, journal untouched, clear refuses while a real record references a demo row."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import mk_group, mk_student, ok


async def enable(t: Tenant) -> dict[str, Any]:
    return await ok(await t.post("/v1/demo/enable", {}), 201)


async def demo_student(t: Tenant, name: str = "Aziz Rahimov") -> dict[str, Any]:
    items = (await ok(await t.get("/v1/students", params={"limit": 200})))["items"]
    return next(s for s in items if s["full_name"] == name)


async def test_enable_writes_a_flagged_sample_center_and_switches_the_mode_on(tenant: Tenant) -> None:
    assert (await ok(await tenant.get("/v1/demo"))) == {"demo_mode": False, "counts": {}}
    made = await enable(tenant)
    assert made["demo_mode"] is True
    c = made["counts"]
    assert c["students"] == 11 and c["teachers"] == 2 and c["courses"] == 2 and c["study_groups"] == 2
    assert c["enrollments"] == 8 and c["leads"] == 4 and c["waitlist_entries"] == 3
    assert (
        c["charges"] == 24
        and c["payments"] > 10
        and c["attendance"] > 20
        and c["lessons"] > 8
        and c["expenses"] >= 4
    )
    assert await ok(await tenant.get("/v1/demo")) == made
    assert (await ok(await tenant.get("/v1/settings")))["demo_mode"] is True
    again = await tenant.post("/v1/demo/enable", {})
    assert again.status_code == 409


async def test_the_sample_data_is_coherent_with_the_product_rules(tenant: Tenant) -> None:
    await enable(tenant)
    groups = (await ok(await tenant.get("/v1/groups")))["items"]
    ielts = next(g for g in groups if g["name"].startswith("IELTS"))
    math = next(g for g in groups if g["name"].startswith("Matematika"))
    assert (ielts["capacity"], ielts["active_students"], math["capacity"], math["active_students"]) == (
        4,
        4,
        5,
        4,
    )
    offers = await ok(await tenant.get("/v1/waitlist/offers"))
    assert [(o["student_name"], o["group_name"]) for o in offers] == [
        ("Feruza Olimova", math["name"])
    ]  # the free seat
    late = await mk_student(tenant, "Real Latecomer")
    r = await tenant.post(
        f"/v1/groups/{ielts['id']}/enrollments", {"student_id": late["id"], "started_on": "2026-02-01"}
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "group_full"
    dash = await ok(await tenant.get("/v1/dashboard"))
    assert dash["waiting"]["seats"] and dash["finance"]["income"] != "0.00"
    assert dash["payments"]["unpaid"] >= 2  # two families are behind


async def test_demo_money_never_enters_the_journal(tenant: Tenant) -> None:
    await enable(tenant)
    assert (
        await ok(await tenant.get("/v1/accounting/pending")) == []
    )  # every demo payment and expense is left out
    sync = await ok(await tenant.post("/v1/accounting/sync", {}))
    assert sync["posted"] == 0 and sync["reversed"] == 0
    entries = await ok(await tenant.get("/v1/accounting/entries", params={"limit": 200}))
    assert (entries["items"] if isinstance(entries, dict) else entries) == []  # the books are empty
    s = await demo_student(tenant)
    body = {"student_id": s["id"], "amount": "1000", "method": "cash", "auto_allocate": False}
    await ok(await tenant.post("/v1/payments", body), 201)
    entries = await ok(await tenant.get("/v1/accounting/entries", params={"limit": 200}))
    rows = entries["items"] if isinstance(entries, dict) else entries
    assert len(rows) == 1  # a REAL payment is posted as always
    assert (await ok(await tenant.get("/v1/accounting/verify")))["ok"] is True


async def test_clear_deletes_only_the_demo_rows_and_switches_off(tenant: Tenant) -> None:
    real = await mk_student(tenant, "Real Student")
    real_group = await mk_group(tenant, capacity=3, monthly_fee="123000")
    await enable(tenant)
    cleared = await ok(await tenant.post("/v1/demo/disable", {}))
    assert cleared["demo_mode"] is False
    assert (
        cleared["deleted"]["students"] == 11
        and cleared["deleted"]["payments"] > 10
        and cleared["deleted"]["study_groups"] == 2
    )
    assert await ok(await tenant.get("/v1/demo")) == {"demo_mode": False, "counts": {}}
    students = (await ok(await tenant.get("/v1/students", params={"limit": 200})))["items"]
    assert [s["full_name"] for s in students] == ["Real Student"]
    assert (await ok(await tenant.get(f"/v1/groups/{real_group['id']}")))["capacity"] == 3
    assert (await ok(await tenant.get(f"/v1/students/{real['id']}")))["full_name"] == "Real Student"
    assert len((await ok(await tenant.get("/v1/groups")))["items"]) == 1
    # nothing left to clear: a second disable is a no-op, and demo mode can be started over
    assert (await ok(await tenant.post("/v1/demo/disable", {})))["deleted"] == {}
    assert (await enable(tenant))["counts"]["students"] == 11


async def test_clear_keeps_the_mode_on_when_asked_only_to_clear(tenant: Tenant) -> None:
    await enable(tenant)
    out = await ok(await tenant.post("/v1/demo/clear", {}))
    assert out["demo_mode"] is True and out["deleted"]["students"] == 11


async def test_clear_is_refused_while_a_real_payment_references_a_demo_student(tenant: Tenant) -> None:
    await enable(tenant)
    s = await demo_student(tenant)
    body = {"student_id": s["id"], "amount": "5000", "method": "cash", "auto_allocate": False}
    await ok(await tenant.post("/v1/payments", body), 201)
    r = await tenant.post("/v1/demo/disable", {})
    assert r.status_code == 409 and r.json()["error"]["code"] == "demo_referenced"
    blockers = r.json()["error"]["details"]["blockers"]
    assert blockers and blockers[0]["table"] in ("payments", "payment_allocations")
    after = await ok(await tenant.get("/v1/demo"))
    assert (
        after["demo_mode"] is True and after["counts"]["students"] == 11
    )  # nothing was deleted, the mode stays
    assert (await tenant.post("/v1/demo/clear", {})).status_code == 409


async def test_clear_is_refused_when_a_person_marked_attendance_on_a_demo_lesson(tenant: Tenant) -> None:
    await enable(tenant)
    today = date.today()
    params = {
        "date_from": today.isoformat(),
        "date_to": (today + timedelta(days=8)).isoformat(),
        "status": "planned",
        "limit": 200,
    }
    lesson = (await ok(await tenant.get("/v1/lessons", params=params)))["items"][0]
    roster = (await ok(await tenant.get(f"/v1/lessons/{lesson['id']}/attendance")))["entries"]
    mark = {"records": [{"student_id": roster[0]["student_id"], "status": "present"}]}
    await ok(await tenant.put(f"/v1/lessons/{lesson['id']}/attendance", mark))
    r = await tenant.post("/v1/demo/disable", {})
    assert r.status_code == 409 and r.json()["error"]["code"] == "demo_referenced"
    assert "attendance" in {b["table"] for b in r.json()["error"]["details"]["blockers"]}


async def test_clear_is_refused_when_a_real_student_joined_a_demo_group(tenant: Tenant) -> None:
    await enable(tenant)
    groups = (await ok(await tenant.get("/v1/groups")))["items"]
    math = next(g for g in groups if g["name"].startswith("Matematika"))
    real = await mk_student(tenant, "Real Joiner")
    body = {"student_id": real["id"], "started_on": "2026-02-01", "ignore_waitlist": True}
    await ok(await tenant.post(f"/v1/groups/{math['id']}/enrollments", body), 201)
    r = await tenant.post("/v1/demo/disable", {})
    assert r.status_code == 409
    assert r.json()["error"]["details"]["blockers"][0]["table"] == "enrollments"


async def test_demo_is_tenant_isolated_and_permissioned(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    await enable(tenant)
    assert await ok(await tenant_b.get("/v1/demo")) == {"demo_mode": False, "counts": {}}
    assert (await ok(await tenant_b.get("/v1/students")))["items"] == []
    await mk_student(tenant_b, "B Real")
    await enable(tenant_b)
    await ok(await tenant.post("/v1/demo/disable", {}))  # A's clear does not touch B's demo data
    assert (await ok(await tenant_b.get("/v1/demo")))["counts"][
        "students"
    ] == 11  # only flagged rows are counted
    names = [
        s["full_name"] for s in (await ok(await tenant_b.get("/v1/students", params={"limit": 200})))["items"]
    ]
    assert "B Real" in names and "Aziz Rahimov" in names
    for role in ("manager", "viewer", "teacher"):
        email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
        staff = {"full_name": role, "email": email, "role": role, "initial_password": "staff-password-123"}
        await ok(await tenant.post("/v1/staff", staff), 201)
        data = await ok(
            await client.post("/v1/auth/login", json={"identifier": email, "password": "staff-password-123"})
        )
        who = Tenant(client, data, email, "staff-password-123")
        assert (await who.get("/v1/demo")).status_code == 200, role
        assert (await who.post("/v1/demo/enable", {})).status_code == 403, role
        assert (await who.post("/v1/demo/disable", {})).status_code == 403, role
        assert (await who.post("/v1/demo/clear", {})).status_code == 403, role
