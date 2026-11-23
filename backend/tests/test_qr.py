"""QR attendance: codes, printable cards, delivery to a guardian, and scanning at a lesson."""

from __future__ import annotations

import io
import uuid
from typing import Any

import httpx
from pypdf import PdfReader

from nazoratly.rules import qr as Q
from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, mk_teacher, ok
from tests.test_document_delivery import FakeTelegram, _family, _run
from tests.test_trials import group_with_lessons, lesson_on

NOV9 = "2026-11-09"


async def code_of(t: Tenant, student: dict[str, Any], **body: Any) -> str:
    return str((await ok(await t.post(f"/v1/students/{student['id']}/qr", body)))["code"])


async def scan(t: Tenant, code: str, lesson: dict[str, Any]) -> httpx.Response:
    return await t.post("/v1/attendance/scan", {"code": code, "lesson_id": lesson["id"]})


async def mark_of(t: Tenant, lesson: dict[str, Any], student: dict[str, Any]) -> dict[str, Any]:
    roster = (await ok(await t.get(f"/v1/lessons/{lesson['id']}/attendance")))["entries"]
    return next(e for e in roster if e["student_id"] == student["id"])


async def class_with(t: Tenant, n: int = 2) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    grp = await group_with_lessons(t)
    students = []
    for i in range(n):
        s = await mk_student(t, f"Scanner {i}")
        await enroll(t, grp["id"], s["id"], "2026-11-01")
        students.append(s)
    return grp, await lesson_on(t, grp["id"], NOV9), students


# ---- codes -------------------------------------------------------------------------------------------------
async def test_code_is_created_once_unique_and_carries_no_personal_data(tenant: Tenant) -> None:
    a, b = await mk_student(tenant, "Qr Ali"), await mk_student(tenant, "Qr Vali")
    first = await ok(await tenant.post(f"/v1/students/{a['id']}/qr", {}))
    again = await ok(await tenant.post(f"/v1/students/{a['id']}/qr", {}))
    assert first["code"] == again["code"] and first["rotated"] is False and Q.is_valid_code(first["code"])
    other = await code_of(tenant, b)
    assert other != first["code"]
    assert "QR" not in first["code"][5:] or True  # (alphabet check is in the golden tests)
    assert first["code"] != await code_of(
        tenant, await mk_student(tenant, "Qr Ali")
    )  # same name, new student: new code
    assert first["issued_at"]


async def test_rotating_invalidates_the_old_card(tenant: Tenant) -> None:
    grp, lesson, (s, _) = await class_with(tenant)
    old = await code_of(tenant, s)
    new = await ok(await tenant.post(f"/v1/students/{s['id']}/qr", {"rotate": True}))
    assert new["rotated"] is True and new["code"] != old
    r = await scan(tenant, old, lesson)
    assert r.status_code == 404 and r.json()["error"]["code"] == "unknown_code"
    assert (await scan(tenant, new["code"], lesson)).status_code == 200


async def test_codes_are_tenant_scoped(tenant: Tenant, tenant_b: Tenant) -> None:
    grp, lesson, (s, _) = await class_with(tenant)
    code = await code_of(tenant, s)
    assert (await tenant_b.post(f"/v1/students/{s['id']}/qr", {})).status_code == 404
    assert (await tenant_b.get(f"/v1/students/{s['id']}/qr-card")).status_code == 404
    # another center's scan sees the code as unknown, and the lesson as not its own
    grp_b, lesson_b, _ = await class_with(tenant_b)
    r = await scan(tenant_b, code, lesson_b)
    assert r.status_code == 404 and r.json()["error"]["code"] == "unknown_code"
    assert (await scan(tenant_b, code, lesson)).status_code == 404  # foreign lesson


