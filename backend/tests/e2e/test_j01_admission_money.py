"""Journey 1: a lead becomes a paying student and the money flows into correct books.

lead -> trial -> accept -> enroll -> attendance -> monthly charges with family/individual/scholarship discounts -> partial
payments (FIFO) -> refund -> cash close with a difference -> period close -> accounting reports. After every phase the
books must be sound (chain verifies, trial balance and balance sheet balance)."""

from __future__ import annotations

from typing import Any

from tests.conftest import Tenant
from tests.e2e.journeys import (
    TODAY,
    A,
    assert_books_sound,
    entries,
    lessons_of,
    link_guardian,
    mark_present,
    money,
    pay,
    phone,
)
from tests.helpers import enroll, mk_group, mk_guardian, mk_student, ok


async def _balance(t: Tenant, student_id: str) -> dict[str, Any]:
    return await ok(await t.get(f"/v1/students/{student_id}/balance"))  # type: ignore[no-any-return]


async def test_lead_to_paying_student_to_closed_books(tenant: Tenant) -> None:
    t = tenant
    # --- center setup: monthly group on Mondays, family discount for the 2nd child
    grp = await mk_group(t, monthly_fee="600000")
    await ok(
        await t.put(
            f"/v1/groups/{grp['id']}/schedule",
            [{"weekday": 1, "start_time": "10:00:00", "end_time": "11:00:00"}],
        )
    )
    await ok(
        await t.post(
            f"/v1/groups/{grp['id']}/lessons/generate", {"date_from": "2026-01-01", "date_to": "2026-02-28"}
        )
    )
    await ok(await t.patch("/v1/settings", {"family_discount_2nd_percent": 10}))

    # --- lead -> trial (atomic: student + trial enrollment)
    src = await ok(await t.post("/v1/lead-sources", {"name": "Instagram"}), 201)
    ld = await ok(
        await t.post("/v1/leads", {"full_name": "Aziza Karimova", "phone": phone(), "source_id": src["id"]}),
        201,
    )
    conv = await ok(
        await t.post(
            f"/v1/leads/{ld['id']}/enroll-trial", {"group_id": grp["id"], "started_on": "2026-01-05"}
        )
    )
    a_id, trial = conv["student_id"], conv["enrollment"]
    assert trial["status"] == "trial" and conv["lead"]["stage"] == "trial_scheduled"
    assert (await ok(await t.get("/v1/charges", params={"student_id": a_id})))[
        "items"
    ] == []  # a trial is not billed

    # --- the trial lesson is attended
    by_day = {x["lesson_date"]: x for x in await lessons_of(t, grp["id"], "2026-01-01", "2026-02-28")}
    await mark_present(t, by_day["2026-01-05"]["id"], [a_id])

    # --- accept: the first month is billed in full, accepting twice never double-bills
    await ok(
        await t.post(f"/v1/enrollments/{trial['id']}/accept", {"mode": "full", "accepted_on": "2026-01-12"})
    )
    jan_charges = (await ok(await t.get("/v1/charges", params={"student_id": a_id})))["items"]
    assert [(c["period_month"], c["amount"]) for c in jan_charges] == [("2026-01-01", "600000.00")]
    assert (await t.post(f"/v1/enrollments/{trial['id']}/accept", {"mode": "full"})).status_code == 409
    await assert_books_sound(t)

    # --- a sibling (shared guardian), a student with an individual discount, a scholarship student
    mom = await mk_guardian(t, "Karimova Dilnoza")
    await link_guardian(t, a_id, mom["id"])
    b = await mk_student(t, "Sibling Karimov")
    await link_guardian(t, b["id"], mom["id"])
    c = await mk_student(t, "Individual Student")
    s = await mk_student(t, "Scholar Student")
    for st in (b, c, s):
        await enroll(t, grp["id"], st["id"], "2026-01-01")
    await ok(
        await t.post(
            "/v1/discounts",
            {
                "student_id": c["id"],
                "kind": "individual",
                "amount": "100000",
                "reason": "staff child",
                "valid_from": "2026-01-01",
            },
        ),
        201,
    )
    await ok(
        await t.post(
            "/v1/discounts",
            {
                "student_id": s["id"],
                "kind": "scholarship",
                "percent": "100",
                "reason": "olympiad winner",
                "valid_from": "2026-01-01",
            },
        ),
        201,
    )

    # --- February billing (idempotent): A 600000, sibling -10%, individual -100000, scholar free
    gen = await ok(await t.post("/v1/charges/generate", {"month": "2026-02-01", "due_day": 10}))
    assert gen["skipped_free"] == 1
    feb = {
        x["student_id"]: x
        for x in (await ok(await t.get("/v1/charges", params={"month": "2026-02-01", "limit": 200})))["items"]
    }
    assert money(feb[a_id]["amount"]) == 600000
    assert money(feb[b["id"]]["amount"]) == 540000
    assert money(feb[c["id"]]["amount"]) == 500000
    assert s["id"] not in feb
    assert (await ok(await t.post("/v1/charges/generate", {"month": "2026-02-01", "due_day": 10})))[
        "created"
    ] == 0

    # --- payments: February's payment is FIFO-allocated to the OLDEST charge first
    p1 = await pay(t, a_id, "400000", "2026-01-20T10:00:00+05:00")
    assert money(p1["allocated"]) == 400000
    assert money((await _balance(t, a_id))["outstanding_total"]) == 200000 + 600000
    p2 = await pay(t, a_id, "700000", "2026-02-03T10:00:00+05:00")
    alloc = [(x["period_month"], money(x["amount"])) for x in p2["allocations"]]
    assert alloc == [("2026-01-01", 200000), ("2026-02-01", 500000)]
    assert money((await _balance(t, a_id))["outstanding_total"]) == 100000
    pb = await pay(t, b["id"], "540000", "2026-02-04T10:00:00+05:00", method="bank_transfer")
    assert money(pb["unallocated"]) == 0 and money((await _balance(t, b["id"]))["outstanding_total"]) == 0
    over = await pay(
        t, c["id"], "800000", "2026-02-05T10:00:00+05:00"
    )  # overpayment is credit, never a negative debt
    assert money(over["unallocated"]) == 300000
    cb = await _balance(t, c["id"])
    assert money(cb["outstanding_total"]) == 0 and money(cb["credit"]) == 300000
    await assert_books_sound(t)

    # --- a cash refund of part of A's February payment: the allocation is released, the debt reappears
    r = await ok(
        await t.post(
            "/v1/refunds",
            {
                "kind": "wrong_payment",
                "student_id": a_id,
                "payment_id": p2["id"],
                "amount": "50000",
                "payout": "cash",
                "reason": "paid twice by mistake",
            },
        ),
        201,
    )
    assert money(r["amount"]) == 50000
    assert money((await _balance(t, a_id))["outstanding_total"]) == 150000
    await assert_books_sound(t)

    # --- cash close: the books expect cash in minus cash out; the cashier counted 10000 less
    prev = await ok(await t.get("/v1/cash-close/preview"))
    expected = 400000 + 700000 + 800000 - 50000
    assert money(prev["book_balance"]) == expected
    assert (
        await t.post("/v1/cash-close", {"counted": str(expected - 10000)})
    ).status_code == 422  # note required
    shift = await ok(
        await t.post(
            "/v1/cash-close",
            {"counted": str(expected - 10000), "note": "short 10000", "post_difference": True},
        ),
        201,
    )
    assert money(shift["difference"]) == -10000 and shift["adjustment_entry_no"] is not None
    shift2 = await ok(await t.post("/v1/cash-close", {"counted": str(expected - 10000)}), 201)
    assert shift2["shift_no"] == 2 and money(shift2["difference"]) == 0
    await assert_books_sound(t)

    # --- close January and February: closed months refuse new entries, the chain still verifies
    for month in ("2026-01", "2026-02"):
        await ok(await t.post(f"{A}/periods/{month}/close"), 201)
    late = {
        "date": "2026-01-15",
        "memo": "late entry",
        "lines": [
            {"account": "1000", "debit": "1000", "credit": "0"},
            {"account": "3000", "debit": "0", "credit": "1000"},
        ],
    }
    assert (await t.post(f"{A}/entries", late)).status_code == 409
    assert [p["month"] for p in await ok(await t.get(f"{A}/periods"))] == ["2026-01", "2026-02"]

    # --- reports tie out to the operational money
    tb = await assert_books_sound(t)
    rows = {r["code"]: r for r in tb["rows"]}
    assert money(rows["1000"]["balance_debit"]) == expected - 10000
    assert money(rows["1010"]["balance_debit"]) == 540000
    assert money(rows["4000"]["balance_credit"]) == 400000 + 700000 + 540000 + 800000
    assert money(rows["4200"]["balance_debit"]) == 50000
    inc = await ok(
        await t.get(
            f"{A}/reports/income-statement", params={"date_from": "2026-01-01", "date_to": TODAY.isoformat()}
        )
    )
    gross = 400000 + 700000 + 540000 + 800000
    assert (money(inc["total_income"]), money(inc["total_expenses"]), money(inc["net"])) == (
        gross - 50000,
        10000,
        gross - 50000 - 10000,
    )
    # the books agree with the operational summary on what was received
    summary = await ok(await t.get("/v1/reports/summary", params={"month": "2026-02-01"}))
    assert (money(summary["charged"]), money(summary["revenue"])) == (1640000, 700000 + 540000 + 800000)
    assert money(summary["outstanding_now"]) == 150000
    assert len(await entries(t)) == 6  # four payments, the refund, the cash difference
