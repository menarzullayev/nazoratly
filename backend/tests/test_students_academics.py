from __future__ import annotations

import uuid

import httpx

from tests.conftest import Tenant
from tests.helpers import consent, enroll, mk_course, mk_group, mk_guardian, mk_student, mk_teacher, ok
from tests.test_tenancy_and_staff import _add_staff, _login


async def test_student_crud_search_and_validation(tenant: Tenant) -> None:
    a = await mk_student(tenant, "Alisher Valiyev", phone="+998901112233")
    await mk_student(tenant, "Bobur Karimov")
    res = (await ok(await tenant.get("/v1/students", params={"q": "alish"})))["items"]
    assert [s["full_name"] for s in res] == ["Alisher Valiyev"]
    assert (await ok(await tenant.get("/v1/students", params={"q": "%"})))[
        "items"
    ] == []  # wildcard is escaped
    upd = await ok(await tenant.patch(f"/v1/students/{a['id']}", {"status": "paused", "notes": "moved"}))
    assert upd["status"] == "paused"
    assert (await tenant.post("/v1/students", {"full_name": "X", "phone": "998901112233"})).status_code == 422
    assert (
        await tenant.post("/v1/students", {"full_name": "X", "birth_date": "2999-01-01"})
    ).status_code == 422
    assert (await tenant.post("/v1/students", {"full_name": "X", "unknown_field": 1})).status_code == 422
    page = await ok(await tenant.get("/v1/students", params={"limit": 1}))
    assert len(page["items"]) == 1 and page["has_more"] is True
    assert (await tenant.get("/v1/students", params={"limit": 0})).status_code == 422


async def test_guardian_links_primary_and_consents(tenant: Tenant) -> None:
    s = await mk_student(tenant)
    g1, g2 = await mk_guardian(tenant, "Mother"), await mk_guardian(tenant, "Father")
    await ok(
        await tenant.post(
            f"/v1/students/{s['id']}/guardians",
            {"guardian_id": g1["id"], "relation": "mother", "is_primary": True},
        ),
        201,
    )
    await ok(
        await tenant.post(
            f"/v1/students/{s['id']}/guardians",
            {"guardian_id": g2["id"], "relation": "father", "is_primary": True},
        ),
        201,
    )
    detail = await ok(await tenant.get(f"/v1/students/{s['id']}"))
    primaries = [g["full_name"] for g in detail["guardians"] if g["is_primary"]]
    assert primaries == ["Father"]  # exactly one primary, the latest
    assert (
        await tenant.post(
            f"/v1/students/{s['id']}/guardians", {"guardian_id": g1["id"], "relation": "mother"}
        )
    ).status_code == 409

    c = await consent(tenant, s["id"], "notifications", g1["id"])
    assert (
        await tenant.post(
            f"/v1/students/{s['id']}/consents",
            {"purpose": "notifications", "policy_version": "v1", "given_by_self": True},
        )
    ).status_code == 409  # already active
    other = await mk_guardian(tenant, "Stranger")
    assert (
        await tenant.post(
            f"/v1/students/{s['id']}/consents",
            {"purpose": "marketing", "policy_version": "v1", "given_by_guardian_id": other["id"]},
        )
    ).status_code == 404  # not linked
    assert (
        await tenant.post(
            f"/v1/students/{s['id']}/consents", {"purpose": "marketing", "policy_version": "v1"}
        )
    ).status_code == 422
    revoked = await ok(await tenant.post(f"/v1/consents/{c['id']}/revoke"))
    assert revoked["revoked_at"] is not None
    assert (await tenant.post(f"/v1/consents/{c['id']}/revoke")).status_code == 409
    await consent(tenant, s["id"], "notifications", g1["id"])  # a new one may be given after revocation
    await ok(await tenant.delete(f"/v1/students/{s['id']}/guardians/{g2['id']}"))
    assert (await tenant.delete(f"/v1/students/{s['id']}/guardians/{g2['id']}")).status_code == 404


async def test_cross_tenant_references_are_rejected(tenant: Tenant, tenant_b: Tenant) -> None:
    s = await mk_student(tenant)
    grp_b = await mk_group(tenant_b)
    # center A cannot enroll its student into center B's group (group is invisible -> 404)
    assert (
        await tenant.post(
            f"/v1/groups/{grp_b['id']}/enrollments", {"student_id": s["id"], "started_on": "2026-01-01"}
        )
    ).status_code == 404
    g_b = await mk_guardian(tenant_b)
    assert (
        await tenant.post(
            f"/v1/students/{s['id']}/guardians", {"guardian_id": g_b["id"], "relation": "other"}
        )
    ).status_code == 404


