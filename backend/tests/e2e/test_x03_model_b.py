"""Model B across the whole product: automation and AI may prepare, never send. Every producer of text (billing, reminders, AI
reports, schedule changes, reports, certificates, documents, teacher reminders, referrals, QR cards, guardian requests, agent
drafts) is run against a family that HAS consented and is reachable; then the worker runs against a recording Telegram fake.
Not a single message may exist or leave. Only a person's explicit approval creates exactly one message, delivered exactly once."""

from __future__ import annotations

import json
import re
import uuid
from datetime import timedelta
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.e2e.journeys import TODAY, outbox_rows
from tests.helpers import consent, enroll, mk_student, ok
from tests.test_agents import _auth, _propose
from tests.test_ai_reports import good_reply
from tests.test_document_delivery import _family
from tests.test_documents import set_requisites
from tests.test_schedule import mk_lesson
from tests.test_trials import group_with_lessons
from tests.test_worker import _worker


class Recorder:
    """Records every Bot API call per chat; every message of other tests' chats is simply accepted."""

    def __init__(self, chat: int) -> None:
        self.chat = chat
        self.calls: list[str] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        method = req.url.path.rsplit("/", 1)[1]
        raw = req.content
        if method == "sendDocument":
            if f'name="chat_id"\r\n\r\n{self.chat}'.encode() in raw:
                self.calls.append(method)
        else:
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = {}
            if payload.get("chat_id") == self.chat:
                self.calls.append(method)
        return httpx.Response(200, json={"ok": True})


async def run_worker(pg_server: dict[str, Any], rec: Recorder, passes: int = 1) -> None:
    w = _worker(pg_server, rec)
    await w.open()
    try:
        for _ in range(passes):
            await w.run_once()
    finally:
        await w.close()


