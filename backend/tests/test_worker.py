from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import psycopg
import pytest

from nazoratly.worker import Worker, WorkerSettings
from tests.conftest import Tenant
from tests.helpers import consent, mk_student, ok
from tests.test_agents import _auth, _propose

TOKEN = "123456:SECRET-BOT-TOKEN"


def _worker(pg_server: dict[str, Any], handler: Any) -> Worker:
    settings = WorkerSettings(
        database_url_worker=pg_server["worker"], telegram_bot_token=TOKEN, worker_batch=100
    )  # type: ignore[arg-type]
    return Worker(settings, httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def _queued(
    t: Tenant, channel: str = "telegram", chat_id: int | None = 777, notify: bool = True
) -> dict[str, Any]:
    s = await mk_student(t)
    body = (
        {"full_name": "Parent", "telegram_chat_id": chat_id}
        if chat_id
        else {"full_name": "Parent", "phone": "+998901234567"}
    )
    g = await ok(await t.post("/v1/guardians", body), 201)
    await ok(
        await t.post(f"/v1/students/{s['id']}/guardians", {"guardian_id": g["id"], "relation": "mother"}), 201
    )
    await consent(t, s["id"], "notifications", g["id"])
    msg = await ok(
        await t.post(
            "/v1/outbox", {"student_id": s["id"], "guardian_id": g["id"], "channel": channel, "body": "Salom"}
        ),
        201,
    )
    if not notify:
        notif = next(
            c
            for c in await ok(await t.get(f"/v1/students/{s['id']}/consents"))
            if c["purpose"] == "notifications"
        )
        await ok(await t.post(f"/v1/consents/{notif['id']}/revoke"))
    return msg  # type: ignore[no-any-return]


async def _status(t: Tenant, msg_id: str) -> dict[str, Any]:
    items = (await ok(await t.get("/v1/outbox", params={"limit": 200})))["items"]
    return next(m for m in items if m["id"] == msg_id)


async def test_sends_telegram_and_marks_sent(pg_server: dict[str, Any], tenant: Tenant) -> None:
    seen: list[dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append({"url": str(req.url), "json": json.loads(req.content)})
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

    msg = await _queued(tenant)
    w = _worker(pg_server, handler)
    await w.open()
    try:
        assert await w.run_once() >= 1
    finally:
        await w.close()
    mine = [r for r in seen if r["json"]["chat_id"] == 777]
    assert (
        len(mine) >= 1 and mine[0]["json"]["text"] == "Salom" and f"/bot{TOKEN}/sendMessage" in mine[0]["url"]
    )
    done = await _status(tenant, msg["id"])
    assert (
        done["status"] == "sent" and done["sent_at"] and done["attempts"] == 1 and done["last_error"] is None
    )


async def test_failure_modes(pg_server: dict[str, Any], tenant: Tenant) -> None:
    transient = await _queued(tenant, chat_id=101)
    blocked = await _queued(tenant, chat_id=102)
    limited = await _queued(tenant, chat_id=103)
    leaky = await _queued(tenant, chat_id=104)

    def handler(req: httpx.Request) -> httpx.Response:
        chat = json.loads(req.content)["chat_id"]
        if chat == 101:
            return httpx.Response(502, text="bad gateway")
        if chat == 102:
            return httpx.Response(
                403, json={"ok": False, "description": "Forbidden: bot was blocked by the user"}
            )
        if chat == 103:
            return httpx.Response(
                429,
                json={"ok": False, "description": "Too Many Requests", "parameters": {"retry_after": 120}},
            )
        if chat == 104:
            raise httpx.ConnectError(f"cannot reach {req.url}")
        return httpx.Response(200, json={"ok": True})

    w = _worker(pg_server, handler)
    await w.open()
    try:
        await w.run_once()
    finally:
        await w.close()
    t1, t2, t3, t4 = [await _status(tenant, m["id"]) for m in (transient, blocked, limited, leaky)]
    assert (
        t1["status"] == "queued"
        and t1["attempts"] == 1
        and "502" in t1["last_error"]
        and t1["send_after"] > t1["created_at"]
    )
    assert t2["status"] == "failed" and "blocked" in t2["last_error"]
    assert t3["status"] == "queued" and "rate limit" in t3["last_error"]
    assert t4["status"] == "queued" and t4["last_error"] == "network error: ConnectError"
    assert TOKEN not in json.dumps([t1, t2, t3, t4])  # the bot token never reaches the database or API


async def test_retries_exhaust_to_failed(pg_server: dict[str, Any], tenant: Tenant, super_dsn: str) -> None:
    msg = await _queued(tenant, chat_id=201)
    w = _worker(pg_server, lambda req: httpx.Response(500, text="boom"))
    await w.open()
    try:
        for _ in range(5):
            with psycopg.connect(super_dsn, autocommit=True) as c:  # let the backoff elapse
                c.execute(
                    "UPDATE outbox_messages SET send_after = now() WHERE public_id = %s AND status = 'queued'",
                    (msg["id"],),
                )
            await w.run_once()
    finally:
        await w.close()
    final = await _status(tenant, msg["id"])
    assert final["status"] == "failed" and final["attempts"] == 5


async def test_consent_revoked_before_send_cancels_without_calling_telegram(
    pg_server: dict[str, Any], tenant: Tenant
) -> None:
    calls: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(json.loads(req.content)["chat_id"])
        return httpx.Response(200, json={"ok": True})

    msg = await _queued(tenant, chat_id=301, notify=False)
    w = _worker(pg_server, handler)
    await w.open()
    try:
        await w.run_once()
    finally:
        await w.close()
    assert 301 not in calls
    st = await _status(tenant, msg["id"])
    assert st["status"] == "cancelled" and "consent" in st["last_error"]


async def test_sms_without_provider_fails_loudly(pg_server: dict[str, Any], tenant: Tenant) -> None:
    msg = await _queued(tenant, channel="sms", chat_id=None)
    w = _worker(pg_server, lambda req: httpx.Response(200, json={"ok": True}))
    await w.open()
    try:
        await w.run_once()
    finally:
        await w.close()
    st = await _status(tenant, msg["id"])
    assert st["status"] == "failed" and st["last_error"] == "no SMS provider is configured"


async def test_concurrent_workers_send_each_message_once(pg_server: dict[str, Any], tenant: Tenant) -> None:
    sent: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(json.loads(req.content)["chat_id"])
        return httpx.Response(200, json={"ok": True})

    chats = list(range(9000, 9012))
    msgs = [await _queued(tenant, chat_id=c) for c in chats]
    w1, w2 = _worker(pg_server, handler), _worker(pg_server, handler)
    await w1.open()
    await w2.open()
    try:
        await asyncio.gather(w1.run_once(), w2.run_once(), w1.run_once(), w2.run_once())
    finally:
        await w1.close()
        await w2.close()
    ours = [c for c in sent if c in chats]
    assert sorted(ours) == chats  # each exactly once
    statuses = [(await _status(tenant, m["id"]))["status"] for m in msgs]
    assert set(statuses) == {"sent"}


async def test_draft_becomes_executed_after_delivery(pg_server: dict[str, Any], tenant: Tenant) -> None:
    s = await mk_student(tenant, "Draft Student")
    g = await ok(
        await tenant.post("/v1/guardians", {"full_name": "Draft Parent", "telegram_chat_id": 555}), 201
    )
    await ok(
        await tenant.post(
            f"/v1/students/{s['id']}/guardians", {"guardian_id": g["id"], "relation": "father"}
        ),
        201,
    )
    await consent(tenant, s["id"], "notifications", g["id"])
    await consent(tenant, s["id"], "ai_assistant_processing", g["id"])
    created = await ok(await tenant.post("/v1/agents", {"name": "w", "scopes": ["read", "draft"]}), 201)
    who = _auth(pg_server, created["token"])
    assert who is not None
    _propose(pg_server, who, s["id"], g["id"])
    draft = (await ok(await tenant.get("/v1/agent-drafts")))["items"][0]
    await ok(await tenant.post(f"/v1/agent-drafts/{draft['id']}/approve", {}))
    w = _worker(pg_server, lambda req: httpx.Response(200, json={"ok": True}))
    await w.open()
    try:
        await w.run_once()
    finally:
        await w.close()
    executed = (await ok(await tenant.get("/v1/agent-drafts", params={"status": "executed"})))["items"]
    assert [d["id"] for d in executed] == [draft["id"]]


def test_worker_role_has_no_table_access(pg_server: dict[str, Any]) -> None:
    with psycopg.connect(pg_server["worker"]) as c:
        for table in ("outbox_messages", "guardians", "students"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(f"SELECT * FROM {table}")  # type: ignore[arg-type]
            c.rollback()


def _sms_worker(pg_server: dict[str, Any], handler: Any) -> Worker:
    settings = WorkerSettings(
        database_url_worker=pg_server["worker"],  # type: ignore[arg-type]
        eskiz_email="owner@example.com",
        eskiz_password="eskiz-pass",  # type: ignore[arg-type]
        worker_batch=100,
    )
    return Worker(settings, httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_eskiz_sms_login_send_relogin_and_errors(pg_server: dict[str, Any], tenant: Tenant) -> None:
    calls: list[tuple[str, str, bytes]] = []
    state = {"tokens": 0, "reject_first_send": True}

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append((req.method, req.url.path, req.content))
        if req.url.path == "/api/auth/login":
            state["tokens"] += 1
            return httpx.Response(
                200, json={"message": "token_generated", "data": {"token": f"tok{state['tokens']}"}}
            )
        assert req.url.path == "/api/message/sms/send"
        if req.headers["Authorization"] == "Bearer tok1" and state["reject_first_send"]:
            state["reject_first_send"] = False
            return httpx.Response(401, json={"message": "Expired"})  # token expired -> worker logs in again
        return httpx.Response(
            200, json={"id": "abc", "message": "Waiting for SMS provider", "status": "waiting"}
        )

    msg = await _queued(tenant, channel="sms", chat_id=None)
    w = _sms_worker(pg_server, handler)
    await w.open()
    try:
        await w.run_once()
    finally:
        await w.close()
    st = await _status(tenant, msg["id"])
    assert st["status"] == "sent"
    sends = [c for c in calls if c[1].endswith("/sms/send")]
    assert len(sends) == 2 and b"mobile_phone=998901234567" in sends[-1][2] and b"from=4546" in sends[-1][2]
    assert state["tokens"] == 2


async def test_eskiz_failures(pg_server: dict[str, Any], tenant: Tenant) -> None:
    bad_login = await _queued(tenant, channel="sms", chat_id=None)
    w = _sms_worker(pg_server, lambda req: httpx.Response(401, json={"message": "bad credentials"}))
    await w.open()
    try:
        await w.run_once()
    finally:
        await w.close()
    st = await _status(tenant, bad_login["id"])
    assert st["status"] == "failed" and "login failed" in st["last_error"]

    rejected = await _queued(tenant, channel="sms", chat_id=None)
    flaky = await _queued(tenant, channel="sms", chat_id=None)
    answers = iter([422, 503])

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/auth/login":
            return httpx.Response(200, json={"data": {"token": "t"}})
        return httpx.Response(next(answers), json={"message": "nope"})

    w = _sms_worker(pg_server, handler)
    await w.open()
    try:
        await w.run_once()
    finally:
        await w.close()
    r1, r2 = await _status(tenant, rejected["id"]), await _status(tenant, flaky["id"])
    assert {r1["status"], r2["status"]} == {"failed", "queued"}  # 4xx permanent, 5xx retried later
