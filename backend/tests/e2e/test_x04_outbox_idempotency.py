"""Replay safety: Idempotency-Key on money endpoints (replays, conflicting bodies, concurrent duplicates, tenant scoping) and the
outbox/worker (retries, permanent errors, several workers, replays) never duplicate a payment, a journal entry or a message."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx
import psycopg

from tests.conftest import Tenant
from tests.e2e.journeys import assert_books_sound, entries, money, outbox_rows
from tests.helpers import enroll, mk_group, mk_student, ok
from tests.test_tenancy_and_staff import _add_staff, _login
from tests.test_worker import _queued, _status, _worker


def key() -> dict[str, str]:
    return {"Idempotency-Key": f"e2e-{uuid.uuid4().hex}"}


async def test_money_endpoints_replay_safely(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    t = tenant
    st = await mk_student(t, "Replay Student")
    ch = await ok(
        await t.post(
            "/v1/charges",
            {
                "student_id": st["id"],
                "kind": "tuition",
                "period_month": "2026-01-01",
                "amount": "500000",
                "due_date": "2026-01-10",
            },
        ),
        201,
    )
    body = {"student_id": st["id"], "amount": "200000", "method": "cash"}
    h = key()

    first = await t.post("/v1/payments", body, headers=h)
    assert first.status_code == 201 and first.headers.get("Idempotent-Replayed") is None
    for _ in range(3):
        again = await t.post("/v1/payments", body, headers=h)
        assert again.status_code == 201 and again.headers["Idempotent-Replayed"] == "true"
        assert again.json()["id"] == first.json()["id"]
    # the same key with another body is a client bug: refused, nothing written
    assert (await t.post("/v1/payments", {**body, "amount": "999"}, headers=h)).status_code == 422
    bal = await ok(await t.get(f"/v1/students/{st['id']}/balance"))
    assert money(bal["outstanding_total"]) == 300000  # counted ONCE
    assert len(await entries(t)) == 1  # one journal entry, not four

    # a failed request frees the key: the corrected retry goes through exactly once
    h2 = key()
    bad = await t.post("/v1/payments", {"student_id": st["id"], "amount": "-5", "method": "cash"}, headers=h2)
    assert bad.status_code == 422
    good = await t.post("/v1/payments", {**body, "amount": "100000"}, headers=h2)
    assert good.status_code == 201 and good.json()["id"] != first.json()["id"]

    # 8 identical requests at once: exactly one payment, the rest replay or wait (409)
    h3 = key()
    results = await asyncio.gather(
        *[t.post("/v1/payments", {**body, "amount": "10000"}, headers=h3) for _ in range(8)]
    )
    codes = sorted(r.status_code for r in results)
    assert codes.count(201) >= 1 and set(codes) <= {201, 409}
    created = {r.json()["id"] for r in results if r.status_code == 201}
    assert len(created) == 1
    pays = (await ok(await t.get("/v1/payments", params={"student_id": st["id"], "limit": 200})))["items"]
    assert len(pays) == 3 and sum(money(p["amount"]) for p in pays) == 310000
    assert len(await entries(t)) == 3

    # the same key in another center is a different request (scoped by center and user)
    other = await mk_student(tenant_b, "B student")
    r = await tenant_b.post(
        "/v1/payments", {"student_id": other["id"], "amount": "1000", "method": "cash"}, headers=h
    )
    assert r.status_code == 201 and r.headers.get("Idempotent-Replayed") is None
    # ...and so is another user of the same center
    _, email = await _add_staff(t, "accountant")
    acc = await _login(client, email, "staff-password-123")
    r = await acc.post("/v1/payments", body, headers=h)
    assert (
        r.status_code == 201
        and r.headers.get("Idempotent-Replayed") is None
        and r.json()["id"] != first.json()["id"]
    )

    # refunds and cash close replay the same way
    pay = first.json()
    rbody = {
        "kind": "wrong_payment",
        "student_id": st["id"],
        "payment_id": pay["id"],
        "amount": "50000",
        "payout": "cash",
        "reason": "paid twice",
    }
    h4 = key()
    r1 = await t.post("/v1/refunds", rbody, headers=h4)
    r2 = await t.post("/v1/refunds", rbody, headers=h4)
    assert (
        r1.status_code == 201
        and r2.headers["Idempotent-Replayed"] == "true"
        and r2.json()["id"] == r1.json()["id"]
    )
    assert len((await ok(await t.get("/v1/refunds")))["items"]) == 1
    h5 = key()
    c1 = await t.post("/v1/cash-close", {"counted": "1000000", "note": "count"}, headers=h5)
    c2 = await t.post("/v1/cash-close", {"counted": "1000000", "note": "count"}, headers=h5)
    assert c1.status_code == 201 and c2.json()["id"] == c1.json()["id"]
    assert len((await ok(await t.get("/v1/cash-close")))["items"]) == 1
    assert ch["id"]
    await assert_books_sound(t)


async def test_charge_generation_is_idempotent_by_nature(tenant: Tenant) -> None:
    grp = await mk_group(tenant, monthly_fee="300000")
    sts = [await mk_student(tenant) for _ in range(3)]
    for s in sts:
        await enroll(tenant, grp["id"], s["id"], "2026-01-01")
    runs = await asyncio.gather(
        *[tenant.post("/v1/charges/generate", {"month": "2026-03-01"}) for _ in range(4)]
    )
    assert all(r.status_code in (200, 409, 503) for r in runs), [r.text for r in runs]
    total = sum(r.json()["created"] for r in runs if r.status_code == 200)
    assert total == 3  # four overlapping runs created three charges, not twelve
    assert (
        len(
            (await ok(await tenant.get("/v1/charges", params={"month": "2026-03-01", "limit": 200})))["items"]
        )
        == 3
    )
    assert (await ok(await tenant.post("/v1/charges/generate", {"month": "2026-03-01"})))["created"] == 0


async def test_outbox_worker_retries_never_duplicate_a_message(
    pg_server: dict[str, Any], super_dsn: str, tenant: Tenant
) -> None:
    sent: list[int] = []
    flaky = {"left": 1}

    def handler(req: httpx.Request) -> httpx.Response:
        chat = json.loads(req.content)["chat_id"]
        if chat == 8101 and flaky["left"] > 0:  # a transient Telegram failure on the first try
            flaky["left"] -= 1
            return httpx.Response(502, text="bad gateway")
        if chat == 8102:  # blocked bot: permanent
            return httpx.Response(
                403, json={"ok": False, "description": "Forbidden: bot was blocked by the user"}
            )
        sent.append(chat)
        return httpx.Response(200, json={"ok": True})

    transient = await _queued(tenant, chat_id=8101)
    permanent = await _queued(tenant, chat_id=8102)
    normal = [await _queued(tenant, chat_id=8200 + i) for i in range(6)]

    async def one_pass(n: int) -> None:
        ws = [_worker(pg_server, handler) for _ in range(n)]
        for w in ws:
            await w.open()
        try:
            await asyncio.gather(*[w.run_once() for w in ws])
        finally:
            for w in ws:
                await w.close()

    await one_pass(3)
    ours = [c for c in sent if 8200 <= c < 8300]
    assert sorted(ours) == [8200 + i for i in range(6)]  # three workers at once: each message exactly once
    st = await _status(tenant, transient["id"])
    assert st["status"] == "queued" and st["attempts"] == 1  # backed off, not lost and not hammered
    assert (await _status(tenant, permanent["id"]))[
        "status"
    ] == "failed"  # a permanent refusal is never retried
    await one_pass(2)  # immediately again: the backoff holds, so the transient message is not re-sent yet
    assert 8101 not in sent
    assert [c for c in sent if 8200 <= c < 8300] == ours  # and nothing already sent is sent again
    with psycopg.connect(super_dsn) as c:  # time passes: the retry becomes due and succeeds once
        c.execute(
            "UPDATE outbox_messages SET send_after = now() - interval '1 minute' WHERE status = 'queued'"
        )
        c.commit()
    await one_pass(3)
    assert sent.count(8101) == 1 and (await _status(tenant, transient["id"]))["status"] == "sent"
    await one_pass(2)
    assert sent.count(8101) == 1 and sent.count(8102) == 0
    assert {r[1] for r in outbox_rows(super_dsn, tenant.org_id)} == {"sent", "failed"}
    assert len(normal) == 6
