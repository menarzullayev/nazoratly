"""Daily cash close (smena, G1): the books' cash balance, the counted cash, the difference with its note, the link to the
journal head, the optional adjusting entry and the rules around them. The difference arithmetic is the shared golden file
(tests/golden/money.json); the monthly period close of the journal stays separate."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.helpers import mk_student, ok, org_today
from tests.test_accounting import A, entries, manual, shape
from tests.test_refunds import refund, setup_paid
from tests.test_tenancy_and_staff import _add_staff, _login

TODAY = org_today()
C = "/v1/cash-close"


async def close(t: Tenant, counted: str, **kw: Any) -> dict[str, Any]:
    return await ok(await t.post(C, {"counted": counted, **kw}), 201)


async def cash_in(t: Tenant, amount: str = "300000") -> dict[str, Any]:
    st = await mk_student(t)
    return await ok(
        await t.post("/v1/payments", {"student_id": st["id"], "amount": amount, "method": "cash"}), 201
    )


async def test_preview_follows_the_books_and_shifts_are_numbered(tenant: Tenant) -> None:
    p0 = await ok(await tenant.get(f"{C}/preview"))
    assert (p0["close_date"], p0["book_balance"], p0["cash_in"], p0["cash_out"], p0["journal_seq"], p0["next_shift_no"]) == (
        TODAY.isoformat(), "0.00", "0.00", "0.00", 0, 1,
    )  # fmt: skip
    await cash_in(tenant, "300000")
    p1 = await ok(await tenant.get(f"{C}/preview"))
    assert (p1["book_balance"], p1["cash_in"], p1["cash_out"], p1["journal_seq"]) == (
        "300000.00",
        "300000.00",
        "0.00",
        2,
    )
    first = await close(tenant, "300000")
    assert (first["shift_no"], first["counted"], first["book_balance"], first["difference"], first["status"]) == (
        1, "300000.00", "300000.00", "0.00", "ok",
    )  # fmt: skip
    assert (first["journal_seq"], first["adjustment_entry_no"], first["note"]) == (2, None, None)
    second = await close(tenant, "300000")
    assert second["shift_no"] == 2
    assert (await ok(await tenant.get(f"{C}/preview")))["next_shift_no"] == 3
    # a balanced close is not a journal entry
    assert [e for e in await entries(tenant) if e["source_type"] == "cash_close"] == []
    listed = (await ok(await tenant.get(C)))["items"]
    assert [(x["shift_no"], x["id"]) for x in listed] == [(2, second["id"]), (1, first["id"])]
    assert (await ok(await tenant.get(f"{C}/{first['id']}")))["journal_seq"] == 2


async def test_cash_given_back_lowers_what_the_books_expect(tenant: Tenant) -> None:
    st, _, pay = await setup_paid(tenant)
    assert pay is not None
    await refund(
        tenant,
        {
            "kind": "wrong_payment",
            "student_id": st["id"],
            "payout": "cash",
            "payment_id": pay["id"],
            "amount": "100000",
        },
    )
    p = await ok(await tenant.get(f"{C}/preview"))
    assert (p["book_balance"], p["cash_in"], p["cash_out"]) == ("200000.00", "300000.00", "100000.00")
    ok_close = await close(tenant, "200000")
    assert ok_close["status"] == "ok"


async def test_a_difference_needs_a_note_and_is_kept_with_it(tenant: Tenant) -> None:
    await cash_in(tenant, "300000")
    for counted in ("280000", "320000"):
        r = await tenant.post(C, {"counted": counted})
        assert r.status_code == 422 and r.json()["error"]["details"]["errors"] == ["note_required"]
        r = await tenant.post(C, {"counted": counted, "note": "   "})
        assert r.status_code == 422
    assert (await ok(await tenant.get(C)))["items"] == []  # nothing was saved
    short = await close(tenant, "280000", note="sinf puli ichkarida qoldi")
    assert (short["difference"], short["status"], short["note"], short["adjustment_entry_no"]) == (
        "-20000.00",
        "short",
        "sinf puli ichkarida qoldi",
        None,
    )
    over = await close(tenant, "310000", note="qaytim berilmadi")
    assert (over["difference"], over["status"]) == ("10000.00", "over")
    assert [
        e for e in await entries(tenant) if e["source_type"] == "cash_close"
    ] == []  # not posted unless asked


async def test_posting_the_difference_balances_the_books(tenant: Tenant) -> None:
    await cash_in(tenant, "300000")
    short = await close(tenant, "280000", note="kamomad", post_difference=True)
    assert short["adjustment_entry_no"] is not None
    e = [x for x in await entries(tenant) if x["source_type"] == "cash_close"]
    assert len(e) == 1 and shape(e[0]) == [("5900", "20000.00", "0.00"), ("1000", "0.00", "20000.00")]
    assert e[0]["source_key"] and e[0]["date"] == TODAY.isoformat()
    after = await ok(await tenant.get(f"{C}/preview"))
    assert after["book_balance"] == "280000.00"  # the books now agree with the drawer
    over = await close(tenant, "290000", note="topilgan pul", post_difference=True)
    assert over["difference"] == "10000.00"
    e2 = [x for x in await entries(tenant) if x["source_type"] == "cash_close"]
    assert sorted(shape(x) for x in e2)[0] in (
        [("1000", "10000.00", "0.00"), ("4100", "0.00", "10000.00")],
        [("5900", "20000.00", "0.00"), ("1000", "0.00", "20000.00")],
    )
    assert (await ok(await tenant.get(f"{A}/verify")))["ok"] is True
    assert await ok(await tenant.get(f"{A}/pending")) == []
    # a balanced close has nothing to post
    r = await tenant.post(C, {"counted": "290000", "post_difference": True})
    assert r.status_code == 422 and r.json()["error"]["details"]["errors"] == ["nothing_to_post"]


async def test_validation_dates_and_the_closed_month(tenant: Tenant) -> None:
    await cash_in(tenant, "100000")
    tomorrow = (TODAY + timedelta(days=1)).isoformat()
    assert (await tenant.post(C, {"counted": "100000", "close_date": tomorrow})).status_code == 422
    for bad in (
        {"counted": "-1"},
        {"counted": "abc"},
        {},
        {"counted": "100000", "surprise": 1},
        {"counted": "100000", "close_date": "nope"},
        {"counted": "100000", "note": "x" * 501},
    ):
        assert (await tenant.post(C, bad)).status_code == 422, bad
    # an earlier day is checked against the books as of that day (the payment came later)
    yesterday = (TODAY - timedelta(days=1)).isoformat()
    early = await close(tenant, "0", close_date=yesterday)
    assert (early["book_balance"], early["status"], early["shift_no"]) == ("0.00", "ok", 1)
    assert (await close(tenant, "0", close_date=yesterday))["shift_no"] == 2
    assert (
        len((await ok(await tenant.get(C, params={"date_from": yesterday, "date_to": yesterday})))["items"])
        == 2
    )
    assert (await ok(await tenant.get(C, params={"date_from": tomorrow})))["items"] == []


async def test_a_difference_cannot_be_posted_into_a_closed_month_and_nothing_is_saved(tenant: Tenant) -> None:
    long_ago = (TODAY.replace(day=1) - timedelta(days=40)).replace(day=15)
    await manual(tenant, long_ago.isoformat(), [("1000", "50000", "0"), ("3000", "0", "50000")])
    month = long_ago.strftime("%Y-%m")
    await ok(await tenant.post(f"{A}/periods/{month}/close"), 201)
    r = await tenant.post(
        C, {"counted": "40000", "close_date": long_ago.isoformat(), "note": "late", "post_difference": True}
    )
    assert r.status_code == 409
    assert (await ok(await tenant.get(C)))["items"] == []  # the close was rolled back with the failed entry
    saved = await close(
        tenant, "40000", close_date=long_ago.isoformat(), note="late count"
    )  # recording it without posting is fine
    assert (saved["difference"], saved["adjustment_entry_no"]) == ("-10000.00", None)


async def test_permissions_and_tenant_isolation(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    await cash_in(tenant)
    made = await close(tenant, "300000")
    assert (await tenant_b.get(f"{C}/{made['id']}")).status_code == 404
    assert (await tenant_b.get(C)).json()["items"] == []
    assert (await ok(await tenant_b.get(f"{C}/preview")))["book_balance"] == "0.00"
    _, v_email = await _add_staff(tenant, "viewer")
    viewer = await _login(client, v_email, "staff-password-123")
    assert (await viewer.get(C)).status_code == 403 and (
        await viewer.post(C, {"counted": "1"})
    ).status_code == 403
    _, m_email = await _add_staff(tenant, "manager")
    manager = await _login(client, m_email, "staff-password-123")
    assert (await manager.post(C, {"counted": "300000"})).status_code == 201  # a manager may close the desk
    forbidden = await manager.post(C, {"counted": "290000", "note": "kamomad", "post_difference": True})
    assert forbidden.status_code == 403  # booking in the journal needs accounting:write
    _, a_email = await _add_staff(tenant, "accountant")
    acc = await _login(client, a_email, "staff-password-123")
    assert (
        await acc.post(C, {"counted": "290000", "note": "kamomad", "post_difference": True})
    ).status_code == 201
