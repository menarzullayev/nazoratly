"""Refunds (G1): wrong payment, student leaves, package remainder and conversion to credit, all through the journal.
The amounts are the shared golden rules (tests/golden/money.json); these tests prove the plumbing: money really leaves the
right payments, charges shrink, the debt/credit numbers follow, the hash-chained journal gets the entries (and none for credit),
and validation, permissions and tenant isolation hold."""

from __future__ import annotations

from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, ok
from tests.test_accounting import A, entries, shape
from tests.test_packages import attend, balance, pkg_group, sell, student_in
from tests.test_tenancy_and_staff import _add_staff, _login

MONTH = "2026-11-01"


async def setup_paid(
    t: Tenant, fee: str = "300000", paid: str | None = "300000", method: str = "cash", month: str = MONTH
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    """A student with one billed month, optionally paid in one payment; returns (student, charge, payment)."""
    grp = await mk_group(t, monthly_fee=fee)
    st = await mk_student(t)
    await enroll(t, grp["id"], st["id"], "2026-11-01")
    await ok(await t.post("/v1/charges/generate", {"month": month, "due_day": 10}))
    charge = (await ok(await t.get("/v1/charges", params={"student_id": st["id"], "month": month})))["items"][
        0
    ]
    payment = None
    if paid:
        payment = await ok(
            await t.post("/v1/payments", {"student_id": st["id"], "amount": paid, "method": method}), 201
        )
    return st, charge, payment


async def refund(t: Tenant, body: dict[str, Any], status: int = 201) -> Any:
    return await ok(await t.post("/v1/refunds", {"reason": "owner decision", **body}), status)


async def refund_entries(t: Tenant) -> list[dict[str, Any]]:
    return await entries(t, source_type="refund")


# ---- wrong payment ----------------------------------------------------------------------------------------------------
async def test_wrong_payment_gives_cash_back_reopens_the_debt_and_posts_to_the_journal(
    tenant: Tenant,
) -> None:
    st, charge, pay = await setup_paid(tenant)
    assert pay is not None
    pre = await ok(
        await tenant.post(
            "/v1/refunds/preview",
            {
                "kind": "wrong_payment",
                "student_id": st["id"],
                "payout": "cash",
                "reason": "preview",
                "payment_id": pay["id"],
                "amount": "100000",
            },
        )
    )
    assert (pre["amount"], pre["available"], pre["errors"]) == ("100000.00", "300000.00", [])
    assert (await ok(await tenant.get("/v1/refunds")))["items"] == []  # a preview writes nothing
    r = await refund(
        tenant,
        {
            "kind": "wrong_payment",
            "student_id": st["id"],
            "payout": "cash",
            "payment_id": pay["id"],
            "amount": "100000",
        },
    )
    assert (r["kind"], r["payout"], r["amount"], r["charge_reduction"], r["charge_id"]) == (
        "wrong_payment",
        "cash",
        "100000.00",
        "0.00",
        None,
    )
    assert [(x["payment_id"], x["amount"]) for x in r["payments"]] == [(pay["id"], "100000.00")]
    after = await ok(await tenant.get(f"/v1/payments/{pay['id']}"))
    assert (
        after["amount"],
        after["refunded"],
        after["allocated"],
        after["unallocated"],
        after["voided"],
    ) == ("300000.00", "100000.00", "200000.00", "0.00", False)
    ch = await ok(await tenant.get(f"/v1/charges/{charge['id']}"))
    assert (ch["amount"], ch["paid"], ch["outstanding"]) == (
        "300000.00",
        "200000.00",
        "100000.00",
    )  # the money left, so the debt is open again
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert (bal["outstanding_total"], bal["credit"]) == ("100000.00", "0.00")
    es = await refund_entries(tenant)
    assert len(es) == 1 and shape(es[0]) == [("4200", "100000.00", "0.00"), ("1000", "0.00", "100000.00")]
    cash = {c["account_code"]: c["balance"] for c in await ok(await tenant.get(f"{A}/cash-accounts"))}
    assert cash["1000"] == "200000.00"  # 300000 received, 100000 given back
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True
    assert await ok(await tenant.get(f"{A}/pending")) == []  # nothing is missing from the journal


async def test_wrong_payment_by_card_pays_out_from_the_bank_and_defaults_to_everything(
    tenant: Tenant,
) -> None:
    st, _, pay = await setup_paid(tenant, paid="300000", method="card")
    assert pay is not None
    r = await refund(
        tenant, {"kind": "wrong_payment", "student_id": st["id"], "payout": "bank", "payment_id": pay["id"]}
    )
    assert r["amount"] == "300000.00"
    assert shape((await refund_entries(tenant))[0]) == [
        ("4200", "300000.00", "0.00"),
        ("1010", "0.00", "300000.00"),
    ]
    after = await ok(await tenant.get(f"/v1/payments/{pay['id']}"))
    assert (after["refunded"], after["allocated"], after["unallocated"]) == ("300000.00", "0.00", "0.00")


async def test_unallocated_money_is_refunded_without_touching_charges(tenant: Tenant) -> None:
    st, charge, pay = await setup_paid(tenant, fee="100000", paid="300000")  # 200000 stays as credit
    assert pay is not None and pay["unallocated"] == "200000.00"
    await refund(
        tenant,
        {
            "kind": "wrong_payment",
            "student_id": st["id"],
            "payout": "cash",
            "payment_id": pay["id"],
            "amount": "150000",
        },
    )
    ch = await ok(await tenant.get(f"/v1/charges/{charge['id']}"))
    assert (ch["paid"], ch["outstanding"]) == ("100000.00", "0.00")  # the charge stayed paid
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert bal["credit"] == "50000.00"


async def test_wrong_payment_rules(tenant: Tenant, tenant_b: Tenant) -> None:
    st, _, pay = await setup_paid(tenant)
    assert pay is not None
    base = {
        "kind": "wrong_payment",
        "student_id": st["id"],
        "payout": "cash",
        "payment_id": pay["id"],
        "reason": "owner decision",
    }
    r = await tenant.post("/v1/refunds", {**base, "amount": "300000.01"})
    assert r.status_code == 422 and r.json()["error"]["details"]["errors"] == ["exceeds_available"]
    r = await tenant.post("/v1/refunds", {**base, "payout": "credit"})
    assert r.status_code == 422 and r.json()["error"]["details"]["errors"] == ["bad_payout"]
    assert (await tenant.post("/v1/refunds", {**base, "amount": "0"})).status_code == 422
    assert (await tenant.post("/v1/refunds", {**base, "amount": "-5"})).status_code == 422
    assert (await tenant.post("/v1/refunds", {**base, "reason": "x"})).status_code == 422
    assert (await tenant.post("/v1/refunds", {**base, "surprise": 1})).status_code == 422
    assert (
        await tenant.post("/v1/refunds", {**base, "charge_id": pay["id"]})
    ).status_code == 422  # does not apply to this kind
    assert (
        await tenant.post("/v1/refunds", {k: v for k, v in base.items() if k != "payment_id"})
    ).status_code == 422
    other = await mk_student(tenant)
    assert (
        await tenant.post("/v1/refunds", {**base, "student_id": other["id"]})
    ).status_code == 422  # another student's payment
    assert (await tenant_b.post("/v1/refunds", base)).status_code == 404  # another center
    assert (await tenant.get("/v1/refunds")).json()["items"] == []
    await refund(tenant, {**base, "amount": "200000"})
    over = await tenant.post("/v1/refunds", {**base, "amount": "100000.01"})  # only 100000 is left to refund
    assert over.status_code == 422
    await refund(tenant, {**base, "amount": "100000"})
    assert (await tenant.post("/v1/refunds", base)).status_code == 422  # nothing left
    # a payment with refunds cannot be voided; a voided payment cannot be refunded
    assert (await tenant.post(f"/v1/payments/{pay['id']}/void", {"reason": "mistake"})).status_code == 409
    st2, _, pay2 = await setup_paid(tenant)
    assert pay2 is not None
    await ok(await tenant.post(f"/v1/payments/{pay2['id']}/void", {"reason": "entered twice"}))
    assert (
        await tenant.post("/v1/refunds", {**base, "student_id": st2["id"], "payment_id": pay2["id"]})
    ).status_code == 409


# ---- student leaves --------------------------------------------------------------------------------------------------------
async def test_leaving_refunds_the_proportional_remainder_and_shrinks_the_charge(tenant: Tenant) -> None:
    st, charge, pay = await setup_paid(tenant)  # 300000 for a 30-day month, fully paid
    assert pay is not None
    body = {
        "kind": "leaving",
        "student_id": st["id"],
        "payout": "cash",
        "charge_id": charge["id"],
        "left_on": "2026-11-10",
    }
    pre = await ok(await tenant.post("/v1/refunds/preview", {**body, "reason": "preview"}))
    assert (pre["amount"], pre["charge_reduction"], pre["errors"]) == ("200000.00", "200000.00", [])
    r = await refund(tenant, body)
    assert (r["kind"], r["amount"], r["charge_reduction"], r["left_on"]) == (
        "leaving",
        "200000.00",
        "200000.00",
        "2026-11-10",
    )
    ch = await ok(await tenant.get(f"/v1/charges/{charge['id']}"))
    assert (ch["amount"], ch["paid"], ch["outstanding"], ch["voided"]) == (
        "100000.00",
        "100000.00",
        "0.00",
        False,
    )
    after = await ok(await tenant.get(f"/v1/payments/{pay['id']}"))
    assert (after["refunded"], after["allocated"]) == ("200000.00", "100000.00")
    assert shape((await refund_entries(tenant))[0]) == [
        ("4200", "200000.00", "0.00"),
        ("1000", "0.00", "200000.00"),
    ]
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert (bal["outstanding_total"], bal["credit"]) == ("0.00", "0.00")
    again = await tenant.post("/v1/refunds", {**body, "reason": "again", "left_on": "2026-11-20"})
    assert again.status_code == 409  # a month is settled for a leaving student once
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


async def test_leaving_with_the_money_kept_as_credit_posts_nothing(tenant: Tenant) -> None:
    st, charge, _ = await setup_paid(tenant)
    r = await refund(
        tenant,
        {
            "kind": "leaving",
            "student_id": st["id"],
            "payout": "credit",
            "charge_id": charge["id"],
            "left_on": "2026-11-10",
        },
    )
    assert (r["amount"], r["payments"]) == ("200000.00", [])
    assert await refund_entries(tenant) == []
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert (bal["outstanding_total"], bal["credit"]) == (
        "0.00",
        "200000.00",
    )  # the money is the student's credit
    ch = await ok(await tenant.get(f"/v1/charges/{charge['id']}"))
    assert ch["amount"] == "100000.00"
    cash = {c["account_code"]: c["balance"] for c in await ok(await tenant.get(f"{A}/cash-accounts"))}
    assert cash["1000"] == "300000.00"  # no cash moved


async def test_leaving_takes_the_money_from_the_newest_payments_first(tenant: Tenant) -> None:
    st, charge, _ = await setup_paid(tenant, paid="100000")
    newer = await ok(
        await tenant.post("/v1/payments", {"student_id": st["id"], "amount": "200000", "method": "cash"}), 201
    )
    r = await refund(
        tenant,
        {
            "kind": "leaving",
            "student_id": st["id"],
            "payout": "cash",
            "charge_id": charge["id"],
            "left_on": "2026-11-10",
        },
    )
    assert [(x["payment_id"], x["amount"]) for x in r["payments"]] == [(newer["id"], "200000.00")]


async def test_leaving_edge_cases(tenant: Tenant) -> None:
    # not paid beyond the used part: nothing to give back
    st, charge, _ = await setup_paid(tenant, paid=None)
    body = {
        "kind": "leaving",
        "student_id": st["id"],
        "payout": "cash",
        "charge_id": charge["id"],
        "left_on": "2026-11-10",
    }
    r = await tenant.post("/v1/refunds", {**body, "reason": "owner decision"})
    assert r.status_code == 422 and r.json()["error"]["details"]["errors"] == ["nothing_to_refund"]
    # attended the whole month: nothing to reduce
    st2, charge2, _ = await setup_paid(tenant)
    r = await tenant.post(
        "/v1/refunds",
        {
            **body,
            "student_id": st2["id"],
            "charge_id": charge2["id"],
            "left_on": "2026-11-30",
            "reason": "owner decision",
        },
    )
    assert r.status_code == 422 and "nothing_to_reduce" in r.json()["error"]["details"]["errors"]
    # left before the month began: the charge is voided and everything paid comes back
    st3, charge3, _ = await setup_paid(tenant)
    await refund(
        tenant, {**body, "student_id": st3["id"], "charge_id": charge3["id"], "left_on": "2026-10-20"}
    )
    ch = await ok(await tenant.get(f"/v1/charges/{charge3['id']}"))
    assert ch["voided"] is True
    assert (await ok(await tenant.get(f"/v1/students/{st3['id']}/balance")))["outstanding_total"] == "0.00"
    # a charge of another student, a voided charge and another center's charge are refused
    assert (
        await tenant.post("/v1/refunds", {**body, "reason": "owner decision", "charge_id": charge2["id"]})
    ).status_code == 422
    assert (
        await tenant.post(
            "/v1/refunds",
            {**body, "student_id": st3["id"], "charge_id": charge3["id"], "reason": "owner decision"},
        )
    ).status_code == 409


async def test_a_charge_with_a_payment_plan_must_be_unplanned_first(tenant: Tenant) -> None:
    st, charge, _ = await setup_paid(tenant)
    await ok(
        await tenant.put(
            f"/v1/charges/{charge['id']}/plan", {"equal": {"count": 3, "first_due": "2026-11-10"}}
        )
    )
    r = await tenant.post(
        "/v1/refunds",
        {
            "kind": "leaving",
            "student_id": st["id"],
            "payout": "cash",
            "charge_id": charge["id"],
            "left_on": "2026-11-10",
            "reason": "owner decision",
        },
    )
    assert r.status_code == 409


# ---- package remainder -----------------------------------------------------------------------------------------------------
async def test_package_remainder_refunds_the_unused_lessons(tenant: Tenant) -> None:
    grp = await pkg_group(tenant, lessons=8, price="400000")
    st, en = await student_in(tenant, grp)
    pkg = await sell(tenant, en["id"], pay={"amount": "400000", "method": "cash"})
    await attend(tenant, grp, st, ["present", "present", "present"])
    body = {"kind": "package_remainder", "student_id": st["id"], "payout": "cash", "package_id": pkg["id"]}
    pre = await ok(await tenant.post("/v1/refunds/preview", {**body, "reason": "preview"}))
    assert (pre["amount"], pre["charge_reduction"]) == ("250000.00", "250000.00")  # 5 of 8 lessons
    r = await refund(tenant, body)
    assert (r["amount"], r["package_id"]) == ("250000.00", pkg["id"])
    assert shape((await refund_entries(tenant))[0]) == [
        ("4200", "250000.00", "0.00"),
        ("1000", "0.00", "250000.00"),
    ]
    ch = await ok(await tenant.get(f"/v1/charges/{pkg['charge_id']}"))
    assert (ch["amount"], ch["outstanding"]) == ("150000.00", "0.00")
    b = await balance(tenant, st["id"])
    assert (b["available"], b["debt_lessons"]) == (0, 0)  # the three attended lessons stay covered
    again = await tenant.post("/v1/refunds", {**body, "reason": "owner decision"})
    assert again.status_code == 422 and again.json()["error"]["details"]["errors"] == ["nothing_to_refund"]
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True


async def test_package_remainder_keeps_consumed_lessons_covered_when_the_price_does_not_split_evenly(
    tenant: Tenant,
) -> None:
    grp = await pkg_group(tenant, lessons=3, price="100000")
    st, en = await student_in(tenant, grp)
    pkg = await sell(tenant, en["id"], pay={"amount": "100000", "method": "cash"})
    await attend(tenant, grp, st, ["present"])
    r = await refund(
        tenant,
        {"kind": "package_remainder", "student_id": st["id"], "payout": "cash", "package_id": pkg["id"]},
    )
    assert r["amount"] == "66666.00"  # not 66667: the lesson already taught must stay paid
    b = await balance(tenant, st["id"])
    assert (b["available"], b["debt_lessons"]) == (0, 0)


async def test_package_remainder_as_credit_and_an_unpaid_package(tenant: Tenant) -> None:
    grp = await pkg_group(tenant, lessons=8, price="400000")
    st, en = await student_in(tenant, grp)
    pkg = await sell(tenant, en["id"], pay={"amount": "400000", "method": "cash"})
    r = await refund(
        tenant,
        {"kind": "package_remainder", "student_id": st["id"], "payout": "credit", "package_id": pkg["id"]},
    )
    assert r["amount"] == "400000.00" and await refund_entries(tenant) == []
    assert (await ok(await tenant.get(f"/v1/charges/{pkg['charge_id']}")))[
        "voided"
    ] is True  # the whole package went back
    assert (await ok(await tenant.get(f"/v1/students/{st['id']}/balance")))["credit"] == "400000.00"
    st2, en2 = await student_in(tenant, grp)
    unpaid = await sell(tenant, en2["id"])
    r = await tenant.post(
        "/v1/refunds",
        {
            "kind": "package_remainder",
            "student_id": st2["id"],
            "payout": "cash",
            "package_id": unpaid["id"],
            "reason": "owner decision",
        },
    )
    assert r.status_code == 422  # nothing was paid


# ---- to credit --------------------------------------------------------------------------------------------------------------
async def test_to_credit_moves_paid_money_to_the_students_credit_without_cash(tenant: Tenant) -> None:
    st, charge, pay = await setup_paid(tenant)
    assert pay is not None
    r = await refund(
        tenant,
        {
            "kind": "to_credit",
            "student_id": st["id"],
            "payout": "credit",
            "charge_id": charge["id"],
            "amount": "100000",
        },
    )
    assert (r["amount"], r["charge_reduction"], r["payments"]) == ("100000.00", "100000.00", [])
    assert await refund_entries(tenant) == []
    ch = await ok(await tenant.get(f"/v1/charges/{charge['id']}"))
    assert (ch["amount"], ch["outstanding"]) == ("200000.00", "0.00")
    bal = await ok(await tenant.get(f"/v1/students/{st['id']}/balance"))
    assert (bal["outstanding_total"], bal["credit"]) == ("0.00", "100000.00")
    # the credit pays the next month by itself
    await ok(await tenant.post("/v1/charges/generate", {"month": "2026-12-01", "due_day": 10}))
    assert len(await ok(await tenant.post(f"/v1/students/{st['id']}/allocate-credit"))) == 1
    # everything paid can be converted: the charge goes away
    st2, charge2, _ = await setup_paid(tenant)
    await refund(
        tenant,
        {
            "kind": "to_credit",
            "student_id": st2["id"],
            "payout": "credit",
            "charge_id": charge2["id"],
            "amount": "300000",
        },
    )
    assert (await ok(await tenant.get(f"/v1/charges/{charge2['id']}")))["voided"] is True


async def test_to_credit_rules(tenant: Tenant) -> None:
    st, charge, _ = await setup_paid(tenant)
    base = {
        "kind": "to_credit",
        "student_id": st["id"],
        "payout": "credit",
        "charge_id": charge["id"],
        "reason": "owner decision",
    }
    r = await tenant.post("/v1/refunds", {**base, "amount": "300000.01"})
    assert r.status_code == 422 and r.json()["error"]["details"]["errors"] == ["exceeds_available"]
    r = await tenant.post("/v1/refunds", {**base, "payout": "cash", "amount": "1000"})
    assert r.status_code == 422 and r.json()["error"]["details"]["errors"] == ["bad_payout"]
    assert (await tenant.post("/v1/refunds", base)).status_code == 422  # the amount is required
    unpaid_st, unpaid_ch, _ = await setup_paid(tenant, paid=None)
    r = await tenant.post(
        "/v1/refunds", {**base, "student_id": unpaid_st["id"], "charge_id": unpaid_ch["id"], "amount": "1000"}
    )
    assert r.status_code == 422  # nothing paid on the charge


# ---- list, permissions, isolation --------------------------------------------------------------------------------------------
async def test_listing_filters_and_permissions(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    st, charge, pay = await setup_paid(tenant)
    assert pay is not None
    r1 = await refund(
        tenant,
        {
            "kind": "wrong_payment",
            "student_id": st["id"],
            "payout": "cash",
            "payment_id": pay["id"],
            "amount": "50000",
        },
    )
    r2 = await refund(
        tenant,
        {
            "kind": "to_credit",
            "student_id": st["id"],
            "payout": "credit",
            "charge_id": charge["id"],
            "amount": "10000",
        },
    )
    everything = (await ok(await tenant.get("/v1/refunds")))["items"]
    assert {x["id"] for x in everything} == {r1["id"], r2["id"]}
    assert [
        x["id"] for x in (await ok(await tenant.get("/v1/refunds", params={"kind": "to_credit"})))["items"]
    ] == [r2["id"]]
    assert [
        x["id"]
        for x in (
            await ok(
                await tenant.get("/v1/refunds", params={"student_id": st["id"], "date_from": "2999-01-01"})
            )
        )["items"]
    ] == []
    assert (await ok(await tenant.get(f"/v1/refunds/{r1['id']}")))["amount"] == "50000.00"
    assert (await tenant_b.get(f"/v1/refunds/{r1['id']}")).status_code == 404
    assert (await tenant_b.get("/v1/refunds")).json()["items"] == []
    _, v_email = await _add_staff(tenant, "viewer")
    viewer = await _login(client, v_email, "staff-password-123")
    assert (await viewer.get("/v1/refunds")).status_code == 403
    assert (
        await viewer.post(
            "/v1/refunds",
            {
                "kind": "to_credit",
                "student_id": st["id"],
                "payout": "credit",
                "charge_id": charge["id"],
                "amount": "1",
                "reason": "no right",
            },
        )
    ).status_code == 403
    _, m_email = await _add_staff(tenant, "manager")
    manager = await _login(client, m_email, "staff-password-123")
    assert (await manager.get("/v1/refunds")).status_code == 200
    _, a_email = await _add_staff(tenant, "accountant")
    acc = await _login(client, a_email, "staff-password-123")
    assert (
        await acc.post(
            "/v1/refunds/preview",
            {
                "kind": "wrong_payment",
                "student_id": st["id"],
                "payout": "cash",
                "payment_id": pay["id"],
                "reason": "check",
            },
        )
    ).status_code == 200


async def test_refund_validation_matrix(tenant: Tenant) -> None:
    st, charge, pay = await setup_paid(tenant)
    assert pay is not None
    bad: list[dict[str, Any]] = [
        {"kind": "gift", "payout": "cash"},
        {"kind": "leaving", "payout": "cash"},  # no charge
        {"kind": "package_remainder", "payout": "cash"},  # no package
        {"kind": "to_credit", "payout": "credit", "charge_id": charge["id"]},  # no amount
        {
            "kind": "leaving",
            "payout": "cash",
            "charge_id": charge["id"],
            "amount": "5",
        },  # amount does not apply
        {"kind": "leaving", "payout": "cheque", "charge_id": charge["id"]},
        {"kind": "leaving", "payout": "cash", "charge_id": charge["id"], "left_on": "not-a-date"},
    ]
    for extra in bad:
        r = await tenant.post("/v1/refunds", {"student_id": st["id"], "reason": "owner decision", **extra})
        assert r.status_code == 422, (extra, r.text)
    assert (await tenant.get("/v1/refunds")).json()["items"] == []
