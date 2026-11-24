"""Journey 8: the teacher. The owner invites a teacher with a one-time code, the teacher signs in and works only inside their own
groups: roll call, QR, grades, hours and pay estimate. Unmarked lessons produce internal reminders once, and the teacher may
write to a guardian within the rules (own students, daily limit, switch-off) with every message logged and immutable."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, mk_teacher, ok, org_today
from tests.test_teacher_app import accept, center, family, invite, lesson, run_sweep


async def test_invitation_roll_call_reminders_and_guardian_messages(
    app: Any, client: httpx.AsyncClient, tenant: Tenant, super_dsn: str
) -> None:
    t = tenant
    today = org_today()

    # --- the invitation code is one-time: a second account cannot reuse it, a revoked one is dead
    prof = await mk_teacher(t, pay_model="per_lesson", pay_rate="120000")
    inv = await invite(t, prof)
    first = await ok(await accept(client, inv["code"], f"teacher-{uuid.uuid4().hex[:6]}@example.com"), 201)
    assert (await accept(client, inv["code"])).status_code in (404, 409, 422)  # already used
    prof2 = await mk_teacher(t)
    revoked = await invite(t, prof2)
    assert (await t.delete(f"/v1/teacher-invitations/{revoked['id']}")).status_code in (200, 204)
    assert (await accept(client, revoked["code"])).status_code in (404, 409, 422)
    assert first["org"]["role"] == "teacher"

    # --- a signed-in teacher with a group of two students (one has a reachable guardian)
    c = await center(client, t, pay_model="per_lesson", pay_rate="120000")
    a, b = c.students
    stranger = await mk_teacher(t)
    other_group = await mk_group(t, teacher_id=stranger["id"])
    foreign_kid = await mk_student(t, "Foreign pupil")
    await enroll(t, other_group["id"], foreign_kid["id"], "2026-01-01")
    await family(t, foreign_kid, 777001)

    # --- scope: only own groups and lessons; no money, no student directory, no staff administration
    mine = await lesson(t, c.group, today, "07:00:00", "08:00:00")
    missed = await lesson(t, c.group, today, "08:30:00", "09:30:00")
    theirs = await lesson(t, other_group, today)
    assert [g["id"] for g in await ok(await c.teacher.get("/v1/teacher/groups"))] == [c.group["id"]]
    assert (await c.teacher.get(f"/v1/lessons/{theirs['id']}/attendance")).status_code == 403
    assert (await c.teacher.get(f"/v1/teacher/groups/{other_group['id']}/students")).status_code == 403
    for denied in (
        "/v1/payments",
        "/v1/charges",
        "/v1/accounting/entries",
        "/v1/payrolls",
        "/v1/staff",
        "/v1/audit",
    ):
        assert (await c.teacher.get(denied)).status_code == 403, denied
    assert (await c.teacher.get("/v1/students")).status_code == 403
    assert (await c.teacher.post(f"/v1/teachers/{c.profile['id']}/invitations")).status_code == 403
    assert (
        await c.teacher.post(
            "/v1/teacher/guardian-messages", {"student_id": foreign_kid["id"], "text": "Salom"}
        )
    ).status_code == 403

    # --- roll call + QR + a grade; the lesson becomes held and its pay is the teacher's
    await ok(
        await c.teacher.put(
            f"/v1/lessons/{mine['id']}/attendance",
            {
                "records": [
                    {"student_id": a["id"], "status": "present"},
                    {"student_id": b["id"], "status": "late", "minutes_late": 10},
                ]
            },
        )
    )
    qr = (await ok(await t.post(f"/v1/students/{b['id']}/qr", {})))["code"]
    scan = await ok(await c.teacher.post("/v1/attendance/scan", {"code": qr, "lesson_id": mine["id"]}))
    assert scan["result"] in ("marked", "already_present")
    await ok(
        await c.teacher.put(
            "/v1/marks",
            {
                "student_id": a["id"],
                "group_id": c.group["id"],
                "scope": "lesson",
                "lesson_id": mine["id"],
                "grade": 5,
                "note": "Zo'r",
            },
        ),
        201,
    )
    pay = await ok(await c.teacher.get("/v1/teacher/pay"))
    assert (pay["lessons"], pay["minutes"], pay["estimate"], pay["payroll"]) == (1, 60, 120000, None)

    # --- the unmarked lesson: one reminder to the teacher, one digest to the owner, nothing twice, nothing external
    noon = datetime.combine(today, datetime.min.time()).replace(hour=12)
    evening = noon.replace(hour=21)
    assert await run_sweep(app, super_dsn, t, noon) == {"teacher_reminders": 1, "digests": 0}
    assert await run_sweep(app, super_dsn, t, noon) == {"teacher_reminders": 0, "digests": 0}
    assert await run_sweep(app, super_dsn, t, evening) == {"teacher_reminders": 0, "digests": 1}
    note = (await ok(await c.teacher.get("/v1/notifications")))["items"]
    assert [n["kind"] for n in note] == ["lesson_unmarked"] and c.group["name"] in note[0]["body"]
    digest = (await ok(await t.get("/v1/notifications")))["items"]
    assert [n["kind"] for n in digest] == ["unmarked_digest"] and "08:30-09:30" in digest[0]["body"]
    assert (await ok(await t.get("/v1/outbox")))[
        "items"
    ] == []  # reminders are internal: no guardian was told anything
    await ok(
        await c.teacher.put(
            f"/v1/lessons/{missed['id']}/attendance",
            {"records": [{"student_id": a["id"], "status": "absent"}]},
        )
    )
    assert [x for x in await ok(await t.get("/v1/lessons/unmarked")) if x["lesson_id"] == missed["id"]] == []

    # --- the teacher writes to a guardian: a template and free text, a daily limit, the owner's switch
    await ok(await t.patch("/v1/teacher-app/settings", {"guardian_daily_limit": 2}))
    url = "/v1/teacher/guardian-messages"
    await ok(await c.teacher.post(url, {"student_id": a["id"], "template": "praise"}), 201)
    await ok(await c.teacher.post(url, {"student_id": a["id"], "text": "Ertaga ochiq dars bor."}), 201)
    limited = await c.teacher.post(url, {"student_id": a["id"], "text": "Uchinchi"})
    assert limited.status_code == 429 and limited.json()["error"]["code"] == "daily_limit"
    assert (await c.teacher.post(url, {"student_id": b["id"], "text": "Salom"})).json()["error"]["code"] in (
        "no_recipient",
        "daily_limit",
    )
    log = (await ok(await t.get("/v1/teacher-messages")))["items"]
    assert len(log) == 2 and {m["teacher_name"] for m in log} == {c.profile["full_name"]}
    queued = {o["body"] for o in (await ok(await t.get("/v1/outbox", params={"limit": 50})))["items"]}
    assert {m["body"] for m in (await ok(await c.teacher.get(url)))["items"]} <= queued
    await ok(await t.patch(f"/v1/teachers/{c.profile['id']}/messaging", {"enabled": False}))
    off = await c.teacher.post(url, {"student_id": a["id"], "text": "Yana"})
    assert off.status_code == 403 and off.json()["error"]["code"] == "messaging_off"
    for method in ("put", "patch", "delete"):
        r = await getattr(client, method)(f"/v1/teacher-messages/{log[0]['id']}", headers=t.h)
        assert r.status_code in (404, 405)
    assert (
        len((await ok(await t.get("/v1/teacher-messages")))["items"]) == 2
    )  # refusals and the switch left the log as it was
