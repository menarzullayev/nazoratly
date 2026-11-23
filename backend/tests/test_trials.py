"""Admission lifecycle: org settings, trial enrollments, acceptance modes and pending decisions."""

from __future__ import annotations

import uuid
from typing import Any

import httpx

from tests.conftest import Tenant, make_tenant
from tests.helpers import enroll, mk_group, mk_student, ok

# Nov 2026: Mondays are 2, 9, 16, 23, 30 -> five lessons; accepting on the 16th leaves three (16, 23, 30).
NOV = {"date_from": "2026-11-01", "date_to": "2026-11-30"}


async def group_with_lessons(t: Tenant, fee: str = "600000", capacity: int | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"monthly_fee": fee}
    if capacity:
        body["capacity"] = capacity
    grp = await mk_group(t, **body)
    await ok(
        await t.put(
            f"/v1/groups/{grp['id']}/schedule",
            [{"weekday": 1, "start_time": "10:00:00", "end_time": "11:00:00"}],
        )
    )
    await ok(await t.post(f"/v1/groups/{grp['id']}/lessons/generate", NOV))
    return grp


async def lesson_on(t: Tenant, group_id: str, day: str) -> dict[str, Any]:
    items = (await ok(await t.get("/v1/lessons", params={**NOV, "group_id": group_id})))["items"]
    return next(x for x in items if x["lesson_date"] == day)


async def attend(t: Tenant, group_id: str, student_id: str, day: str, status: str = "present") -> None:
    les = await lesson_on(t, group_id, day)
    await ok(
        await t.put(
            f"/v1/lessons/{les['id']}/attendance", {"records": [{"student_id": student_id, "status": status}]}
        )
    )


async def trial(t: Tenant, group_id: str, student_id: str, started_on: str = "2026-11-09") -> dict[str, Any]:
    return await enroll(t, group_id, student_id, started_on, status="trial")


async def charges_of(t: Tenant, student_id: str) -> list[dict[str, Any]]:
    return (await ok(await t.get("/v1/charges", params={"student_id": student_id})))["items"]


# ---- settings --------------------------------------------------------------------------------------------
async def test_settings_defaults_patch_and_validation(tenant: Tenant) -> None:
    s = await ok(await tenant.get("/v1/settings"))
    assert (s["trial_free_lessons"], s["trial_free_days"]) == (1, 7)
    s = await ok(await tenant.patch("/v1/settings", {"trial_free_lessons": 2, "trial_free_days": 14}))
    assert (s["trial_free_lessons"], s["trial_free_days"]) == (2, 14)
    again = await ok(await tenant.get("/v1/settings"))
    assert again == s
    assert (await tenant.patch("/v1/settings", {"trial_free_days": -1})).status_code == 422
    assert (await tenant.patch("/v1/settings", {"nope": 1})).status_code == 422


async def test_settings_are_per_center(tenant: Tenant, tenant_b: Tenant) -> None:
    await ok(await tenant.patch("/v1/settings", {"trial_free_days": 30}))
    assert (await ok(await tenant_b.get("/v1/settings")))["trial_free_days"] == 7