async def test_every_producer_only_prepares_and_only_a_person_sends(
    pg_server: dict[str, Any], super_dsn: str, tenant: Tenant, app: Any, fake_ai: Any
) -> None:
    t = tenant
    chat = 940_000 + uuid.uuid4().int % 50_000
    kid, mom = await _family(t, chat_id=chat)
    await consent(t, kid["id"], "ai_assistant_processing", mom["id"])
    await set_requisites(t)
    fake_ai(good_reply)

    # --- a reachable, consenting family with a debt, a lesson, a group, a trial, a waitlist
    grp = await group_with_lessons(t)
    await enroll(t, grp["id"], kid["id"], "2026-11-01")
    others = [await mk_student(t, f"Waiting {i}") for i in range(2)]
    ch = await ok(
        await t.post(
            "/v1/charges",
            {
                "student_id": kid["id"],
                "kind": "tuition",
                "period_month": TODAY.replace(day=1).isoformat(),
                "amount": "500000",
                "due_date": (TODAY - timedelta(days=20)).isoformat(),
            },
        ),
        201,
    )
    pay = await ok(
        await t.post("/v1/payments", {"student_id": kid["id"], "amount": "100000", "method": "cash"}), 201
    )
    future = await mk_lesson(t, grp["id"], "2026-12-14")
    movable = await mk_lesson(t, grp["id"], "2026-12-21")
    org = t.org_id

    # --- run every automation / generator: nothing may be queued
    await ok(
        await t.post(
            "/v1/charges/generate",
            {"month": (TODAY.replace(day=1) + timedelta(days=32)).replace(day=1).isoformat()},
        )
    )
    await ok(await t.get("/v1/leads/reminders"))
    await ok(await t.get("/v1/trials/pending"))
    await ok(await t.get("/v1/waitlist/offers"))
    await ok(await t.get("/v1/reports/packages/payment-needed"))
    await ok(await t.get("/v1/reports/debtors"))
    await ok(await t.get("/v1/lessons/unmarked"))
    await ok(await t.post("/v1/teacher-app/reminders/run"))
    for kind in ("weekly_summary", "debt_followup", "churn_risk"):
        await ok(await t.post("/v1/ai/reports", {"kind": kind}), 201)
    await ok(await t.post("/v1/referrals/book"))
    mv = await ok(
        await t.post(
            f"/v1/lessons/{movable['id']}/move",
            {"lesson_date": "2026-12-22", "start_time": "10:00", "end_time": "11:00", "reason": "holiday"},
        )
    )
    assert mv["notices_created"] == 1
    await ok(await t.post(f"/v1/lessons/{future['id']}/cancel", {"reason": "snow"}))
    prog = await ok(
        await t.post(
            "/v1/reports/progress", {"student_id": kid["id"], "group_id": grp["id"], "month": "2026-11"}
        ),
        201,
    )
    await ok(await t.post("/v1/reports/progress/generate", {"group_id": grp["id"], "month": "2026-11"}))
    receipt = await ok(await t.post("/v1/documents/receipts", {"payment_id": pay["id"]}), 201)
    await ok(await t.post("/v1/documents/invoices", {"student_id": kid["id"], "charge_id": ch["id"]}), 201)
    finished = await ok(
        await t.patch(
            f"/v1/enrollments/{(await ok(await t.get(f'/v1/groups/{grp["id"]}/enrollments')))['items'][0]['id']}",
            {"status": "finished"},
        )
    )
    cert = await ok(await t.post("/v1/certificates", {"enrollment_id": finished["id"]}), 201)
    await ok(await t.post(f"/v1/students/{kid['id']}/qr", {}))
    assert (await t.get(f"/v1/students/{kid['id']}/qr-card")).status_code == 200
    await ok(await t.post("/v1/guardian/codes", {"student_id": kid["id"]}), 201)
    # an agent that may only draft proposes a reminder: it stays a pending draft
    agent = await ok(await t.post("/v1/agents", {"name": "assistant", "scopes": ["read", "draft"]}), 201)
    who = _auth(pg_server, agent["token"])
    assert who is not None
    _propose(pg_server, who, kid["id"], mom["id"])
    draft = (await ok(await t.get("/v1/agent-drafts")))["items"][0]
    assert draft["status"] == "pending"
    notices = (await ok(await t.get("/v1/schedule-notices")))["items"]
    assert len(notices) == 2 and {n["status"] for n in notices} == {"pending"}
    assert others  # (kept to show the waiting list had candidates)

    rec = Recorder(chat)
    assert outbox_rows(super_dsn, org) == [] and (await ok(await t.get("/v1/outbox")))["items"] == []
    await run_worker(pg_server, rec, passes=2)
    assert rec.calls == []  # not one byte left the system

    # --- a person approves each thing: exactly one message per approval, never two
    await ok(await t.post(f"/v1/schedule-notices/{notices[0]['id']}/approve", {}))
    await ok(await t.post(f"/v1/reports/progress/{prog['id']}/approve", {"guardian_id": mom["id"]}), 201)
    await ok(await t.post(f"/v1/documents/{receipt['id']}/send", {"guardian_id": mom["id"]}), 201)
    await ok(await t.post(f"/v1/certificates/{cert['id']}/send", {"guardian_id": mom["id"]}), 201)
    await ok(await t.post(f"/v1/agent-drafts/{draft['id']}/approve", {}))
    for repeat in (
        f"/v1/schedule-notices/{notices[0]['id']}/approve",
        f"/v1/agent-drafts/{draft['id']}/approve",
    ):
        assert (await t.post(repeat, {})).status_code == 409
    for repeat in (
        f"/v1/reports/progress/{prog['id']}/approve",
        f"/v1/documents/{receipt['id']}/send",
        f"/v1/certificates/{cert['id']}/send",
    ):
        again = await t.post(repeat, {"guardian_id": mom["id"]})
        assert again.status_code in (200, 409)  # a replay returns the same message, never a second one
    rows = outbox_rows(super_dsn, org)
    assert len(rows) == 5 and {r[0] for r in rows} == {"telegram"}
    assert (await ok(await t.get("/v1/schedule-notices")))["items"][0][
        "status"
    ] == "pending"  # the unapproved one still waits

    await run_worker(pg_server, rec)
    first = list(rec.calls)
    assert first.count("sendMessage") + first.count("sendRichMessage") == 5
    assert first.count("sendDocument") == 3  # progress report, receipt, certificate
    await run_worker(pg_server, rec, passes=3)
    assert rec.calls == first  # replaying the worker sends nothing again
    assert {r[1] for r in outbox_rows(super_dsn, org)} == {"sent"}
    assert re.fullmatch(r"[a-z]+", "ok")
