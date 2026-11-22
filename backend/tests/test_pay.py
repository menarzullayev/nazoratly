from __future__ import annotations

import hashlib
import uuid
from base64 import b64encode
from typing import Any

import httpx
import psycopg

from tests.conftest import Tenant
from tests.helpers import enroll, mk_group, mk_student, ok
from tests.test_tenancy_and_staff import _add_staff, _login

PAYME_KEY = "payme-secret-key-0123"
CLICK_KEY = "click-secret-key-0123"


async def _connect(t: Tenant, provider: str, secret: str, ref: str) -> dict[str, Any]:
    return await ok(await t.put(f"/v1/payment-providers/{provider}", {"merchant_ref": ref, "secret": secret}))


async def _billed_student(t: Tenant, fee: str = "300000") -> dict[str, Any]:
    grp = await mk_group(t, monthly_fee=fee)
    st = await mk_student(t)
    await enroll(t, grp["id"], st["id"], "2026-01-01")
    for m in ("2026-01-01", "2026-02-01"):
        await ok(await t.post("/v1/charges/generate", {"month": m, "due_day": 5}))
    return st


def _basic(login: str, password: str) -> dict[str, str]:
    return {"Authorization": "Basic " + b64encode(f"{login}:{password}".encode()).decode()}


async def payme(
    c: httpx.AsyncClient, org: str, method: str, params: dict[str, Any], key: str = PAYME_KEY, rid: int = 7
) -> dict[str, Any]:
    r = await c.post(
        f"/pay/payme/{org}",
        json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params},
        headers=_basic("Paycom", key),
    )
    assert r.status_code == 200  # the protocol answers HTTP 200 even for errors
    body = r.json()
    assert body["id"] == rid
    return body  # type: ignore[no-any-return]


def click_form(
    secret: str,
    service_id: str,
    action: int,
    student: str,
    click_trans_id: int,
    amount: str,
    prepare_id: int | None = None,
    error: int = 0,
) -> dict[str, str]:
    sign_time = "2026-03-01 12:00:00"
    parts = (
        [str(click_trans_id), service_id, secret, student]
        + ([str(prepare_id)] if action == 1 else [])
        + [amount, str(action), sign_time]
    )
    form = {
        "click_trans_id": str(click_trans_id),
        "service_id": service_id,
        "click_paydoc_id": "555",
        "merchant_trans_id": student,
        "amount": amount,
        "action": str(action),
        "error": str(error),
        "error_note": "",
        "sign_time": sign_time,
        "sign_string": hashlib.md5("".join(parts).encode()).hexdigest(),  # noqa: S324
    }
    if action == 1:
        form["merchant_prepare_id"] = str(prepare_id)
    return form


async def click(c: httpx.AsyncClient, org: str, form: dict[str, str]) -> dict[str, Any]:
    r = await c.post(f"/pay/click/{org}", data=form)
    assert r.status_code == 200
    return r.json()  # type: ignore[no-any-return]


async def test_provider_settings_secrets_and_rbac(
    client: httpx.AsyncClient, tenant: Tenant, super_dsn: str
) -> None:
    out = await _connect(tenant, "payme", PAYME_KEY, "merchant-1")
    assert out["callback_url"].endswith(f"/pay/payme/{tenant.org_id}") and "secret" not in out
    listed = await ok(await tenant.get("/v1/payment-providers"))
    assert [p["provider"] for p in listed] == ["payme"] and PAYME_KEY not in str(listed)
    with psycopg.connect(super_dsn) as c:
        raw = c.execute(
            "SELECT secret_ciphertext FROM payment_provider_accounts WHERE merchant_ref = 'merchant-1'"
        ).fetchone()
    assert raw is not None and PAYME_KEY.encode() not in bytes(raw[0])
    audit = await ok(await tenant.get("/v1/audit", params={"entity_type": "memberships"}))
    assert PAYME_KEY not in str(audit)
    with psycopg.connect(super_dsn) as c:
        snaps = c.execute(
            "SELECT after_data::text FROM audit_log WHERE entity_type = 'payment_provider_accounts'"
        ).fetchall()
    assert snaps and all("secret_ciphertext" not in s[0] for s in snaps)
    _, m_email = await _add_staff(tenant, "manager")
    mgr = await _login(client, m_email, "staff-password-123")
    assert (
        await mgr.put("/v1/payment-providers/payme", {"merchant_ref": "x", "secret": "12345678"})
    ).status_code == 403
    assert (
        await tenant.put("/v1/payment-providers/stripe", {"merchant_ref": "x", "secret": "12345678"})
    ).status_code == 422
    assert (
        await tenant.put("/v1/payment-providers/click", {"merchant_ref": "x", "secret": "short"})
    ).status_code == 422


