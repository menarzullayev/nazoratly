"""Lead funnel: sources, leads, interactions, atomic conversion to a trial, and the funnel report."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from tests.conftest import Tenant
from tests.helpers import mk_group, mk_student, ok, org_today


async def source(t: Tenant, name: str = "Instagram") -> dict[str, Any]:
    return await ok(await t.post("/v1/lead-sources", {"name": name}), 201)


async def lead(t: Tenant, name: str = "Madina", **kw: Any) -> dict[str, Any]:
    return await ok(await t.post("/v1/leads", {"full_name": name, **kw}), 201)


def phone() -> str:
    return f"+99891{uuid.uuid4().int % 10_000_000:07d}"


# ---- sources and leads -----------------------------------------------------------------------------------
async def test_sources_are_unique_ignoring_case(tenant: Tenant, tenant_b: Tenant) -> None:
    await source(tenant, "Instagram")
    assert (await tenant.post("/v1/lead-sources", {"name": "instagram"})).status_code == 409
    await source(tenant_b, "Instagram")  # another center may use the same name
    names = [s["name"] for s in await ok(await tenant.get("/v1/lead-sources"))]
    assert names == ["Instagram"]


async def test_create_list_filter_and_patch_leads(tenant: Tenant) -> None:
    src = await source(tenant)
    a = await lead(tenant, "Ali", source_id=src["id"], phone=phone(), next_follow_up_on="2026-11-10")
    b = await lead(tenant, "Vali", next_follow_up_on="2026-12-10")
    assert a["stage"] == "new" and a["source"] == "Instagram"
    assert {x["id"] for x in (await ok(await tenant.get("/v1/leads")))["items"]} == {a["id"], b["id"]}
    by_stage = (await ok(await tenant.get("/v1/leads", params={"stage": "new"})))["items"]
    assert len(by_stage) == 2
    due = (await ok(await tenant.get("/v1/leads", params={"follow_up_before": "2026-11-30"})))["items"]
    assert [x["id"] for x in due] == [a["id"]]
    by_src = (await ok(await tenant.get("/v1/leads", params={"source_id": src["id"]})))["items"]
    assert [x["id"] for x in by_src] == [a["id"]]
    p = await ok(await tenant.patch(f"/v1/leads/{a['id']}", {"stage": "contacted", "note": "called"}))
    assert p["stage"] == "contacted" and p["note"] == "called"
    assert (
        await tenant.patch(f"/v1/leads/{a['id']}", {"stage": "enrolled"})
    ).status_code == 422  # only conversion enrolls
    assert (await tenant.patch(f"/v1/leads/{a['id']}", {"stage": "bogus"})).status_code == 422
    assert (await tenant.post("/v1/leads", {"full_name": "  "})).status_code == 422
    assert (await tenant.post("/v1/leads", {"full_name": "X", "phone": "123"})).status_code == 422


async def test_interactions_form_a_timeline_and_move_the_follow_up(tenant: Tenant) -> None:
    ld = await lead(tenant, "Ali", next_follow_up_on="2026-11-10")
    await ok(
        await tenant.post(
            f"/v1/leads/{ld['id']}/interactions",
            {
                "happened_on": "2026-11-05",
                "kind": "call",
                "summary": "Called the parent",
                "next_follow_up_on": "2026-11-20",
            },
        ),
        201,
    )
    await ok(
        await tenant.post(
            f"/v1/leads/{ld['id']}/interactions",
            {"happened_on": "2026-11-12", "kind": "message", "summary": "Sent prices"},
        ),
        201,
    )
    detail = await ok(await tenant.get(f"/v1/leads/{ld['id']}"))
    assert [i["summary"] for i in detail["interactions"]] == [
        "Sent prices",
        "Called the parent",
    ]  # newest first
    assert detail["next_follow_up_on"] == "2026-11-20"
    bad = await tenant.post(
        f"/v1/leads/{ld['id']}/interactions", {"happened_on": "2026-11-05", "kind": "fax", "summary": "x"}
    )
    assert bad.status_code == 422


# ---- conversion ------------------------------------------------------------------------------------------
async def test_enroll_trial_is_atomic_and_idempotent(tenant: Tenant) -> None:
    grp = await mk_group(tenant)
    ph = phone()
    ld = await lead(tenant, "Madina Karimova", phone=ph)
    first = await ok(
        await tenant.post(
            f"/v1/leads/{ld['id']}/enroll-trial", {"group_id": grp["id"], "started_on": "2026-11-09"}
        )
    )
    assert first["lead"]["stage"] == "trial_scheduled" and first["lead"]["student_id"] == first["student_id"]
    assert (
        first["enrollment"]["status"] == "trial" and first["enrollment"]["student_id"] == first["student_id"]
    )
    again = await ok(await tenant.post(f"/v1/leads/{ld['id']}/enroll-trial", {"group_id": grp["id"]}))
    assert (
        again["student_id"] == first["student_id"] and again["enrollment"]["id"] == first["enrollment"]["id"]
    )
    students = (await ok(await tenant.get("/v1/students", params={"q": "Madina Karimova"})))["items"]
    assert len(students) == 1
    members = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/enrollments", params={"status": "trial"})))[
        "items"
    ]
    assert len(members) == 1


async def test_duplicate_phone_is_flagged_unless_linked(tenant: Tenant) -> None:
    grp = await mk_group(tenant)
    ph = phone()
    existing = await mk_student(tenant, "Existing Student", phone=ph)
    ld = await lead(tenant, "New Lead", phone=ph)
    r = await tenant.post(f"/v1/leads/{ld['id']}/enroll-trial", {"group_id": grp["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_student"
    assert r.json()["error"]["details"]["student_id"] == existing["id"]
    linked = await ok(
        await tenant.post(
            f"/v1/leads/{ld['id']}/enroll-trial", {"group_id": grp["id"], "link_existing": True}
        )
    )
    assert linked["student_id"] == existing["id"]
    assert len((await ok(await tenant.get("/v1/students", params={"q": "Student"})))["items"]) == 1


async def test_enroll_trial_into_a_full_group_changes_nothing(tenant: Tenant) -> None:
    grp = await mk_group(tenant, capacity=1)
    taken = await mk_student(tenant)
    await ok(
        await tenant.post(
            f"/v1/groups/{grp['id']}/enrollments", {"student_id": taken["id"], "started_on": "2026-11-09"}
        ),
        201,
    )
    ld = await lead(tenant, "Late Lead", phone=phone())
    r = await tenant.post(f"/v1/leads/{ld['id']}/enroll-trial", {"group_id": grp["id"]})
    assert r.status_code == 409
    after = await ok(await tenant.get(f"/v1/leads/{ld['id']}"))
    assert after["stage"] == "new" and after["student_id"] is None
    assert (await ok(await tenant.get("/v1/students", params={"q": "Late Lead"})))[
        "items"
    ] == []  # rolled back


async def test_other_centers_leads_are_invisible(tenant: Tenant, tenant_b: Tenant) -> None:
    ld = await lead(tenant, "Secret Lead")
    grp_b = await mk_group(tenant_b)
    assert (await tenant_b.get(f"/v1/leads/{ld['id']}")).status_code == 404
    assert (await tenant_b.patch(f"/v1/leads/{ld['id']}", {"note": "x"})).status_code == 404
    assert (
        await tenant_b.post(f"/v1/leads/{ld['id']}/enroll-trial", {"group_id": grp_b["id"]})
    ).status_code == 404
    assert (
        await tenant_b.post(
            f"/v1/leads/{ld['id']}/interactions",
            {"happened_on": "2026-11-05", "kind": "note", "summary": "x"},
        )
    ).status_code == 404
    assert (await ok(await tenant_b.get("/v1/leads")))["items"] == []
    src_a = await source(tenant, "OnlyA")
    assert (await tenant_b.post("/v1/leads", {"full_name": "X", "source_id": src_a["id"]})).status_code == 404


# ---- funnel report ---------------------------------------------------------------------------------------
async def test_funnel_report_matches_a_hand_built_dataset(tenant: Tenant) -> None:
    ig, friend = await source(tenant, "Instagram"), await source(tenant, "Tanish")
    grp = await mk_group(tenant)
    await lead(tenant, "A1", source_id=ig["id"])
    await ok(
        await tenant.patch(
            f"/v1/leads/{(await lead(tenant, 'A2', source_id=ig['id']))['id']}", {"stage": "contacted"}
        )
    )
    conv = await lead(tenant, "A3", source_id=ig["id"], phone=phone())
    await ok(await tenant.post(f"/v1/leads/{conv['id']}/enroll-trial", {"group_id": grp["id"]}))
    await lead(tenant, "B1", source_id=friend["id"])
    await lead(tenant, "C1")
    around = {
        "date_from": (org_today() - timedelta(days=1)).isoformat(),
        "date_to": (org_today() + timedelta(days=1)).isoformat(),
    }
    rep = await ok(await tenant.get("/v1/reports/funnel", params=around))
    assert rep["stages"] == {
        "new": 3,
        "contacted": 1,
        "trial_scheduled": 1,
        "trial_attended": 0,
        "enrolled": 0,
        "lost": 0,
    }
    assert rep["by_source"][0] == {"source": "Instagram", "leads": 3, "enrolled": 0, "conversion": 0.0}
    assert rep["by_source"][-1]["source"] is None
    assert rep["trial_to_enrolled"] == 0.0
    empty = await ok(
        await tenant.get("/v1/reports/funnel", params={"date_from": "2000-01-01", "date_to": "2000-01-02"})
    )
    assert empty["by_source"] == [] and empty["trial_to_enrolled"] == 0.0
    assert (
        await tenant.get("/v1/reports/funnel", params={"date_from": "2026-12-01", "date_to": "2026-11-01"})
    ).status_code == 422
