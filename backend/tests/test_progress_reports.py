"""Monthly progress reports: numbers and PDF, draft -> approval -> outbox (never sent without a person), rules."""

from __future__ import annotations

import uuid
from typing import Any

import httpx

from nazoratly.rules import results as R
from tests.conftest import Tenant
from tests.helpers import enroll, mk_student, mk_teacher, ok, org_today
from tests.test_document_delivery import FakeTelegram, _family, _run
from tests.test_documents import pdf_text
from tests.test_results import klass, lesson_mark, month_mark, staff
from tests.test_trials import attend, group_with_lessons, lesson_on

MONTH = "2026-11"


def body(grp: dict[str, Any], st: dict[str, Any], month: str = MONTH) -> dict[str, Any]:
    return {"student_id": st["id"], "group_id": grp["id"], "month": month}


async def prepare(t: Tenant, name: str = "Ғуломов Жасур") -> tuple[dict[str, Any], dict[str, Any]]:
    """A group with a student: 1 present, 1 late, 1 absent, 1 excused; grades 5 and 4 plus month grade 3; one exam."""
    grp = await group_with_lessons(t)
    st = await mk_student(t, name)
    await enroll(t, grp["id"], st["id"], "2026-11-01")
    for day, status in (
        ("2026-11-02", "present"),
        ("2026-11-09", "late"),
        ("2026-11-16", "absent"),
        ("2026-11-23", "excused"),
    ):
        await attend(t, grp["id"], st["id"], day, status)
    for day, grade, note in (("2026-11-09", 5, "Faol qatnashdi"), ("2026-11-16", 4, None)):
        les = await lesson_on(t, grp["id"], day)
        await ok(
            await t.put(
                "/v1/marks", lesson_mark(grp, st, les, grade=grade, **({"note": note} if note else {}))
            ),
            201,
        )
    await ok(await t.put("/v1/marks", month_mark(grp, st, grade=3, note="Uy vazifasiga e'tibor bering")), 201)
    exam = await ok(
        await t.post(
            f"/v1/groups/{grp['id']}/exams",
            {"title": "Oraliq test", "held_on": "2026-11-12", "max_score": "40"},
        ),
        201,
    )
    await ok(
        await t.put(f"/v1/exams/{exam['id']}/results", {"records": [{"student_id": st["id"], "score": "30"}]})
    )
    return grp, st


async def test_report_numbers_and_pdf(tenant: Tenant) -> None:
    grp, st = await prepare(tenant)
    rep = await ok(await tenant.post("/v1/reports/progress", body(grp, st)), 201)
    snap = rep["snapshot"]
    assert (snap["present"], snap["late"], snap["absent"], snap["excused"]) == (1, 1, 1, 1)
    assert (
        snap["attendance_percent"] == 67 and rep["attendance_percent"] == 67
    )  # 2 of 3, the excused one is outside
    assert snap["average_grade"] == "4.0" and rep["average_grade"] == "4.0"  # (5 + 4 + 3) / 3
    assert snap["month_grade"] == 3 and snap["month_label"] == "2026 yil noyabr"
    assert [(x["lesson_date"], x["grade"]) for x in snap["lessons"]] == [("2026-11-09", 5), ("2026-11-16", 4)]
    assert [(e["title"], e["percent"]) for e in snap["exams"]] == [("Oraliq test", 75)]
    assert rep["status"] == "draft" and rep["approved_at"] is None and rep["month"] == MONTH
    pdf = await tenant.get(f"/v1/reports/progress/{rep['id']}/pdf")
    assert (
        pdf.status_code == 200
        and pdf.headers["content-type"] == "application/pdf"
        and pdf.content.startswith(b"%PDF")
    )
    text = pdf_text(pdf.content)
    center = (await ok(await tenant.get("/v1/organization")))["name"]
    for needle in (
        center,
        "OYLIK HISOBOT",
        "2026 yil noyabr",
        "Ғуломов Жасур",
        grp["name"],
        "Davomat: 67%",
        "O'rtacha baho (1-5): 4.0",
        "Oy bahosi: 3",
        "Uy vazifasiga e'tibor bering",
        "Faol qatnashdi",
        "Oraliq test",
        "30 / 40",
        "75%",
        "Keldi: 1, kechikdi: 1, kelmadi: 1, sababli: 1",
    ):
        assert needle in text, needle
    # same data -> byte-identical PDF
    again = await ok(await tenant.post("/v1/reports/progress", body(grp, st)))
    assert again["id"] == rep["id"]
    assert (await tenant.get(f"/v1/reports/progress/{rep['id']}/pdf")).content == pdf.content


async def test_empty_month_has_no_percent_and_no_average(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], "2026-11-01")
    rep = await ok(await tenant.post("/v1/reports/progress", body(grp, st)), 201)
    assert rep["attendance_percent"] is None and rep["average_grade"] is None
    text = pdf_text((await tenant.get(f"/v1/reports/progress/{rep['id']}/pdf")).content)
    assert "Davomat: ma'lumot yo'q" in text and "baho qo'yilmagan" in text