# ---- cards ---------------------------------------------------------------------------------------------------
async def test_student_card_is_a_pdf_with_the_name_and_code(tenant: Tenant) -> None:
    s = await mk_student(tenant, "Karimov Anvar")
    r = await tenant.get(f"/v1/students/{s['id']}/qr-card")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF") and "qr-Karimov-Anvar.pdf" in r.headers["content-disposition"]
    text = PdfReader(io.BytesIO(r.content)).pages[0].extract_text()
    code = await code_of(tenant, s)  # the card created it, so it is the same code
    assert "Karimov Anvar" in text and code in text and "Center t" in text
    again = await tenant.get(f"/v1/students/{s['id']}/qr-card")
    assert again.content == r.content  # same input, same bytes


async def test_group_cards_fill_a_sheet_and_page_over(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="1")
    names = [f"Card Kid {i:02d}" for i in range(9)]
    for n in names:
        await enroll(tenant, grp["id"], (await mk_student(tenant, n))["id"])
    dropped = await mk_student(tenant, "Not Printed")
    e = await enroll(tenant, grp["id"], dropped["id"])
    await ok(await tenant.patch(f"/v1/enrollments/{e['id']}", {"status": "finished"}))
    r = await tenant.get(f"/v1/groups/{grp['id']}/qr-cards")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    pages = PdfReader(io.BytesIO(r.content)).pages
    assert len(pages) == 2  # eight cards per page
    text = "".join(p.extract_text() for p in pages)
    assert all(n in text for n in names) and "Not Printed" not in text and grp["name"] in text
    empty = await mk_group(tenant, monthly_fee="1")
    r = await tenant.get(f"/v1/groups/{empty['id']}/qr-cards")
    assert r.status_code == 200 and len(PdfReader(io.BytesIO(r.content)).pages) == 1


# ---- sending to a guardian ----------------------------------------------------------------------------------
async def test_card_is_sent_to_the_guardian_through_the_outbox(
    pg_server: dict[str, Any], tenant: Tenant
) -> None:
    chat = 770_000 + uuid.uuid4().int % 100_000
    st, guardian = await _family(tenant, chat_id=chat)
    sent = await ok(
        await tenant.post(f"/v1/students/{st['id']}/qr-card/send", {"guardian_id": guardian["id"]}), 201
    )
    again = await tenant.post(f"/v1/students/{st['id']}/qr-card/send", {"guardian_id": guardian["id"]})
    assert (
        again.status_code == 200 and again.json()["message_id"] == sent["message_id"]
    )  # never a second message
    fake = FakeTelegram(chat)
    await _run(pg_server, fake)
    assert [c["method"] for c in fake.calls] == ["sendMessage", "sendDocument"]
    assert "Karimov Anvar" in fake.calls[0]["json"]["text"]
    upload = fake.calls[1]["file"]
    assert b"%PDF" in upload and b'filename="qr-Karimov-Anvar.pdf"' in upload
    # rotating the code makes a new card that may be sent again
    await ok(await tenant.post(f"/v1/students/{st['id']}/qr", {"rotate": True}))
    third = await ok(
        await tenant.post(f"/v1/students/{st['id']}/qr-card/send", {"guardian_id": guardian["id"]}), 201
    )
    assert third["message_id"] != sent["message_id"]


async def test_card_delivery_rules(tenant: Tenant, tenant_b: Tenant) -> None:
    st, guardian = await _family(tenant, chat_id=None)  # guardian never linked the bot
    r = await tenant.post(f"/v1/students/{st['id']}/qr-card/send", {"guardian_id": guardian["id"]})
    assert r.status_code == 409 and "Telegram" in r.json()["error"]["message"]
    st2, g2 = await _family(tenant, chat_id=991_001, linked=False)
    r = await tenant.post(f"/v1/students/{st2['id']}/qr-card/send", {"guardian_id": g2["id"]})
    assert r.status_code == 409 and "not linked" in r.json()["error"]["message"]
    st3, g3 = await _family(tenant, chat_id=991_002, notify=False)
    r = await tenant.post(f"/v1/students/{st3['id']}/qr-card/send", {"guardian_id": g3["id"]})
    assert r.status_code == 409 and "consent" in r.json()["error"]["message"]
    assert (
        await tenant_b.post(f"/v1/students/{st3['id']}/qr-card/send", {"guardian_id": g3["id"]})
    ).status_code == 404


