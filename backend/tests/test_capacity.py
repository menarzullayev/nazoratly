"""Group capacity and waiting list: seats (trials count), queue order, offers, one-click enrollment, reservations."""

from __future__ import annotations

import uuid
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_guardian, mk_student, ok


async def full_group(t: Tenant, capacity: int = 2, **kw: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    grp = await mk_group(t, capacity=capacity, monthly_fee="500000", **kw)
    members = []
    for i in range(capacity):
        s = await mk_student(t, f"Seat Holder {i}")
        members.append(await enroll(t, grp["id"], s["id"]))
    return grp, members


async def queue(t: Tenant, group_id: str, name: str, **kw: Any) -> dict[str, Any]:
    s = await mk_student(t, name)
    entry = await ok(await t.post(f"/v1/groups/{group_id}/waitlist", {"student_id": s["id"], **kw}), 201)
    entry["student"] = s
    return entry


async def test_full_group_refuses_and_points_to_the_waiting_list(tenant: Tenant) -> None:
    grp, _ = await full_group(tenant, 2)
    late = await mk_student(tenant, "Too Late")
    r = await tenant.post(
        f"/v1/groups/{grp['id']}/enrollments", {"student_id": late["id"], "started_on": "2026-02-01"}
    )
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "group_full" and "waiting list" in err["message"]
    assert err["details"] == {"capacity": 2, "occupied": 2, "waiting": 0}


async def test_trial_students_hold_a_seat(tenant: Tenant) -> None:
    grp = await mk_group(tenant, capacity=1, monthly_fee="500000")
    t1 = await mk_student(tenant)
    await enroll(tenant, grp["id"], t1["id"], status="trial")
    other = await mk_student(tenant)
    r = await tenant.post(
        f"/v1/groups/{grp['id']}/enrollments", {"student_id": other["id"], "started_on": "2026-02-01"}
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "group_full"


async def test_queue_order_positions_and_listing(tenant: Tenant) -> None:
    grp, _ = await full_group(tenant, 1)
    a = await queue(tenant, grp["id"], "First", note="phoned twice")
    b = await queue(tenant, grp["id"], "Second")
    c = await queue(tenant, grp["id"], "Third")
    assert (a["position"], b["position"], c["position"]) == (1, 2, 3)
    assert a["note"] == "phoned twice" and a["status"] == "waiting"
    items = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/waitlist")))["items"]
    assert [i["student_name"] for i in items] == ["First", "Second", "Third"]
    assert [i["position"] for i in items] == [1, 2, 3]
    # removing the first moves everybody up
    gone = await ok(await tenant.delete(f"/v1/waitlist/{a['id']}"))
    assert gone["status"] == "removed" and gone["position"] is None and gone["resolved_at"] is not None
    items = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/waitlist")))["items"]
    assert [(i["student_name"], i["position"]) for i in items] == [("Second", 1), ("Third", 2)]
    # a removed student may queue again, at the back
    again = await ok(
        await tenant.post(f"/v1/groups/{grp['id']}/waitlist", {"student_id": a["student"]["id"]}), 201
    )
    assert again["position"] == 3
    removed = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/waitlist", params={"status": "removed"})))[
        "items"
    ]
    assert len(removed) == 1


async def test_joining_rules(tenant: Tenant) -> None:
    unlimited = await mk_group(tenant, monthly_fee="1")
    s = await mk_student(tenant)
    r = await tenant.post(f"/v1/groups/{unlimited['id']}/waitlist", {"student_id": s["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "seat_available"

    grp = await mk_group(tenant, capacity=3, monthly_fee="1")
    r = await tenant.post(f"/v1/groups/{grp['id']}/waitlist", {"student_id": s["id"]})
    assert (
        r.status_code == 409 and r.json()["error"]["code"] == "seat_available"
    )  # free seats and nobody waiting

    full, members = await full_group(tenant, 1)
    holder = members[0]["student_id"]
    r = await tenant.post(f"/v1/groups/{full['id']}/waitlist", {"student_id": holder})
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_enrolled"

    w = await queue(tenant, full["id"], "Waiting")
    r = await tenant.post(f"/v1/groups/{full['id']}/waitlist", {"student_id": w["student"]["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_waiting"

    ghost = str(uuid.uuid4())
    assert (await tenant.post(f"/v1/groups/{full['id']}/waitlist", {"student_id": ghost})).status_code == 404
    assert (
        await tenant.post(f"/v1/groups/{uuid.uuid4()}/waitlist", {"student_id": s["id"]})
    ).status_code == 404
    await ok(await tenant.patch(f"/v1/groups/{full['id']}", {"status": "finished"}))
    r = await tenant.post(f"/v1/groups/{full['id']}/waitlist", {"student_id": s["id"]})
    assert r.status_code == 409


async def test_a_free_seat_with_a_queue_still_lets_new_students_queue(tenant: Tenant) -> None:
    grp, members = await full_group(tenant, 2)
    await queue(tenant, grp["id"], "Waiting One")
    await ok(
        await tenant.patch(f"/v1/enrollments/{members[0]['id']}", {"status": "finished"})
    )  # a seat frees
    newcomer = await mk_student(tenant, "Newcomer")
    entry = await ok(
        await tenant.post(f"/v1/groups/{grp['id']}/waitlist", {"student_id": newcomer["id"]}), 201
    )
    assert entry["position"] == 2  # seats are reserved for the queue


async def test_freed_seat_makes_an_offer_and_enrolls_in_one_click(tenant: Tenant) -> None:
    grp, members = await full_group(tenant, 2)
    g = await mk_guardian(tenant, "Dilnoza opa")
    first = await queue(tenant, grp["id"], "Ali Karimov")
    await ok(
        await tenant.post(
            f"/v1/students/{first['student']['id']}/guardians",
            {"guardian_id": g["id"], "relation": "mother", "is_primary": True},
        ),
        201,
    )
    second = await queue(tenant, grp["id"], "Vali Aliyev")
    assert await ok(await tenant.get("/v1/waitlist/offers")) == []  # full: nobody is offered

    await ok(await tenant.patch(f"/v1/enrollments/{members[1]['id']}", {"status": "finished"}))
    offers = await ok(await tenant.get("/v1/waitlist/offers"))
    assert [(o["student_name"], o["position"], o["free_seats"]) for o in offers] == [("Ali Karimov", 1, 1)]
    text = offers[0]["offer_text"]
    assert "Dilnoza opa" in text and "1 ta o'rin" in text and grp["name"] in text and "Ali Karimov" in text
    # nothing was enrolled by itself
    assert (await ok(await tenant.get(f"/v1/groups/{grp['id']}/enrollments")))["items"].__len__() == 1

    # second in line cannot take the seat that belongs to the first
    r = await tenant.post(f"/v1/waitlist/{second['id']}/enroll", {})
    assert r.status_code == 409 and r.json()["error"]["code"] == "group_full"
    enr = await ok(await tenant.post(f"/v1/waitlist/{first['id']}/enroll", {"started_on": "2026-03-02"}), 201)
    assert (
        enr["student_name"] == "Ali Karimov"
        and enr["status"] == "active"
        and enr["started_on"] == "2026-03-02"
    )
    done = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/waitlist", params={"status": "enrolled"})))[
        "items"
    ]
    assert [d["student_name"] for d in done] == ["Ali Karimov"]
    assert await ok(await tenant.get("/v1/waitlist/offers")) == []
    # the entry is closed: a second click is refused
    assert (await tenant.post(f"/v1/waitlist/{first['id']}/enroll", {})).status_code == 409
    assert (await tenant.delete(f"/v1/waitlist/{first['id']}")).status_code == 409


async def test_guardian_less_offer_uses_a_polite_fallback_and_can_start_as_trial(tenant: Tenant) -> None:
    grp, members = await full_group(tenant, 1)
    first = await queue(tenant, grp["id"], "No Guardian")
    await ok(await tenant.patch(f"/v1/enrollments/{members[0]['id']}", {"status": "finished"}))
    offers = await ok(await tenant.get("/v1/waitlist/offers"))
    assert "hurmatli ota-ona" in offers[0]["offer_text"]
    enr = await ok(
        await tenant.post(
            f"/v1/waitlist/{first['id']}/enroll", {"status": "trial", "started_on": "2026-03-02"}
        ),
        201,
    )
    assert enr["status"] == "trial"


async def test_raising_the_capacity_frees_seats_for_the_queue(tenant: Tenant) -> None:
    grp, _ = await full_group(tenant, 1)
    await queue(tenant, grp["id"], "One")
    await queue(tenant, grp["id"], "Two")
    await queue(tenant, grp["id"], "Three")
    await ok(await tenant.patch(f"/v1/groups/{grp['id']}", {"capacity": 3}))
    offers = await ok(await tenant.get("/v1/waitlist/offers"))
    assert [(o["student_name"], o["position"], o["free_seats"]) for o in offers] == [
        ("One", 1, 2),
        ("Two", 2, 2),
    ]
    assert "2 ta o'rin" in offers[0]["offer_text"]
    # lowering below the occupied seats is still refused
    assert (await tenant.patch(f"/v1/groups/{grp['id']}", {"capacity": 0})).status_code == 422


async def test_direct_enrollment_respects_the_queue_unless_overridden(tenant: Tenant) -> None:
    grp, members = await full_group(tenant, 2)
    await queue(tenant, grp["id"], "Waiting")
    await ok(
        await tenant.patch(f"/v1/enrollments/{members[0]['id']}", {"status": "finished"})
    )  # one seat, one waiting
    other = await mk_student(tenant, "Pushy")
    body = {"student_id": other["id"], "started_on": "2026-03-02"}
    r = await tenant.post(f"/v1/groups/{grp['id']}/enrollments", body)
    assert r.status_code == 409 and "reserved" in r.json()["error"]["message"]
    forced = await ok(
        await tenant.post(f"/v1/groups/{grp['id']}/enrollments", {**body, "ignore_waitlist": True}), 201
    )
    assert forced["student_name"] == "Pushy"
    # but the group is full again: the override never exceeds the capacity
    third = await mk_student(tenant, "Third")
    r = await tenant.post(
        f"/v1/groups/{grp['id']}/enrollments",
        {"student_id": third["id"], "started_on": "2026-03-02", "ignore_waitlist": True},
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "group_full"


async def test_enrolling_a_waiting_student_directly_uses_their_place_in_line(tenant: Tenant) -> None:
    grp, members = await full_group(tenant, 2)
    first = await queue(tenant, grp["id"], "First")
    second = await queue(tenant, grp["id"], "Second")
    await ok(await tenant.patch(f"/v1/enrollments/{members[0]['id']}", {"status": "finished"}))
    body = {"started_on": "2026-03-02"}
    r = await tenant.post(
        f"/v1/groups/{grp['id']}/enrollments", {"student_id": second["student"]["id"], **body}
    )
    assert r.status_code == 409  # second in line, one seat
    await ok(
        await tenant.post(
            f"/v1/groups/{grp['id']}/enrollments", {"student_id": first["student"]["id"], **body}
        ),
        201,
    )
    entries = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/waitlist", params={"status": "enrolled"})))[
        "items"
    ]
    assert [e["student_name"] for e in entries] == ["First"]  # the waiting entry closed itself


async def test_frozen_student_needs_a_free_seat_to_return(tenant: Tenant) -> None:
    grp, members = await full_group(tenant, 1)
    await ok(await tenant.patch(f"/v1/enrollments/{members[0]['id']}", {"status": "frozen"}))
    other = await mk_student(tenant, "Takes the seat")
    await enroll(tenant, grp["id"], other["id"], "2026-02-01")
    r = await tenant.patch(f"/v1/enrollments/{members[0]['id']}", {"status": "active"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "group_full"
    await ok(await tenant.patch(f"/v1/groups/{grp['id']}", {"capacity": 2}))
    back = await ok(await tenant.patch(f"/v1/enrollments/{members[0]['id']}", {"status": "active"}))
    assert back["status"] == "active"


async def test_last_seat_is_taken_once_under_concurrency(tenant: Tenant) -> None:
    import asyncio

    grp, _ = await full_group(tenant, 1)
    ok_ = await mk_student(tenant)  # make one free seat by raising capacity, then race for it
    await ok(await tenant.patch(f"/v1/groups/{grp['id']}", {"capacity": 2}))
    racers = [await mk_student(tenant, f"Racer {i}") for i in range(6)]
    results = await asyncio.gather(
        *[
            tenant.post(
                f"/v1/groups/{grp['id']}/enrollments", {"student_id": s["id"], "started_on": "2026-02-01"}
            )
            for s in racers
        ]
    )
    codes = sorted(r.status_code for r in results)
    assert codes == [201] + [409] * 5, codes
    _ = ok_


async def test_waiting_list_is_tenant_isolated_and_permissioned(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    grp, _ = await full_group(tenant, 1)
    w = await queue(tenant, grp["id"], "Mine")
    assert (await tenant_b.get(f"/v1/groups/{grp['id']}/waitlist")).status_code == 404
    assert (await tenant_b.delete(f"/v1/waitlist/{w['id']}")).status_code == 404
    assert (await tenant_b.post(f"/v1/waitlist/{w['id']}/enroll", {})).status_code == 404
    assert await ok(await tenant_b.get("/v1/waitlist/offers")) == []
    s_b = await mk_student(tenant_b)
    assert (
        await tenant_b.post(f"/v1/groups/{grp['id']}/waitlist", {"student_id": s_b["id"]})
    ).status_code == 404

    email = f"viewer-{uuid.uuid4().hex[:8]}@example.com"
    await ok(
        await tenant.post(
            "/v1/staff",
            {"full_name": "V", "email": email, "role": "viewer", "initial_password": "staff-password-123"},
        ),
        201,
    )
    data = await ok(
        await client.post("/v1/auth/login", json={"identifier": email, "password": "staff-password-123"})
    )
    viewer = Tenant(client, data, email, "staff-password-123")
    assert (await viewer.get("/v1/waitlist/offers")).status_code == 200
    assert (
        await viewer.post(f"/v1/groups/{grp['id']}/waitlist", {"student_id": w["student"]["id"]})
    ).status_code == 403
    assert (await viewer.delete(f"/v1/waitlist/{w['id']}")).status_code == 403
    assert (await viewer.post(f"/v1/waitlist/{w['id']}/enroll", {})).status_code == 403


async def test_dashboard_lists_the_seat_that_freed_up(tenant: Tenant) -> None:
    grp, members = await full_group(tenant, 1)
    first = await queue(tenant, grp["id"], "Dashboard Waiter")
    await queue(tenant, grp["id"], "Behind Him")
    before = (await ok(await tenant.get("/v1/dashboard")))["waiting"]
    assert before["seats"] == [] and before["total"] == 0
    await ok(await tenant.patch(f"/v1/enrollments/{members[0]['id']}", {"status": "finished"}))
    after = (await ok(await tenant.get("/v1/dashboard")))["waiting"]
    assert [(s["student_name"], s["group_name"], s["position"], s["free_seats"]) for s in after["seats"]] == [
        ("Dashboard Waiter", grp["name"], 1, 1)
    ]
    assert after["seats"][0]["entry_id"] == first["id"] and after["total"] == 1
