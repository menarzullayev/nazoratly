"""Journey 2: schedule a week with rooms and teachers, hit conflicts, cover for a sick teacher, move and cancel lessons.

Money and messages follow the schedule: a substitute moves the per-lesson pay, a move/cancel prepares guardian notices that
only go out after a person approves them (Model B), and an approved payroll freezes its lessons."""

from __future__ import annotations

from typing import Any

import httpx

from tests.conftest import Tenant
from tests.e2e.journeys import A, assert_books_sound, money
from tests.helpers import mk_group, mk_teacher, ok
from tests.test_schedule import MON, family, mk_lesson, mk_room, staff

DEC = "2026-12-01"


async def payroll(t: Tenant, teacher_id: str) -> dict[str, Any]:
    return await ok(await t.post("/v1/payrolls/generate", {"teacher_id": teacher_id, "month": DEC}))  # type: ignore[no-any-return]


def lesson_items(pr: dict[str, Any]) -> list[str]:
    return [i["amount"] for i in pr["items"] if i["kind"] == "lesson"]


async def test_week_with_conflicts_substitute_move_cancel_and_payroll(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    t = tenant
    room = await mk_room(t, "Xona 1")
    ali, vali = await mk_teacher(t, pay_rate="100000"), await mk_teacher(t, pay_rate="80000")
    g1 = await mk_group(t, teacher_id=ali["id"], name="Ingliz A1")
    g2 = await mk_group(t, teacher_id=ali["id"], name="Ingliz B1")
    kid1 = await family(t, g1["id"], chat=881001)
    kid2 = await family(t, g1["id"], chat=881002)

    # --- Monday 10:00 in Xona 1; the second group of the same teacher and room clashes on both counts
    first = await mk_lesson(t, g1["id"], room_id=room["id"])
    clash = await t.post(
        "/v1/lessons",
        {"group_id": g2["id"], "lesson_date": MON, "start_time": "10:30", "end_time": "11:30", "room_id": room["id"]},
    )
    assert clash.status_code == 409 and clash.json()["error"]["code"] == "schedule_conflict"
    assert {c["kind"] for c in clash.json()["error"]["details"]["conflicts"]} == {"room", "teacher"}

    # --- roles that may write the schedule can override (API.md says "egasi"; the code allows academics:write); a teacher cannot
    teacher_login, _ = await staff(client, t, "teacher")
    body = {"group_id": g2["id"], "lesson_date": MON, "start_time": "10:30", "end_time": "11:30", "room_id": room["id"]}
    assert (await teacher_login.post("/v1/lessons", body)).status_code == 403
    manager, _ = await staff(client, t, "manager")
    assert (await manager.post("/v1/lessons", body)).status_code == 409
    overridden = await ok(await manager.post("/v1/lessons", body, params={"allow_conflict": "true"}), 201)
    checks = await ok(await t.get("/v1/schedule/checks", params={"date_from": MON, "date_to": MON}))
    assert {c["kind"] for c in checks["conflicts"]} >= {"room", "teacher"}

    # fix the clash for real: move the second group's lesson to Tuesday (a move re-checks conflicts too)
    moved = await ok(
        await t.post(
            f"/v1/lessons/{overridden['id']}/move",
            {"lesson_date": "2026-12-08", "start_time": "10:30", "end_time": "11:30", "room_id": room["id"], "reason": "room clash", "notify": False},
        )
    )
    assert moved["lesson"]["lesson_date"] == "2026-12-08"
    checks = await ok(await t.get("/v1/schedule/checks", params={"date_from": MON, "date_to": MON}))
    assert checks["conflicts"] == []

    # --- the first lesson is held: Ali earns 100000 in a draft payroll
    await ok(await t.patch(f"/v1/lessons/{first['id']}", {"status": "held"}))
    assert lesson_items(await payroll(t, ali["id"])) == ["100000.00"]

    # --- Ali is ill for the next lesson: Vali covers, the per-lesson pay moves with the lesson
    second = await mk_lesson(t, g1["id"], day="2026-12-14", room_id=room["id"])
    await ok(await t.patch(f"/v1/lessons/{second['id']}", {"status": "held"}))
    assert lesson_items(await payroll(t, ali["id"])) == ["100000.00", "100000.00"]
    sub = await ok(await t.post(f"/v1/lessons/{second['id']}/substitute", {"teacher_id": vali["id"], "reason": "Ali is ill"}))
    effect = {e["teacher_id"]: e for e in sub["payroll_effect"]}
    assert effect[ali["id"]]["delta"] == "-100000.00" and effect[vali["id"]]["delta"] == "80000.00"
    assert lesson_items(await payroll(t, ali["id"])) == ["100000.00"]
    vali_pr = await payroll(t, vali["id"])
    assert lesson_items(vali_pr) == ["80000.00"]

    # --- move a planned lesson: notices are drafts, nothing is sent until a person approves
    third = await mk_lesson(t, g1["id"], day="2026-12-21", room_id=room["id"])
    mv = await ok(
        await t.post(
            f"/v1/lessons/{third['id']}/move",
            {"lesson_date": "2026-12-23", "start_time": "12:00", "end_time": "13:00", "room_id": room["id"], "reason": "New Year concert"},
        )
    )
    assert mv["notices_created"] == 2
    notices = (await ok(await t.get("/v1/schedule-notices")))["items"]
    assert len(notices) == 2 and {n["status"] for n in notices} == {"pending"}
    assert (await ok(await t.get("/v1/outbox")))["items"] == []
    by_student = {n["student_id"]: n for n in notices}
    await ok(await t.post(f"/v1/schedule-notices/{by_student[kid1['id']]['id']}/approve", {}))
    await ok(await t.post(f"/v1/schedule-notices/{by_student[kid2['id']]['id']}/reject"))
    out = (await ok(await t.get("/v1/outbox")))["items"]
    assert [m["student_id"] for m in out] == [kid1["id"]] and out[0]["status"] == "queued"
    assert "23.12.2026 12:00" in out[0]["body"]

    # --- cancel a planned lesson: a notice draft is prepared again, an unmarked per-lesson pay is unaffected
    fourth = await mk_lesson(t, g1["id"], day="2026-12-28", room_id=room["id"])
    cancelled = await ok(await t.post(f"/v1/lessons/{fourth['id']}/cancel", {"reason": "holiday"}))
    assert cancelled["lesson"]["status"] == "cancelled" and cancelled["notices_created"] == 2
    assert (await t.post(f"/v1/lessons/{fourth['id']}/cancel", {})).status_code == 409
    hist = await ok(await t.get(f"/v1/lessons/{third['id']}/changes"))
    assert [h["kind"] for h in hist] == ["move"]

    # --- approving the payroll freezes its lessons; the books follow approval and payment
    pr = await payroll(t, vali["id"])
    approved = await ok(await t.post(f"/v1/payrolls/{pr['id']}/approve"))
    assert money(approved["total"]) == 80000
    frozen = await t.post(f"/v1/lessons/{second['id']}/substitute", {"teacher_id": ali["id"], "reason": "back"})
    assert frozen.status_code == 409
    await ok(await t.post(f"/v1/payrolls/{pr['id']}/pay"))
    tb = await assert_books_sound(t)
    rows = {r["code"]: r for r in tb["rows"]}
    assert money(rows["5100"]["balance_debit"]) == 80000 and money(rows["2100"]["balance_debit"]) == 0
    assert money(rows["1000"]["balance_credit"]) == 80000
    payables = await ok(await t.get(f"{A}/reports/payables-aging"))
    assert payables is not None