async def test_payme_auth_and_protocol_errors(client: httpx.AsyncClient, tenant: Tenant) -> None:
    await _connect(tenant, "payme", PAYME_KEY, "m1")
    org = tenant.org_id
    for headers in (
        {},
        _basic("Paycom", "wrong-key"),
        _basic("Intruder", PAYME_KEY),
        {"Authorization": "Basic !!!"},
    ):
        r = await client.post(
            f"/pay/payme/{org}",
            json={"method": "CheckTransaction", "params": {"id": "x"}, "id": 1},
            headers=headers,
        )
        assert r.json()["error"]["code"] == -32504
    unknown_org = await client.post(
        f"/pay/payme/{uuid.uuid4()}",
        json={"method": "CheckTransaction", "params": {}, "id": 1},
        headers=_basic("Paycom", PAYME_KEY),
    )
    assert unknown_org.json()["error"]["code"] == -32504
    assert (
        await client.post(f"/pay/payme/{org}", content=b"{not json", headers=_basic("Paycom", PAYME_KEY))
    ).json()["error"]["code"] == -32700
    assert (
        await client.post(
            f"/pay/payme/{org}", json={"params": {}, "id": 1}, headers=_basic("Paycom", PAYME_KEY)
        )
    ).json()["error"]["code"] == -32600
    assert (await payme(client, org, "NoSuchMethod", {}))["error"]["code"] == -32601
    assert (await client.get(f"/pay/payme/{org}")).status_code == 405
    # a disabled provider stops answering
    await ok(
        await tenant.put(
            "/v1/payment-providers/payme", {"merchant_ref": "m1", "secret": PAYME_KEY, "status": "disabled"}
        )
    )
    assert (await payme(client, org, "CheckTransaction", {"id": "x"}))["error"]["code"] == -32504


