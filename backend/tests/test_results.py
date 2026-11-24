"""Teacher notes and grades, simple exam results, a student's results, permissions and tenant isolation."""

from __future__ import annotations

import uuid
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, mk_teacher, ok, org_today
from tests.test_trials import group_with_lessons, lesson_on

NOV9 = "2026-11-09"
NOV16 = "2026-11-16"


async def klass(t: Tenant, n: int = 2) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    grp = await group_with_lessons(t)
    students = []
    for i in range(n):
        s = await mk_student(t, f"Pupil {i} {uuid.uuid4().hex[:4]}")
        await enroll(t, grp["id"], s["id"], "2026-11-01")
        students.append(s)
    return grp, students


def lesson_mark(grp: dict[str, Any], st: dict[str, Any], lesson: dict[str, Any], **kw: Any) -> dict[str, Any]:
    return {"student_id": st["id"], "group_id": grp["id"], "scope": "lesson", "lesson_id": lesson["id"], **kw}


def month_mark(grp: dict[str, Any], st: dict[str, Any], month: str = "2026-11", **kw: Any) -> dict[str, Any]:
    return {"student_id": st["id"], "group_id": grp["id"], "scope": "month", "month": month, **kw}


async def staff(client: httpx.AsyncClient, t: Tenant, role: str) -> tuple[Tenant, dict[str, Any]]:
    email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
    member = await ok(
        await t.post(
            "/v1/staff",
            {"full_name": role, "email": email, "role": role, "initial_password": "staff-password-123"},
        ),
        201,
    )
    data = await ok(
        await client.post("/v1/auth/login", json={"identifier": email, "password": "staff-password-123"})
    )
    return Tenant(client, data, email, "staff-password-123"), member


# ---- notes and grades -----------------------------------------------------------------------------------------
async def test_lesson_and_month_marks_are_upserts(tenant: Tenant) -> None:
    grp, (a, b) = await klass(tenant)
    lesson = await lesson_on(tenant, grp["id"], NOV9)
    first = await tenant.put("/v1/marks", lesson_mark(grp, a, lesson, grade=5, note="Yaxshi ishladi"))
    body = await ok(first, 201)
    assert (body["grade"], body["note"], body["scope"], body["lesson_date"]) == (
        5,
        "Yaxshi ishladi",
        "lesson",
        NOV9,
    )
    assert (
        body["student_name"] == a["full_name"] and body["group_name"] == grp["name"] and body["month"] is None
    )
    again = await ok(await tenant.put("/v1/marks", lesson_mark(grp, a, lesson, grade=4)))  # replaces, 200
    assert again["id"] == body["id"] and again["grade"] == 4 and again["note"] is None
    m1 = await ok(await tenant.put("/v1/marks", month_mark(grp, a, grade=4, note="Oy davomida faol")), 201)
    assert m1["scope"] == "month" and m1["month"] == "2026-11" and m1["lesson_id"] is None
    m2 = await ok(await tenant.put("/v1/marks", month_mark(grp, a, note="Faqat izoh")))
    assert m2["id"] == m1["id"] and m2["grade"] is None
    await ok(await tenant.put("/v1/marks", lesson_mark(grp, b, lesson, note="Kechikdi")), 201)

    items = (await ok(await tenant.get("/v1/marks", params={"student_id": a["id"]})))["items"]
    assert {i["scope"] for i in items} == {"lesson", "month"} and len(items) == 2
    in_month = (await ok(await tenant.get("/v1/marks", params={"group_id": grp["id"], "month": "2026-11"})))[
        "items"
    ]
    assert len(in_month) == 3
    other_month = (
        await ok(await tenant.get("/v1/marks", params={"group_id": grp["id"], "month": "2026-10"}))
    )["items"]
    assert other_month == []
    by_lesson = (await ok(await tenant.get("/v1/marks", params={"lesson_id": lesson["id"]})))["items"]
    assert len(by_lesson) == 2