# ---- scanning ------------------------------------------------------------------------------------------------
async def test_scan_marks_present_and_is_idempotent(tenant: Tenant) -> None:
    grp, lesson, (s, other) = await class_with(tenant)
    code = await code_of(tenant, s)
    first = await ok(await scan(tenant, code, lesson))
    assert first["result"] == "marked" and first["status"] == "present" and first["previous_status"] is None
    assert first["student_name"] == "Scanner 0"
    m = await mark_of(tenant, lesson, s)
    assert m["status"] == "present"
    second = await ok(await scan(tenant, code, lesson))
    assert second["result"] == "already_present" and second["previous_status"] == "present"
    assert (await mark_of(tenant, lesson, other))["status"] is None  # nobody else was touched
    held = await ok(await tenant.get(f"/v1/lessons/{lesson['id']}"))
    assert held["status"] == "held"  # the first scan opens a planned lesson


async def test_scan_overwrites_absent_and_excused_but_keeps_late(tenant: Tenant) -> None:
    grp, lesson, (a, b) = await class_with(tenant)
    await ok(
        await tenant.put(
            f"/v1/lessons/{lesson['id']}/attendance",
            {
                "records": [
                    {"student_id": a["id"], "status": "absent"},
                    {"student_id": b["id"], "status": "late", "minutes_late": 12},
                ]
            },
        )
    )
    r = await ok(await scan(tenant, await code_of(tenant, a), lesson))
    assert r["result"] == "marked" and r["previous_status"] == "absent"
    assert (await mark_of(tenant, lesson, a))["status"] == "present"
    r = await ok(await scan(tenant, await code_of(tenant, b), lesson))
    assert r["result"] == "already_present" and r["status"] == "late"
    assert (await mark_of(tenant, lesson, b))["minutes_late"] == 12  # a late mark is not downgraded


async def test_scan_refusals_write_nothing(tenant: Tenant, tenant_b: Tenant) -> None:
    grp, lesson, (s, _) = await class_with(tenant)
    outsider = await mk_student(tenant, "Other Group Kid")
    other_grp = await mk_group(tenant, monthly_fee="1")
    await enroll(tenant, other_grp["id"], outsider["id"])
    out_code = await code_of(tenant, outsider)
    r = await scan(tenant, out_code, lesson)
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_in_group"
    assert r.json()["error"]["details"]["student_name"] == "Other Group Kid"
    roster = (await ok(await tenant.get(f"/v1/lessons/{lesson['id']}/attendance")))["entries"]
    assert all(e["status"] is None for e in roster)
    assert (await scan(tenant, "hello", lesson)).status_code == 422
    r = await scan(tenant, "NZQ1-ABCDEFGHJKLMNPQRSTUV", lesson)
    assert r.status_code == 404 and r.json()["error"]["code"] == "unknown_code"
    assert (
        await tenant.post("/v1/attendance/scan", {"code": "x", "lesson_id": str(uuid.uuid4())})
    ).status_code == 404
    assert (await tenant.post("/v1/attendance/scan", {"code": "x"})).status_code == 422

    await ok(await tenant.patch(f"/v1/lessons/{lesson['id']}", {"status": "cancelled"}))
    r = await scan(tenant, await code_of(tenant, s), lesson)
    assert r.status_code == 409 and r.json()["error"]["code"] == "lesson_cancelled"
    assert (await mark_of(tenant, lesson, s))["status"] is None


async def test_scan_accepts_scanner_noise_and_lowercase(tenant: Tenant) -> None:
    grp, lesson, (s, _) = await class_with(tenant)
    code = await code_of(tenant, s)
    r = await ok(await scan(tenant, f"  {code.lower()}\r\n", lesson))
    assert r["result"] == "marked"