async def test_groups_schedule_enrollment_and_capacity(tenant: Tenant) -> None:
    teacher = await mk_teacher(tenant)
    grp = await mk_group(tenant, teacher_id=teacher["id"], capacity=2, monthly_fee="400000")
    assert grp["monthly_fee"] == "400000.00" and grp["teacher_name"] == teacher["full_name"]
    sched = await ok(
        await tenant.put(
            f"/v1/groups/{grp['id']}/schedule",
            [
                {"weekday": 1, "start_time": "10:00:00", "end_time": "11:30:00"},
                {"weekday": 3, "start_time": "10:00:00", "end_time": "11:30:00"},
            ],
        )
    )
    assert len(sched["schedule"]) == 2
    assert (
        await tenant.put(
            f"/v1/groups/{grp['id']}/schedule",
            [{"weekday": 1, "start_time": "10:00:00", "end_time": "09:00:00"}],
        )
    ).status_code == 422
    assert (
        await tenant.put(
            f"/v1/groups/{grp['id']}/schedule",
            [
                {"weekday": 1, "start_time": "10:00:00", "end_time": "11:00:00"},
                {"weekday": 1, "start_time": "10:00:00", "end_time": "12:00:00"},
            ],
        )
    ).status_code == 422

    s1, s2, s3 = [await mk_student(tenant) for _ in range(3)]
    e1 = await enroll(tenant, grp["id"], s1["id"], discount_percent="25")
    assert e1["effective_monthly_fee"] == "300000.00"
    await enroll(tenant, grp["id"], s2["id"])
    assert (
        await tenant.post(
            f"/v1/groups/{grp['id']}/enrollments", {"student_id": s3["id"], "started_on": "2026-01-01"}
        )
    ).status_code == 409  # full
    assert (
        await tenant.post(
            f"/v1/groups/{grp['id']}/enrollments", {"student_id": s1["id"], "started_on": "2026-01-01"}
        )
    ).status_code in (409, 422)
    members = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/enrollments")))["items"]
    assert len(members) == 2
    assert (await tenant.patch(f"/v1/groups/{grp['id']}", {"capacity": 1})).status_code == 409
    assert (await tenant.delete(f"/v1/groups/{grp['id']}")).status_code == 409  # has open enrollments
    fin = await ok(await tenant.patch(f"/v1/enrollments/{e1['id']}", {"status": "finished"}))
    assert fin["status"] == "finished" and fin["ended_on"] is not None
    assert (await tenant.patch(f"/v1/enrollments/{e1['id']}", {"status": "active"})).status_code == 409
    assert (await tenant.delete(f"/v1/students/{s3['id']}")).status_code == 200


async def test_course_and_teacher_delete_guards(tenant: Tenant) -> None:
    course = await mk_course(tenant)
    teacher = await mk_teacher(tenant)
    await mk_group(tenant, course_id=course["id"], teacher_id=teacher["id"])
    assert (await tenant.delete(f"/v1/courses/{course['id']}")).status_code == 409
    assert (await tenant.delete(f"/v1/teachers/{teacher['id']}")).status_code == 409
    assert (
        await tenant.post("/v1/teachers", {"full_name": "P", "pay_model": "percent", "pay_rate": "150"})
    ).status_code == 422