async def test_mark_validation_and_business_rules(tenant: Tenant, tenant_b: Tenant) -> None:
    grp, (a, _) = await klass(tenant)
    other_grp = await group_with_lessons(tenant)
    lesson = await lesson_on(tenant, grp["id"], NOV9)
    other_lesson = await lesson_on(tenant, other_grp["id"], NOV9)
    outsider = await mk_student(tenant, "Not Enrolled")
    for grade in (0, 6, -1):
        assert (await tenant.put("/v1/marks", lesson_mark(grp, a, lesson, grade=grade))).status_code == 422
    assert (
        await tenant.put("/v1/marks", lesson_mark(grp, a, lesson))
    ).status_code == 422  # neither grade nor note
    assert (await tenant.put("/v1/marks", lesson_mark(grp, a, lesson, note="   "))).status_code == 422
    assert (await tenant.put("/v1/marks", lesson_mark(grp, a, lesson, note="x" * 1001))).status_code == 422
    assert (
        await tenant.put("/v1/marks", {**lesson_mark(grp, a, lesson, grade=3), "month": "2026-11"})
    ).status_code == 422
    assert (
        await tenant.put("/v1/marks", {**month_mark(grp, a, grade=3), "lesson_id": lesson["id"]})
    ).status_code == 422
    assert (
        await tenant.put("/v1/marks", {**lesson_mark(grp, a, lesson, grade=3), "extra": 1})
    ).status_code == 422
    for bad in ("2026-13", "2026-1", "nov", "2026-11-01"):
        assert (await tenant.put("/v1/marks", month_mark(grp, a, bad, grade=3))).status_code == 422
    future = org_today().replace(day=1)
    future = future.replace(year=future.year + 1)
    assert (
        await tenant.put("/v1/marks", month_mark(grp, a, future.strftime("%Y-%m"), grade=3))
    ).status_code == 422
    # a lesson of another group, a student who is not in the group, an unknown lesson
    r = await tenant.put("/v1/marks", lesson_mark(grp, a, other_lesson, grade=3))
    assert r.status_code == 422 and "group" in r.json()["error"]["message"]
    assert (await tenant.put("/v1/marks", lesson_mark(grp, outsider, lesson, grade=3))).status_code == 422
    unknown = {**lesson_mark(grp, a, lesson, grade=3), "lesson_id": str(uuid.uuid4())}
    assert (await tenant.put("/v1/marks", unknown)).status_code == 404
    # a cancelled lesson takes no marks
    await ok(await tenant.patch(f"/v1/lessons/{lesson['id']}", {"status": "cancelled"}))
    assert (await tenant.put("/v1/marks", lesson_mark(grp, a, lesson, grade=3))).status_code == 409
    # another center cannot touch it
    assert (await tenant_b.put("/v1/marks", month_mark(grp, a, grade=3))).status_code == 404
    assert (await tenant_b.get("/v1/marks")).json()["items"] == []
    assert (await tenant.get("/v1/marks", params={"month": "2026-11-01"})).status_code == 422


async def test_delete_mark(tenant: Tenant, tenant_b: Tenant) -> None:
    grp, (a, _) = await klass(tenant)
    m = await ok(await tenant.put("/v1/marks", month_mark(grp, a, grade=5)), 201)
    assert (await tenant_b.delete(f"/v1/marks/{m['id']}")).status_code == 404
    assert (await tenant.delete(f"/v1/marks/{m['id']}")).status_code == 204
    assert (await tenant.delete(f"/v1/marks/{m['id']}")).status_code == 404