async def test_payme_full_lifecycle(client: httpx.AsyncClient, tenant: Tenant) -> None:
    await _connect(tenant, "payme", PAYME_KEY, "m1")
    org, st = tenant.org_id, await _billed_student(tenant)
    acct = {"student": st["id"]}

    assert (await payme(client, org, "CheckPerformTransaction", {"amount": 10_000_000, "account": acct}))[
        "result"
    ] == {"allow": True}
    bad_student = await payme(
        client,
        org,
        "CheckPerformTransaction",
        {"amount": 10_000_000, "account": {"student": str(uuid.uuid4())}},
    )
    assert bad_student["error"]["code"] == -31050 and bad_student["error"]["data"] == "student"
    for amount in (0, 99, -5, 1.5, "100", None, True):
        assert (await payme(client, org, "CheckPerformTransaction", {"amount": amount, "account": acct}))[
            "error"
        ]["code"] == -31001

    tx_id = "5f3a9c1e2b4d6f708192a3b4"
    created = (
        await payme(
            client,
            org,
            "CreateTransaction",
            {"id": tx_id, "time": 1_790_000_000_000, "amount": 40_000_000, "account": acct},
        )
    )["result"]
    assert created["state"] == 1 and created["create_time"] > 0
    again = (
        await payme(
            client,
            org,
            "CreateTransaction",
            {"id": tx_id, "time": 1_790_000_000_000, "amount": 40_000_000, "account": acct},
        )
    )["result"]
    assert again["transaction"] == created["transaction"]  # idempotent
    assert (await payme(client, org, "CheckTransaction", {"id": tx_id}))["result"]["state"] == 1
    assert (await ok(await tenant.get("/v1/payments", params={"student_id": st["id"]})))[
        "items"
    ] == []  # nothing yet

    performed = (await payme(client, org, "PerformTransaction", {"id": tx_id}))["result"]
    assert performed["state"] == 2 and performed["perform_time"] > 0
    assert (await payme(client, org, "PerformTransaction", {"id": tx_id}))["result"][
        "perform_time"
    ] == performed["perform_time"]
    pays = (await ok(await tenant.get("/v1/payments", params={"student_id": st["id"]})))["items"]
    assert (
        len(pays) == 1
        and pays[0]["amount"] == "400000.00"
        and pays[0]["method"] == "payme"
        and pays[0]["external_ref"] == tx_id
    )
    detail = await ok(await tenant.get(f"/v1/payments/{pays[0]['id']}"))
    assert [(a["period_month"], a["amount"]) for a in detail["allocations"]] == [
        ("2026-01-01", "300000.00"),
        ("2026-02-01", "100000.00"),
    ]
    assert (await ok(await tenant.get(f"/v1/students/{st['id']}/balance")))[
        "outstanding_total"
    ] == "200000.00"

    stmt = (await payme(client, org, "GetStatement", {"from": 0, "to": 9_999_999_999_999}))["result"][
        "transactions"
    ]
    assert (
        [t["id"] for t in stmt] == [tx_id]
        and stmt[0]["amount"] == 40_000_000
        and stmt[0]["account"] == acct
        and stmt[0]["state"] == 2
    )
    ledger = (await ok(await tenant.get("/v1/online-transactions")))["items"]
    assert (
        ledger[0]["state"] == 2
        and ledger[0]["amount"] == "400000.00"
        and ledger[0]["payment_id"] == pays[0]["id"]
    )

    # refund: cancelling a performed transaction voids the payment and re-opens the debt
    cancelled = (await payme(client, org, "CancelTransaction", {"id": tx_id, "reason": 5}))["result"]
    assert cancelled["state"] == -2 and cancelled["cancel_time"] > 0
    assert (await payme(client, org, "CancelTransaction", {"id": tx_id, "reason": 5}))["result"][
        "cancel_time"
    ] == cancelled["cancel_time"]
    assert (await ok(await tenant.get(f"/v1/students/{st['id']}/balance")))[
        "outstanding_total"
    ] == "600000.00"
    assert (await ok(await tenant.get("/v1/payments", params={"student_id": st["id"]})))["items"] == []
    assert (await payme(client, org, "PerformTransaction", {"id": tx_id}))["error"]["code"] == -31008
    assert (await payme(client, org, "CheckTransaction", {"id": tx_id}))["result"]["reason"] == 5
    assert (await payme(client, org, "CheckTransaction", {"id": "nope"}))["error"]["code"] == -31003
    assert (await payme(client, org, "PerformTransaction", {"id": "nope"}))["error"]["code"] == -31003
    assert (await payme(client, org, "CancelTransaction", {"id": "nope", "reason": 3}))["error"][
        "code"
    ] == -31003


async def test_payme_cancel_before_perform_and_timeout(
    client: httpx.AsyncClient, tenant: Tenant, super_dsn: str
) -> None:
    await _connect(tenant, "payme", PAYME_KEY, "m1")
    org, st = tenant.org_id, await _billed_student(tenant)
    acct = {"student": st["id"]}
    a, b = "aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"
    for t in (a, b):
        await payme(
            client,
            org,
            "CreateTransaction",
            {"id": t, "time": 1_790_000_000_000, "amount": 10_000_000, "account": acct},
        )
    assert (await payme(client, org, "CancelTransaction", {"id": a, "reason": 3}))["result"]["state"] == -1
    assert (await payme(client, org, "PerformTransaction", {"id": a}))["error"]["code"] == -31008
    assert (
        await payme(
            client, org, "CreateTransaction", {"id": a, "time": 1, "amount": 10_000_000, "account": acct}
        )
    )["error"]["code"] == -31008
    with psycopg.connect(super_dsn, autocommit=True) as c:  # 13 hours old: past Payme's 12 h limit
        c.execute(
            "UPDATE online_transactions SET created_at = now() - interval '13 hours' WHERE provider_trans_id = %s",
            (b,),
        )
    assert (await payme(client, org, "PerformTransaction", {"id": b}))["error"]["code"] == -31008
    chk = (await payme(client, org, "CheckTransaction", {"id": b}))["result"]
    assert chk["state"] == -1 and chk["reason"] == 4  # cancelled by timeout, and that was committed
    assert (await ok(await tenant.get("/v1/payments", params={"student_id": st["id"]})))["items"] == []