async def test_draft_is_regenerated_and_approved_report_is_final(tenant: Tenant) -> None:
    grp, st = await prepare(tenant)
    rep = await ok(await tenant.post("/v1/reports/progress", body(grp, st)), 201)
    await ok(await tenant.put("/v1/marks", month_mark(grp, st, grade=5)))  # month grade 3 -> 5
    redo = await tenant.post("/v1/reports/progress", body(grp, st))
    assert (
        redo.status_code == 200 and redo.json()["id"] == rep["id"] and redo.json()["average_grade"] == "4.7"
    )
    assert "4.7" in pdf_text((await tenant.get(f"/v1/reports/progress/{rep['id']}/pdf")).content)
    chat = 660_000 + uuid.uuid4().int % 100_000
    s2, guardian = await _family(tenant, chat_id=chat)
    await enroll(tenant, grp["id"], s2["id"], "2026-11-01")
    rep2 = await ok(await tenant.post("/v1/reports/progress", body(grp, s2)), 201)
    await ok(
        await tenant.post(f"/v1/reports/progress/{rep2['id']}/approve", {"guardian_id": guardian["id"]}), 201
    )
    final = await tenant.post("/v1/reports/progress", body(grp, s2))
    assert final.status_code == 409 and "final" in final.json()["error"]["message"]
    assert (await tenant.delete(f"/v1/reports/progress/{rep2['id']}")).status_code == 409
    assert (await ok(await tenant.get(f"/v1/reports/progress/{rep2['id']}")))["status"] == "approved"
    assert (await tenant.delete(f"/v1/reports/progress/{rep['id']}")).status_code == 204  # a draft can go
    assert (await tenant.get(f"/v1/reports/progress/{rep['id']}")).status_code == 404


async def test_nothing_is_sent_before_a_person_approves(pg_server: dict[str, Any], tenant: Tenant) -> None:
    chat = 670_000 + uuid.uuid4().int % 100_000
    st, guardian = await _family(tenant, chat_id=chat)
    grp = await group_with_lessons(tenant)
    await enroll(tenant, grp["id"], st["id"], "2026-11-01")
    await attend(tenant, grp["id"], st["id"], "2026-11-02", "present")
    rep = await ok(await tenant.post("/v1/reports/progress", body(grp, st)), 201)
    bulk = await ok(
        await tenant.post("/v1/reports/progress/generate", {"group_id": grp["id"], "month": MONTH})
    )
    assert bulk["regenerated"] == 1 and bulk["created"] == 0
    fake = FakeTelegram(chat)
    await _run(pg_server, fake)
    assert fake.calls == []  # drafts never leave the system

    sent = await ok(
        await tenant.post(f"/v1/reports/progress/{rep['id']}/approve", {"guardian_id": guardian["id"]}), 201
    )
    assert sent["status"] == "queued"
    again = await tenant.post(f"/v1/reports/progress/{rep['id']}/approve", {"guardian_id": guardian["id"]})
    assert (
        again.status_code == 200 and again.json()["message_id"] == sent["message_id"]
    )  # never a second message
    approved = await ok(await tenant.get(f"/v1/reports/progress/{rep['id']}"))
    assert approved["status"] == "approved" and approved["approved_at"]
    await _run(pg_server, fake)
    assert [c["method"] for c in fake.calls] == ["sendMessage", "sendDocument"]
    snap = approved["snapshot"]
    assert fake.calls[0]["json"]["text"] == R.report_caption(
        snap["center_name"], st["full_name"], "2026 yil noyabr", 100, None
    )
    stored = (await tenant.get(f"/v1/reports/progress/{rep['id']}/pdf")).content
    upload = fake.calls[1]["file"]
    assert stored in upload and b'filename="hisobot-2026-11-' in upload