# ---- exams ----------------------------------------------------------------------------------------------------
async def test_exam_results_percent_and_rules(tenant: Tenant, tenant_b: Tenant) -> None:
    grp, (a, b) = await klass(tenant)
    outsider = await mk_student(tenant, "Not In Group")
    exam = await ok(
        await tenant.post(
            f"/v1/groups/{grp['id']}/exams",
            {"title": "Oraliq test", "held_on": "2026-11-10", "max_score": "60"},
        ),
        201,
    )
    assert exam["max_score"] == "60.00" and exam["results_count"] == 0
    assert [r["student_id"] for r in exam["results"]] == sorted(
        [a["id"], b["id"]], key=lambda i: next(s["full_name"].lower() for s in (a, b) if s["id"] == i)
    )
    assert all(r["score"] is None and r["percent"] is None for r in exam["results"])
    dup = await tenant.post(
        f"/v1/groups/{grp['id']}/exams",
        {"title": " ORALIQ TEST ", "held_on": "2026-11-10", "max_score": "10"},
    )
    assert dup.status_code == 409
    for bad_max in ("0", "-5"):
        r = await tenant.post(
            f"/v1/groups/{grp['id']}/exams", {"title": "X", "held_on": "2026-11-11", "max_score": bad_max}
        )
        assert r.status_code == 422

    saved = await ok(
        await tenant.put(
            f"/v1/exams/{exam['id']}/results",
            {
                "records": [
                    {"student_id": a["id"], "score": "45", "note": "Yaxshi"},
                    {"student_id": b["id"], "score": "20.5"},
                ]
            },
        )
    )
    by_id = {r["student_id"]: r for r in saved["results"]}
    assert (by_id[a["id"]]["score"], by_id[a["id"]]["percent"], by_id[a["id"]]["note"]) == (
        "45.00",
        75,
        "Yaxshi",
    )
    assert (by_id[b["id"]]["score"], by_id[b["id"]]["percent"]) == ("20.50", 34)  # 34.17 -> 34
    assert saved["results_count"] == 2
    # a repeat replaces the score (one score per student)
    redo = await ok(
        await tenant.put(
            f"/v1/exams/{exam['id']}/results", {"records": [{"student_id": a["id"], "score": "60"}]}
        )
    )
    assert (
        next(r for r in redo["results"] if r["student_id"] == a["id"])["percent"] == 100
        and redo["results_count"] == 2
    )

    def put(records: list[dict[str, Any]]) -> Any:
        return tenant.put(f"/v1/exams/{exam['id']}/results", {"records": records})

    assert (await put([{"student_id": a["id"], "score": "60.01"}])).status_code == 422  # above the maximum
    assert (await put([{"student_id": a["id"], "score": "-1"}])).status_code == 422
    assert (await put([{"student_id": outsider["id"], "score": "10"}])).status_code == 422  # not in the group
    assert (
        await put([{"student_id": a["id"], "score": "1"}, {"student_id": a["id"], "score": "2"}])
    ).status_code == 422
    assert (await put([])).status_code == 422
    assert (await put([{"student_id": str(uuid.uuid4()), "score": "1"}])).status_code == 404
    # the maximum cannot drop below an entered score; a higher one is fine
    assert (await tenant.patch(f"/v1/exams/{exam['id']}", {"max_score": "50"})).status_code == 422
    bumped = await ok(await tenant.patch(f"/v1/exams/{exam['id']}", {"max_score": "120", "title": "Yakuniy"}))
    assert (
        bumped["title"] == "Yakuniy"
        and next(r for r in bumped["results"] if r["student_id"] == a["id"])["percent"] == 50
    )
    listing = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/exams")))["items"]
    assert [(e["title"], e["results_count"]) for e in listing] == [("Yakuniy", 2)]
    # isolation
    assert (await tenant_b.get(f"/v1/exams/{exam['id']}")).status_code == 404
    assert (
        await tenant_b.put(
            f"/v1/exams/{exam['id']}/results", {"records": [{"student_id": a["id"], "score": "1"}]}
        )
    ).status_code == 404
    assert (await tenant_b.get(f"/v1/groups/{grp['id']}/exams")).status_code == 404
    # removing a score and the exam
    assert (await tenant.delete(f"/v1/exams/{exam['id']}/results/{b['id']}")).status_code == 204
    assert (await tenant.delete(f"/v1/exams/{exam['id']}/results/{b['id']}")).status_code == 404
    assert (await ok(await tenant.get(f"/v1/exams/{exam['id']}")))["results_count"] == 1
    assert (await tenant.delete(f"/v1/exams/{exam['id']}")).status_code == 204
    assert (await tenant.get(f"/v1/exams/{exam['id']}")).status_code == 404


async def test_student_results_collects_everything(tenant: Tenant) -> None:
    grp, (a, b) = await klass(tenant)
    lesson = await lesson_on(tenant, grp["id"], NOV9)
    await ok(await tenant.put("/v1/marks", lesson_mark(grp, a, lesson, grade=5, note="A'lo")), 201)
    await ok(await tenant.put("/v1/marks", month_mark(grp, a, grade=4)), 201)
    exam = await ok(
        await tenant.post(
            f"/v1/groups/{grp['id']}/exams", {"title": "Test 1", "held_on": "2026-11-12", "max_score": "40"}
        ),
        201,
    )
    await ok(
        await tenant.put(
            f"/v1/exams/{exam['id']}/results", {"records": [{"student_id": a["id"], "score": "30"}]}
        )
    )
    await ok(
        await tenant.post(
            "/v1/reports/progress", {"student_id": a["id"], "group_id": grp["id"], "month": "2026-11"}
        ),
        201,
    )
    res = await ok(await tenant.get(f"/v1/students/{a['id']}/results"))
    assert {m["scope"] for m in res["marks"]} == {"lesson", "month"}
    assert [(e["title"], e["score"], e["max_score"], e["percent"]) for e in res["exams"]] == [
        ("Test 1", "30.00", "40.00", 75)
    ]
    assert [(r["month"], r["status"]) for r in res["reports"]] == [("2026-11", "draft")]
    assert res["certificates"] == []
    empty = await ok(await tenant.get(f"/v1/students/{b['id']}/results"))
    assert empty["marks"] == [] and empty["exams"] == [] and empty["reports"] == []
    assert (await tenant.get(f"/v1/students/{uuid.uuid4()}/results")).status_code == 404