async def test_click_prepare_complete_and_errors(client: httpx.AsyncClient, tenant: Tenant) -> None:
    await _connect(tenant, "click", CLICK_KEY, "98765")
    org, st = tenant.org_id, await _billed_student(tenant)
    sid = st["id"]

    prep = await click(client, org, click_form(CLICK_KEY, "98765", 0, sid, 1001, "250000.00"))
    assert prep["error"] == 0 and prep["merchant_prepare_id"] > 0 and prep["click_trans_id"] == "1001"
    again = await click(client, org, click_form(CLICK_KEY, "98765", 0, sid, 1001, "250000.00"))
    assert again["merchant_prepare_id"] == prep["merchant_prepare_id"]  # retry-safe
    assert (await click(client, org, click_form(CLICK_KEY, "98765", 0, sid, 1001, "1.00")))[
        "error"
    ] == -2  # amount changed
    assert (await ok(await tenant.get("/v1/payments", params={"student_id": sid})))["items"] == []

    # protocol errors
    assert (await click(client, org, click_form("wrong-key-0000", "98765", 0, sid, 1002, "1000")))[
        "error"
    ] == -1
    assert (await click(client, org, click_form(CLICK_KEY, "00000", 0, sid, 1002, "1000")))["error"] == -8
    assert (await click(client, org, click_form(CLICK_KEY, "98765", 0, str(uuid.uuid4()), 1002, "1000")))[
        "error"
    ] == -5
    assert (await click(client, org, click_form(CLICK_KEY, "98765", 0, sid, 1002, "-5")))["error"] == -2
    assert (await click(client, org, click_form(CLICK_KEY, "98765", 0, sid, 1002, "10.555")))["error"] == -2
    bad_action = click_form(CLICK_KEY, "98765", 0, sid, 1002, "1000") | {"action": "7"}
    assert (await click(client, org, bad_action))["error"] == -3
    assert (
        await click(
            client, org, click_form(CLICK_KEY, "98765", 1, sid, 1001, "250000.00", prepare_id=999_999)
        )
    )["error"] == -6
    assert (
        await click(
            client,
            org,
            click_form(CLICK_KEY, "98765", 1, sid, 1001, "100.00", prepare_id=prep["merchant_prepare_id"]),
        )
    )["error"] == -2

    done = await click(
        client,
        org,
        click_form(CLICK_KEY, "98765", 1, sid, 1001, "250000.00", prepare_id=prep["merchant_prepare_id"]),
    )
    assert done["error"] == 0 and done["merchant_confirm_id"] == prep["merchant_prepare_id"]
    pays = (await ok(await tenant.get("/v1/payments", params={"student_id": sid})))["items"]
    assert (
        len(pays) == 1
        and pays[0]["method"] == "click"
        and pays[0]["amount"] == "250000.00"
        and pays[0]["allocated"] == "250000.00"
    )
    assert (
        await click(
            client,
            org,
            click_form(CLICK_KEY, "98765", 1, sid, 1001, "250000.00", prepare_id=prep["merchant_prepare_id"]),
        )
    )["error"] == -4
    assert (await click(client, org, click_form(CLICK_KEY, "98765", 0, sid, 1001, "250000.00")))[
        "error"
    ] == -4

    # Click reports a failed debit in Complete -> our side cancels and answers -9; later attempts stay -9
    p2 = await click(client, org, click_form(CLICK_KEY, "98765", 0, sid, 2001, "1000.00"))
    failed = await click(
        client,
        org,
        click_form(
            CLICK_KEY, "98765", 1, sid, 2001, "1000.00", prepare_id=p2["merchant_prepare_id"], error=-5017
        ),
    )
    assert failed["error"] == -9
    assert (
        await click(
            client,
            org,
            click_form(CLICK_KEY, "98765", 1, sid, 2001, "1000.00", prepare_id=p2["merchant_prepare_id"]),
        )
    )["error"] == -9
    ledger = (await ok(await tenant.get("/v1/online-transactions", params={"provider": "click"})))["items"]
    assert sorted(t["state"] for t in ledger) == [-1, 2]


