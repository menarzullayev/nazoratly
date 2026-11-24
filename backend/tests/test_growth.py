"""Growth: referral rewards, promo codes, marketing credits in accounting, lead source ROI, internal lead reminders."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx
import psycopg

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, ok, org_today
from tests.test_tenancy_and_staff import _add_staff, _login

BILL_MONTH = "2026-04-01"


async def student_in_group(
    t: Tenant, fee: str = "600000", name: str | None = None
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    grp = await mk_group(t, monthly_fee=fee)
    st = await mk_student(t, name)
    enr = await enroll(t, grp["id"], st["id"], "2026-01-01")
    return grp, st, enr


async def pay(t: Tenant, student_id: str, amount: str) -> None:
    await ok(
        await t.post("/v1/payments", {"student_id": student_id, "amount": amount, "method": "cash"}), 201
    )


async def set_program(t: Tenant, **kw: Any) -> dict[str, Any]:
    body = {"reward_type": "percent", "reward_value": "10", "condition": "paid", "min_paid": "100000", **kw}
    return await ok(await t.put("/v1/referral-program", body))


async def refer(t: Tenant, referrer: dict[str, Any], invited: dict[str, Any]) -> dict[str, Any]:
    return await ok(
        await t.post(
            "/v1/referrals", {"referrer_student_id": referrer["id"], "invited_student_id": invited["id"]}
        ),
        201,
    )


async def credits_report(t: Tenant, **params: Any) -> dict[str, Any]:
    return await ok(await t.get("/v1/accounting/growth-credits", params=params))


async def charge_of(t: Tenant, student_id: str) -> dict[str, Any]:
    return (await ok(await t.get("/v1/charges", params={"student_id": student_id, "month": BILL_MONTH})))[
        "items"
    ][0]


def outbox_count(dsn: str) -> int:
    with psycopg.connect(dsn) as c:
        return int(c.execute("SELECT count(*) FROM outbox_messages").fetchone()[0])  # type: ignore[index]


# ---- referral rule ---------------------------------------------------------------------------------------------
async def test_referral_rule_is_validated_and_readable(tenant: Tenant) -> None:
    assert (await ok(await tenant.get("/v1/referral-program"))) is None
    base = {"reward_type": "percent", "reward_value": "10", "condition": "paid", "min_paid": "0"}
    for bad in (
        {"reward_value": "0"},
        {"reward_value": "-5"},
        {"reward_value": "1001"},
        {"reward_type": "free_lesson", "reward_value": "1.5"},
        {"reward_type": "free_lesson", "reward_value": "101"},
        {"reward_type": "bogus"},
        {"condition": "soon"},
        {"min_paid": "-1"},
        {"extra": "x"},
    ):
        assert (await tenant.put("/v1/referral-program", {**base, **bad})).status_code == 422, bad
    got = await set_program(
        tenant, reward_type="free_lesson", reward_value="2", condition="enrolled", min_paid="0"
    )
    assert got == {
        "reward_type": "free_lesson",
        "reward_value": "2.00",
        "condition": "enrolled",
        "min_paid": "0.00",
        "active": True,
    }
    again = await set_program(
        tenant, reward_type="amount", reward_value="150000.50"
    )  # the rule is replaced, not duplicated
    assert again["reward_type"] == "amount"
    assert (await ok(await tenant.get("/v1/referral-program")))["reward_value"] == "150000.50"


async def test_a_referral_needs_an_active_rule_and_sane_students(tenant: Tenant, tenant_b: Tenant) -> None:
    _, a, _ = await student_in_group(tenant)
    _, b, _ = await student_in_group(tenant)
    body = {"referrer_student_id": a["id"], "invited_student_id": b["id"]}
    r = await tenant.post("/v1/referrals", body)
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_active_referral_program"
    await set_program(tenant, active=False)
    assert (await tenant.post("/v1/referrals", body)).status_code == 409  # a switched-off rule is no rule
    await set_program(tenant)
    assert (
        await tenant.post("/v1/referrals", {"referrer_student_id": a["id"], "invited_student_id": a["id"]})
    ).status_code == 422  # not oneself
    other = await mk_student(tenant_b)
    assert (
        await tenant.post(
            "/v1/referrals", {"referrer_student_id": a["id"], "invited_student_id": other["id"]}
        )
    ).status_code == 404  # another center's student
    first = await refer(tenant, a, b)
    assert (
        first["status"] == "pending" and first["reward_type"] == "percent" and first["condition_met"] is False
    )
    dup = await tenant.post("/v1/referrals", body)
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "already_referred"
    _, c, _ = await student_in_group(tenant)
    again = await tenant.post(
        "/v1/referrals", {"referrer_student_id": c["id"], "invited_student_id": b["id"]}
    )
    assert again.status_code == 409  # a student is invited by one person only


async def test_a_referral_keeps_the_rule_it_was_made_under(tenant: Tenant) -> None:
    _, a, _ = await student_in_group(tenant)
    _, b, _ = await student_in_group(tenant)
    await set_program(tenant, reward_value="10")
    ref = await refer(tenant, a, b)
    await set_program(tenant, reward_type="amount", reward_value="999")
    listed = (await ok(await tenant.get("/v1/referrals")))[0]
    assert (
        listed["id"] == ref["id"] and listed["reward_type"] == "percent" and listed["reward_value"] == "10.00"
    )


# ---- booking the reward ----------------------------------------------------------------------------------------
async def test_paid_condition_pays_a_credit_that_the_next_billing_consumes(tenant: Tenant) -> None:
    await set_program(tenant, reward_value="10", min_paid="100000")
    _, referrer, _ = await student_in_group(tenant, "600000")
    _, invited, _ = await student_in_group(tenant, "500000")
    await refer(tenant, referrer, invited)
    nothing = await ok(await tenant.post("/v1/referrals/book"))
    assert (
        nothing["rewarded"] == []
        and nothing["skipped"][0]["reason"] == "condition_not_met"
        and nothing["total"] == "0.00"
    )
    await pay(tenant, invited["id"], "99999")
    assert (await ok(await tenant.post("/v1/referrals/book")))["rewarded"] == []  # below the minimum
    await pay(tenant, invited["id"], "1")
    booked = await ok(await tenant.post("/v1/referrals/book"))
    assert [(x["amount"], x["credits"]) for x in booked["rewarded"]] == [("60000.00", 1)] and booked[
        "total"
    ] == "60000.00"
    # safe to repeat: no second reward
    assert (await ok(await tenant.post("/v1/referrals/book")))["rewarded"] == []
    ref = (await ok(await tenant.get("/v1/referrals", params={"status": "rewarded"})))[0]
    assert (
        ref["reward_amount"] == "60000.00"
        and ref["credits_total"] == "60000.00"
        and ref["rewarded_on"] == org_today().isoformat()
    )
    rep = await credits_report(tenant)
    assert rep["totals"] == {
        "count": 1,
        "granted": "60000.00",
        "applied": "0.00",
        "outstanding": "60000.00",
        "cancelled": "0.00",
    }
    # billing (not touched by this feature) takes the credit off the referrer's next charge
    gen = await ok(await tenant.post("/v1/charges/generate", {"month": BILL_MONTH}))
    assert gen["created"] == 2
    assert (await charge_of(tenant, referrer["id"]))["amount"] == "540000.00"
    assert (await charge_of(tenant, invited["id"]))["amount"] == "500000.00"
    rep = await credits_report(tenant)
    assert (
        rep["rows"][0]["source"] == "referral"
        and rep["totals"]["applied"] == "60000.00"
        and rep["totals"]["outstanding"] == "0.00"
    )


async def test_a_big_fixed_reward_is_split_so_that_no_money_is_lost(tenant: Tenant) -> None:
    await set_program(
        tenant, reward_type="amount", reward_value="1000000", condition="enrolled", min_paid="0"
    )
    _, referrer, _ = await student_in_group(tenant, "400000")
    _, invited, _ = await student_in_group(tenant, "300000")
    await refer(tenant, referrer, invited)
    booked = await ok(await tenant.post("/v1/referrals/book"))
    assert [(x["amount"], x["credits"]) for x in booked["rewarded"]] == [("1000000.00", 3)]
    await ok(await tenant.post("/v1/charges/generate", {"month": BILL_MONTH}))
    assert (await charge_of(tenant, referrer["id"]))[
        "amount"
    ] == "0.00"  # one 400000 credit used, the rest waits
    assert (await credits_report(tenant))["totals"] == {
        "count": 3,
        "granted": "1000000.00",
        "applied": "400000.00",
        "outstanding": "600000.00",
        "cancelled": "0.00",
    }


async def test_rewards_that_cannot_be_paid_are_reported_not_lost(tenant: Tenant) -> None:
    await set_program(tenant, reward_type="free_lesson", reward_value="1", condition="enrolled", min_paid="0")
    _, referrer, _ = await student_in_group(tenant)
    _, invited, _ = await student_in_group(tenant)
    await refer(tenant, referrer, invited)
    res = await ok(await tenant.post("/v1/referrals/book"))
    assert [s["reason"] for s in res["skipped"]] == [
        "reward_is_zero"
    ]  # no lessons this month, so a lesson is worth nothing
    # a referrer who is in no group cannot receive a percent or a lesson reward; he stays pending
    await set_program(tenant, reward_type="percent", reward_value="10", condition="enrolled", min_paid="0")
    loner = await mk_student(tenant)
    _, newcomer, _ = await student_in_group(tenant)
    await refer(tenant, loner, newcomer)
    res = await ok(await tenant.post("/v1/referrals/book"))
    reasons = {s["referrer_name"]: s["reason"] for s in res["skipped"]}
    assert reasons[loner["full_name"]] == "referrer_has_no_active_enrollment"
    assert {r["status"] for r in await ok(await tenant.get("/v1/referrals"))} == {"pending"}


async def test_enrolled_condition_waits_for_an_accepted_enrollment(tenant: Tenant) -> None:
    await set_program(tenant, reward_type="amount", reward_value="70000", condition="enrolled", min_paid="0")
    _, referrer, _ = await student_in_group(tenant)
    grp = await mk_group(tenant, monthly_fee="300000")
    invited = await mk_student(tenant)  # not enrolled anywhere yet
    await refer(tenant, referrer, invited)
    assert (await ok(await tenant.post("/v1/referrals/book")))["rewarded"] == []
    await enroll(tenant, grp["id"], invited["id"], "2026-01-01")
    res = await ok(await tenant.post("/v1/referrals/book"))
    assert [x["amount"] for x in res["rewarded"]] == ["70000.00"]


async def test_cancelling_a_referral_cancels_its_unused_credits(tenant: Tenant) -> None:
    await set_program(tenant, reward_type="amount", reward_value="900000", condition="enrolled", min_paid="0")
    _, referrer, _ = await student_in_group(tenant, "400000")
    _, invited, _ = await student_in_group(tenant)
    ref = await refer(tenant, referrer, invited)
    await ok(await tenant.post("/v1/referrals/book"))
    await ok(await tenant.post("/v1/charges/generate", {"month": BILL_MONTH}))  # one credit (400000) is used
    out = await ok(await tenant.post(f"/v1/referrals/{ref['id']}/cancel"))
    assert out["status"] == "cancelled" and out["credits_total"] == "400000.00"
    rep = (await credits_report(tenant))["totals"]
    assert (rep["applied"], rep["outstanding"], rep["cancelled"]) == ("400000.00", "0.00", "500000.00")
    assert (await tenant.post(f"/v1/referrals/{ref['id']}/cancel")).status_code == 409
    assert (await ok(await tenant.post("/v1/referrals/book")))[
        "rewarded"
    ] == []  # a cancelled referral is never rewarded
    # a pending one can be cancelled too
    _, other, _ = await student_in_group(tenant)
    _, newcomer, _ = await student_in_group(tenant)
    pending = await refer(tenant, other, newcomer)
    await ok(await tenant.post(f"/v1/referrals/{pending['id']}/cancel"))


# ---- promo codes -----------------------------------------------------------------------------------------------
async def campaign(t: Tenant, **kw: Any) -> dict[str, Any]:
    today = org_today()
    body = {
        "code": "kuz50",
        "name": "Kuz -50%",
        "kind": "percent",
        "value": "50",
        "valid_from": (today - timedelta(days=1)).isoformat(),
        "valid_to": (today + timedelta(days=30)).isoformat(),
        **kw,
    }
    return await ok(await t.post("/v1/promo-campaigns", body), 201)


async def redeem(t: Tenant, code: str, student: dict[str, Any], enr: dict[str, Any]) -> httpx.Response:
    return await t.post(
        "/v1/promo/redeem", {"code": code, "student_id": student["id"], "enrollment_id": enr["id"]}
    )


async def test_promo_campaign_validation(tenant: Tenant, tenant_b: Tenant) -> None:
    c = await campaign(tenant)
    assert c["code"] == "KUZ50" and c["state"] == "ok" and c["used"] == 0
    dup = await tenant.post(
        "/v1/promo-campaigns",
        {"code": "Kuz50", "name": "x", "kind": "amount", "value": "1", "valid_from": "2026-01-01"},
    )
    assert dup.status_code == 409
    base = {"code": "OTHER1", "name": "x", "kind": "amount", "value": "1000", "valid_from": "2026-01-01"}
    for bad in (
        {"code": "ab"},
        {"code": "has space"},
        {"name": ""},
        {"kind": "percent", "value": "101"},
        {"value": "0"},
        {"valid_to": "2025-12-31"},
        {"max_uses": 0},
        {"kind": "bogus"},
    ):
        assert (await tenant.post("/v1/promo-campaigns", {**base, **bad})).status_code == 422, bad
    await campaign(tenant_b)  # codes are per center
    assert [x["code"] for x in await ok(await tenant.get("/v1/promo-campaigns"))] == ["KUZ50"]


async def test_promo_states_block_redemption(tenant: Tenant) -> None:
    today = org_today()
    grp, st, enr = await student_in_group(tenant, "400000")
    await campaign(tenant, code="FUTURE", valid_from=(today + timedelta(days=3)).isoformat())
    await campaign(
        tenant,
        code="OLD",
        valid_from=(today - timedelta(days=9)).isoformat(),
        valid_to=(today - timedelta(days=1)).isoformat(),
    )
    off = await campaign(tenant, code="OFF")
    await ok(await tenant.patch(f"/v1/promo-campaigns/{off['id']}", {"active": False}))
    for code, state in (("FUTURE", "not_started"), ("OLD", "expired"), ("OFF", "inactive")):
        r = await redeem(tenant, code, st, enr)
        assert r.status_code == 409 and r.json()["error"]["code"] == "promo_unavailable", code
        assert r.json()["error"]["details"]["state"] == state
    assert (await redeem(tenant, "NOPE", st, enr)).status_code == 404
    one = await campaign(tenant, code="ONLYONE", max_uses=1)
    await ok(await redeem(tenant, "ONLYONE", st, enr), 201)
    _, st2, enr2 = await student_in_group(tenant, "400000")
    r = await redeem(tenant, "ONLYONE", st2, enr2)
    assert r.status_code == 409 and r.json()["error"]["details"]["state"] == "exhausted"
    shown = next(c for c in await ok(await tenant.get("/v1/promo-campaigns")) if c["id"] == one["id"])
    assert shown["used"] == 1 and shown["state"] == "exhausted"
    # the limit cannot go below what was already used
    assert (await tenant.patch(f"/v1/promo-campaigns/{one['id']}", {"max_uses": 1})).status_code == 200
    two = await campaign(tenant, code="TWO", max_uses=5)
    await ok(await redeem(tenant, "TWO", st, enr), 201)
    await ok(await redeem(tenant, "TWO", st2, enr2), 201)
    assert (await tenant.patch(f"/v1/promo-campaigns/{two['id']}", {"max_uses": 1})).status_code == 422
    assert (
        await tenant.patch(f"/v1/promo-campaigns/{two['id']}", {"valid_to": "2020-01-01"})
    ).status_code == 422


async def test_promo_redemption_is_a_credit_for_the_next_charge(tenant: Tenant) -> None:
    _, st, enr = await student_in_group(tenant, "400000")
    await campaign(tenant)
    red = await ok(await redeem(tenant, "kuz50", st, enr), 201)
    assert (red["fee"], red["amount"], red["applies"]) == ("400000.00", "200000.00", "next_billing_run")
    again = await redeem(tenant, "KUZ50", st, enr)
    assert again.status_code == 409 and again.json()["error"]["code"] == "promo_already_redeemed"
    rep = await credits_report(tenant)
    assert rep["rows"] == [
        {
            "source": "promo",
            "label": "KUZ50 - Kuz -50%",
            "count": 1,
            "granted": "200000.00",
            "applied": "0.00",
            "outstanding": "200000.00",
            "cancelled": "0.00",
        }
    ]
    await ok(await tenant.post("/v1/charges/generate", {"month": BILL_MONTH}))
    assert (await charge_of(tenant, st["id"]))["amount"] == "200000.00"
    assert (await credits_report(tenant))["totals"]["applied"] == "200000.00"


async def test_a_fixed_promo_never_exceeds_the_fee_and_wrong_enrollments_are_refused(tenant: Tenant) -> None:
    _, st, enr = await student_in_group(tenant, "300000")
    _, other, other_enr = await student_in_group(tenant, "300000")
    await campaign(tenant, code="BIG", kind="amount", value="500000")
    assert (await redeem(tenant, "BIG", st, other_enr)).status_code == 422  # not this student's enrollment
    assert (
        await tenant.post(
            "/v1/promo/redeem",
            {"code": "BIG", "student_id": st["id"], "enrollment_id": "00000000-0000-0000-0000-000000000000"},
        )
    ).status_code == 404
    assert (await ok(await redeem(tenant, "BIG", st, enr), 201))["amount"] == "300000.00"
    free = await mk_group(tenant, monthly_fee="0")
    zero = await mk_student(tenant)
    zero_enr = await enroll(tenant, free["id"], zero["id"], "2026-01-01")
    assert (await redeem(tenant, "BIG", zero, zero_enr)).status_code == 422  # nothing to discount


# ---- marketing credits in accounting ---------------------------------------------------------------------------
async def test_growth_credits_report_separates_promo_and_referral(tenant: Tenant) -> None:
    today = org_today()
    await set_program(tenant, reward_type="amount", reward_value="100000", condition="enrolled", min_paid="0")
    _, a, a_enr = await student_in_group(tenant, "400000")
    _, b, b_enr = await student_in_group(tenant, "400000")
    await refer(tenant, a, b)
    await ok(await tenant.post("/v1/referrals/book"))
    await campaign(tenant, code="KUZ50")
    await campaign(tenant, code="DOST", name="Dost kodi", kind="amount", value="50000")
    await ok(await redeem(tenant, "KUZ50", a, a_enr), 201)
    await ok(await redeem(tenant, "DOST", b, b_enr), 201)
    rep = await credits_report(tenant)
    assert [(r["source"], r["label"], r["granted"]) for r in rep["rows"]] == [
        ("promo", "DOST - Dost kodi", "50000.00"),
        ("promo", "KUZ50 - Kuz -50%", "200000.00"),
        ("referral", "Referral", "100000.00"),
    ]
    assert rep["totals"]["granted"] == "350000.00" and rep["totals"]["count"] == 3
    tomorrow = (today + timedelta(days=1)).isoformat()
    assert (await credits_report(tenant, date_from=tomorrow))["rows"] == []
    assert (await credits_report(tenant, date_from=today.isoformat(), date_to=today.isoformat()))["totals"][
        "count"
    ] == 3
    assert (
        await tenant.get(
            "/v1/accounting/growth-credits", params={"date_from": "2026-12-02", "date_to": "2026-12-01"}
        )
    ).status_code == 422


# ---- lead source ROI -------------------------------------------------------------------------------------------
async def test_source_roi_compares_cost_with_the_revenue_of_converted_leads(tenant: Tenant) -> None:
    today = org_today()
    first = today.replace(day=1)
    insta = await ok(await tenant.post("/v1/lead-sources", {"name": "Instagram"}), 201)
    tanish = await ok(await tenant.post("/v1/lead-sources", {"name": "Tanish"}), 201)
    grp = await mk_group(tenant, monthly_fee="300000")
    a = await ok(await tenant.post("/v1/leads", {"full_name": "Ali", "source_id": insta["id"]}), 201)
    await ok(await tenant.post("/v1/leads", {"full_name": "Vali", "source_id": insta["id"]}), 201)
    c = await ok(await tenant.post("/v1/leads", {"full_name": "Sami", "source_id": tanish["id"]}), 201)
    for ld, amount in ((a, "300000"), (c, "100000")):
        res = await ok(await tenant.post(f"/v1/leads/{ld['id']}/enroll-trial", {"group_id": grp["id"]}))
        await pay(tenant, res["student_id"], amount)
    cost = await ok(
        await tenant.put(
            f"/v1/lead-sources/{insta['id']}/costs/{first.isoformat()}", {"amount": "150000", "note": "ads"}
        )
    )
    assert cost["amount"] == "150000.00" and cost["source"] == "Instagram"
    # repeating corrects the figure instead of adding a second one
    await ok(
        await tenant.put(f"/v1/lead-sources/{insta['id']}/costs/{first.isoformat()}", {"amount": "150000"})
    )
    assert len(await ok(await tenant.get("/v1/lead-source-costs"))) == 1
    rep = await ok(
        await tenant.get(
            "/v1/reports/source-roi", params={"date_from": first.isoformat(), "date_to": today.isoformat()}
        )
    )
    rows = {r["source"]: r for r in rep["rows"]}
    assert rows["Instagram"] == {
        "source": "Instagram",
        "leads": 2,
        "paying": 1,
        "revenue": "300000.00",
        "cost": "150000.00",
        "roi": 100.0,
        "cost_per_lead": "75000.00",
        "cost_per_paying": "150000.00",
    }
    assert (
        rows["Tanish"]["roi"] is None
        and rows["Tanish"]["revenue"] == "100000.00"
        and rows["Tanish"]["cost"] == "0.00"
    )
    assert rep["rows"][0]["source"] == "Instagram"  # ordered by revenue
    assert (
        rep["total"]["leads"] == 3
        and rep["total"]["paying"] == 2
        and rep["total"]["revenue"] == "400000.00"
        and rep["total"]["roi"] == 166.7
    )
    empty = await ok(
        await tenant.get(
            "/v1/reports/source-roi", params={"date_from": "2020-01-01", "date_to": "2020-01-31"}
        )
    )
    assert empty["rows"] == [] and empty["total"]["roi"] is None


async def test_source_cost_validation_and_permissions(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    src = await ok(await tenant.post("/v1/lead-sources", {"name": "OLX"}), 201)
    url = f"/v1/lead-sources/{src['id']}/costs"
    assert (
        await tenant.put(f"{url}/2026-11-15", {"amount": "1"})
    ).status_code == 422  # first day of a month only
    assert (await tenant.put(f"{url}/2026-11-01", {"amount": "-1"})).status_code == 422
    assert (await tenant.put(f"{url}/2026-11-01", {"amount": "1", "extra": 1})).status_code == 422
    assert (
        await tenant.put(f"{url}/2026-11-01", {"amount": "0"})
    ).status_code == 200  # zero is a real figure
    assert (
        await tenant_b.put(f"{url}/2026-11-01", {"amount": "5"})
    ).status_code == 404  # another center's source
    assert await ok(await tenant_b.get("/v1/lead-source-costs")) == []
    assert (
        await tenant.get(
            "/v1/reports/source-roi", params={"date_from": "2026-12-01", "date_to": "2026-11-01"}
        )
    ).status_code == 422
    _, v_email = await _add_staff(tenant, "viewer")
    viewer = await _login(client, v_email, "staff-password-123")
    assert (
        await viewer.get(
            "/v1/reports/source-roi", params={"date_from": "2026-11-01", "date_to": "2026-11-30"}
        )
    ).status_code == 200
    assert (await viewer.put(f"{url}/2026-11-01", {"amount": "9"})).status_code == 403
    assert (await viewer.get("/v1/lead-source-costs")).status_code == 403
    assert (await viewer.get("/v1/referrals")).status_code == 403
    assert (
        await viewer.put("/v1/referral-program", {"reward_type": "amount", "reward_value": "1"})
    ).status_code == 403
    assert (await viewer.get("/v1/accounting/growth-credits")).status_code == 403
    assert (
        await viewer.post(
            "/v1/promo/redeem", {"code": "ABC", "student_id": src["id"], "enrollment_id": src["id"]}
        )
    ).status_code == 403


# ---- internal lead reminders -----------------------------------------------------------------------------------
async def test_lead_reminders_are_an_internal_list_and_send_nothing(
    client: httpx.AsyncClient, tenant: Tenant, super_dsn: str
) -> None:
    today = org_today()
    assert (await ok(await tenant.get("/v1/settings")))["lead_reminder_days"] == 3
    for bad in (0, 61):
        assert (await tenant.patch("/v1/settings", {"lead_reminder_days": bad})).status_code == 422
    quiet = await ok(await tenant.post("/v1/leads", {"full_name": "Quiet"}), 201)
    due = await ok(
        await tenant.post(
            "/v1/leads", {"full_name": "Due", "next_follow_up_on": (today - timedelta(days=2)).isoformat()}
        ),
        201,
    )
    planned = await ok(
        await tenant.post(
            "/v1/leads",
            {"full_name": "Planned", "next_follow_up_on": (today + timedelta(days=9)).isoformat()},
        ),
        201,
    )
    fresh = await ok(await tenant.post("/v1/leads", {"full_name": "Fresh"}), 201)
    attended = await ok(await tenant.post("/v1/leads", {"full_name": "Attended"}), 201)
    await ok(await tenant.patch(f"/v1/leads/{attended['id']}", {"stage": "trial_attended"}))
    lost = await ok(await tenant.post("/v1/leads", {"full_name": "Lost"}), 201)
    await ok(await tenant.patch(f"/v1/leads/{lost['id']}", {"stage": "lost"}))
    with psycopg.connect(super_dsn) as c:  # a lead cannot be created in the past through the API
        c.execute(
            "UPDATE leads SET created_at = now() - interval '5 days' WHERE public_id IN (%s, %s, %s, %s)",
            (quiet["id"], planned["id"], attended["id"], lost["id"]),
        )
        c.commit()
    before = outbox_count(super_dsn)
    got = await ok(await tenant.get("/v1/leads/reminders"))
    assert [(r["full_name"], r["reason"], r["days"]) for r in got] == [
        ("Due", "follow_up_due", 2),
        ("Attended", "after_trial", 5),
        ("Quiet", "silent", 5),
    ]
    assert {"lead_id", "phone", "source", "stage", "next_follow_up_on", "last_contact_on"} <= set(got[0])
    assert outbox_count(super_dsn) == before  # nothing is queued for anybody
    # a logged contact today silences the lead; the quiet-days setting moves the threshold
    await ok(
        await tenant.post(
            f"/v1/leads/{quiet['id']}/interactions",
            {"happened_on": today.isoformat(), "kind": "call", "summary": "Called"},
        ),
        201,
    )
    assert "Quiet" not in [r["full_name"] for r in await ok(await tenant.get("/v1/leads/reminders"))]
    await ok(await tenant.patch("/v1/settings", {"lead_reminder_days": 1}))
    names = [r["full_name"] for r in await ok(await tenant.get("/v1/leads/reminders"))]
    assert "Fresh" not in names  # created today: 0 quiet days
    assert due["id"] and fresh["id"]
    # a new follow-up date moves the lead out of "due"
    await ok(
        await tenant.patch(
            f"/v1/leads/{due['id']}", {"next_follow_up_on": (today + timedelta(days=4)).isoformat()}
        )
    )
    assert "Due" not in [r["full_name"] for r in await ok(await tenant.get("/v1/leads/reminders"))]
    # permissions: staff who can read students may look, teachers may not; another center sees nothing of this
    _, t_email = await _add_staff(tenant, "teacher")
    teacher = await _login(client, t_email, "staff-password-123")
    assert (await teacher.get("/v1/leads/reminders")).status_code == 403
    assert (await client.get("/v1/leads/reminders")).status_code == 401


async def test_other_centers_see_none_of_it(tenant: Tenant, tenant_b: Tenant) -> None:
    await set_program(tenant)
    _, a, _ = await student_in_group(tenant)
    _, b, _ = await student_in_group(tenant)
    ref = await refer(tenant, a, b)
    camp = await campaign(tenant)
    assert await ok(await tenant_b.get("/v1/referral-program")) is None
    assert await ok(await tenant_b.get("/v1/referrals")) == []
    assert await ok(await tenant_b.get("/v1/promo-campaigns")) == []
    assert (await tenant_b.post(f"/v1/referrals/{ref['id']}/cancel")).status_code == 404
    assert (await tenant_b.patch(f"/v1/promo-campaigns/{camp['id']}", {"active": False})).status_code == 404
    assert (
        await tenant_b.post(
            "/v1/promo/redeem", {"code": "KUZ50", "student_id": a["id"], "enrollment_id": ref["id"]}
        )
    ).status_code == 404
    assert (await credits_report(tenant_b))["rows"] == []
    assert (await ok(await tenant_b.post("/v1/referrals/book")))["rewarded"] == []
