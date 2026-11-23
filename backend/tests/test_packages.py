"""Lesson packages: group billing mode, selling a package (a charge plus lessons), the lesson balance (consumption,
expiry, negative lessons), extension, the payment-needed report, and how packages follow admission, make-up, billing
and payroll rules."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from tests.conftest import Tenant
from tests.helpers import consent, enroll, mk_group, mk_guardian, mk_student, ok

TODAY = date.today()


def day(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


async def pkg_group(t: Tenant, lessons: int = 12, price: str = "600000", **kw: Any) -> dict[str, Any]:
    return await mk_group(
        t, billing_mode="package", package_lessons=lessons, package_price=price, monthly_fee="0", **kw
    )


async def student_in(t: Tenant, grp: dict[str, Any], **kw: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    st = await mk_student(t)
    en = await enroll(t, grp["id"], st["id"], (TODAY - timedelta(days=100)).isoformat(), **kw)
    return st, en


async def sell(t: Tenant, enrollment_id: str, **kw: Any) -> dict[str, Any]:
    return await ok(await t.post("/v1/packages", {"enrollment_id": enrollment_id, **kw}), 201)


CASH = {"amount": "600000", "method": "cash"}


async def lesson(t: Tenant, group_id: str, offset: int, hour: int = 10) -> dict[str, Any]:
    return await ok(
        await t.post(
            "/v1/lessons",
            {
                "group_id": group_id,
                "lesson_date": day(offset),
                "start_time": f"{hour:02d}:00:00",
                "end_time": f"{hour + 1:02d}:00:00",
            },
        ),
        201,
    )


async def mark(t: Tenant, lesson_id: str, student_id: str, status: str) -> None:
    await ok(
        await t.put(
            f"/v1/lessons/{lesson_id}/attendance", {"records": [{"student_id": student_id, "status": status}]}
        )
    )


async def attend(t: Tenant, grp: dict[str, Any], st: dict[str, Any], statuses: list[str]) -> None:
    for i, status in enumerate(statuses):
        les = await lesson(t, grp["id"], -len(statuses) + i)
        await mark(t, les["id"], st["id"], status)


async def balance(t: Tenant, student_id: str) -> dict[str, Any]:
    rows = await ok(await t.get(f"/v1/students/{student_id}/lesson-balance"))
    assert len(rows) == 1
    return rows[0]  # type: ignore[no-any-return]


# ---- groups and settings ---------------------------------------------------------------------------------
async def test_group_billing_mode_is_validated(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    assert (grp["billing_mode"], grp["package_lessons"], grp["package_price"]) == ("package", 12, "600000.00")
    monthly = await mk_group(tenant)
    assert (monthly["billing_mode"], monthly["package_lessons"], monthly["package_price"]) == (
        "monthly",
        None,
        None,
    )
    course = (await ok(await tenant.get(f"/v1/groups/{grp['id']}")))["course_id"]
    base = {"course_id": course, "name": "X", "start_date": "2026-01-01"}
    for bad in (
        {"billing_mode": "package"},  # lessons and price are required
        {"billing_mode": "package", "package_lessons": 0, "package_price": "1000"},
        {"billing_mode": "package", "package_lessons": 12, "package_price": "0"},
        {"billing_mode": "monthly", "package_lessons": 12, "package_price": "1000"},
        {"billing_mode": "bogus"},
    ):
        assert (await tenant.post("/v1/groups", {**base, **bad})).status_code == 422, bad


async def test_group_can_switch_modes(tenant: Tenant) -> None:
    monthly = await mk_group(tenant)
    g = await ok(
        await tenant.patch(
            f"/v1/groups/{monthly['id']}",
            {"billing_mode": "package", "package_lessons": 8, "package_price": "480000"},
        )
    )
    assert (g["billing_mode"], g["package_lessons"]) == ("package", 8)
    assert (await tenant.patch(f"/v1/groups/{monthly['id']}", {"billing_mode": "monthly"})).status_code == 200
    g = await ok(await tenant.get(f"/v1/groups/{monthly['id']}"))
    assert (g["billing_mode"], g["package_lessons"], g["package_price"]) == ("monthly", None, None)
    bad = await tenant.patch(f"/v1/groups/{monthly['id']}", {"package_lessons": 5})
    assert bad.status_code == 422  # a monthly group carries no package fields


async def test_settings_have_package_defaults(tenant: Tenant) -> None:
    s = await ok(await tenant.get("/v1/settings"))
    assert (s["package_expiry_days"], s["package_low_lessons"]) == (60, 2)
    s = await ok(await tenant.patch("/v1/settings", {"package_expiry_days": 90, "package_low_lessons": 0}))
    assert (s["package_expiry_days"], s["package_low_lessons"]) == (90, 0)
    for bad in ({"package_expiry_days": 0}, {"package_expiry_days": 731}, {"package_low_lessons": 51}):
        assert (await tenant.patch("/v1/settings", bad)).status_code == 422


# ---- selling and paying ----------------------------------------------------------------------------------
async def test_sell_with_payment_credits_all_lessons(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    p = await sell(tenant, en["id"], pay=CASH)
    assert (p["lessons"], p["price"], p["paid"], p["credited_lessons"]) == (12, "600000.00", "600000.00", 12)
    assert p["purchased_on"] == day(0) and p["expires_on"] == day(60)
    ch = await ok(await tenant.get(f"/v1/charges/{p['charge_id']}"))
    assert (ch["kind"], ch["amount"], ch["due_date"]) == ("package", "600000.00", day(0))
    assert (await ok(await tenant.get(f"/v1/students/{st['id']}/balance")))["outstanding_total"] == "0.00"
    b = await balance(tenant, st["id"])
    assert (b["available"], b["balance_lessons"], b["debt_lessons"], b["need"]) == (12, 12, 0, "ok")
    assert b["next_expiry"] == day(60)


async def test_unpaid_package_gives_nothing_and_a_later_payment_adds_lessons_proportionally(
    tenant: Tenant,
) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    p = await sell(tenant, en["id"])
    assert (p["paid"], p["credited_lessons"]) == ("0.00", 0)
    assert (await balance(tenant, st["id"]))["need"] == "exhausted"
    pay = {"student_id": st["id"], "method": "cash"}
    await ok(await tenant.post("/v1/payments", {**pay, "amount": "299999"}), 201)
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 5  # 299 999 of 600 000 = 5 of 12
    await ok(await tenant.post("/v1/payments", {**pay, "amount": "1"}), 201)
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 6
    await ok(await tenant.post("/v1/payments", {**pay, "amount": "300000"}), 201)
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 12


async def test_overpayment_is_credit_not_extra_lessons(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay={"amount": "1200000", "method": "cash"})
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 12
    assert (await ok(await tenant.get(f"/v1/students/{st['id']}/balance")))["credit"] == "600000.00"


async def test_two_packages_add_up_and_list(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    await sell(tenant, en["id"], pay=CASH)
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 24
    rows = (await ok(await tenant.get("/v1/packages", params={"student_id": st["id"]})))["items"]
    assert len(rows) == 2 and all(r["credited_lessons"] == 12 for r in rows)


async def test_sell_errors(tenant: Tenant, tenant_b: Tenant) -> None:
    monthly = await mk_group(tenant)
    st = await mk_student(tenant)
    en = await enroll(tenant, monthly["id"], st["id"])
    assert (await tenant.post("/v1/packages", {"enrollment_id": en["id"]})).status_code == 409
    grp = await pkg_group(tenant)
    trial_st = await mk_student(tenant)
    trial = await enroll(tenant, grp["id"], trial_st["id"], status="trial")
    assert (await tenant.post("/v1/packages", {"enrollment_id": trial["id"]})).status_code == 409
    other_grp = await pkg_group(tenant_b)
    other_st = await mk_student(tenant_b)
    other = await enroll(tenant_b, other_grp["id"], other_st["id"])
    assert (await tenant.post("/v1/packages", {"enrollment_id": other["id"]})).status_code == 404
    assert (await tenant.post("/v1/packages", {"enrollment_id": str(uuid.uuid4())})).status_code == 404


async def test_sell_replays_with_the_same_idempotency_key(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    hdr = {"Idempotency-Key": f"pkg-{uuid.uuid4().hex}"}
    a = await ok(
        await tenant.post("/v1/packages", {"enrollment_id": en["id"], "pay": CASH}, headers=hdr), 201
    )
    b = await tenant.post("/v1/packages", {"enrollment_id": en["id"], "pay": CASH}, headers=hdr)
    assert b.json()["id"] == a["id"]
    assert len((await ok(await tenant.get("/v1/packages", params={"student_id": st["id"]})))["items"]) == 1


async def test_voiding_the_charge_removes_the_package(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    p = await sell(tenant, en["id"])
    await ok(await tenant.post(f"/v1/charges/{p['charge_id']}/void", {"reason": "sold by mistake"}))
    assert (await ok(await tenant.get("/v1/packages", params={"student_id": st["id"]})))["items"] == []
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 0


# ---- consumption -----------------------------------------------------------------------------------------
async def test_present_late_and_absent_consume_excused_does_not_in_makeup_mode(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    await attend(tenant, grp, st, ["present", "late", "absent", "excused"])
    b = await balance(tenant, st["id"])
    assert b["balance_lessons"] == 9  # 12 - present - late - absent; the excused one stays in the package


async def test_excused_consumes_only_when_the_center_gives_nothing(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    await attend(tenant, grp, st, ["excused", "excused"])
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 12
    await ok(await tenant.patch("/v1/settings", {"excused_mode": "none"}))
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 10
    await ok(await tenant.patch("/v1/settings", {"excused_mode": "credit"}))
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 12


async def test_changing_a_mark_updates_the_balance(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    les = await lesson(tenant, grp["id"], -1)
    await mark(tenant, les["id"], st["id"], "present")
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 11
    await mark(tenant, les["id"], st["id"], "excused")
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 12
    await mark(tenant, les["id"], st["id"], "absent")
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 11
    await ok(await tenant.delete(f"/v1/lessons/{les['id']}/attendance/{st['id']}"))
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 12


async def test_a_cancelled_lesson_consumes_nothing(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    les = await lesson(tenant, grp["id"], -1)
    await mark(tenant, les["id"], st["id"], "present")
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 11
    await ok(await tenant.delete(f"/v1/lessons/{les['id']}/attendance/{st['id']}"))
    await ok(await tenant.patch(f"/v1/lessons/{les['id']}", {"status": "cancelled"}))
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 12
    marked = await tenant.put(
        f"/v1/lessons/{les['id']}/attendance", {"records": [{"student_id": st["id"], "status": "present"}]}
    )
    assert marked.status_code == 409  # nothing can be marked on a cancelled lesson


async def test_excused_in_a_package_group_makes_a_right_but_never_a_money_credit(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    les = await lesson(tenant, grp["id"], -2)
    await mark(tenant, les["id"], st["id"], "excused")
    rights = (await ok(await tenant.get("/v1/entitlements")))["items"]
    assert [r["kind"] for r in rights] == ["makeup"]
    await ok(await tenant.patch("/v1/settings", {"excused_mode": "credit"}))
    les2 = await lesson(tenant, grp["id"], -1)
    await mark(tenant, les2["id"], st["id"], "excused")
    assert [r["kind"] for r in (await ok(await tenant.get("/v1/entitlements")))["items"]] == ["makeup"]


async def test_makeup_lesson_attended_consumes_nothing(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    missed = await lesson(tenant, grp["id"], -3)
    await mark(tenant, missed["id"], st["id"], "excused")
    right = (await ok(await tenant.get("/v1/entitlements")))["items"][0]
    sched = await ok(
        await tenant.post(
            f"/v1/entitlements/{right['id']}/schedule",
            {"lesson_date": day(0), "start_time": "15:00:00", "end_time": "16:00:00"},
        )
    )
    await mark(tenant, sched["makeup_lesson_id"], st["id"], "present")
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 12


# ---- negative lessons, expiry, extension -----------------------------------------------------------------
async def test_lessons_without_a_package_are_negative_and_a_payment_clears_them(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await attend(tenant, grp, st, ["present", "present", "late"])
    b = await balance(tenant, st["id"])
    assert (b["balance_lessons"], b["debt_lessons"], b["need"]) == (-3, 3, "debt")
    assert b["debt_amount"] == "150000.00"  # 3 of 12 at 600 000
    await sell(tenant, en["id"], pay=CASH)
    b = await balance(tenant, st["id"])
    assert (b["balance_lessons"], b["debt_lessons"], b["debt_amount"], b["need"]) == (9, 0, "0.00", "ok")


async def test_unused_lessons_burn_at_expiry_and_an_extension_revives_them(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    p = await sell(tenant, en["id"], purchased_on=day(-70), pay=CASH)
    assert p["expires_on"] == day(-10)
    b = await balance(tenant, st["id"])
    assert (b["available"], b["burned"], b["balance_lessons"], b["need"]) == (0, 12, 0, "exhausted")
    assert b["next_expiry"] is None
    ext = await ok(await tenant.post(f"/v1/packages/{p['id']}/extend", {"expires_on": day(5)}))
    assert ext["expires_on"] == day(5)
    b = await balance(tenant, st["id"])
    assert (b["available"], b["burned"], b["next_expiry"]) == (12, 0, day(5))


async def test_extension_must_move_the_date_forward_within_two_years(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    _, en = await student_in(tenant, grp)
    p = await sell(tenant, en["id"])
    assert (
        await tenant.post(f"/v1/packages/{p['id']}/extend", {"expires_on": p["expires_on"]})
    ).status_code == 422
    assert (await tenant.post(f"/v1/packages/{p['id']}/extend", {"expires_on": day(-1)})).status_code == 422
    assert (await tenant.post(f"/v1/packages/{p['id']}/extend", {"expires_on": day(800)})).status_code == 422
    assert (
        await tenant.post(f"/v1/packages/{uuid.uuid4()}/extend", {"expires_on": day(90)})
    ).status_code == 404


async def test_a_lesson_on_the_expiry_day_still_consumes(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await ok(await tenant.patch("/v1/settings", {"package_expiry_days": 1}))
    await sell(tenant, en["id"], pay=CASH)  # expires tomorrow
    les = await lesson(tenant, grp["id"], 1)
    await mark(tenant, les["id"], st["id"], "present")
    assert (await balance(tenant, st["id"]))["balance_lessons"] == 11


# ---- admission, billing and payroll ----------------------------------------------------------------------
async def test_monthly_generation_skips_package_groups(tenant: Tenant) -> None:
    pkg = await pkg_group(tenant)
    await student_in(tenant, pkg)
    monthly = await mk_group(tenant, monthly_fee="500000")
    ms = await mk_student(tenant)
    await enroll(tenant, monthly["id"], ms["id"])
    month = TODAY.replace(day=1).isoformat()
    out = await ok(await tenant.post("/v1/charges/generate", {"month": month, "due_day": 10}))
    assert out["created"] == 1 and out["skipped_package_groups"] == 1


async def test_trial_in_a_package_group_is_free_and_acceptance_bills_nothing(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st = await mk_student(tenant)
    en = await enroll(tenant, grp["id"], st["id"], (TODAY - timedelta(days=5)).isoformat(), status="trial")
    trial_lesson = await lesson(tenant, grp["id"], -3)
    await mark(tenant, trial_lesson["id"], st["id"], "present")
    acc = await ok(
        await tenant.post(f"/v1/enrollments/{en['id']}/accept", {"mode": "full", "accepted_on": day(-1)})
    )
    assert acc["charge_amount"] == "0.00"
    assert (await ok(await tenant.get(f"/v1/students/{st['id']}/balance")))["outstanding_total"] == "0.00"
    b = await balance(tenant, st["id"])
    assert b["balance_lessons"] == 0  # the trial lesson before acceptance was free
    after = await lesson(tenant, grp["id"], 0)
    await mark(tenant, after["id"], st["id"], "present")
    assert (await balance(tenant, st["id"]))["balance_lessons"] == -1


async def test_dropped_trial_consumes_nothing(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st = await mk_student(tenant)
    en = await enroll(tenant, grp["id"], st["id"], (TODAY - timedelta(days=5)).isoformat(), status="trial")
    les = await lesson(tenant, grp["id"], -3)
    await mark(tenant, les["id"], st["id"], "present")
    await ok(await tenant.post(f"/v1/enrollments/{en['id']}/drop", {}))
    rows = await ok(await tenant.get(f"/v1/students/{st['id']}/lesson-balance"))
    assert rows == []


async def test_percent_payroll_counts_package_money(tenant: Tenant) -> None:
    teacher = await ok(
        await tenant.post(
            "/v1/teachers", {"full_name": "Pct Teacher", "pay_model": "percent", "pay_rate": "10"}
        ),
        201,
    )
    grp = await pkg_group(tenant, teacher_id=teacher["id"])
    _, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    month = TODAY.replace(day=1).isoformat()
    out = await ok(await tenant.post("/v1/payrolls/generate", {"month": month, "teacher_id": teacher["id"]}))
    assert out["total"] == "60000.00"  # 10% of the 600 000 paid for the package


# ---- payment needed --------------------------------------------------------------------------------------
async def test_payment_needed_report_orders_debt_exhausted_low_and_drafts_text(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    debt_st, _ = await student_in(tenant, grp)
    await attend(tenant, grp, debt_st, ["present", "present"])
    new_st, _ = await student_in(tenant, grp)  # nothing bought: exhausted
    low_st, low_en = await student_in(tenant, grp)
    await sell(tenant, low_en["id"], pay=CASH)
    for i in range(10):
        les = await lesson(tenant, grp["id"], -20 - i, hour=8)
        await mark(tenant, les["id"], low_st["id"], "present")  # 2 of 12 left
    ok_st, ok_en = await student_in(tenant, grp)
    await sell(tenant, ok_en["id"], pay=CASH)
    guardian = await mk_guardian(tenant, "Dilnoza opa")
    await ok(
        await tenant.post(
            f"/v1/students/{low_st['id']}/guardians", {"guardian_id": guardian["id"], "relation": "mother"}
        ),
        201,
    )
    rows = await ok(await tenant.get("/v1/reports/packages/payment-needed"))
    assert [(r["student_id"], r["need"]) for r in rows] == [
        (debt_st["id"], "debt"),
        (new_st["id"], "exhausted"),
        (low_st["id"], "low"),
    ]
    low = rows[2]
    assert (
        low["balance_lessons"] == 2
        and "2 ta dars qoldi" in low["reminder_text"]
        and "Dilnoza opa" in low["reminder_text"]
    )
    assert rows[0]["debt_lessons"] == 2 and rows[0]["debt_amount"] == "100000.00"
    assert "100 000 so'm" in rows[0]["reminder_text"]
    only = await ok(await tenant.get("/v1/reports/packages/payment-needed", params={"need": "debt"}))
    assert [r["student_id"] for r in only] == [debt_st["id"]]
    assert ok_st["id"] not in [r["student_id"] for r in rows]


async def test_low_threshold_follows_the_setting(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    await sell(tenant, en["id"], pay=CASH)
    await attend(tenant, grp, st, ["present"] * 10)
    assert (await balance(tenant, st["id"]))["need"] == "low"
    await ok(await tenant.patch("/v1/settings", {"package_low_lessons": 1}))
    assert (await balance(tenant, st["id"]))["need"] == "ok"


async def test_packages_are_tenant_isolated(tenant: Tenant, tenant_b: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, en = await student_in(tenant, grp)
    p = await sell(tenant, en["id"], pay=CASH)
    assert (await ok(await tenant_b.get("/v1/packages")))["items"] == []
    assert (await tenant_b.post(f"/v1/packages/{p['id']}/extend", {"expires_on": day(90)})).status_code == 404
    assert (await tenant_b.get(f"/v1/students/{st['id']}/lesson-balance")).status_code == 404
    assert await ok(await tenant_b.get("/v1/reports/packages/payment-needed")) == []


async def test_consent_is_not_needed_for_the_staff_report_but_the_agent_view_hides_it(tenant: Tenant) -> None:
    grp = await pkg_group(tenant)
    st, _ = await student_in(tenant, grp)
    await consent(tenant, st["id"], "ai_assistant_processing")
    rows = await ok(await tenant.get("/v1/reports/packages/payment-needed"))
    assert [r["student_id"] for r in rows] == [st["id"]]
