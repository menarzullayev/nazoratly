"""Teacher app (G8): invitations, sign-in, own-groups-only, attendance and QR by the teacher, hours and pay, unmarked lessons
and the reminders, direct messages to guardians (rules, limits, log), staff delivery through the worker."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Any

import httpx
import psycopg
import pytest

from nazoratly.db import Session
from nazoratly.teacher_app import sweep_center
from nazoratly.worker import Worker, WorkerSettings
from tests.conftest import Tenant, make_tenant
from tests.helpers import consent, enroll, mk_group, mk_student, mk_teacher, ok, org_today

PW = "teacher-password-123"


def iso(d: date) -> str:
    return d.isoformat()


async def lesson(
    t: Tenant, group: dict[str, Any], day: date, start: str = "10:00:00", end: str = "11:30:00"
) -> dict[str, Any]:
    return await ok(
        await t.post(
            "/v1/lessons",
            {"group_id": group["id"], "lesson_date": iso(day), "start_time": start, "end_time": end},
        ),
        201,
    )


async def family(
    t: Tenant, student: dict[str, Any], chat_id: int | None = 555111, notify: bool = True
) -> dict[str, Any]:
    body: dict[str, Any] = {"full_name": "Mama"}
    body.update({"telegram_chat_id": chat_id} if chat_id else {"phone": "+998901112233"})
    g = await ok(await t.post("/v1/guardians", body), 201)
    await ok(
        await t.post(
            f"/v1/students/{student['id']}/guardians", {"guardian_id": g["id"], "relation": "mother"}
        ),
        201,
    )
    if notify:
        await consent(t, student["id"], "notifications", g["id"])
    return g


async def invite(t: Tenant, teacher: dict[str, Any]) -> dict[str, Any]:
    return await ok(await t.post(f"/v1/teachers/{teacher['id']}/invitations"), 201)  # type: ignore[no-any-return]


async def accept(client: httpx.AsyncClient, code: str, email: str | None = None, **kw: Any) -> httpx.Response:
    email = email or f"t-{uuid.uuid4().hex[:8]}@example.com"
    return await client.post(
        "/v1/auth/accept-teacher-invite", json={"code": code, "email": email, "password": PW, **kw}
    )


class Center:
    """An owner with a teacher (invited and signed in), her group of two students and one guardian."""

    def __init__(self) -> None:
        self.owner: Tenant
        self.teacher: Tenant
        self.profile: dict[str, Any]
        self.group: dict[str, Any]
        self.students: list[dict[str, Any]]
        self.guardian: dict[str, Any]


async def center(client: httpx.AsyncClient, owner: Tenant, **teacher_kw: Any) -> Center:
    c = Center()
    c.owner = owner
    c.profile = await mk_teacher(owner, **teacher_kw)
    inv = await invite(owner, c.profile)
    email = f"teacher-{uuid.uuid4().hex[:8]}@example.com"
    data = await ok(await accept(client, inv["code"], email), 201)
    c.teacher = Tenant(client, data, email, PW)
    c.group = await mk_group(owner, teacher_id=c.profile["id"])
    c.students = []
    for i in range(2):
        s = await mk_student(owner, f"Pupil {i} {uuid.uuid4().hex[:4]}")
        await enroll(owner, c.group["id"], s["id"], "2026-01-01")
        c.students.append(s)
    c.guardian = await family(owner, c.students[0])
    return c


def sql(super_dsn: str, query: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with psycopg.connect(super_dsn, autocommit=True) as conn:
        cur = conn.execute(query, params)  # type: ignore[arg-type]
        return cur.fetchall() if cur.description else []


# ---- invitation and sign-in ------------------------------------------------------------------------------------------
async def test_owner_invites_teacher_who_signs_in_with_the_code(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    prof = await mk_teacher(tenant)
    inv = await invite(tenant, prof)
    assert (
        inv["code"].startswith("T-")
        and len(inv["code"]) == 10
        and inv["status"] == "valid"
        and inv["link"] is None
    )
    listed = (await ok(await tenant.get("/v1/teacher-invitations")))["items"]
    assert [(i["id"], i["status"], i["teacher_name"]) for i in listed] == [
        (inv["id"], "valid", prof["full_name"])
    ]
    assert "code" not in listed[0]  # the code is shown once

    # sloppy typing is forgiven (lowercase, spaces, missing dash)
    sloppy = inv["code"].lower().replace("-", " ")
    r = await accept(client, sloppy, "ustoz@example.com", full_name="Botir Aliyev")
    data = await ok(r, 201)
    assert data["org"]["role"] == "teacher" and data["org"]["membership_status"] == "active"
    me = await ok(
        await client.get("/v1/teacher/me", headers={"Authorization": f"Bearer {data['access_token']}"})
    )
    assert me["teacher_id"] == prof["id"] and me["messaging_enabled"] is True and me["groups"] == 0
    listed = (await ok(await tenant.get("/v1/teacher-invitations")))["items"]
    assert listed[0]["status"] == "used" and listed[0]["used_via"] == "api" and listed[0]["used_at"]
    # the account can also log in normally afterwards
    assert (
        await client.post("/v1/auth/login", json={"identifier": "ustoz@example.com", "password": PW})
    ).status_code == 200


async def test_invitation_refusals(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant, super_dsn: str
) -> None:
    prof = await mk_teacher(tenant)
    first = await invite(tenant, prof)
    second = await invite(tenant, prof)  # replaces the first
    statuses = {
        i["id"]: i["status"] for i in (await ok(await tenant.get("/v1/teacher-invitations")))["items"]
    }
    assert statuses == {first["id"]: "revoked", second["id"]: "valid"}
    r = await accept(client, first["code"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "invitation_revoked"

    assert (await accept(client, "T-ABCDEFGH")).status_code == 404  # well formed, unknown
    bad = await accept(client, "hello")
    assert bad.status_code == 422 and "invitation code" in bad.json()["error"]["message"]
    assert (await accept(client, "T-ABCDEF0H")).status_code == 422  # a symbol outside the alphabet
    assert (
        await client.post("/v1/auth/accept-teacher-invite", json={"code": second["code"], "password": PW})
    ).status_code == 422  # email or phone needed
    assert (await accept(client, second["code"], password="short")).status_code == 422  # type: ignore[arg-type]

    sql(
        super_dsn,
        "UPDATE teacher_invitations SET expires_at = now() - interval '1 minute' WHERE public_id = %s",
        (second["id"],),
    )
    r = await accept(client, second["code"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "invitation_expired"
    assert (await ok(await tenant.get("/v1/teacher-invitations")))["items"][0]["status"] == "expired"

    third = await invite(tenant, prof)
    email = f"t-{uuid.uuid4().hex[:8]}@example.com"
    await ok(await accept(client, third["code"], email), 201)
    r = await accept(client, third["code"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "invitation_used"
    # a taken email asks the person to sign in instead, and nothing was consumed
    other = await invite(tenant, await mk_teacher(tenant))
    r = await accept(client, other["code"], email)
    assert r.status_code == 409 and "already exists" in r.json()["error"]["message"]
    assert (await accept(client, other["code"])).status_code == 201

    # a teacher with an account cannot be invited again; other centers cannot touch this teacher or its invitations
    assert (await tenant.post(f"/v1/teachers/{prof['id']}/invitations")).status_code == 409
    assert (await tenant_b.post(f"/v1/teachers/{prof['id']}/invitations")).status_code == 404
    assert (await tenant_b.get("/v1/teacher-invitations")).json()["items"] == []
    assert (await tenant_b.delete(f"/v1/teacher-invitations/{second['id']}")).status_code == 404
    # revoking: only an open one
    fresh = await invite(tenant, await mk_teacher(tenant))
    await ok(await tenant.delete(f"/v1/teacher-invitations/{fresh['id']}"))
    assert (await tenant.delete(f"/v1/teacher-invitations/{fresh['id']}")).status_code == 409
    assert (await accept(client, fresh["code"])).status_code == 409


async def test_only_managers_invite(client: httpx.AsyncClient, tenant: Tenant) -> None:
    c = await center(client, tenant)
    spare = await mk_teacher(tenant)
    assert (await c.teacher.post(f"/v1/teachers/{spare['id']}/invitations")).status_code == 403
    assert (await c.teacher.get("/v1/teacher-invitations")).status_code == 403
    assert (
        await c.teacher.patch(f"/v1/teachers/{spare['id']}/messaging", {"enabled": False})
    ).status_code == 403
    assert (await c.teacher.patch("/v1/teacher-app/settings", {"guardian_daily_limit": 1})).status_code == 403
    assert (await c.teacher.get("/v1/teacher-messages")).status_code == 403
    assert (await c.teacher.post("/v1/teacher-app/reminders/run")).status_code == 403
    assert (await client.post(f"/v1/teachers/{spare['id']}/invitations")).status_code == 401


async def test_signed_in_person_accepts_an_invitation_for_their_account(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    prof = await mk_teacher(tenant)
    inv = await invite(tenant, prof)
    elsewhere = await make_tenant(client, "elsewhere")  # owns another center, has an account already
    r = await elsewhere.post("/v1/me/accept-teacher-invite", {"code": inv["code"]})
    org = await ok(r)
    assert org["role"] == "teacher" and org["membership_status"] == "active"
    switched = await ok(await elsewhere.post("/v1/auth/switch", {"org_id": org["id"]}))
    me = await ok(
        await client.get("/v1/teacher/me", headers={"Authorization": f"Bearer {switched['access_token']}"})
    )
    assert me["teacher_id"] == prof["id"]
    assert (await elsewhere.post("/v1/me/accept-teacher-invite", {"code": inv["code"]})).json()["error"][
        "code"
    ] == "invitation_used"
    # the owner of this center cannot take a teacher invitation for their own account
    other = await invite(tenant, await mk_teacher(tenant))
    r = await tenant.post("/v1/me/accept-teacher-invite", {"code": other["code"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "user_has_other_role"


# ---- own groups only ---------------------------------------------------------------------------------------------------
async def test_teacher_sees_only_own_groups_lessons_and_students(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    c = await center(client, tenant)
    stranger = await mk_teacher(tenant)
    other = await mk_group(tenant, teacher_id=stranger["id"])
    o_student = await mk_student(tenant, "Foreign pupil")
    await enroll(tenant, other["id"], o_student["id"], "2026-01-01")
    today = org_today()
    mine = await lesson(tenant, c.group, today)
    theirs = await lesson(tenant, other, today)

    groups = await ok(await c.teacher.get("/v1/teacher/groups"))
    assert [(g["id"], g["students"]) for g in groups] == [(c.group["id"], 2)]
    roster = await ok(await c.teacher.get(f"/v1/teacher/groups/{c.group['id']}/students"))
    assert {s["id"]: s["guardian_reachable"] for s in roster} == {
        c.students[0]["id"]: True,
        c.students[1]["id"]: False,
    }
    assert all(
        set(s) == {"id", "full_name", "guardian_reachable"} for s in roster
    )  # no phone numbers, no chat ids
    assert (await c.teacher.get(f"/v1/teacher/groups/{other['id']}/students")).status_code == 403

    lessons = await ok(await c.teacher.get("/v1/teacher/lessons"))
    assert [x["lesson_id"] for x in lessons] == [mine["id"]]
    assert (await c.teacher.get(f"/v1/lessons/{theirs['id']}/attendance")).status_code == 403
    span = {"date_from": iso(today), "date_to": iso(today)}
    assert [x["id"] for x in (await ok(await c.teacher.get("/v1/lessons", params=span)))["items"]] == [
        mine["id"]
    ]
    assert {mine["id"], theirs["id"]} <= {
        x["id"] for x in (await ok(await tenant.get("/v1/lessons", params=span)))["items"]
    }

    # an owner or any account without a teacher profile gets a clear refusal on the teacher routes
    assert (await tenant.get("/v1/teacher/me")).status_code == 403
    assert (await tenant.get("/v1/teacher/groups")).status_code == 403
    for bad in ({"from": "2026-12-01", "to": "2026-11-01"}, {"from": "2026-01-01", "to": "2026-12-31"}):
        assert (await c.teacher.get("/v1/teacher/lessons", params=bad)).status_code == 422


async def test_teacher_marks_attendance_scans_qr_and_writes_marks(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    c = await center(client, tenant)
    today = org_today()
    les = await lesson(tenant, c.group, today)
    a, b = c.students
    await ok(
        await c.teacher.put(
            f"/v1/lessons/{les['id']}/attendance",
            {
                "records": [
                    {"student_id": a["id"], "status": "present"},
                    {"student_id": b["id"], "status": "late", "minutes_late": 10},
                ]
            },
        )
    )
    mine = (await ok(await c.teacher.get("/v1/teacher/lessons")))[0]
    assert mine["marked"] == 2 and mine["needs_roll_call"] is False and mine["status"] == "held"

    # QR: the code of a student on the roster marks present; a foreign lesson is refused
    qr = (await ok(await tenant.post(f"/v1/students/{b['id']}/qr", {})))["code"]
    scanned = await ok(await c.teacher.post("/v1/attendance/scan", {"code": qr, "lesson_id": les["id"]}))
    assert scanned["result"] in ("marked", "already_present")
    stranger_group = await mk_group(tenant, teacher_id=(await mk_teacher(tenant))["id"])
    foreign = await lesson(tenant, stranger_group, today)
    assert (
        await c.teacher.post("/v1/attendance/scan", {"code": qr, "lesson_id": foreign["id"]})
    ).status_code == 403
    assert (await c.teacher.put(f"/v1/lessons/{foreign['id']}/attendance", {"records": []})).status_code in (
        403,
        422,
    )

    # notes and grades for own students only
    mark = await ok(
        await c.teacher.put(
            "/v1/marks",
            {
                "student_id": a["id"],
                "group_id": c.group["id"],
                "scope": "lesson",
                "lesson_id": les["id"],
                "grade": 5,
                "note": "Zo'r",
            },
        ),
        201,
    )
    assert mark["grade"] == 5
    s2 = await mk_student(tenant, "Not mine")
    await enroll(tenant, stranger_group["id"], s2["id"], "2026-01-01")
    r = await c.teacher.put(
        "/v1/marks",
        {
            "student_id": s2["id"],
            "group_id": stranger_group["id"],
            "scope": "lesson",
            "lesson_id": foreign["id"],
            "grade": 1,
        },
    )
    assert r.status_code == 403


# ---- hours and pay -------------------------------------------------------------------------------------------------------
async def test_hours_and_pay_estimate_and_payroll(client: httpx.AsyncClient, tenant: Tenant) -> None:
    c = await center(client, tenant, pay_model="per_lesson", pay_rate="120000")
    first = org_today().replace(day=1)
    l1 = await lesson(tenant, c.group, first, "10:00:00", "11:30:00")  # 90 min
    l2 = await lesson(tenant, c.group, first + timedelta(days=1), "10:00:00", "11:00:00")  # 60 min
    await lesson(tenant, c.group, first + timedelta(days=2))  # never held: not paid
    for les in (l1, l2):
        await ok(
            await c.teacher.put(
                f"/v1/lessons/{les['id']}/attendance",
                {"records": [{"student_id": c.students[0]["id"], "status": "present"}]},
            )
        )
    pay = await ok(await c.teacher.get("/v1/teacher/pay"))
    assert (pay["lessons"], pay["minutes"], pay["hours"], pay["estimate"], pay["payroll"]) == (
        2,
        150,
        "2.5",
        240000,
        None,
    )
    assert pay["month"] == iso(first) and pay["pay_model"] == "per_lesson"
    gen = await ok(
        await tenant.post("/v1/payrolls/generate", {"teacher_id": c.profile["id"], "month": iso(first)})
    )
    pay = await ok(await c.teacher.get("/v1/teacher/pay", params={"month": first.strftime("%Y-%m")}))
    assert pay["payroll"] == {"status": "draft", "total": gen["total"]} and pay["estimate"] == 240000
    assert (await c.teacher.get("/v1/teacher/pay", params={"month": "2026-13"})).status_code == 422
    # a teacher cannot read payrolls (own pay goes through /teacher/pay only)
    assert (await c.teacher.get("/v1/payrolls")).status_code == 403
    nobody = await ok(await c.teacher.get("/v1/teacher/pay", params={"month": "2020-01"}))
    assert (nobody["lessons"], nobody["hours"], nobody["estimate"]) == (0, "0.0", 0)


async def test_fixed_salary_estimate(client: httpx.AsyncClient, tenant: Tenant) -> None:
    c = await center(client, tenant, pay_model="fixed", pay_rate="3000000")
    pay = await ok(await c.teacher.get("/v1/teacher/pay", params={"month": "2020-01"}))
    assert pay["estimate"] == 3_000_000 and pay["lessons"] == 0


# ---- unmarked lessons and reminders ------------------------------------------------------------------------------------
async def run_sweep(app: Any, super_dsn: str, owner: Tenant, when: datetime) -> dict[str, int]:
    org_id = int(
        sql(super_dsn, "SELECT id FROM organizations WHERE public_id = %s", (uuid.UUID(owner.org_id),))[0][0]
    )
    async with app.state.db.tx(Session(user_id=None, org_id=org_id, actor_type="system")) as conn:
        return await sweep_center(conn, org_id, now=when)


async def test_unmarked_lessons_remind_the_teacher_once_and_the_owner_at_day_end(
    app: Any, client: httpx.AsyncClient, tenant: Tenant, super_dsn: str
) -> None:
    c = await center(client, tenant)
    today = org_today()
    done = await lesson(tenant, c.group, today, "07:00:00", "08:00:00")
    missed = await lesson(tenant, c.group, today, "08:30:00", "09:30:00")
    cancelled = await lesson(tenant, c.group, today, "12:00:00", "13:00:00")
    await ok(await tenant.patch(f"/v1/lessons/{cancelled['id']}", {"status": "cancelled"}))
    await ok(
        await c.teacher.put(
            f"/v1/lessons/{done['id']}/attendance",
            {"records": [{"student_id": c.students[0]["id"], "status": "present"}]},
        )
    )

    t_nine = datetime.combine(today, datetime.min.time()).replace(hour=9, minute=45)
    t_noon = t_nine.replace(hour=12)
    t_eve = t_nine.replace(hour=21)

    assert await run_sweep(app, super_dsn, tenant, t_nine) == {
        "teacher_reminders": 0,
        "digests": 0,
    }  # still inside the wait
    first = await run_sweep(app, super_dsn, tenant, t_noon)  # more than 2 h after 09:30
    assert first == {"teacher_reminders": 1, "digests": 0}  # the digest waits for the evening
    assert await run_sweep(app, super_dsn, tenant, t_noon) == {
        "teacher_reminders": 0,
        "digests": 0,
    }  # idempotent
    mine = (await ok(await c.teacher.get("/v1/notifications")))["items"]
    assert len(mine) == 1 and mine[0]["kind"] == "lesson_unmarked" and mine[0]["read_at"] is None
    assert missed["id"] and "davomat belgilanmagan" in mine[0]["body"] and c.group["name"] in mine[0]["body"]
    assert (await ok(await c.teacher.get("/v1/teacher/me")))["unread_notifications"] == 1
    read = await ok(await c.teacher.post(f"/v1/notifications/{mine[0]['id']}/read"))
    assert read["read_at"]
    assert (await ok(await c.teacher.get("/v1/notifications", params={"unread": True})))["items"] == []

    evening = await run_sweep(app, super_dsn, tenant, t_eve)
    assert evening == {"teacher_reminders": 0, "digests": 1}
    assert await run_sweep(app, super_dsn, tenant, t_eve) == {"teacher_reminders": 0, "digests": 0}
    digest = (await ok(await tenant.get("/v1/notifications")))["items"]
    assert len(digest) == 1 and digest[0]["kind"] == "unmarked_digest"
    assert (
        "(1)" in digest[0]["body"]
        and "08:30-09:30" in digest[0]["body"]
        and c.group["name"] in digest[0]["body"]
    )
    assert (
        "07:00" not in digest[0]["body"] and "12:00" not in digest[0]["body"]
    )  # marked and cancelled lessons are not listed
    # people see only their own notifications
    assert (await ok(await c.teacher.get("/v1/notifications")))["items"][0]["kind"] == "lesson_unmarked"
    assert (await tenant.post(f"/v1/notifications/{mine[0]['id']}/read")).status_code == 404

    # once the roll call is saved the lesson drops out of the unmarked list
    listed = await ok(await tenant.get("/v1/lessons/unmarked"))
    assert [x["lesson_id"] for x in listed if x["group_name"] == c.group["name"]] == [
        missed["id"]
    ] or listed == []


async def test_unmarked_list_is_scoped_and_reminders_can_be_run_by_the_owner(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    c = await center(client, tenant)
    stranger = await mk_teacher(tenant)
    other = await mk_group(tenant, teacher_id=stranger["id"])
    day = org_today() - timedelta(days=1)
    mine = await lesson(tenant, c.group, day, "08:00:00", "09:00:00")
    theirs = await lesson(tenant, other, day, "08:00:00", "09:00:00")
    owner_view = {x["lesson_id"]: x for x in await ok(await tenant.get("/v1/lessons/unmarked"))}
    assert set(owner_view) >= {mine["id"], theirs["id"]} and owner_view[mine["id"]]["state"] == "reminder_due"
    assert owner_view[mine["id"]]["teacher_name"] == c.profile["full_name"]
    teacher_view = await ok(await c.teacher.get("/v1/lessons/unmarked"))
    assert [x["lesson_id"] for x in teacher_view] == [mine["id"]]
    assert (await tenant_b.get("/v1/lessons/unmarked")).json() == []
    ran = await ok(await tenant.post("/v1/teacher-app/reminders/run"))
    assert (
        ran["teacher_reminders"] == 1
    )  # the other teacher has no account: nobody to remind (the owner list shows it)
    assert (await ok(await tenant.post("/v1/teacher-app/reminders/run")))["teacher_reminders"] == 0
    got = (await ok(await c.teacher.get("/v1/notifications")))["items"]
    assert [n["kind"] for n in got] == ["lesson_unmarked"]
    after = await ok(await tenant.get("/v1/lessons/unmarked"))
    assert {x["lesson_id"]: x["state"] for x in after}[mine["id"]] == "reminded"


async def test_app_settings(client: httpx.AsyncClient, tenant: Tenant) -> None:
    s = await ok(await tenant.get("/v1/teacher-app/settings"))
    assert s == {"reminder_after_hours": 2, "guardian_daily_limit": 20, "digest_after": "20:00"}
    s = await ok(
        await tenant.patch(
            "/v1/teacher-app/settings",
            {"reminder_after_hours": 0, "digest_after": "18:30", "guardian_daily_limit": 3},
        )
    )
    assert s == {"reminder_after_hours": 0, "guardian_daily_limit": 3, "digest_after": "18:30"}
    for bad in (
        {"reminder_after_hours": 49},
        {"guardian_daily_limit": -1},
        {"digest_after": "25:00"},
        {"digest_after": "7:5"},
        {"x": 1},
    ):
        assert (await tenant.patch("/v1/teacher-app/settings", bad)).status_code == 422


# ---- messages to guardians -----------------------------------------------------------------------------------------------
async def test_teacher_writes_to_a_guardian_with_a_template_and_free_text(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    c = await center(client, tenant)
    a = c.students[0]
    tpl = await ok(await c.teacher.get("/v1/teacher/message-templates"))
    assert {t["code"] for t in tpl} == {"absent", "late", "homework", "praise", "meeting"}
    sent = await ok(
        await c.teacher.post("/v1/teacher/guardian-messages", {"student_id": a["id"], "template": "praise"}),
        201,
    )
    assert (
        len(sent["sent"]) == 1
        and sent["remaining_today"] == 19
        and sent["sent"][0]["guardian_id"] == c.guardian["id"]
    )
    free = await ok(
        await c.teacher.post(
            "/v1/teacher/guardian-messages", {"student_id": a["id"], "text": "  Ertaga ochiq dars bor.  "}
        ),
        201,
    )
    assert free["remaining_today"] == 18

    mine = (await ok(await c.teacher.get("/v1/teacher/guardian-messages")))["items"]
    assert [m["template"] for m in mine] == [None, "praise"] and mine[0]["delivery"] == "queued"
    assert mine[0]["body"].startswith("Ertaga ochiq dars bor.") and c.profile["full_name"] in mine[0]["body"]
    assert a["full_name"] in mine[1]["body"] and c.group["name"] in mine[1]["body"]
    # the text really is in the outbox, to the right guardian
    outbox = (await ok(await tenant.get("/v1/outbox", params={"limit": 50})))["items"]
    assert {o["body"] for o in outbox} >= {mine[0]["body"], mine[1]["body"]}
    # the owner sees the whole log, with who/what/to whom; filters work
    log = (await ok(await tenant.get("/v1/teacher-messages")))["items"]
    assert (
        len(log) == 2
        and log[0]["teacher_name"] == c.profile["full_name"]
        and log[0]["guardian_name"] == "Mama"
    )
    assert (
        await ok(
            await tenant.get(
                "/v1/teacher-messages", params={"teacher_id": c.profile["id"], "day": iso(org_today())}
            )
        )
    )["items"].__len__() == 2
    assert (await ok(await tenant.get("/v1/teacher-messages", params={"day": "2020-01-01"})))["items"] == []
    me = await ok(await c.teacher.get("/v1/teacher/me"))
    assert (me["messages_sent_today"], me["messages_left_today"]) == (2, 18)
    # nothing in the API can edit or delete the log
    for method in ("put", "patch", "delete"):
        r = await getattr(client, method)(f"/v1/teacher-messages/{log[0]['id']}", headers=tenant.h)
        assert r.status_code in (404, 405)


async def test_guardian_message_refusals(client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant) -> None:
    c = await center(client, tenant)
    a, b = c.students
    post = c.teacher.post
    url = "/v1/teacher/guardian-messages"
    # exactly one of template / text
    assert (await post(url, {"student_id": a["id"]})).status_code == 422
    assert (await post(url, {"student_id": a["id"], "template": "praise", "text": "x"})).status_code == 422
    assert (await post(url, {"student_id": a["id"], "template": "nope"})).status_code == 422
    assert (await post(url, {"student_id": a["id"], "text": "x" * 1001})).status_code == 422
    assert (await post(url, {"student_id": a["id"], "text": "   "})).status_code == 422
    # a student of another teacher / another center
    other_teacher = await mk_teacher(tenant)
    other = await mk_group(tenant, teacher_id=other_teacher["id"])
    foreign = await mk_student(tenant, "Foreign")
    await enroll(tenant, other["id"], foreign["id"], "2026-01-01")
    await family(tenant, foreign, 777)
    r = await post(url, {"student_id": foreign["id"], "text": "Salom"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_own_student"
    assert (await post(url, {"student_id": str(uuid.uuid4()), "text": "Salom"})).status_code == 404
    other_center = await mk_student(tenant_b, "Other center")
    assert (await post(url, {"student_id": other_center["id"], "text": "Salom"})).status_code == 404
    # an unenrolled student is not "own"; the right group must match when given
    loner = await mk_student(tenant, "Loner")
    assert (await post(url, {"student_id": loner["id"], "text": "Salom"})).json()["error"][
        "code"
    ] == "not_own_student"
    assert (await post(url, {"student_id": a["id"], "group_id": other["id"], "text": "Salom"})).json()[
        "error"
    ]["code"] == "not_own_student"
    # nobody can receive it: no guardian, no chat, no consent, reminders off
    r = await post(url, {"student_id": b["id"], "text": "Salom"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_recipient"
    await family(tenant, b, chat_id=None)  # phone only
    assert (await post(url, {"student_id": b["id"], "text": "Salom"})).status_code == 409
    nc = await mk_student(tenant, "No consent")
    await enroll(tenant, c.group["id"], nc["id"], "2026-01-01")
    await family(tenant, nc, 888, notify=False)
    assert (await post(url, {"student_id": nc["id"], "text": "Salom"})).json()["error"][
        "code"
    ] == "no_recipient"
    # a guardian that was asked for must belong to the student
    stranger_g = await ok(
        await tenant.post("/v1/guardians", {"full_name": "Stranger", "telegram_chat_id": 999}), 201
    )
    r = await post(url, {"student_id": a["id"], "guardian_id": stranger_g["id"], "text": "Salom"})
    assert r.json()["error"]["code"] == "no_recipient"
    assert (await ok(await c.teacher.get("/v1/teacher/guardian-messages")))[
        "items"
    ] == []  # nothing was queued by any refusal
    assert (await ok(await tenant.get("/v1/teacher-messages")))["items"] == []


async def test_messaging_right_off_and_daily_limit(client: httpx.AsyncClient, tenant: Tenant) -> None:
    c = await center(client, tenant)
    a = c.students[0]
    url = "/v1/teacher/guardian-messages"
    await ok(await tenant.patch("/v1/teacher-app/settings", {"guardian_daily_limit": 2}))
    await ok(await c.teacher.post(url, {"student_id": a["id"], "text": "Birinchi"}), 201)
    await ok(await c.teacher.post(url, {"student_id": a["id"], "text": "Ikkinchi"}), 201)
    r = await c.teacher.post(url, {"student_id": a["id"], "text": "Uchinchi"})
    assert r.status_code == 429 and r.json()["error"]["code"] == "daily_limit"
    assert (await ok(await c.teacher.get("/v1/teacher/me")))["messages_left_today"] == 0
    await ok(await tenant.patch("/v1/teacher-app/settings", {"guardian_daily_limit": 3}))
    await ok(await c.teacher.post(url, {"student_id": a["id"], "text": "Uchinchi"}), 201)
    assert len((await ok(await tenant.get("/v1/teacher-messages")))["items"]) == 3

    # the owner switches the right off for this teacher only
    sw = await ok(await tenant.patch(f"/v1/teachers/{c.profile['id']}/messaging", {"enabled": False}))
    assert sw == {"teacher_id": c.profile["id"], "enabled": False}
    r = await c.teacher.post(url, {"student_id": a["id"], "text": "Yana"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "messaging_off"
    assert (await ok(await c.teacher.get("/v1/teacher/me")))["messaging_enabled"] is False
    # ...and the log stays readable; switching back works
    assert len((await ok(await c.teacher.get("/v1/teacher/guardian-messages")))["items"]) == 3
    await ok(await tenant.patch("/v1/teachers/" + c.profile["id"] + "/messaging", {"enabled": True}))
    await ok(await tenant.patch("/v1/teacher-app/settings", {"guardian_daily_limit": 10}))
    await ok(await c.teacher.post(url, {"student_id": a["id"], "template": "late"}), 201)
    assert (
        await tenant.patch(f"/v1/teachers/{uuid.uuid4()}/messaging", {"enabled": True})
    ).status_code == 404


# ---- delivery of staff notifications through the worker ----------------------------------------------------------------------
async def test_staff_notifications_are_delivered_to_the_linked_telegram_chat(
    app: Any, client: httpx.AsyncClient, tenant: Tenant, pg_server: dict[str, Any], super_dsn: str
) -> None:
    c = await center(client, tenant)
    sql(
        super_dsn,
        "UPDATE users SET telegram_user_id = %s WHERE id = (SELECT user_id FROM teachers WHERE public_id = %s)",
        (4242424, uuid.UUID(c.profile["id"])),
    )
    await lesson(tenant, c.group, org_today() - timedelta(days=1), "08:00:00", "09:00:00")
    await ok(await tenant.post("/v1/teacher-app/reminders/run"))
    seen: list[dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append({"url": str(req.url), "json": __import__("json").loads(req.content)})
        return httpx.Response(200, json={"ok": True})

    settings = WorkerSettings(
        database_url_worker=pg_server["worker"], telegram_bot_token="123456:TOKEN", worker_batch=100
    )  # type: ignore[arg-type]
    worker = Worker(settings, httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    await worker.open()
    try:
        assert await worker.run_once() >= 1
        mine = [s for s in seen if s["json"].get("chat_id") == 4242424]
        assert len(mine) == 1 and "davomat belgilanmagan" in mine[0]["json"]["text"]
        before = len(seen)
        await worker.run_once()
        assert len(seen) == before  # delivered once
    finally:
        await worker.close()
    rows = sql(
        super_dsn,
        "SELECT delivery FROM staff_notifications WHERE user_id = (SELECT user_id FROM teachers WHERE public_id = %s)",
        (uuid.UUID(c.profile["id"]),),
    )
    assert rows == [("sent",)]


async def test_teacher_message_reaches_the_guardian_chat_through_the_worker(
    client: httpx.AsyncClient, tenant: Tenant, pg_server: dict[str, Any]
) -> None:
    c = await center(client, tenant)
    await ok(
        await c.teacher.post(
            "/v1/teacher/guardian-messages", {"student_id": c.students[0]["id"], "template": "meeting"}
        ),
        201,
    )
    seen: list[dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(__import__("json").loads(req.content))
        return httpx.Response(200, json={"ok": True})

    settings = WorkerSettings(
        database_url_worker=pg_server["worker"], telegram_bot_token="123456:TOKEN", worker_batch=100
    )  # type: ignore[arg-type]
    worker = Worker(settings, httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    await worker.open()
    try:
        await worker.run_once()
    finally:
        await worker.close()
    assert any(s.get("chat_id") == 555111 and c.profile["full_name"] in s["text"] for s in seen)
    assert (await ok(await c.teacher.get("/v1/teacher/guardian-messages")))["items"][0]["delivery"] == "sent"


@pytest.mark.parametrize(
    "path", ["/v1/teacher/me", "/v1/notifications", "/v1/teacher/pay", "/v1/teacher/groups"]
)
async def test_teacher_routes_need_sign_in(client: httpx.AsyncClient, path: str) -> None:
    assert (await client.get(path)).status_code == 401