async def test_lessons_generation_and_attendance(tenant: Tenant) -> None:
    teacher = await mk_teacher(tenant)
    grp = await mk_group(tenant, teacher_id=teacher["id"])
    await ok(
        await tenant.put(
            f"/v1/groups/{grp['id']}/schedule",
            [{"weekday": 1, "start_time": "10:00:00", "end_time": "11:00:00"}],
        )
    )
    gen = await ok(
        await tenant.post(
            f"/v1/groups/{grp['id']}/lessons/generate", {"date_from": "2026-03-02", "date_to": "2026-03-31"}
        )
    )
    assert gen["created"] == 5  # Mondays: 2, 9, 16, 23, 30
    again = await ok(
        await tenant.post(
            f"/v1/groups/{grp['id']}/lessons/generate", {"date_from": "2026-03-02", "date_to": "2026-03-31"}
        )
    )
    assert again["created"] == 0 and again["skipped_existing"] == 5
    assert (
        await tenant.post(
            f"/v1/groups/{grp['id']}/lessons/generate", {"date_from": "2020-01-01", "date_to": "2026-12-31"}
        )
    ).status_code == 422

    lessons = (
        await ok(await tenant.get("/v1/lessons", params={"date_from": "2026-03-01", "date_to": "2026-03-31"}))
    )["items"]
    assert len(lessons) == 5 and lessons[0]["teacher_id"] == teacher["id"]
    lesson = lessons[0]
    s1, s2, outsider = await mk_student(tenant), await mk_student(tenant), await mk_student(tenant)
    await enroll(tenant, grp["id"], s1["id"])
    await enroll(tenant, grp["id"], s2["id"])
    roster = await ok(await tenant.get(f"/v1/lessons/{lesson['id']}/attendance"))
    assert len(roster["entries"]) == 2 and all(e["status"] is None for e in roster["entries"])

    saved = await ok(
        await tenant.put(
            f"/v1/lessons/{lesson['id']}/attendance",
            {
                "records": [
                    {"student_id": s1["id"], "status": "present"},
                    {"student_id": s2["id"], "status": "late", "minutes_late": 15},
                ]
            },
        )
    )
    assert saved["lesson_status"] == "held"
    by = {e["student_id"]: e for e in saved["entries"]}
    assert by[s2["id"]]["status"] == "late" and by[s2["id"]]["minutes_late"] == 15
    # upsert: change a mark
    again = await ok(
        await tenant.put(
            f"/v1/lessons/{lesson['id']}/attendance",
            {"records": [{"student_id": s2["id"], "status": "absent"}]},
        )
    )
    assert {e["student_id"]: e["status"] for e in again["entries"]}[s2["id"]] == "absent"
    # negative cases
    assert (
        await tenant.put(
            f"/v1/lessons/{lesson['id']}/attendance",
            {"records": [{"student_id": outsider["id"], "status": "present"}]},
        )
    ).status_code == 422
    assert (
        await tenant.put(
            f"/v1/lessons/{lesson['id']}/attendance",
            {"records": [{"student_id": s1["id"], "status": "present", "minutes_late": 5}]},
        )
    ).status_code == 422
    assert (
        await tenant.put(
            f"/v1/lessons/{lesson['id']}/attendance",
            {
                "records": [
                    {"student_id": s1["id"], "status": "present"},
                    {"student_id": s1["id"], "status": "absent"},
                ]
            },
        )
    ).status_code == 422
    assert (
        await tenant.patch(f"/v1/lessons/{lesson['id']}", {"status": "cancelled"})
    ).status_code == 409  # has marks
    await ok(await tenant.delete(f"/v1/lessons/{lesson['id']}/attendance/{s1['id']}"))
    assert (await tenant.delete(f"/v1/lessons/{lesson['id']}/attendance/{s1['id']}")).status_code == 404

    report = await ok(await tenant.get(f"/v1/groups/{grp['id']}/attendance", params={"month": "2026-03-15"}))
    assert len(report["lessons"]) == 5
    rows = {s["student_name"]: s for s in report["students"]}
    assert rows[s2["full_name"]]["absent"] == 1
    ab = await ok(
        await tenant.get(
            "/v1/reports/absences",
            params={"date_from": "2026-03-01", "date_to": "2026-03-31", "min_absences": 1},
        )
    )
    assert [r["student_id"] for r in ab] == [s2["id"]]


async def test_teacher_sees_only_own_groups_and_lessons(client: httpx.AsyncClient, tenant: Tenant) -> None:
    member, email = await _add_staff(tenant, "teacher")
    prof = await mk_teacher(tenant, staff_id=member["id"])
    other = await mk_teacher(tenant)
    mine = await mk_group(tenant, teacher_id=prof["id"])
    theirs = await mk_group(tenant, teacher_id=other["id"])
    for g in (mine, theirs):
        await ok(
            await tenant.put(
                f"/v1/groups/{g['id']}/schedule",
                [{"weekday": 2, "start_time": "09:00:00", "end_time": "10:00:00"}],
            )
        )
        await ok(
            await tenant.post(
                f"/v1/groups/{g['id']}/lessons/generate", {"date_from": "2026-03-01", "date_to": "2026-03-07"}
            )
        )
    st = await mk_student(tenant)
    await enroll(tenant, mine["id"], st["id"])
    tch = await _login(client, email, "staff-password-123")
    groups = (await ok(await tch.get("/v1/groups")))["items"]
    assert [g["id"] for g in groups] == [mine["id"]]
    assert (await tch.get(f"/v1/groups/{theirs['id']}")).status_code == 403
    lessons = (
        await ok(await tch.get("/v1/lessons", params={"date_from": "2026-03-01", "date_to": "2026-03-07"}))
    )["items"]
    assert len(lessons) == 1 and lessons[0]["group_id"] == mine["id"]
    other_lessons = (
        await ok(
            await tenant.get(
                "/v1/lessons",
                params={"date_from": "2026-03-01", "date_to": "2026-03-07", "group_id": theirs["id"]},
            )
        )
    )["items"]
    assert (await tch.get(f"/v1/lessons/{other_lessons[0]['id']}/attendance")).status_code == 403
    marked = await ok(
        await tch.put(
            f"/v1/lessons/{lessons[0]['id']}/attendance",
            {"records": [{"student_id": st["id"], "status": "present"}]},
        )
    )
    assert marked["entries"][0]["status"] == "present"
    assert (
        await tch.patch(f"/v1/lessons/{lessons[0]['id']}", {"room_id": None, "teacher_id": other["id"]})
    ).status_code == 403


async def test_unknown_ids_and_bad_uuids(tenant: Tenant) -> None:
    assert (await tenant.get(f"/v1/students/{uuid.uuid4()}")).status_code == 404
    assert (await tenant.get("/v1/students/not-a-uuid")).status_code == 422
