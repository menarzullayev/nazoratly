"""Excused absence: entitlements (make-up right / credit / none), make-up scheduling, credits at charge generation."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, ok

MARCH = {"date_from": "2026-03-01", "date_to": "2026-03-31"}


async def lesson(t: Tenant, group_id: str, day: date, start: str = "10:00:00") -> dict[str, Any]:
    end = f"{int(start[:2]) + 1:02d}:00:00"
    return await ok(
        await t.post(
            "/v1/lessons",
            {"group_id": group_id, "lesson_date": day.isoformat(), "start_time": start, "end_time": end},
        ),
        201,
    )


async def mark(t: Tenant, lesson_id: str, student_id: str, status: str) -> None:
    await ok(
        await t.put(
            f"/v1/lessons/{lesson_id}/attendance", {"records": [{"student_id": student_id, "status": status}]}
        )
    )


async def rights(t: Tenant, **params: Any) -> list[dict[str, Any]]:
    return (await ok(await t.get("/v1/entitlements", params=params)))["items"]


async def setup(t: Tenant, fee: str = "600000") -> tuple[dict[str, Any], dict[str, Any]]:
    grp = await mk_group(t, monthly_fee=fee)
    st = await mk_student(t)
    await enroll(t, grp["id"], st["id"], "2026-01-01")
    return grp, st


# ---- settings --------------------------------------------------------------------------------------------
async def test_settings_expose_the_makeup_options(tenant: Tenant) -> None:
    s = await ok(await tenant.get("/v1/settings"))
    assert (s["excused_mode"], s["makeup_expiry_days"], s["makeup_lapses"]) == ("makeup", 30, True)
    s = await ok(
        await tenant.patch(
            "/v1/settings", {"excused_mode": "credit", "makeup_expiry_days": 10, "makeup_lapses": False}
        )
    )
    assert (s["excused_mode"], s["makeup_expiry_days"], s["makeup_lapses"]) == ("credit", 10, False)
    assert (await tenant.patch("/v1/settings", {"excused_mode": "bogus"})).status_code == 422
    assert (await tenant.patch("/v1/settings", {"makeup_expiry_days": 366})).status_code == 422


# ---- creation, idempotency, cancellation -----------------------------------------------------------------
async def test_excused_creates_one_makeup_right_with_expiry(tenant: Tenant) -> None:
    grp, st = await setup(tenant)
    missed = date.today() - timedelta(days=3)
    les = await lesson(tenant, grp["id"], missed)
    await mark(tenant, les["id"], st["id"], "excused")
    await mark(tenant, les["id"], st["id"], "excused")  # saving the roll call again changes nothing
    items = await rights(tenant)
    assert len(items) == 1
    r = items[0]
    assert (r["kind"], r["status"], r["effective_status"], r["amount"]) == ("makeup", "open", "open", None)
    assert (
        r["expires_on"] == (missed + timedelta(days=30)).isoformat() and r["missed_on"] == missed.isoformat()
    )
    assert r["student_id"] == st["id"]


async def test_changing_the_mark_cancels_an_open_right_and_excused_again_reopens_it(tenant: Tenant) -> None:
    grp, st = await setup(tenant)
    les = await lesson(tenant, grp["id"], date.today() - timedelta(days=2))
    await mark(tenant, les["id"], st["id"], "excused")
    await mark(tenant, les["id"], st["id"], "present")
    assert [r["status"] for r in await rights(tenant)] == ["cancelled"]
    await mark(tenant, les["id"], st["id"], "excused")
    items = await rights(tenant)
    assert len(items) == 1 and items[0]["status"] == "open"


async def test_none_mode_creates_nothing_and_other_marks_create_nothing(tenant: Tenant) -> None:
    grp, st = await setup(tenant)
    les = await lesson(tenant, grp["id"], date.today() - timedelta(days=2))
    await mark(tenant, les["id"], st["id"], "absent")
    await mark(tenant, les["id"], st["id"], "late")
    assert await rights(tenant) == []
    await ok(await tenant.patch("/v1/settings", {"excused_mode": "none"}))
    await mark(tenant, les["id"], st["id"], "excused")
    assert await rights(tenant) == []


async def test_a_trial_student_gets_no_right(tenant: Tenant) -> None:
    grp = await mk_group(tenant)
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], "2026-01-01", status="trial")
    les = await lesson(tenant, grp["id"], date.today() - timedelta(days=2))
    await mark(tenant, les["id"], st["id"], "excused")
    assert await rights(tenant) == []


# ---- scheduling and closing ------------------------------------------------------------------------------
async def test_schedule_attend_closes_and_absent_again_reopens(tenant: Tenant) -> None:
    grp, st = await setup(tenant)
    les = await lesson(tenant, grp["id"], date.today() - timedelta(days=3))
    await mark(tenant, les["id"], st["id"], "excused")
    r = (await rights(tenant))[0]
    day = (date.today() + timedelta(days=7)).isoformat()
    sched = await ok(
        await tenant.post(
            f"/v1/entitlements/{r['id']}/schedule",
            {"lesson_date": day, "start_time": "12:00:00", "end_time": "13:00:00"},
        )
    )
    assert sched["status"] == "scheduled" and sched["makeup_date"] == day
    mk = next(
        x
        for x in (await ok(await tenant.get("/v1/lessons", params={"date_from": day, "date_to": day})))[
            "items"
        ]
        if x["id"] == sched["makeup_lesson_id"]
    )
    assert mk["kind"] == "makeup"
    roster = (await ok(await tenant.get(f"/v1/lessons/{mk['id']}/attendance")))["entries"]
    assert [e["student_id"] for e in roster] == [
        st["id"]
    ]  # only the entitled student is on a make-up roll call
    again = await tenant.post(
        f"/v1/entitlements/{r['id']}/schedule",
        {"lesson_date": day, "start_time": "14:00:00", "end_time": "15:00:00"},
    )
    assert again.status_code == 409 and again.json()["error"]["code"] == "not_open"

    await mark(tenant, mk["id"], st["id"], "absent")
    back = (await rights(tenant))[0]
    assert back["status"] == "open" and back["makeup_lesson_id"] is None
    await ok(
        await tenant.post(
            f"/v1/entitlements/{r['id']}/schedule",
            {"lesson_date": day, "start_time": "16:00:00", "end_time": "17:00:00"},
        )
    )
    mk2 = (await rights(tenant))[0]["makeup_lesson_id"]
    await mark(tenant, mk2, st["id"], "present")
    done = (await rights(tenant))[0]
    assert done["status"] == "used" and done["used_on"] == day


async def test_schedule_validation(tenant: Tenant) -> None:
    grp, st = await setup(tenant)
    les = await lesson(tenant, grp["id"], date.today() - timedelta(days=3))
    await mark(tenant, les["id"], st["id"], "excused")
    r = (await rights(tenant))[0]
    past = (date.today() - timedelta(days=1)).isoformat()
    assert (
        await tenant.post(
            f"/v1/entitlements/{r['id']}/schedule",
            {"lesson_date": past, "start_time": "12:00:00", "end_time": "13:00:00"},
        )
    ).status_code == 422
    assert (
        await tenant.post(
            f"/v1/entitlements/{r['id']}/schedule",
            {"lesson_date": date.today().isoformat(), "start_time": "13:00:00", "end_time": "12:00:00"},
        )
    ).status_code == 422
    enr = (await ok(await tenant.get(f"/v1/students/{st['id']}/enrollments")))[0]
    await ok(
        await tenant.patch(
            f"/v1/enrollments/{enr['id']}", {"status": "finished", "ended_on": date.today().isoformat()}
        )
    )
    gone = await tenant.post(
        f"/v1/entitlements/{r['id']}/schedule",
        {
            "lesson_date": (date.today() + timedelta(days=5)).isoformat(),
            "start_time": "12:00:00",
            "end_time": "13:00:00",
        },
    )
    assert gone.status_code in (409, 422)


async def test_cancel_open_and_scheduled(tenant: Tenant) -> None:
    grp, st = await setup(tenant)
    a = await lesson(tenant, grp["id"], date.today() - timedelta(days=4))
    b = await lesson(tenant, grp["id"], date.today() - timedelta(days=3))
    await mark(tenant, a["id"], st["id"], "excused")
    await mark(tenant, b["id"], st["id"], "excused")
    r1, r2 = sorted(await rights(tenant), key=lambda x: x["missed_on"])
    assert (await ok(await tenant.post(f"/v1/entitlements/{r1['id']}/cancel", {})))["status"] == "cancelled"
    day = (date.today() + timedelta(days=6)).isoformat()
    await ok(
        await tenant.post(
            f"/v1/entitlements/{r2['id']}/schedule",
            {"lesson_date": day, "start_time": "12:00:00", "end_time": "13:00:00"},
        )
    )
    assert (await ok(await tenant.post(f"/v1/entitlements/{r2['id']}/cancel", {})))["status"] == "cancelled"
    assert (await tenant.post(f"/v1/entitlements/{r2['id']}/cancel", {})).status_code == 409


# ---- lapsing ---------------------------------------------------------------------------------------------
async def test_a_right_lapses_after_its_expiry_unless_lapsing_is_off(tenant: Tenant) -> None:
    grp, st = await setup(tenant)
    await ok(await tenant.patch("/v1/settings", {"makeup_expiry_days": 0}))
    les = await lesson(tenant, grp["id"], date.today() - timedelta(days=2))
    await mark(tenant, les["id"], st["id"], "excused")
    r = (await rights(tenant))[0]
    assert r["status"] == "open" and r["effective_status"] == "lapsed"
    assert [x["id"] for x in await rights(tenant, status="lapsed")] == [r["id"]]
    assert await rights(tenant, status="open") == []
    s = await tenant.post(
        f"/v1/entitlements/{r['id']}/schedule",
        {
            "lesson_date": (date.today() + timedelta(days=5)).isoformat(),
            "start_time": "12:00:00",
            "end_time": "13:00:00",
        },
    )
    assert s.status_code == 409 and s.json()["error"]["code"] == "not_open"
    await ok(await tenant.patch("/v1/settings", {"makeup_lapses": False}))
    assert (await rights(tenant))[0]["effective_status"] == "open"


# ---- credits ---------------------------------------------------------------------------------------------
async def test_credit_mode_reduces_the_next_generated_charge(tenant: Tenant) -> None:
    await ok(await tenant.patch("/v1/settings", {"excused_mode": "credit"}))
    grp, st = await setup(tenant, fee="600000")
    await ok(
        await tenant.put(
            f"/v1/groups/{grp['id']}/schedule",
            [{"weekday": 1, "start_time": "10:00:00", "end_time": "11:00:00"}],
        )
    )
    await ok(
        await tenant.post(f"/v1/groups/{grp['id']}/lessons/generate", MARCH)
    )  # five Mondays: 2, 9, 16, 23, 30
    items = (await ok(await tenant.get("/v1/lessons", params={**MARCH, "group_id": grp["id"]})))["items"]
    for les in items[:2]:
        await mark(tenant, les["id"], st["id"], "excused")
    credits = await rights(tenant)
    assert sorted(c["amount"] for c in credits) == ["120000.00", "120000.00"] and {
        c["kind"] for c in credits
    } == {"credit"}
    gen = await ok(await tenant.post("/v1/charges/generate", {"month": "2026-04-01"}))
    assert gen["created"] == 1
    charge = (
        await ok(await tenant.get("/v1/charges", params={"student_id": st["id"], "month": "2026-04-01"}))
    )["items"][0]
    assert charge["amount"] == "360000.00"
    assert {c["status"] for c in await rights(tenant)} == {"used"}
    again = await ok(await tenant.post("/v1/charges/generate", {"month": "2026-04-01"}))
    assert again["created"] == 0  # idempotent: credits are not consumed twice


async def test_a_credit_cannot_schedule_a_makeup(tenant: Tenant) -> None:
    await ok(await tenant.patch("/v1/settings", {"excused_mode": "credit"}))
    grp, st = await setup(tenant)
    await ok(
        await tenant.put(
            f"/v1/groups/{grp['id']}/schedule",
            [{"weekday": 1, "start_time": "10:00:00", "end_time": "11:00:00"}],
        )
    )
    await ok(await tenant.post(f"/v1/groups/{grp['id']}/lessons/generate", MARCH))
    les = (await ok(await tenant.get("/v1/lessons", params={**MARCH, "group_id": grp["id"]})))["items"][0]
    await mark(tenant, les["id"], st["id"], "excused")
    r = (await rights(tenant))[0]
    s = await tenant.post(
        f"/v1/entitlements/{r['id']}/schedule",
        {
            "lesson_date": (date.today() + timedelta(days=5)).isoformat(),
            "start_time": "12:00:00",
            "end_time": "13:00:00",
        },
    )
    assert s.status_code == 409


# ---- isolation and idempotency ---------------------------------------------------------------------------
async def test_other_centers_cannot_see_or_touch_rights(tenant: Tenant, tenant_b: Tenant) -> None:
    grp, st = await setup(tenant)
    les = await lesson(tenant, grp["id"], date.today() - timedelta(days=2))
    await mark(tenant, les["id"], st["id"], "excused")
    r = (await rights(tenant))[0]
    assert await rights(tenant_b) == []
    body = {
        "lesson_date": (date.today() + timedelta(days=5)).isoformat(),
        "start_time": "12:00:00",
        "end_time": "13:00:00",
    }
    assert (await tenant_b.post(f"/v1/entitlements/{r['id']}/schedule", body)).status_code == 404
    assert (await tenant_b.post(f"/v1/entitlements/{r['id']}/cancel", {})).status_code == 404


async def test_schedule_replays_with_the_same_idempotency_key(tenant: Tenant) -> None:
    grp, st = await setup(tenant)
    les = await lesson(tenant, grp["id"], date.today() - timedelta(days=2))
    await mark(tenant, les["id"], st["id"], "excused")
    r = (await rights(tenant))[0]
    body = {
        "lesson_date": (date.today() + timedelta(days=5)).isoformat(),
        "start_time": "12:00:00",
        "end_time": "13:00:00",
    }
    key = {"Idempotency-Key": f"mk-{uuid.uuid4().hex}"}
    a = await tenant.post(f"/v1/entitlements/{r['id']}/schedule", body, headers=key)
    b = await tenant.post(f"/v1/entitlements/{r['id']}/schedule", body, headers=key)
    assert a.status_code == b.status_code == 200 and a.json() == b.json()


# ---- payroll ---------------------------------------------------------------------------------------------
async def test_teacher_is_paid_for_a_makeup_lesson_only_when_someone_attended(tenant: Tenant) -> None:
    from tests.helpers import mk_teacher

    teacher = await mk_teacher(tenant, pay_model="per_lesson", pay_rate="100000")
    grp = await mk_group(tenant, teacher_id=teacher["id"], monthly_fee="600000")
    st = await mk_student(tenant)
    await enroll(tenant, grp["id"], st["id"], "2026-01-01")
    today = date.today()
    regular = await lesson(tenant, grp["id"], today, "09:00:00")
    await mark(tenant, regular["id"], st["id"], "excused")
    r = (await rights(tenant))[0]
    await ok(
        await tenant.post(
            f"/v1/entitlements/{r['id']}/schedule",
            {"lesson_date": today.isoformat(), "start_time": "15:00:00", "end_time": "16:00:00"},
        )
    )
    mk = (await rights(tenant))[0]["makeup_lesson_id"]
    month = today.replace(day=1).isoformat()

    await mark(tenant, mk, st["id"], "absent")  # the make-up lesson is held, but nobody came
    pay = await ok(await tenant.post("/v1/payrolls/generate", {"teacher_id": teacher["id"], "month": month}))
    assert pay["total"] == "100000.00"  # only the regular lesson
    await ok(
        await tenant.post(
            f"/v1/entitlements/{r['id']}/schedule",
            {"lesson_date": today.isoformat(), "start_time": "17:00:00", "end_time": "18:00:00"},
        )
    )
    mk2 = (await rights(tenant))[0]["makeup_lesson_id"]
    await mark(tenant, mk2, st["id"], "present")
    pay = await ok(await tenant.post("/v1/payrolls/generate", {"teacher_id": teacher["id"], "month": month}))
    assert pay["total"] == "200000.00"  # regular + the attended make-up; the empty one is still not paid
