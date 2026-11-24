"""Money invariants under a long random sequence of operations (seeded: reproducible). After every batch:

 * the journal chain verifies, the trial balance and balance sheet balance, no entry is unbalanced;
 * per student: 0 <= paid <= amount on every charge, outstanding never negative, credit never negative, and the money adds up
   (payments - refunds - allocated = credit);
 * the books match the operational records: cash (1000) and bank (1010) balances equal payments minus refunds by method,
   revenue (4000) equals the live payments, refunds (4200) equal the refunds paid out;
 * FIFO: with only automatic allocations, a younger charge is never paid while an older one is open.
Eight concurrent payments never over-allocate."""

from __future__ import annotations

import asyncio
import random
from typing import Any

from tests.conftest import Tenant
from tests.e2e.journeys import assert_books_sound, money
from tests.helpers import enroll, mk_group, mk_student, ok

MONTHS = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]


async def all_charges(t: Tenant, student_id: str) -> list[dict[str, Any]]:
    return (await ok(await t.get("/v1/charges", params={"student_id": student_id, "limit": 200})))["items"]


async def live_payments(t: Tenant, student_id: str) -> list[dict[str, Any]]:
    items = (await ok(await t.get("/v1/payments", params={"student_id": student_id, "limit": 200})))["items"]
    return [p for p in items if not p.get("voided")]


async def student_invariants(t: Tenant, student_id: str, refunded: int) -> tuple[int, int]:
    charges = [c for c in await all_charges(t, student_id) if not c["voided"]]
    for c in charges:
        assert 0 <= money(c["paid"]) <= money(c["amount"]), c
        assert money(c["outstanding"]) == money(c["amount"]) - money(c["paid"]), c
    bal = await ok(await t.get(f"/v1/students/{student_id}/balance"))
    outstanding = money(bal["outstanding_total"])
    assert outstanding == sum(money(c["outstanding"]) for c in charges) and outstanding >= 0
    credit = money(bal["credit"])
    assert credit >= 0
    paid_in = sum(money(p["amount"]) for p in await live_payments(t, student_id))
    allocated = sum(money(c["paid"]) for c in charges)
    assert paid_in - refunded - allocated == credit, (paid_in, refunded, allocated, credit)
    return paid_in, refunded


async def check_everything(
    t: Tenant, students: list[dict[str, Any]], refunds: dict[str, int], methods: dict[str, str]
) -> None:
    live_cash = live_other = 0
    for s in students:
        await student_invariants(t, s["id"], refunds.get(s["id"], 0))
        for p in await live_payments(t, s["id"]):
            if p["method"] == "cash":
                live_cash += money(p["amount"])
            else:
                live_other += money(p["amount"])
    tb = await assert_books_sound(t)
    rows = {r["code"]: r for r in tb["rows"]}

    def bal(code: str) -> int:
        r = rows.get(code)
        return 0 if r is None else money(r["balance_debit"]) - money(r["balance_credit"])

    refunded_total = sum(refunds.values())
    assert bal("1000") == live_cash - refunded_total  # every refund in this test is paid out of the cash desk
    assert bal("1010") == live_other
    assert -bal("4000") == live_cash + live_other
    assert bal("4200") == refunded_total