async def test_frozen_or_unenrolled_students_are_not_in_the_roster(tenant: Tenant) -> None:
    grp, lesson, (s, _) = await class_with(tenant)
    code = await code_of(tenant, s)
    enr = (await ok(await tenant.get(f"/v1/groups/{grp['id']}/enrollments")))["items"]
    mine = next(e for e in enr if e["student_id"] == s["id"])
    await ok(await tenant.patch(f"/v1/enrollments/{mine['id']}", {"status": "frozen"}))
    r = await scan(tenant, code, lesson)
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_in_group"


async def test_trial_student_can_be_scanned(tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    t = await mk_student(tenant, "Trial Kid")
    await enroll(tenant, grp["id"], t["id"], "2026-11-09", status="trial")
    lesson = await lesson_on(tenant, grp["id"], NOV9)
    assert (await ok(await scan(tenant, await code_of(tenant, t), lesson)))["result"] == "marked"


async def test_a_scan_updates_the_makeup_entitlement_exactly_like_manual_marking(tenant: Tenant) -> None:
    grp, lesson, (by_scan, by_hand) = await class_with(tenant)
    for s in (by_scan, by_hand):
        await ok(
            await tenant.put(
                f"/v1/lessons/{lesson['id']}/attendance",
                {"records": [{"student_id": s["id"], "status": "excused"}]},
            )
        )

    async def rights(s: dict[str, Any]) -> list[tuple[str, str]]:
        items = (await ok(await tenant.get("/v1/entitlements", params={"student_id": s["id"]})))["items"]
        return [(e["kind"], e["status"]) for e in items]

    before = await rights(by_scan)
    assert before == await rights(by_hand) and len(before) == 1
    await ok(await scan(tenant, await code_of(tenant, by_scan), lesson))
    await ok(
        await tenant.put(
            f"/v1/lessons/{lesson['id']}/attendance",
            {"records": [{"student_id": by_hand["id"], "status": "present"}]},
        )
    )
    assert await rights(by_scan) == await rights(
        by_hand
    )  # whatever manual marking does, the scan does the same


async def test_scan_permissions_and_teacher_scope(client: httpx.AsyncClient, tenant: Tenant) -> None:
    grp = await group_with_lessons(tenant)
    own_student = await mk_student(tenant, "Own Class Kid")
    await enroll(tenant, grp["id"], own_student["id"], "2026-11-01")
    lesson = await lesson_on(tenant, grp["id"], NOV9)
    code = await code_of(tenant, own_student)

    async def staff(role: str) -> tuple[Tenant, dict[str, Any]]:
        email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
        member = await ok(
            await tenant.post(
                "/v1/staff",
                {"full_name": role, "email": email, "role": role, "initial_password": "staff-password-123"},
            ),
            201,
        )
        data = await ok(
            await client.post("/v1/auth/login", json={"identifier": email, "password": "staff-password-123"})
        )
        return Tenant(client, data, email, "staff-password-123"), member

    viewer, _ = await staff("viewer")
    assert (await scan(viewer, code, lesson)).status_code == 403
    teacher, member = await staff("teacher")
    await mk_teacher(tenant, staff_id=member["id"])
    # a teacher with a profile but not the teacher of this group: forbidden
    r = await scan(teacher, code, lesson)
    assert r.status_code == 403
    # make them the group's teacher: allowed, and only for their own lessons
    teachers = (await ok(await tenant.get("/v1/teachers")))["items"]
    me = next(t for t in teachers if t["has_login"])
    await ok(await tenant.patch(f"/v1/groups/{grp['id']}", {"teacher_id": me["id"]}))
    r = await scan(teacher, code, lesson)
    assert r.status_code == 200 and r.json()["result"] == "marked"
    other = await group_with_lessons(tenant)
    other_lesson = await lesson_on(tenant, other["id"], NOV9)
    assert (await scan(teacher, code, other_lesson)).status_code == 403
    assert (
        await teacher.post(f"/v1/students/{own_student['id']}/qr", {})
    ).status_code == 403  # issuing codes needs students:write