async def test_provider_credentials_are_per_center(
    client: httpx.AsyncClient, tenant: Tenant, tenant_b: Tenant
) -> None:
    await _connect(tenant, "payme", PAYME_KEY, "m1")
    await _connect(tenant_b, "payme", "other-center-key-99", "m2")
    st_a = await _billed_student(tenant)
    # center A's key does not open center B's endpoint, and B's endpoint cannot see A's students
    assert (
        await payme(
            client,
            tenant_b.org_id,
            "CheckPerformTransaction",
            {"amount": 10_000_000, "account": {"student": st_a["id"]}},
            key=PAYME_KEY,
        )
    )["error"]["code"] == -32504
    assert (
        await payme(
            client,
            tenant_b.org_id,
            "CheckPerformTransaction",
            {"amount": 10_000_000, "account": {"student": st_a["id"]}},
            key="other-center-key-99",
        )
    )["error"]["code"] == -31050
    # a Click callback for a center that never connected Click is refused
    assert (await click(client, tenant.org_id, click_form(CLICK_KEY, "1", 0, st_a["id"], 5, "1000")))[
        "error"
    ] == -8


async def test_without_secrets_key_provider_features_are_off(settings: Any, tenant: Tenant) -> None:
    from nazoratly.main import create_app

    app = create_app(settings.model_copy(update={"secrets_key": None}))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.put(
                "/v1/payment-providers/payme",
                json={"merchant_ref": "m", "secret": "12345678"},
                headers=tenant.h,
            )
            assert r.status_code == 400 and "SECRETS_KEY" in r.json()["error"]["message"]
            assert (await payme(c, tenant.org_id, "CheckTransaction", {"id": "x"}))["error"]["code"] == -32504


async def test_click_reversal_refunds_via_click_then_voids_payment(
    app: Any, client: httpx.AsyncClient, tenant: Tenant
) -> None:
    await ok(
        await tenant.put(
            "/v1/payment-providers/click",
            {"merchant_ref": "98765", "secret": CLICK_KEY, "merchant_user_id": "4321"},
        )
    )
    assert (await ok(await tenant.get("/v1/payment-providers")))[0]["reversal_enabled"] is True
    org, st = tenant.org_id, await _billed_student(tenant)
    prep = await click(client, org, click_form(CLICK_KEY, "98765", 0, st["id"], 3001, "100000.00"))
    await click(
        client,
        org,
        click_form(
            CLICK_KEY, "98765", 1, st["id"], 3001, "100000.00", prepare_id=prep["merchant_prepare_id"]
        ),
    )
    tx = (await ok(await tenant.get("/v1/online-transactions", params={"provider": "click"})))["items"][0]
    seen: list[httpx.Request] = []
    answer: dict[str, Any] = {"error_code": -1, "error_note": "Refund window closed", "payment_id": 555}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(200, json=answer)

    app.state.outbound_transport = httpx.MockTransport(handler)
    try:
        r = await tenant.post(f"/v1/online-transactions/{tx['id']}/reverse")
        assert r.status_code == 422 and r.json()["error"]["details"]["click_error_code"] == -1
        assert (await ok(await tenant.get("/v1/online-transactions")))["items"][0][
            "state"
        ] == 2  # unchanged when Click refuses
        answer.update({"error_code": 0, "error_note": "Success"})
        done = await ok(await tenant.post(f"/v1/online-transactions/{tx['id']}/reverse"))
        assert done["state"] == -2
    finally:
        app.state.outbound_transport = None
    req = seen[-1]
    assert req.method == "DELETE" and req.url.path == "/v2/merchant/payment/reversal/98765/555"
    uid, digest, ts = req.headers["Auth"].split(":")
    assert uid == "4321" and digest == hashlib.sha1((ts + CLICK_KEY).encode()).hexdigest()  # noqa: S324
    assert (await ok(await tenant.get("/v1/payments", params={"student_id": st["id"]})))["items"] == []
    assert (await ok(await tenant.get(f"/v1/students/{st['id']}/balance")))[
        "outstanding_total"
    ] == "600000.00"
    assert (
        await tenant.post(f"/v1/online-transactions/{tx['id']}/reverse")
    ).status_code == 409  # already reversed


async def test_reversal_preconditions(tenant: Tenant) -> None:
    await _connect(tenant, "click", CLICK_KEY, "98765")  # no merchant_user_id
    await _connect(tenant, "payme", PAYME_KEY, "m1")
    assert (await tenant.post(f"/v1/online-transactions/{uuid.uuid4()}/reverse")).status_code == 404
