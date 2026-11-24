"""Schedule: calendar, room/teacher conflicts, room capacity, substitute teacher + payroll, move/cancel + guardian drafts."""

from __future__ import annotations

import uuid
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import consent, enroll, mk_group, mk_student, mk_teacher, ok

MON = "2026-12-07"  # a Monday
TUE = "2026-12-08"
NEXT_MONTH = "2027-01-04"


async def mk_room(t: Tenant, name: str, capacity: int | None = 20) -> dict[str, Any]:
    b = await ok(await t.post("/v1/branches", {"name": f"Branch {uuid.uuid4().hex[:6]}"}), 201)
    body: dict[str, Any] = {"branch_id": b["id"], "name": name}
    if capacity is not None:
        body["capacity"] = capacity
    return await ok(await t.post("/v1/rooms", body), 201)  # type: ignore[no-any-return]


async def mk_lesson(
    t: Tenant,
    group_id: str,
    day: str = MON,
    start: str = "10:00",
    end: str = "11:00",
    *,
    room_id: str | None = None,
    teacher_id: str | None = None,
    allow: bool = False,
    status: int = 201,
) -> dict[str, Any]:
    body: dict[str, Any] = {"group_id": group_id, "lesson_date": day, "start_time": start, "end_time": end}
    if room_id:
        body["room_id"] = room_id
    if teacher_id:
        body["teacher_id"] = teacher_id
    r = await t.post("/v1/lessons", body, params={"allow_conflict": "true"} if allow else None)
    assert r.status_code == status, r.text
    return r.json()  # type: ignore[no-any-return]


async def staff(client: httpx.AsyncClient, owner: Tenant, role: str) -> tuple[Tenant, dict[str, Any]]:
    email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
    member = await ok(
        await owner.post(
            "/v1/staff",
            {"full_name": role, "email": email, "role": role, "initial_password": "staff-password-123"},
        ),
        201,
    )
    data = await ok(
        await client.post("/v1/auth/login", json={"identifier": email, "password": "staff-password-123"})
    )
    return Tenant(client, data, email, "staff-password-123"), member


async def family(t: Tenant, group_id: str, *, notify: bool = True, chat: int = 777001) -> dict[str, Any]:
    """An enrolled student with a linked guardian (Telegram chat) and, when `notify`, an active notifications consent."""
    st = await mk_student(t, f"Student {uuid.uuid4().hex[:5]}")
    guardian = await ok(await t.post("/v1/guardians", {"full_name": "Dilnoza opa", "telegram_chat_id": chat}), 201)
    await ok(
        await t.post(f"/v1/students/{st['id']}/guardians", {"guardian_id": guardian["id"], "relation": "mother"}),
        201,
    )
    if notify:
        await consent(t, st["id"], "notifications", guardian["id"])
    await enroll(t, group_id, st["id"], "2026-11-01")
    st["guardian"] = guardian
    return st


def kinds(err: dict[str, Any]) -> set[str]:
    return {c["kind"] for c in err["error"]["details"]["conflicts"]}


