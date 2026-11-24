"""Journey 4: learning results. Attendance, grades, an exam, a monthly progress PDF that waits for a person, a certificate with a
public, name-masked verification, and a worker that delivers only what was approved."""

from __future__ import annotations

import uuid
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.e2e.journeys import money
from tests.helpers import enroll, mk_student, ok
from tests.test_document_delivery import FakeTelegram, _family, _run
from tests.test_documents import pdf_text
from tests.test_results import lesson_mark, month_mark, staff
from tests.test_trials import attend, group_with_lessons, lesson_on

MONTH = "2026-11"


async def test_marks_exam_progress_report_and_certificate(
    client: httpx.AsyncClient, pg_server: dict[str, Any], tenant: Tenant
) -> None:
    t = tenant
    chat = 930_000 + uuid.uuid4().int % 50_000
    kid, mom = await _family(t, chat_id=chat)
    other = await mk_student(t, "Classmate Vali")
    grp = await group_with_lessons(t)
    for st in (kid, other):
        await enroll(t, grp["id"], st["id"], "2026-11-01")

    # --- a month of lessons: present, late, absent, excused
    for day, status in (
        ("2026-11-02", "present"),
        ("2026-11-09", "late"),
        ("2026-11-16", "absent"),
        ("2026-11-23", "excused"),
    ):
        await attend(t, grp["id"], kid["id"], day, status)
        await attend(t, grp["id"], other["id"], day, "present")

    # --- grades per lesson and per month; an exam with scores
    for day, grade in (("2026-11-09", 5), ("2026-11-16", 4)):
        les = await lesson_on(t, grp["id"], day)
        await ok(await t.put("/v1/marks", lesson_mark(grp, kid, les, grade=grade, note="good work")), 201)
    await ok(await t.put("/v1/marks", month_mark(grp, kid, grade=3, note="homework needs attention")), 201)
    exam = await ok(
        await t.post(
            f"/v1/groups/{grp['id']}/exams", {"title": "Mid-term", "held_on": "2026-11-12", "max_score": "40"}
        ),
        201,
    )
    await ok(
        await t.put(
            f"/v1/exams/{exam['id']}/results",
            {
                "records": [
                    {"student_id": kid["id"], "score": "30"},
                    {"student_id": other["id"], "score": "40"},
                ]
            },
        )
    )
    assert money((await ok(await t.get(f"/v1/exams/{exam['id']}")))["results_count"]) == 2

    # --- a teacher of ANOTHER group cannot grade this group's students
    stranger, _ = await staff(client, t, "teacher")
    les = await lesson_on(t, grp["id"], "2026-11-02")
    assert (await stranger.put("/v1/marks", lesson_mark(grp, kid, les, grade=5))).status_code in (403, 404)

    # --- the progress report: draft, numbers from the data, PDF with the facts
    rep = await ok(
        await t.post(
            "/v1/reports/progress", {"student_id": kid["id"], "group_id": grp["id"], "month": MONTH}
        ),
        201,
    )
    snap = rep["snapshot"]
    assert (snap["present"], snap["late"], snap["absent"], snap["excused"]) == (1, 1, 1, 1)
    assert snap["attendance_percent"] == 67 and snap["average_grade"] == "4.0"
    assert [(e["title"], e["percent"]) for e in snap["exams"]] == [("Mid-term", 75)]
    assert rep["status"] == "draft"
    pdf = await t.get(f"/v1/reports/progress/{rep['id']}/pdf")
    text = pdf_text(pdf.content)
    for needle in ("OYLIK HISOBOT", kid["full_name"], "Davomat: 67%", "30 / 40", "homework needs attention"):
        assert needle in text, needle

    # --- nothing leaves the system before a person approves; then exactly one message plus the PDF
    fake = FakeTelegram(chat)
    await _run(pg_server, fake)
    assert fake.calls == []
    sent = await ok(
        await t.post(f"/v1/reports/progress/{rep['id']}/approve", {"guardian_id": mom["id"]}), 201
    )
    await _run(pg_server, fake)
    await _run(pg_server, fake)  # a second worker pass must not resend
    assert [c["method"] for c in fake.calls] == ["sendMessage", "sendDocument"]
    assert (await t.post(f"/v1/reports/progress/{rep['id']}/approve", {"guardian_id": mom["id"]})).json()[
        "message_id"
    ] == sent["message_id"]
    assert (await t.get(f"/v1/reports/progress/{rep['id']}/pdf")).content in fake.calls[1]["file"]
    # an approved report is final: it cannot be regenerated
    assert (
        await t.post("/v1/reports/progress", {"student_id": kid["id"], "group_id": grp["id"], "month": MONTH})
    ).status_code == 409

    # --- the student finishes the course: a certificate with a public verification code
    enr = (await ok(await t.get(f"/v1/groups/{grp['id']}/enrollments")))["items"]
    mine = next(e for e in enr if e["student_id"] == kid["id"])
    done = await ok(await t.patch(f"/v1/enrollments/{mine['id']}", {"status": "finished"}))
    cert = await ok(await t.post("/v1/certificates", {"enrollment_id": done["id"]}), 201)
    anon = await ok(await client.get(f"/v1/verify/certificate/{cert['code']}"))
    assert (
        anon["valid"] is True
        and kid["full_name"] not in str(anon)
        and anon["holder"].startswith(kid["full_name"][0])
    )
    await _run(pg_server, fake)
    assert [c["method"] for c in fake.calls] == ["sendMessage", "sendDocument"]  # issuing sent nothing
    await ok(await t.post(f"/v1/certificates/{cert['id']}/send", {"guardian_id": mom["id"]}), 201)
    await _run(pg_server, fake)
    assert len(fake.calls) == 4 and cert["code"] in fake.calls[2]["json"]["text"]

    # --- voiding makes the public check fail, and a reissue gets a new number and code
    await ok(await t.post(f"/v1/certificates/{cert['id']}/void", {"reason": "issued by mistake"}))
    voided = await ok(await client.get(f"/v1/verify/certificate/{cert['code']}"))
    assert voided["valid"] is False
    fresh = await ok(await t.post("/v1/certificates", {"enrollment_id": done["id"]}), 201)
    assert fresh["number"] != cert["number"] and fresh["code"] != cert["code"]
    assert (await ok(await client.get(f"/v1/verify/certificate/{fresh['code']}")))["valid"] is True

    # --- everything is on the student's results card
    card = await ok(await t.get(f"/v1/students/{kid['id']}/results"))
    assert {c["number"] for c in card["certificates"]} >= {fresh["number"]}