async def test_random_operations_keep_the_money_and_the_books_consistent(tenant: Tenant) -> None:
    t = tenant
    rng = random.Random(20261125)
    grp = await mk_group(t, monthly_fee="500000")
    students = [await mk_student(t, f"Money Student {i}") for i in range(6)]
    for s in students:
        await enroll(t, grp["id"], s["id"], "2026-01-01")
    for month in MONTHS:
        assert (await ok(await t.post("/v1/charges/generate", {"month": month, "due_day": 10})))[
            "created"
        ] == 6

    # --- phase 1: automatic allocation only -> strict FIFO per student
    for _ in range(20):
        s = rng.choice(students)
        await ok(
            await t.post(
                "/v1/payments",
                {
                    "student_id": s["id"],
                    "amount": str(rng.randrange(50, 700) * 1000),
                    "method": rng.choice(["cash", "bank_transfer", "card"]),
                },
            ),
            201,
        )
    for s in students:
        charges = sorted(
            (c for c in await all_charges(t, s["id"]) if not c["voided"]),
            key=lambda c: (c["due_date"], c["period_month"]),
        )
        seen_open = False
        for c in charges:
            if seen_open:
                assert money(c["paid"]) == 0, (
                    f"FIFO broken for {s['full_name']}: {c['period_month']} paid while an older charge is open"
                )
            if money(c["outstanding"]) > 0:
                seen_open = True
    await check_everything(t, students, {}, {})

    # --- phase 2: a random mix of payments, voids, credit allocation and cash refunds
    refunds: dict[str, int] = {s["id"]: 0 for s in students}
    for step in range(1, 61):
        s = rng.choice(students)
        op = rng.choice(["pay", "pay", "pay", "void", "credit", "refund", "void_charge"])
        if op == "pay":
            await ok(
                await t.post(
                    "/v1/payments",
                    {
                        "student_id": s["id"],
                        "amount": str(rng.randrange(20, 900) * 1000),
                        "method": rng.choice(["cash", "bank_transfer"]),
                    },
                ),
                201,
            )
        elif op == "void":
            live = await live_payments(t, s["id"])
            if live:
                p = rng.choice(live)
                r = await t.post(f"/v1/payments/{p['id']}/void", {"reason": "entered in error"})
                assert r.status_code in (200, 409), r.text  # a refunded payment cannot be voided
        elif op == "credit":
            await ok(await t.post(f"/v1/students/{s['id']}/allocate-credit"))
        elif op == "refund":
            live = [p for p in await live_payments(t, s["id"]) if p["method"] == "cash"]
            if live:
                p = rng.choice(live)
                amount = rng.randrange(5, 50) * 1000
                r = await t.post(
                    "/v1/refunds",
                    {
                        "kind": "wrong_payment",
                        "student_id": s["id"],
                        "payment_id": p["id"],
                        "amount": str(amount),
                        "payout": "cash",
                        "reason": "paid by mistake",
                    },
                )
                assert r.status_code in (201, 422), r.text  # 422: more than what is left to refund
                if r.status_code == 201:
                    refunds[s["id"]] += amount
        elif op == "void_charge":
            open_charges = [
                c for c in await all_charges(t, s["id"]) if not c["voided"] and money(c["paid"]) == 0
            ]
            if open_charges and rng.random() < 0.3:
                c = rng.choice(open_charges)
                await ok(await t.post(f"/v1/charges/{c['id']}/void", {"reason": "billed by mistake"}))
        if step % 15 == 0:
            await check_everything(t, students, refunds, {})
    await check_everything(t, students, refunds, {})


async def test_concurrent_payments_never_over_allocate(tenant: Tenant) -> None:
    t = tenant
    grp = await mk_group(t, monthly_fee="400000")
    s = await mk_student(t, "Concurrent payer")
    await enroll(t, grp["id"], s["id"], "2026-01-01")
    for month in MONTHS[:3]:
        await ok(await t.post("/v1/charges/generate", {"month": month, "due_day": 10}))
    owed = 3 * 400000
    results = await asyncio.gather(
        *[
            t.post("/v1/payments", {"student_id": s["id"], "amount": "250000", "method": "cash"})
            for _ in range(8)
        ]
    )
    assert all(r.status_code == 201 for r in results), [r.text for r in results if r.status_code != 201]
    allocated = sum(money(r.json()["allocated"]) for r in results)
    assert allocated == owed  # 2,000,000 paid against 1,200,000 owed: exactly what is owed was allocated
    await student_invariants(t, s["id"], 0)
    bal = await ok(await t.get(f"/v1/students/{s['id']}/balance"))
    assert money(bal["outstanding_total"]) == 0 and money(bal["credit"]) == 8 * 250000 - owed
    await assert_books_sound(t)
