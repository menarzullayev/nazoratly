"""Journey 3: growth. A marketing source brings a lead who pays; the referrer is rewarded; a promo code halves a fee; both
become credits that the next billing run consumes. The journal is not touched by credits (revenue simply shrinks on the
charge) and nothing is ever sent to a lead or a guardian by automation."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from tests.conftest import Tenant
from tests.e2e.journeys import TODAY, assert_books_sound, entries, money, pay
from tests.helpers import mk_group, ok
from tests.test_growth import campaign, credits_report, redeem, refer, set_program, student_in_group

NEXT_MONTH = ((TODAY.replace(day=1) + timedelta(days=32)).replace(day=1)).isoformat()


async def month_charge(t: Tenant, student_id: str, month: str) -> dict[str, Any]:
    items = (await ok(await t.get("/v1/charges", params={"student_id": student_id, "month": month})))["items"]
    assert len(items) == 1, items
    return items[0]  # type: ignore[no-any-return]


async def test_source_to_referral_and_promo_credits(tenant: Tenant) -> None:
    t = tenant
    first = TODAY.replace(day=1).isoformat()
    await set_program(t, reward_type="percent", reward_value="10", condition="paid", min_paid="100000")

    # --- an existing student (the referrer) and a promo campaign
    _, referrer, _ = await student_in_group(t, "600000", "Referrer Ali")
    _, promo_kid, promo_enr = await student_in_group(t, "400000", "Promo Vali")
    await campaign(t, code="KUZ50")

    # --- marketing: Instagram brought a lead; it costs 150000 this month; the lead becomes a trial and pays
    insta = await ok(await t.post("/v1/lead-sources", {"name": "Instagram"}), 201)
    await ok(
        await t.put(f"/v1/lead-sources/{insta['id']}/costs/{first}", {"amount": "150000", "note": "ads"})
    )
    grp = await mk_group(t, monthly_fee="300000")
    lead = await ok(await t.post("/v1/leads", {"full_name": "Newcomer Sami", "source_id": insta["id"]}), 201)
    conv = await ok(await t.post(f"/v1/leads/{lead['id']}/enroll-trial", {"group_id": grp["id"]}))
    invited_id = conv["student_id"]
    await ok(
        await t.post(f"/v1/enrollments/{conv['enrollment']['id']}/accept", {"mode": "full"})
    )  # a trial is never billed
    invited = {"id": invited_id}

    # --- the referral is recorded under the rule of the day; it does not pay until the invited student pays enough
    ref = await refer(t, referrer, invited)
    assert ref["status"] == "pending"
    assert (await ok(await t.post("/v1/referrals/book")))["rewarded"] == []
    await pay(t, invited_id, "300000")
    booked = await ok(await t.post("/v1/referrals/book"))
    assert [(x["amount"], x["credits"]) for x in booked["rewarded"]] == [("60000.00", 1)]
    assert (await ok(await t.post("/v1/referrals/book")))["rewarded"] == []  # booking twice never pays twice

    # --- the promo: half of the first fee as a credit, one use per student
    red = await ok(await redeem(t, "kuz50", promo_kid, promo_enr), 201)
    assert (red["fee"], red["amount"]) == ("400000.00", "200000.00")
    assert (await redeem(t, "KUZ50", promo_kid, promo_enr)).status_code == 409

    # --- credits wait for the next billing run, and they show as outstanding marketing money
    rep = await credits_report(t)
    assert rep["totals"]["granted"] == "260000.00" and rep["totals"]["outstanding"] == "260000.00"
    assert {r["source"] for r in rep["rows"]} == {"promo", "referral"}

    # --- the next run consumes them: referrer 600000-60000, promo kid 400000-200000, the others full
    gen = await ok(await t.post("/v1/charges/generate", {"month": NEXT_MONTH, "due_day": 10}))
    assert gen["created"] == 3
    assert money((await month_charge(t, referrer["id"], NEXT_MONTH))["amount"]) == 540000
    assert money((await month_charge(t, promo_kid["id"], NEXT_MONTH))["amount"]) == 200000
    assert money((await month_charge(t, invited_id, NEXT_MONTH))["amount"]) == 300000
    rep = await credits_report(t)
    assert rep["totals"]["applied"] == "260000.00" and rep["totals"]["outstanding"] == "0.00"
    assert (await ok(await t.post("/v1/charges/generate", {"month": NEXT_MONTH, "due_day": 10})))[
        "created"
    ] == 0
    assert (await ok(await t.get("/v1/referrals", params={"status": "rewarded"})))[0][
        "reward_amount"
    ] == "60000.00"

    # --- credits are not cash: the journal holds only the one real payment, and the books are sound
    assert [e["source_type"] for e in await entries(t)] == ["payment"]
    await assert_books_sound(t)

    # --- the source report ties cost to the revenue of the converted lead
    roi = await ok(
        await t.get("/v1/reports/source-roi", params={"date_from": first, "date_to": TODAY.isoformat()})
    )
    row = next(r for r in roi["rows"] if r["source"] == "Instagram")
    assert (row["leads"], row["paying"], row["revenue"], row["cost"]) == (1, 1, "300000.00", "150000.00")
    assert row["roi"] == 100.0

    # --- lead reminders and the whole journey sent nothing to anyone
    await ok(await t.get("/v1/leads/reminders"))
    assert (await ok(await t.get("/v1/outbox")))["items"] == []