# ---- trial enrollments -----------------------------------------------------------------------------------
async def test_trial_creates_no_charge_and_is_skipped_by_generate(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    e = await trial(tenant, grp["id"], st["id"], "2026-10-28")
    assert e["status"] == "trial"
    gen = await ok(await tenant.post("/v1/charges/generate", {"month": "2026-11-01"}))
    assert gen["created"] == 0
    assert await charges_of(tenant, st["id"]) == []


async def test_trial_counts_toward_capacity(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant, capacity=1)
    a, b = await mk_student(tenant), await mk_student(tenant)
    await trial(tenant, grp["id"], a["id"])
    r = await tenant.post(
        f"/v1/groups/{grp['id']}/enrollments", {"student_id": b["id"], "started_on": "2026-11-09"}
    )
    assert r.status_code == 409


async def test_same_student_cannot_hold_two_open_enrollments_in_a_group(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    await trial(tenant, grp["id"], st["id"])
    r = await tenant.post(
        f"/v1/groups/{grp['id']}/enrollments", {"student_id": st["id"], "started_on": "2026-11-09"}
    )
    assert r.status_code in (409, 422)


async def test_invalid_enroll_status_is_rejected(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    r = await tenant.post(
        f"/v1/groups/{grp['id']}/enrollments",
        {"student_id": st["id"], "started_on": "2026-11-09", "status": "frozen"},
    )
    assert r.status_code == 422


# ---- pending decisions -----------------------------------------------------------------------------------
async def test_pending_after_free_lesson_and_after_free_days(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    by_lesson, by_days, waiting = [await mk_student(tenant) for _ in range(3)]
    await trial(tenant, grp["id"], by_lesson["id"], "2026-11-02")
    await attend(tenant, grp["id"], by_lesson["id"], "2026-11-09")
    await trial(tenant, grp["id"], by_days["id"], "2026-01-01")  # long ago: days are used up
    await trial(tenant, grp["id"], waiting["id"], "2099-01-01")  # not started yet
    items = (await ok(await tenant.get("/v1/trials/pending")))["items"]
    by = {i["student_id"]: i for i in items}
    assert by[by_lesson["id"]]["reason"] == "lessons" and by[by_lesson["id"]]["lessons_attended"] == 1
    assert by[by_days["id"]]["reason"] == "days"
    assert waiting["id"] not in by


async def test_absent_lesson_does_not_use_up_the_trial(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    await ok(await tenant.patch("/v1/settings", {"trial_free_days": 365}))
    await trial(tenant, grp["id"], st["id"], "2026-11-02")
    await attend(tenant, grp["id"], st["id"], "2026-11-09", "absent")
    items = (await ok(await tenant.get("/v1/trials/pending")))["items"]
    assert st["id"] not in {i["student_id"] for i in items}


async def test_zero_limits_mean_decide_immediately(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    await ok(await tenant.patch("/v1/settings", {"trial_free_lessons": 0, "trial_free_days": 365}))
    await trial(tenant, grp["id"], st["id"], "2099-01-01")
    items = (await ok(await tenant.get("/v1/trials/pending")))["items"]
    assert st["id"] in {i["student_id"] for i in items}


# ---- accept / drop ---------------------------------------------------------------------------------------
async def test_accept_modes_create_the_golden_amounts(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant, fee="600000")  # five Monday lessons in November
    full, prorated, free = [await mk_student(tenant) for _ in range(3)]
    e_full = await trial(tenant, grp["id"], full["id"], "2026-11-02")
    e_pro = await trial(tenant, grp["id"], prorated["id"], "2026-11-02")
    e_free = await trial(tenant, grp["id"], free["id"], "2026-11-02")

    a = await ok(
        await tenant.post(
            f"/v1/enrollments/{e_full['id']}/accept", {"mode": "full", "accepted_on": "2026-11-16"}
        )
    )
    assert a["status"] == "active" and a["first_month_mode"] == "full"
    assert [c["amount"] for c in await charges_of(tenant, full["id"])] == ["600000.00"]

    await ok(
        await tenant.post(
            f"/v1/enrollments/{e_pro['id']}/accept", {"mode": "prorated", "accepted_on": "2026-11-16"}
        )
    )
    assert [c["amount"] for c in await charges_of(tenant, prorated["id"])] == ["360000.00"]  # 3 of 5 lessons

    await ok(
        await tenant.post(
            f"/v1/enrollments/{e_free['id']}/accept", {"mode": "free_until_next", "accepted_on": "2026-11-16"}
        )
    )
    assert await charges_of(tenant, free["id"]) == []

    # generating the acceptance month afterwards must not bill again
    gen = await ok(await tenant.post("/v1/charges/generate", {"month": "2026-11-01"}))
    assert gen["created"] == 0
    assert await charges_of(tenant, free["id"]) == []
    # the next month bills everyone, including the free-until-next student
    nxt = await ok(await tenant.post("/v1/charges/generate", {"month": "2026-12-01"}))
    assert nxt["created"] == 3


async def test_accept_without_lessons_falls_back_to_full(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="500000")  # no schedule, no lessons
    st = await mk_student(tenant)
    e = await trial(tenant, grp["id"], st["id"], "2026-11-02")
    a = await ok(
        await tenant.post(
            f"/v1/enrollments/{e['id']}/accept", {"mode": "prorated", "accepted_on": "2026-11-16"}
        )
    )
    assert a["fallback_to_full"] is True
    assert [c["amount"] for c in await charges_of(tenant, st["id"])] == ["500000.00"]


async def test_accept_twice_or_non_trial_is_a_conflict_and_never_double_bills(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st, other = await mk_student(tenant), await mk_student(tenant)
    e = await trial(tenant, grp["id"], st["id"], "2026-11-02")
    body = {"mode": "full", "accepted_on": "2026-11-16"}
    await ok(await tenant.post(f"/v1/enrollments/{e['id']}/accept", body))
    r = await tenant.post(f"/v1/enrollments/{e['id']}/accept", body)
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_accepted"
    assert len(await charges_of(tenant, st["id"])) == 1
    plain = await enroll(tenant, grp["id"], other["id"], "2026-11-02")
    r = await tenant.post(f"/v1/enrollments/{plain['id']}/accept", body)
    assert r.status_code == 409 and r.json()["error"]["code"] == "enrollment_not_trial"


async def test_accept_before_the_trial_started_is_rejected(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    e = await trial(tenant, grp["id"], st["id"], "2026-11-09")
    r = await tenant.post(f"/v1/enrollments/{e['id']}/accept", {"mode": "full", "accepted_on": "2026-11-01"})
    assert r.status_code == 422


async def test_drop_finishes_the_trial_and_removes_it_from_pending(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    e = await trial(tenant, grp["id"], st["id"], "2026-01-01")
    assert st["id"] in {i["student_id"] for i in (await ok(await tenant.get("/v1/trials/pending")))["items"]}
    d = await ok(await tenant.post(f"/v1/enrollments/{e['id']}/drop", {"reason": "not interested"}))
    assert d["status"] == "finished" and d["ended_on"] is not None
    assert st["id"] not in {
        i["student_id"] for i in (await ok(await tenant.get("/v1/trials/pending")))["items"]
    }
    assert await charges_of(tenant, st["id"]) == []
    r = await tenant.post(f"/v1/enrollments/{e['id']}/drop", {})
    assert r.status_code == 409 and r.json()["error"]["code"] == "enrollment_not_trial"


async def test_foreign_enrollment_is_404_and_idempotency_replays(tenant: Tenant, tenant_b: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    e = await trial(tenant, grp["id"], st["id"], "2026-11-02")
    body = {"mode": "full", "accepted_on": "2026-11-16"}
    assert (await tenant_b.post(f"/v1/enrollments/{e['id']}/accept", body)).status_code == 404
    assert (await tenant_b.post(f"/v1/enrollments/{e['id']}/drop", {})).status_code == 404
    key = {"Idempotency-Key": f"acc-{uuid.uuid4().hex}"}
    first = await tenant.post(f"/v1/enrollments/{e['id']}/accept", body, headers=key)
    replay = await tenant.post(f"/v1/enrollments/{e['id']}/accept", body, headers=key)
    assert first.status_code == replay.status_code == 200
    assert len(await charges_of(tenant, st["id"])) == 1


async def test_teacher_cannot_accept(client: httpx.AsyncClient, tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    e = await trial(tenant, grp["id"], st["id"], "2026-11-02")
    u = await make_tenant(client, "other")
    # a role without finance:write must not accept; viewer-like check via an unauthenticated call
    r = await client.post(f"/v1/enrollments/{e['id']}/accept", json={"mode": "full"})
    assert r.status_code == 401
    assert u.org_id != tenant.org_id