# ---- permissions ---------------------------------------------------------------------------------------------
async def test_permissions_and_teacher_scope(client: httpx.AsyncClient, tenant: Tenant) -> None:
    grp, (a, _) = await klass(tenant)
    other = await group_with_lessons(tenant)
    other_student = await mk_student(tenant, "Other Class Kid")
    await enroll(tenant, other["id"], other_student["id"], "2026-11-01")
    lesson = await lesson_on(tenant, grp["id"], NOV9)
    other_lesson = await lesson_on(tenant, other["id"], NOV9)
    exam = await ok(
        await tenant.post(
            f"/v1/groups/{grp['id']}/exams", {"title": "T", "held_on": "2026-11-12", "max_score": "10"}
        ),
        201,
    )
    other_exam = await ok(
        await tenant.post(
            f"/v1/groups/{other['id']}/exams", {"title": "T", "held_on": "2026-11-12", "max_score": "10"}
        ),
        201,
    )
    await ok(await tenant.put("/v1/marks", lesson_mark(other, other_student, other_lesson, grade=3)), 201)

    viewer, _ = await staff(client, tenant, "viewer")
    assert (await viewer.get("/v1/marks")).status_code == 200
    assert (await viewer.put("/v1/marks", lesson_mark(grp, a, lesson, grade=3))).status_code == 403
    assert (
        await viewer.post(
            f"/v1/groups/{grp['id']}/exams", {"title": "T", "held_on": "2026-11-12", "max_score": "5"}
        )
    ).status_code == 403
    accountant, _ = await staff(client, tenant, "accountant")
    assert (await accountant.get("/v1/marks")).status_code == 403

    teacher, member = await staff(client, tenant, "teacher")
    prof = await mk_teacher(tenant, staff_id=member["id"])
    # a teacher profile without a group sees nothing and writes nothing
    assert (await teacher.get("/v1/marks")).json()["items"] == []
    assert (await teacher.put("/v1/marks", lesson_mark(grp, a, lesson, grade=3))).status_code == 403
    await ok(await tenant.patch(f"/v1/groups/{grp['id']}", {"teacher_id": prof["id"]}))
    mine = await ok(await teacher.put("/v1/marks", lesson_mark(grp, a, lesson, grade=5, note="Zo'r")), 201)
    assert (
        await teacher.put("/v1/marks", lesson_mark(other, other_student, other_lesson, grade=1))
    ).status_code == 403
    listed = (await ok(await teacher.get("/v1/marks")))["items"]
    assert [m["id"] for m in listed] == [mine["id"]]  # the other group's mark is not visible
    assert (await teacher.get("/v1/marks", params={"group_id": other["id"]})).json()["items"] == []
    other_mark = (await ok(await tenant.get("/v1/marks", params={"group_id": other["id"]})))["items"][0]
    assert (await teacher.delete(f"/v1/marks/{other_mark['id']}")).status_code == 403
    # exams: own group yes, another group no
    assert (await teacher.get(f"/v1/exams/{exam['id']}")).status_code == 200
    assert (await teacher.get(f"/v1/exams/{other_exam['id']}")).status_code == 403
    assert (await teacher.get(f"/v1/groups/{other['id']}/exams")).status_code == 403
    assert (
        await teacher.put(
            f"/v1/exams/{exam['id']}/results", {"records": [{"student_id": a["id"], "score": "7"}]}
        )
    ).status_code == 200
    assert (
        await teacher.put(
            f"/v1/exams/{other_exam['id']}/results",
            {"records": [{"student_id": other_student["id"], "score": "7"}]},
        )
    ).status_code == 403
    assert (
        await teacher.post(
            f"/v1/groups/{other['id']}/exams", {"title": "T2", "held_on": "2026-11-12", "max_score": "5"}
        )
    ).status_code == 403
    # the student's results show the teacher only their own group
    ros = await ok(await teacher.get(f"/v1/students/{other_student['id']}/results"))
    assert ros["marks"] == [] and ros["exams"] == []
    # a teacher may not approve or issue (those need results:approve)
    assert (await teacher.post("/v1/certificates", {"enrollment_id": str(uuid.uuid4())})).status_code == 403


async def test_group_without_teacher_scope_for_managers(client: httpx.AsyncClient, tenant: Tenant) -> None:
    grp = await mk_group(tenant)
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], "2026-11-01")
    manager, _ = await staff(client, tenant, "manager")
    assert (await manager.put("/v1/marks", month_mark(grp, st, grade=4))).status_code == 201