# ---- conflicts on save --------------------------------------------------------------------------------------------
async def test_room_conflict_is_refused_then_allowed(tenant: Tenant) -> None:
    room = await mk_room(tenant, "R1")
    t1, t2 = await mk_teacher(tenant), await mk_teacher(tenant)
    g1, g2 = await mk_group(tenant, teacher_id=t1["id"]), await mk_group(tenant, teacher_id=t2["id"])
    first = await mk_lesson(tenant, g1["id"], room_id=room["id"])
    r = await tenant.post(
        "/v1/lessons",
        {"group_id": g2["id"], "lesson_date": MON, "start_time": "10:30", "end_time": "11:30", "room_id": room["id"]},
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "schedule_conflict"
    assert kinds(r.json()) == {"room"}
    clash = r.json()["error"]["details"]["conflicts"][0]
    assert clash["lesson_id"] == first["id"] and clash["room"] == "R1" and clash["start_time"] == "10:00"
    # touching times are fine, another day is fine, another room is fine
    await mk_lesson(tenant, g2["id"], start="11:00", end="12:00", room_id=room["id"])
    await mk_lesson(tenant, g2["id"], day=TUE, start="10:30", end="11:30", room_id=room["id"])
    await mk_lesson(tenant, g2["id"], day="2026-12-09", room_id=(await mk_room(tenant, "R2"))["id"])
    # the owner may override
    await mk_lesson(tenant, g2["id"], start="10:30", end="11:30", room_id=room["id"], allow=True)


async def test_teacher_conflict_includes_group_teacher_default(tenant: Tenant) -> None:
    t1 = await mk_teacher(tenant)
    g1, g2 = await mk_group(tenant, teacher_id=t1["id"]), await mk_group(tenant, teacher_id=t1["id"])
    await mk_lesson(tenant, g1["id"])  # teacher defaults to the group's teacher
    r = await tenant.post(
        "/v1/lessons", {"group_id": g2["id"], "lesson_date": MON, "start_time": "10:15", "end_time": "10:45"}
    )
    assert r.status_code == 409 and kinds(r.json()) == {"teacher"}
    other = await mk_teacher(tenant)
    await mk_lesson(tenant, g2["id"], start="10:15", end="10:45", teacher_id=other["id"])  # another teacher: fine


async def test_cancelled_lessons_never_clash_and_reactivation_is_checked(tenant: Tenant) -> None:
    room = await mk_room(tenant, "R1")
    g1, g2 = await mk_group(tenant), await mk_group(tenant)
    a = await mk_lesson(tenant, g1["id"], room_id=room["id"])
    await ok(await tenant.patch(f"/v1/lessons/{a['id']}", {"status": "cancelled"}))
    b = await mk_lesson(tenant, g2["id"], room_id=room["id"])  # the cancelled lesson does not block the room
    r = await tenant.patch(f"/v1/lessons/{a['id']}", {"status": "planned"})  # but bringing it back would clash
    assert r.status_code == 409 and kinds(r.json()) == {"room"}
    assert (await tenant.patch(f"/v1/lessons/{a['id']}", {"status": "planned"}, params={"allow_conflict": "true"})).status_code == 200
    assert b["room_id"] == room["id"]


async def test_patch_lesson_room_and_time_are_checked(tenant: Tenant) -> None:
    room = await mk_room(tenant, "R1")
    g1, g2 = await mk_group(tenant), await mk_group(tenant)
    await mk_lesson(tenant, g1["id"], room_id=room["id"])
    b = await mk_lesson(tenant, g2["id"], start="12:00", end="13:00")
    r = await tenant.patch(f"/v1/lessons/{b['id']}", {"room_id": room["id"], "start_time": "10:30", "end_time": "11:30"})
    assert r.status_code == 409
    bad = await tenant.patch(f"/v1/lessons/{b['id']}", {"start_time": "15:00", "end_time": "14:00"})
    assert bad.status_code == 422
    # saving the same lesson again is not a clash with itself
    await ok(await tenant.patch(f"/v1/lessons/{b['id']}", {"room_id": room["id"]}))


async def test_weekly_schedule_conflicts_and_capacity_warning(tenant: Tenant) -> None:
    room = await mk_room(tenant, "Small", capacity=8)
    t1 = await mk_teacher(tenant)
    g1 = await mk_group(tenant, teacher_id=t1["id"], capacity=12)
    g2 = await mk_group(tenant, teacher_id=t1["id"])
    slot = {"weekday": 1, "start_time": "18:00", "end_time": "19:30", "room_id": room["id"]}
    saved = await ok(await tenant.put(f"/v1/groups/{g1['id']}/schedule", [slot]))
    assert saved["conflicts"] == []
    assert [w["problem"] for w in saved["capacity_warnings"]] == ["group_capacity_over_room"]
    assert saved["capacity_warnings"][0]["room_capacity"] == 8 and saved["capacity_warnings"][0]["group_capacity"] == 12
    # the same teacher and room, overlapping weekday/time, in another group
    r = await tenant.put(f"/v1/groups/{g2['id']}/schedule", [{**slot, "start_time": "19:00", "end_time": "20:00"}])
    assert r.status_code == 409 and r.json()["error"]["code"] == "schedule_conflict"
    assert kinds(r.json()) == {"room", "teacher"}
    allowed = await ok(
        await tenant.put(
            f"/v1/groups/{g2['id']}/schedule",
            [{**slot, "start_time": "19:00", "end_time": "20:00"}],
            params={"allow_conflict": "true"},
        )
    )
    assert len(allowed["conflicts"]) == 2
    # a free weekday is fine
    await ok(await tenant.put(f"/v1/groups/{g2['id']}/schedule", [{**slot, "weekday": 2}]))
    # a group's own slots may not overlap
    own = await tenant.put(
        f"/v1/groups/{g2['id']}/schedule",
        [
            {"weekday": 3, "start_time": "10:00", "end_time": "11:00"},
            {"weekday": 3, "start_time": "10:30", "end_time": "11:30"},
        ],
    )
    assert own.status_code == 422


async def test_unlimited_group_enrolled_over_room_warns(tenant: Tenant) -> None:
    room = await mk_room(tenant, "Tiny", capacity=1)
    g = await mk_group(tenant)  # no capacity limit
    for _ in range(2):
        await enroll(tenant, g["id"], (await mk_student(tenant))["id"])
    saved = await ok(
        await tenant.put(
            f"/v1/groups/{g['id']}/schedule",
            [{"weekday": 4, "start_time": "10:00", "end_time": "11:00", "room_id": room["id"]}],
        )
    )
    assert [w["problem"] for w in saved["capacity_warnings"]] == ["enrolled_over_room"]
    # a room without a capacity never warns
    free = await mk_room(tenant, "Unknown", capacity=None)
    saved = await ok(
        await tenant.put(
            f"/v1/groups/{g['id']}/schedule",
            [{"weekday": 4, "start_time": "10:00", "end_time": "11:00", "room_id": free["id"]}],
        )
    )
    assert saved["capacity_warnings"] == []


async def test_generate_reports_clashing_lessons(tenant: Tenant) -> None:
    room = await mk_room(tenant, "R1")
    g1, g2 = await mk_group(tenant, start_date="2026-12-01"), await mk_group(tenant, start_date="2026-12-01")
    slot = {"weekday": 1, "start_time": "10:00", "end_time": "11:00", "room_id": room["id"]}
    await ok(await tenant.put(f"/v1/groups/{g1['id']}/schedule", [slot]))
    await ok(await tenant.put(f"/v1/groups/{g2['id']}/schedule", [slot], params={"allow_conflict": "true"}))
    rng = {"date_from": MON, "date_to": "2026-12-21"}
    first = await ok(await tenant.post(f"/v1/groups/{g1['id']}/lessons/generate", rng))
    assert first["created"] == 3 and first["conflicting_lessons"] == 0
    second = await ok(await tenant.post(f"/v1/groups/{g2['id']}/lessons/generate", rng))
    assert second["created"] == 3 and second["conflicting_lessons"] == 3


# ---- calendar and checks -------------------------------------------------------------------------------------------
async def test_calendar_week_and_day_with_flags(tenant: Tenant) -> None:
    room = await mk_room(tenant, "R1", capacity=5)
    t1, t2 = await mk_teacher(tenant), await mk_teacher(tenant)
    g1 = await mk_group(tenant, teacher_id=t1["id"], capacity=10)
    g2 = await mk_group(tenant, teacher_id=t2["id"])
    a = await mk_lesson(tenant, g1["id"], room_id=room["id"])
    b = await mk_lesson(tenant, g2["id"], start="10:30", end="11:30", room_id=room["id"], allow=True)
    await mk_lesson(tenant, g2["id"], day=TUE)
    week = await ok(await tenant.get("/v1/calendar", params={"date": "2026-12-09"}))
    assert (week["view"], week["date_from"], week["date_to"]) == ("week", MON, "2026-12-13")
    assert [d["weekday"] for d in week["days"]] == [1, 2, 3, 4, 5, 6, 7]
    monday = week["days"][0]["entries"]
    assert [e["lesson_id"] for e in monday] == [a["id"], b["id"]]
    ea, eb = monday
    assert [(c["kind"], c["lesson_id"]) for c in ea["conflicts"]] == [("room", b["id"])]
    assert [(c["kind"], c["lesson_id"]) for c in eb["conflicts"]] == [("room", a["id"])]
    assert ea["capacity_problem"] == "group_capacity_over_room" and eb["capacity_problem"] == "ok"
    assert ea["teacher_name"] == t1["full_name"] and ea["room_name"] == "R1" and ea["is_substitute"] is False
    assert len(week["days"][1]["entries"]) == 1 and week["days"][2]["entries"] == []
    day = await ok(await tenant.get("/v1/calendar", params={"date": TUE, "view": "day"}))
    assert len(day["days"]) == 1 and len(day["days"][0]["entries"]) == 1
    only_t1 = await ok(await tenant.get("/v1/calendar", params={"date": MON, "teacher_id": t1["id"]}))
    assert [e["lesson_id"] for e in only_t1["days"][0]["entries"]] == [a["id"]]
    only_g2 = await ok(await tenant.get("/v1/calendar", params={"date": MON, "group_id": g2["id"]}))
    assert sum(len(d["entries"]) for d in only_g2["days"]) == 2
    by_room = await ok(await tenant.get("/v1/calendar", params={"date": MON, "room_id": room["id"]}))
    assert sum(len(d["entries"]) for d in by_room["days"]) == 2
    assert (await tenant.get("/v1/calendar", params={"date": "not-a-date"})).status_code == 422


async def test_teacher_calendar_shows_only_own_and_substituted_lessons(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    teacher, member = await staff(client, tenant, "teacher")
    me = await mk_teacher(tenant, staff_id=member["id"])
    other = await mk_teacher(tenant)
    mine, theirs, covered = (
        await mk_group(tenant, teacher_id=me["id"]),
        await mk_group(tenant, teacher_id=other["id"]),
        await mk_group(tenant, teacher_id=other["id"]),
    )
    own = await mk_lesson(tenant, mine["id"])
    await mk_lesson(tenant, theirs["id"], start="12:00", end="13:00")
    sub = await mk_lesson(tenant, covered["id"], start="14:00", end="15:00")
    seen = lambda cal: [e["lesson_id"] for d in cal["days"] for e in d["entries"]]  # noqa: E731
    assert seen(await ok(await teacher.get("/v1/calendar", params={"date": MON}))) == [own["id"]]
    await ok(await tenant.post(f"/v1/lessons/{sub['id']}/substitute", {"teacher_id": me["id"]}))
    cal = await ok(await teacher.get("/v1/calendar", params={"date": MON}))
    assert seen(cal) == [own["id"], sub["id"]]
    assert cal["days"][0]["entries"][1]["is_substitute"] is True
    # lessons endpoint and roll call follow the same rule
    listed = (await ok(await teacher.get("/v1/lessons", params={"date_from": MON, "date_to": MON})))["items"]
    assert {x["id"] for x in listed} == {own["id"], sub["id"]}
    assert (await teacher.get(f"/v1/lessons/{sub['id']}/attendance")).status_code == 200


async def test_schedule_checks_report(client: httpx.AsyncClient, tenant: Tenant) -> None:
    room = await mk_room(tenant, "R1", capacity=4)
    t1 = await mk_teacher(tenant)
    g1 = await mk_group(tenant, teacher_id=t1["id"], capacity=9)
    g2 = await mk_group(tenant, teacher_id=t1["id"])
    await mk_lesson(tenant, g1["id"], room_id=room["id"])
    await mk_lesson(tenant, g2["id"], start="10:30", end="11:30", room_id=room["id"], allow=True)
    rep = await ok(await tenant.get("/v1/schedule/checks", params={"date_from": MON, "date_to": MON}))
    assert sorted(c["kind"] for c in rep["conflicts"]) == ["room", "teacher"]  # each pair reported once
    assert {c["group_a"] for c in rep["conflicts"]} == {g1["name"]}
    assert [w["problem"] for w in rep["capacity"]] == ["group_capacity_over_room"]
    quiet = await ok(await tenant.get("/v1/schedule/checks", params={"date_from": TUE, "date_to": TUE}))
    assert quiet["conflicts"] == []
    assert (await tenant.get("/v1/schedule/checks", params={"date_from": MON, "date_to": "2027-06-01"})).status_code == 422
    assert (await tenant.get("/v1/schedule/checks", params={"date_from": TUE, "date_to": MON})).status_code == 422
    teacher, _ = await staff(client, tenant, "teacher")
    assert (await teacher.get("/v1/schedule/checks", params={"date_from": MON, "date_to": MON})).status_code == 403


# ---- substitute teacher and payroll --------------------------------------------------------------------------------
async def payroll_total(t: Tenant, teacher_id: str, month: str = "2026-12-01") -> tuple[int, dict[str, Any]]:
    p = await ok(await t.post("/v1/payrolls/generate", {"teacher_id": teacher_id, "month": month}))
    return len([i for i in p["items"] if i["kind"] == "lesson"]), p


async def test_substitute_payroll_goes_to_the_substitute(tenant: Tenant) -> None:
    t1 = await mk_teacher(tenant, pay_rate="100000")
    t2 = await mk_teacher(tenant, pay_rate="80000")
    grp = await mk_group(tenant, teacher_id=t1["id"])
    les = await mk_lesson(tenant, grp["id"])
    await ok(await tenant.patch(f"/v1/lessons/{les['id']}", {"status": "held"}))
    assert (await payroll_total(tenant, t1["id"]))[0] == 1  # a draft payroll with the lesson exists
    res = await ok(await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": t2["id"], "reason": "sick"}))
    assert res["kind"] == "substitute" and res["lesson"]["substitute_teacher_id"] == t2["id"]
    assert res["lesson"]["effective_teacher_id"] == t2["id"] and res["lesson"]["teacher_id"] == t1["id"]
    assert res["draft_payroll_lines_removed"] == 1  # the old teacher's draft line left the draft
    effect = {e["teacher_id"]: e for e in res["payroll_effect"]}
    assert effect[t1["id"]]["delta"] == "-100000.00" and effect[t2["id"]]["delta"] == "80000.00"
    assert effect[t1["id"]]["month"] == "2026-12" and effect[t1["id"]]["payroll_status"] == "draft"
    n1, _ = await payroll_total(tenant, t1["id"])
    n2, p2 = await payroll_total(tenant, t2["id"])
    assert (n1, n2) == (0, 1)
    assert [i["amount"] for i in p2["items"] if i["kind"] == "lesson"] == ["80000.00"]
    # clearing the substitute gives the lesson back
    back = await ok(await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": None}))
    assert back["lesson"]["substitute_teacher_id"] is None and back["lesson"]["effective_teacher_id"] == t1["id"]
    assert (await payroll_total(tenant, t1["id"]))[0] == 1 and (await payroll_total(tenant, t2["id"]))[0] == 0
    hist = await ok(await tenant.get(f"/v1/lessons/{les['id']}/changes"))
    assert [h["kind"] for h in hist] == ["substitute", "substitute"]
    assert hist[0]["reason"] == "sick" and hist[0]["new_teacher_name"] == t2["full_name"]


async def test_substitute_rules(tenant: Tenant, tenant_b: Tenant) -> None:
    t1, t2 = await mk_teacher(tenant), await mk_teacher(tenant)
    g1, g2 = await mk_group(tenant, teacher_id=t1["id"]), await mk_group(tenant, teacher_id=t2["id"])
    les = await mk_lesson(tenant, g1["id"])
    await mk_lesson(tenant, g2["id"], start="10:30", end="11:30")  # t2 is busy then
    busy = await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": t2["id"]})
    assert busy.status_code == 409 and kinds(busy.json()) == {"teacher"}
    forced = await ok(
        await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": t2["id"], "allow_conflict": True})
    )
    assert len(forced["allowed_conflicts"]) == 1
    same = await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": t2["id"], "allow_conflict": True})
    assert same.status_code == 422  # already the substitute
    t3 = await mk_teacher(tenant)
    await ok(await tenant.patch(f"/v1/teachers/{t3['id']}", {"status": "inactive"}))
    assert (await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": t3["id"]})).status_code == 422
    assert (await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": str(uuid.uuid4())})).status_code == 404
    foreign = await mk_teacher(tenant_b)
    assert (await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": foreign["id"]})).status_code == 404
    assert (await tenant_b.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": foreign["id"]})).status_code == 404


async def test_fixed_salary_teacher_loses_nothing_and_substitute_per_lesson_gains(tenant: Tenant) -> None:
    fixed = await mk_teacher(tenant, pay_model="fixed", pay_rate="5000000")
    sub = await mk_teacher(tenant, pay_rate="70000")
    grp = await mk_group(tenant, teacher_id=fixed["id"])
    les = await mk_lesson(tenant, grp["id"])
    res = await ok(await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": sub["id"]}))
    assert [(e["teacher_id"], e["delta"]) for e in res["payroll_effect"]] == [(sub["id"], "70000.00")]


async def test_lesson_in_approved_payroll_cannot_be_changed(tenant: Tenant) -> None:
    t1, t2 = await mk_teacher(tenant), await mk_teacher(tenant)
    grp = await mk_group(tenant, teacher_id=t1["id"])
    les = await mk_lesson(tenant, grp["id"])
    await ok(await tenant.patch(f"/v1/lessons/{les['id']}", {"status": "held"}))
    _, pay = await payroll_total(tenant, t1["id"])
    await ok(await tenant.post(f"/v1/payrolls/{pay['id']}/approve"))
    r = await tenant.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": t2["id"]})
    assert r.status_code == 409 and "payroll" in r.json()["error"]["message"]


# ---- cancel --------------------------------------------------------------------------------------------------------
async def test_cancel_prepares_drafts_and_changes_payroll(tenant: Tenant) -> None:
    t1 = await mk_teacher(tenant, pay_rate="100000")
    grp = await mk_group(tenant, teacher_id=t1["id"], name="Ingliz A1")
    les = await mk_lesson(tenant, grp["id"])
    kid = await family(tenant, grp["id"])
    await family(tenant, grp["id"], notify=False)  # nobody can be told about this one
    res = await ok(await tenant.post(f"/v1/lessons/{les['id']}/cancel", {"reason": "teacher is ill"}))
    assert res["lesson"]["status"] == "cancelled" and res["lesson"]["cancel_reason"] == "teacher is ill"
    assert res["notices_created"] == 1 and res["students_without_notice"] == 1
    assert [(e["teacher_id"], e["delta"], e["month"]) for e in res["payroll_effect"]] == [
        (t1["id"], "-100000.00", "2026-12")
    ]
    notices = (await ok(await tenant.get("/v1/schedule-notices")))["items"]
    mine = [n for n in notices if n["student_id"] == kid["id"]]
    assert len(mine) == 1 and mine[0]["status"] == "pending" and mine[0]["kind"] == "cancel"
    assert "Ingliz A1" in mine[0]["body"] and "07.12.2026 10:00" in mine[0]["body"] and "teacher is ill" in mine[0]["body"]
    # nothing was queued for sending: a draft is not a message
    out = (await ok(await tenant.get("/v1/outbox")))["items"]
    assert out == []
    again = await tenant.post(f"/v1/lessons/{les['id']}/cancel", {})
    assert again.status_code == 409  # only planned lessons


async def test_cancel_refused_for_held_lessons_and_attendance(tenant: Tenant) -> None:
    grp = await mk_group(tenant)
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], "2026-11-01")
    les = await mk_lesson(tenant, grp["id"])
    await ok(
        await tenant.put(
            f"/v1/lessons/{les['id']}/attendance", {"records": [{"student_id": st["id"], "status": "present"}]}
        )
    )  # the lesson becomes 'held'
    r = await tenant.post(f"/v1/lessons/{les['id']}/cancel", {})
    assert r.status_code == 409
    planned = await mk_lesson(tenant, grp["id"], day=TUE)
    assert (await tenant.post(f"/v1/lessons/{planned['id']}/cancel", {"notify": False})).status_code == 200


async def test_cancel_without_notify_creates_no_drafts(tenant: Tenant) -> None:
    grp = await mk_group(tenant)
    await family(tenant, grp["id"])
    les = await mk_lesson(tenant, grp["id"])
    res = await ok(await tenant.post(f"/v1/lessons/{les['id']}/cancel", {"notify": False}))
    assert res["notices_created"] == 0
    assert (await ok(await tenant.get("/v1/schedule-notices")))["items"] == []


async def test_held_lesson_with_a_payroll_line_cannot_be_cancelled(tenant: Tenant) -> None:
    t1 = await mk_teacher(tenant, pay_rate="100000")
    grp = await mk_group(tenant, teacher_id=t1["id"])
    les = await mk_lesson(tenant, grp["id"])
    await ok(await tenant.patch(f"/v1/lessons/{les['id']}", {"status": "held"}))
    n, _ = await payroll_total(tenant, t1["id"])
    assert n == 1
    assert (await tenant.post(f"/v1/lessons/{les['id']}/cancel", {})).status_code == 409


# ---- move ----------------------------------------------------------------------------------------------------------
async def test_move_updates_lesson_keeps_the_original_and_prepares_drafts(tenant: Tenant) -> None:
    t1 = await mk_teacher(tenant)
    grp = await mk_group(tenant, teacher_id=t1["id"], name="Matematika")
    kid = await family(tenant, grp["id"])
    les = await mk_lesson(tenant, grp["id"])
    res = await ok(
        await tenant.post(
            f"/v1/lessons/{les['id']}/move",
            {"lesson_date": "2026-12-09", "start_time": "12:00", "end_time": "13:00", "reason": "Holiday."},
        )
    )
    moved = res["lesson"]
    assert (moved["lesson_date"], moved["start_time"], moved["end_time"]) == ("2026-12-09", "12:00:00", "13:00:00")
    assert (moved["original_date"], moved["original_start_time"]) == (MON, "10:00:00")
    assert res["payroll_effect"] == [] and res["notices_created"] == 1
    again = await ok(
        await tenant.post(
            f"/v1/lessons/{les['id']}/move",
            {"lesson_date": "2026-12-10", "start_time": "12:00", "end_time": "13:00", "notify": False},
        )
    )
    assert again["lesson"]["original_date"] == MON  # the first date is kept
    notice = [n for n in (await ok(await tenant.get("/v1/schedule-notices")))["items"] if n["student_id"] == kid["id"]]
    assert len(notice) == 1 and notice[0]["kind"] == "move" and notice[0]["new_date"] == "2026-12-09"
    assert "09.12.2026 12:00" in notice[0]["body"] and "Sabab: Holiday." in notice[0]["body"]
    hist = await ok(await tenant.get(f"/v1/lessons/{les['id']}/changes"))
    assert [(h["kind"], h["notices"]) for h in hist] == [("move", 1), ("move", 0)]


async def test_move_to_next_month_shifts_per_lesson_pay(tenant: Tenant) -> None:
    t1 = await mk_teacher(tenant, pay_rate="100000")
    grp = await mk_group(tenant, teacher_id=t1["id"])
    les = await mk_lesson(tenant, grp["id"], day="2026-12-28")
    res = await ok(
        await tenant.post(
            f"/v1/lessons/{les['id']}/move",
            {"lesson_date": NEXT_MONTH, "start_time": "10:00", "end_time": "11:00", "notify": False},
        )
    )
    assert [(e["month"], e["delta"]) for e in res["payroll_effect"]] == [("2026-12", "-100000.00"), ("2027-01", "100000.00")]


async def test_move_rules(tenant: Tenant) -> None:
    room = await mk_room(tenant, "R1")
    t1 = await mk_teacher(tenant)
    g1, g2 = await mk_group(tenant, teacher_id=t1["id"]), await mk_group(tenant)
    les = await mk_lesson(tenant, g1["id"])
    await mk_lesson(tenant, g2["id"], day=TUE, start="12:00", end="13:00", room_id=room["id"])
    same = {"lesson_date": MON, "start_time": "10:00", "end_time": "11:00"}
    assert (await tenant.post(f"/v1/lessons/{les['id']}/move", same)).status_code == 422
    inverted = {"lesson_date": TUE, "start_time": "14:00", "end_time": "13:00"}
    assert (await tenant.post(f"/v1/lessons/{les['id']}/move", inverted)).status_code == 422
    clash = {"lesson_date": TUE, "start_time": "12:30", "end_time": "13:30", "room_id": room["id"]}
    r = await tenant.post(f"/v1/lessons/{les['id']}/move", clash)
    assert r.status_code == 409 and kinds(r.json()) == {"room"}
    ok_move = await ok(await tenant.post(f"/v1/lessons/{les['id']}/move", {**clash, "allow_conflict": True, "notify": False}))
    assert len(ok_move["allowed_conflicts"]) == 1
    # the same group may not have two lessons at the same start
    twin = await mk_lesson(tenant, g1["id"], day="2026-12-11")
    dup = await tenant.post(
        f"/v1/lessons/{twin['id']}/move", {"lesson_date": TUE, "start_time": "12:30", "end_time": "13:00"}
    )
    assert dup.status_code == 409
    # moved/cancelled lessons cannot be moved again
    await ok(await tenant.post(f"/v1/lessons/{twin['id']}/cancel", {"notify": False}))
    done = await tenant.post(
        f"/v1/lessons/{twin['id']}/move", {"lesson_date": "2026-12-12", "start_time": "09:00", "end_time": "10:00"}
    )
    assert done.status_code == 409


async def test_changes_need_write_permission_and_are_tenant_scoped(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    grp = await mk_group(tenant)
    les = await mk_lesson(tenant, grp["id"])
    teacher, member = await staff(client, tenant, "teacher")
    await mk_teacher(tenant, staff_id=member["id"])
    viewer, _ = await staff(client, tenant, "viewer")
    body = {"lesson_date": TUE, "start_time": "10:00", "end_time": "11:00"}
    for who in (teacher, viewer):
        assert (await who.post(f"/v1/lessons/{les['id']}/move", body)).status_code == 403
        assert (await who.post(f"/v1/lessons/{les['id']}/cancel", {})).status_code == 403
        assert (await who.post(f"/v1/lessons/{les['id']}/substitute", {"teacher_id": None})).status_code == 403
        assert (await who.get("/v1/schedule-notices")).status_code == 403
    assert (await tenant_b.post(f"/v1/lessons/{les['id']}/move", body)).status_code == 404
    assert (await tenant_b.post(f"/v1/lessons/{les['id']}/cancel", {})).status_code == 404
    assert (await tenant_b.get(f"/v1/lessons/{les['id']}/changes")).status_code == 404
    manager, _ = await staff(client, tenant, "manager")
    assert (await manager.post(f"/v1/lessons/{les['id']}/move", body)).status_code == 200


# ---- notices: a person approves -----------------------------------------------------------------------------------
async def test_notice_approval_queues_the_message_and_is_final(tenant: Tenant, tenant_b: Tenant) -> None:
    grp = await mk_group(tenant)
    kid = await family(tenant, grp["id"], chat=777002)
    les = await mk_lesson(tenant, grp["id"])
    await ok(await tenant.post(f"/v1/lessons/{les['id']}/cancel", {"reason": "snow"}))
    (n,) = (await ok(await tenant.get("/v1/schedule-notices")))["items"]
    assert (await tenant_b.post(f"/v1/schedule-notices/{n['id']}/approve", {})).status_code == 404
    approved = await ok(await tenant.post(f"/v1/schedule-notices/{n['id']}/approve", {}))
    assert approved["status"] == "approved" and approved["decided_at"] is not None
    (msg,) = (await ok(await tenant.get("/v1/outbox")))["items"]
    assert msg["status"] == "queued" and msg["channel"] == "telegram" and msg["body"] == n["body"]
    assert msg["student_id"] == kid["id"] and msg["draft_id"] is None
    assert (await tenant.post(f"/v1/schedule-notices/{n['id']}/approve", {})).status_code == 409
    assert (await tenant.post(f"/v1/schedule-notices/{n['id']}/reject")).status_code == 409
    assert (await ok(await tenant.get("/v1/schedule-notices")))["items"] == []  # default filter: pending
    done = (await ok(await tenant.get("/v1/schedule-notices", params={"status": "approved"})))["items"]
    assert [x["id"] for x in done] == [n["id"]]
    assert len((await ok(await tenant.get("/v1/outbox")))["items"]) == 1  # one message, not two


async def test_rejected_notice_sends_nothing(tenant: Tenant) -> None:
    grp = await mk_group(tenant)
    await family(tenant, grp["id"])
    les = await mk_lesson(tenant, grp["id"])
    await ok(await tenant.post(f"/v1/lessons/{les['id']}/cancel", {}))
    (n,) = (await ok(await tenant.get("/v1/schedule-notices")))["items"]
    rejected = await ok(await tenant.post(f"/v1/schedule-notices/{n['id']}/reject"))
    assert rejected["status"] == "rejected"
    assert (await tenant.post(f"/v1/schedule-notices/{n['id']}/approve", {})).status_code == 409
    assert (await ok(await tenant.get("/v1/outbox")))["items"] == []


async def test_approval_rechecks_consent_and_channel(tenant: Tenant) -> None:
    grp = await mk_group(tenant)
    kid = await family(tenant, grp["id"])
    les = await mk_lesson(tenant, grp["id"])
    await ok(await tenant.post(f"/v1/lessons/{les['id']}/cancel", {}))
    (n,) = (await ok(await tenant.get("/v1/schedule-notices")))["items"]
    sms = await tenant.post(f"/v1/schedule-notices/{n['id']}/approve", {"channel": "sms"})
    assert sms.status_code == 409  # the guardian has no phone number
    detail = await ok(await tenant.get(f"/v1/students/{kid['id']}"))
    notifications = next(c for c in detail["consents"] if c["purpose"] == "notifications")
    await ok(await tenant.post(f"/v1/consents/{notifications['id']}/revoke"))
    r = await tenant.post(f"/v1/schedule-notices/{n['id']}/approve", {})
    assert r.status_code == 409 and "no longer" in r.json()["error"]["message"]
    assert (await ok(await tenant.get("/v1/outbox")))["items"] == []
    still = (await ok(await tenant.get("/v1/schedule-notices")))["items"]
    assert [x["status"] for x in still] == ["pending"]