async def test_approval_rules(tenant: Tenant, tenant_b: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    st, no_chat = await _family(tenant, chat_id=None)
    await enroll(tenant, grp["id"], st["id"], "2026-11-01")
    rep = await ok(await tenant.post("/v1/reports/progress", body(grp, st)), 201)
    r = await tenant.post(f"/v1/reports/progress/{rep['id']}/approve", {"guardian_id": no_chat["id"]})
    assert r.status_code == 409 and "Telegram" in r.json()["error"]["message"]
    st2, g2 = await _family(tenant, chat_id=681_001, linked=False)
    await enroll(tenant, grp["id"], st2["id"], "2026-11-01")
    rep2 = await ok(await tenant.post("/v1/reports/progress", body(grp, st2)), 201)
    r = await tenant.post(f"/v1/reports/progress/{rep2['id']}/approve", {"guardian_id": g2["id"]})
    assert r.status_code == 409 and "not linked" in r.json()["error"]["message"]
    st3, g3 = await _family(tenant, chat_id=681_002, notify=False)
    await enroll(tenant, grp["id"], st3["id"], "2026-11-01")
    rep3 = await ok(await tenant.post("/v1/reports/progress", body(grp, st3)), 201)
    r = await tenant.post(f"/v1/reports/progress/{rep3['id']}/approve", {"guardian_id": g3["id"]})
    assert r.status_code == 409 and "consent" in r.json()["error"]["message"]
    for rid in (rep["id"], rep2["id"], rep3["id"]):  # a refused approval changes nothing
        assert (await ok(await tenant.get(f"/v1/reports/progress/{rid}")))["status"] == "draft"
    assert (
        await tenant_b.post(f"/v1/reports/progress/{rep3['id']}/approve", {"guardian_id": g3["id"]})
    ).status_code == 404
    assert (await tenant_b.get(f"/v1/reports/progress/{rep3['id']}")).status_code == 404
    assert (await tenant_b.get(f"/v1/reports/progress/{rep3['id']}/pdf")).status_code == 404


async def test_bulk_generation_skips_approved_and_non_members(tenant: Tenant) -> None:
    grp, (a, b) = await klass(tenant)
    left = await mk_student(tenant, "Left Early")
    e = await enroll(tenant, grp["id"], left["id"], "2026-11-01")
    await ok(await tenant.patch(f"/v1/enrollments/{e['id']}", {"status": "finished"}))
    first = await ok(
        await tenant.post("/v1/reports/progress/generate", {"group_id": grp["id"], "month": MONTH})
    )
    assert (first["created"], first["regenerated"], first["skipped_approved"]) == (2, 0, 0)
    assert {r["student_id"] for r in first["reports"]} == {a["id"], b["id"]}
    chat = 690_000 + uuid.uuid4().int % 100_000
    guardian = await ok(await tenant.post("/v1/guardians", {"full_name": "G", "telegram_chat_id": chat}), 201)
    await ok(
        await tenant.post(
            f"/v1/students/{a['id']}/guardians", {"guardian_id": guardian["id"], "relation": "mother"}
        ),
        201,
    )
    from tests.helpers import consent

    await consent(tenant, a["id"], "notifications", guardian["id"])
    ra = next(r for r in first["reports"] if r["student_id"] == a["id"])
    await ok(
        await tenant.post(f"/v1/reports/progress/{ra['id']}/approve", {"guardian_id": guardian["id"]}), 201
    )
    second = await ok(
        await tenant.post("/v1/reports/progress/generate", {"group_id": grp["id"], "month": MONTH})
    )
    assert (second["created"], second["regenerated"], second["skipped_approved"]) == (0, 1, 1)
    listing = (
        await ok(await tenant.get("/v1/reports/progress", params={"group_id": grp["id"], "month": MONTH}))
    )["items"]
    assert len(listing) == 2
    drafts = (
        await ok(await tenant.get("/v1/reports/progress", params={"group_id": grp["id"], "status": "draft"}))
    )["items"]
    assert [r["student_id"] for r in drafts] == [b["id"]]


async def test_report_validation_and_permissions(client: httpx.AsyncClient, tenant: Tenant) -> None:
    grp, (a, _) = await klass(tenant)
    other = await group_with_lessons(tenant)
    outsider = await mk_student(tenant, "Not In The Group")
    assert (await tenant.post("/v1/reports/progress", body(grp, outsider))).status_code == 422
    future = org_today().replace(day=1)
    future = future.replace(year=future.year + 1).strftime("%Y-%m")
    assert (await tenant.post("/v1/reports/progress", body(grp, a, future))).status_code == 422
    assert (
        await tenant.post("/v1/reports/progress/generate", {"group_id": grp["id"], "month": future})
    ).status_code == 422
    for bad in ("2026-11-01", "2026-13", "x"):
        assert (await tenant.post("/v1/reports/progress", body(grp, a, bad))).status_code == 422
    assert (await tenant.post("/v1/reports/progress", {**body(grp, a), "extra": 1})).status_code == 422

    viewer, _ = await staff(client, tenant, "viewer")
    assert (await viewer.post("/v1/reports/progress", body(grp, a))).status_code == 403
    teacher, member = await staff(client, tenant, "teacher")
    prof = await mk_teacher(tenant, staff_id=member["id"])
    await ok(await tenant.patch(f"/v1/groups/{grp['id']}", {"teacher_id": prof["id"]}))
    mine = await ok(await teacher.post("/v1/reports/progress", body(grp, a)), 201)
    guardian = await ok(
        await tenant.post("/v1/guardians", {"full_name": "G2", "phone": "+998901119999"}), 201
    )
    assert (
        await teacher.post(f"/v1/reports/progress/{mine['id']}/approve", {"guardian_id": guardian["id"]})
    ).status_code == 403
    assert (await viewer.get(f"/v1/reports/progress/{mine['id']}")).status_code == 200
    # a teacher sees only reports of their own groups
    st_other = await mk_student(tenant, "Other Group Kid")
    await enroll(tenant, other["id"], st_other["id"], "2026-11-01")
    theirs = await ok(await tenant.post("/v1/reports/progress", body(other, st_other)), 201)
    assert (await teacher.get(f"/v1/reports/progress/{theirs['id']}")).status_code == 403
    assert (await teacher.post("/v1/reports/progress", body(other, st_other))).status_code == 403
    ids = [r["id"] for r in (await ok(await teacher.get("/v1/reports/progress")))["items"]]
    assert ids == [mine["id"]]
