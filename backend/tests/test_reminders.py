"""Debt reminder drafts and "a QR code for every student": the two operations the Sheets edition had and the API
did not."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import timedelta
from typing import Any

import httpx

from nazoratly.rules import reminders as R
from nazoratly.worker import Worker, WorkerSettings
from tests.conftest import Tenant, make_tenant
from tests.helpers import consent, enroll, mk_course, mk_group, mk_student, mk_teacher, ok, org_today
from tests.test_tenancy_and_staff import _add_staff, _login

PATH = "/v1/reports/debtors/reminders"
TODAY = org_today()


async def debtor(
    t: Tenant, name: str, *, amount: str = "600000", days: int = 10, chat: bool = True, agreed: bool = True
) -> dict[str, Any]:
    student = await mk_student(t, name)
    body: dict[str, Any] = {"full_name": f"Ona {name}", "phone": f"+99890{uuid.uuid4().int % 10_000_000:07d}"}
    if chat:
        body["telegram_chat_id"] = 7_000_000 + uuid.uuid4().int % 900_000_000
    guardian = await ok(await t.post("/v1/guardians", body), 201)
    await ok(
        await t.post(
            f"/v1/students/{student['id']}/guardians", {"guardian_id": guardian["id"], "relation": "mother"}
        ),
        201,
    )
    if agreed:
        await consent(t, student["id"], "notifications", guardian["id"])
    charge = await ok(
        await t.post(
            "/v1/charges",
            {
                "student_id": student["id"],
                "kind": "tuition",
                "period_month": TODAY.replace(day=1).isoformat(),
                "amount": amount,
                "due_date": (TODAY - timedelta(days=days)).isoformat(),
            },
        ),
        201,
    )
    return {"student": student, "guardian": guardian, "charge": charge}


async def test_preview_then_approve_queues_the_approved_text(tenant: Tenant) -> None:
    a = await debtor(tenant, "Ali")
    await debtor(tenant, "NoConsent", agreed=False)
    await debtor(tenant, "NoChat", chat=False)
    await debtor(tenant, "Small", amount="10000")
    preview = await ok(await tenant.get(PATH))
    assert [d["student_id"] for d in preview["drafts"]] == [a["student"]["id"]]
    draft = preview["drafts"][0]
    assert draft["kind"] == "overdue" and "600 000 so'm" in draft["text"] and "10 kun" in draft["text"]
    assert draft["guardian_id"] == a["guardian"]["id"] and draft["overdue_total"] == "600000.00"
    assert {s["student_name"]: s["reason"] for s in preview["skipped"]} == {
        "NoConsent": "no_consent",
        "NoChat": "no_chat",
        "Small": "below_threshold",
    }
    assert (await ok(await tenant.get("/v1/outbox")))["items"] == []  # a preview stores and sends nothing

    sent = await ok(
        await tenant.post(
            PATH, {"messages": [{"student_id": a["student"]["id"], "text": "Edited by a person"}]}
        ),
        201,
    )
    assert len(sent["queued"]) == 1 and sent["refused"] == []
    outbox = (await ok(await tenant.get("/v1/outbox")))["items"]
    assert [(m["body"], m["status"], m["guardian_id"]) for m in outbox] == [
        ("Edited by a person", "queued", a["guardian"]["id"])
    ]

    again = await ok(
        await tenant.post(PATH, {"messages": [{"student_id": a["student"]["id"], "text": "Twice"}]}), 201
    )
    assert again["queued"] == [] and again["refused"][0]["reason"] == "cooldown"
    # a cancelled reminder does not start a cooldown
    await ok(await tenant.post(f"/v1/outbox/{outbox[0]['id']}/cancel"))
    assert len((await ok(await tenant.get(PATH)))["drafts"]) == 1


async def test_installment_texts_and_the_center_settings(tenant: Tenant) -> None:
    a = await debtor(tenant, "Reja", amount="600000", days=5)
    await ok(
        await tenant.put(
            f"/v1/charges/{a['charge']['id']}/plan",
            {
                "installments": [
                    {"amount": "200000", "due_date": (TODAY - timedelta(days=5)).isoformat()},
                    {"amount": "400000", "due_date": (TODAY + timedelta(days=2)).isoformat()},
                ]
            },
        )
    )
    draft = (await ok(await tenant.get(PATH)))["drafts"][0]
    assert draft["kind"] == "overdue" and "1/2-to'lov (200 000 so'm)" in draft["text"]
    settings = await ok(await tenant.get("/v1/settings"))
    assert (
        settings["reminder_cooldown_days"],
        settings["reminder_min_overdue"],
        settings["installment_remind_days"],
        settings["reminder_template"],
    ) == (7, 50000, 3, None)
    changed = await ok(await tenant.patch("/v1/settings", {"reminder_min_overdue": 300000}))
    assert changed["reminder_min_overdue"] == 300000
    assert (await ok(await tenant.get(PATH)))["drafts"] == []
    branch = await ok(await tenant.post("/v1/branches", {"name": "Second"}), 201)
    r = await tenant.patch("/v1/settings", {"reminder_cooldown_days": 1}, headers={"X-Branch": branch["id"]})
    assert r.status_code == 422
    assert (await ok(await tenant.patch("/v1/settings", {"reminder_template": "{student}"})))[
        "reminder_template"
    ] == "{student}"
    assert (await ok(await tenant.patch("/v1/settings", {"reminder_template": ""})))[
        "reminder_template"
    ] is None


async def test_two_approvals_at_once_queue_one_message(tenant: Tenant) -> None:
    a = await debtor(tenant, "Race")
    body = {"messages": [{"student_id": a["student"]["id"], "text": "hello"}]}
    results = await asyncio.gather(tenant.post(PATH, body), tenant.post(PATH, body))
    assert sorted(len(r.json()["queued"]) for r in results) == [0, 1]
    assert len((await ok(await tenant.get("/v1/outbox")))["items"]) == 1


async def test_idempotency_key_replays_the_approval(tenant: Tenant) -> None:
    a = await debtor(tenant, "Replay")
    body = {"messages": [{"student_id": a["student"]["id"], "text": "hello"}]}
    key = {"Idempotency-Key": uuid.uuid4().hex}
    first = await ok(await tenant.post(PATH, body, headers=dict(key)), 201)
    second = await tenant.post(PATH, body, headers=dict(key))
    assert second.json() == first and second.headers["idempotent-replayed"] == "true"


async def staff(client: httpx.AsyncClient, owner: Tenant, role: str) -> dict[str, str]:
    email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
    await ok(
        await owner.post(
            "/v1/staff",
            {"full_name": role, "email": email, "role": role, "initial_password": "staff-password-1"},
        ),
        201,
    )
    login = await ok(
        await client.post("/v1/auth/login", json={"identifier": email, "password": "staff-password-1"})
    )
    return {"Authorization": f"Bearer {login['access_token']}"}


async def test_who_may_use_reminders_and_bulk_qr(client: httpx.AsyncClient, tenant: Tenant) -> None:
    for role, reminders, qr in (
        ("admin", 200, 200),
        ("manager", 200, 200),
        ("accountant", 403, 403),
        ("teacher", 403, 403),
        ("viewer", 403, 403),
    ):
        h = await staff(client, tenant, role)
        assert (await client.get(PATH, headers=h)).status_code == reminders, role
        send = await client.post(
            PATH, headers=h, json={"messages": [{"student_id": str(uuid.uuid4()), "text": "x"}]}
        )
        assert send.status_code == (404 if reminders == 200 else 403), role
        assert (await client.post("/v1/attendance/qr-codes/issue", headers=h)).status_code == qr, role


async def test_another_center_is_not_found(client: httpx.AsyncClient, tenant: Tenant) -> None:
    mine = await debtor(tenant, "Mine")
    other = await make_tenant(client, "foreign")
    assert (await ok(await other.get(PATH)))["drafts"] == []
    r = await other.post(PATH, {"messages": [{"student_id": mine["student"]["id"], "text": "x"}]})
    assert r.status_code == 404
    assert (await ok(await tenant.get("/v1/outbox")))["items"] == []


async def test_issue_codes_to_every_student(client: httpx.AsyncClient, tenant: Tenant) -> None:
    a, b = await mk_student(tenant, "A"), await mk_student(tenant, "B")
    gone = await mk_student(tenant, "Gone", status="left")
    had = (await ok(await tenant.post(f"/v1/students/{a['id']}/qr", {})))["code"]
    assert (await ok(await tenant.post("/v1/attendance/qr-codes/issue"))) == {"issued": 1}
    assert (await ok(await tenant.post("/v1/attendance/qr-codes/issue"))) == {"issued": 0}
    assert (await ok(await tenant.post(f"/v1/students/{a['id']}/qr", {})))["code"] == had  # kept
    assert (await ok(await tenant.post(f"/v1/students/{b['id']}/qr", {})))["code"] != had
    other = await make_tenant(client, "qrb")
    await mk_student(other, "Theirs")
    await mk_student(tenant, "Late")
    assert (await ok(await tenant.post("/v1/attendance/qr-codes/issue"))) == {"issued": 1}
    assert (await ok(await other.post("/v1/attendance/qr-codes/issue"))) == {"issued": 1}
    assert gone["id"]  # a student who left got none: the counts above add up without them


async def test_branch_staff_see_only_their_branch(client: httpx.AsyncClient, tenant: Tenant) -> None:
    branch = await ok(await tenant.post("/v1/branches", {"name": "Yunusobod"}), 201)
    await debtor(tenant, "MainBranch")
    email = f"mgr-{uuid.uuid4().hex[:8]}@example.com"
    await ok(
        await tenant.post(
            "/v1/staff",
            {
                "full_name": "M",
                "email": email,
                "role": "manager",
                "branch_id": branch["id"],
                "initial_password": "staff-password-1",
            },
        ),
        201,
    )
    login = await ok(
        await client.post("/v1/auth/login", json={"identifier": email, "password": "staff-password-1"})
    )
    h = {"Authorization": f"Bearer {login['access_token']}"}
    assert (await ok(await client.get(PATH, headers=h))) == {"drafts": [], "skipped": []}
    assert (await ok(await client.post("/v1/attendance/qr-codes/issue", headers=h))) == {"issued": 0}


# ---- the message as the worker sends it (owner decision 43) -------------------------------------------------------
def _sending_worker(pg_server: dict[str, Any], handler: Any) -> Worker:
    settings = WorkerSettings(
        database_url_worker=pg_server["worker"],
        telegram_bot_token="123456:SECRET-BOT-TOKEN",
        worker_batch=100,
    )  # type: ignore[arg-type]
    return Worker(settings, httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def _run_worker(w: Worker) -> None:
    await w.open()
    try:
        while await w.run_once():
            pass
    finally:
        await w.close()


def _calls_to(seen: list[tuple[str, dict[str, Any]]], chat: int) -> list[tuple[str, dict[str, Any]]]:
    return [(m, p) for m, p in seen if p.get("chat_id") == chat]


async def test_the_sent_reminder_has_the_live_table_the_requisites_and_the_buttons(
    pg_server: dict[str, Any], tenant: Tenant
) -> None:
    a = await debtor(tenant, "Live")
    chat = int(a["guardian"]["telegram_chat_id"])
    await ok(await tenant.patch("/v1/settings", {"pay_info": "8600 1234 5678 9012"}))
    await ok(
        await tenant.post(
            "/v1/charges",
            {
                "student_id": a["student"]["id"],
                "kind": "materials",
                "period_month": TODAY.replace(day=1).isoformat(),
                "amount": "150000",
                "due_date": (TODAY + timedelta(days=20)).isoformat(),
            },
        ),
        201,
    )
    await ok(
        await tenant.post(PATH, {"messages": [{"student_id": a["student"]["id"], "text": "Approved text"}]}),
        201,
    )
    # money arrives between the approval and the sending: the table shows what is owed at the moment of sending
    await ok(
        await tenant.post(
            "/v1/payments", {"student_id": a["student"]["id"], "amount": "100000", "method": "cash"}
        ),
        201,
    )
    seen: list[tuple[str, dict[str, Any]]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.url.path.rsplit("/", 1)[1], json.loads(req.content)))
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

    await _run_worker(_sending_worker(pg_server, handler))
    [(method, payload)] = _calls_to(seen, chat)
    assert method == "sendRichMessage"
    html = payload["rich_message"]["html"]
    sid = uuid.UUID(a["student"]["id"]).hex
    assert html.startswith("<p>Approved text</p><table striped compact>")
    assert (
        "500 000</td>" in html and "150 000</td>" in html
    )  # 600 000 less the 100 000 just paid, and the new charge
    assert html.index("500 000") < html.index("150 000")  # the oldest due date first
    assert "<p><b>Jami qoldiq: 650 000 so'm</b></p>" in html
    assert 'type="copy_text" style="primary" text="8600 1234 5678 9012"' in html
    assert f'type="callback_data" style="success" data="paid:{sid}"' in html
    assert "Authorization" not in json.dumps(payload) and len(f"paid:{sid}") <= 64


async def test_a_reminder_without_requisites_has_no_copy_button_and_a_plain_text_fallback(
    pg_server: dict[str, Any], tenant: Tenant
) -> None:
    a = await debtor(tenant, "Plain")
    chat = int(a["guardian"]["telegram_chat_id"])
    await ok(
        await tenant.post(PATH, {"messages": [{"student_id": a["student"]["id"], "text": "Plain text"}]}), 201
    )
    seen: list[tuple[str, dict[str, Any]]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        method = req.url.path.rsplit("/", 1)[1]
        seen.append((method, json.loads(req.content)))
        if method == "sendRichMessage":  # Telegram does not accept the rich message
            return httpx.Response(400, json={"ok": False, "description": "Bad Request: can't parse"})
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

    await _run_worker(_sending_worker(pg_server, handler))
    methods = [m for m, _ in _calls_to(seen, chat)]
    assert methods == ["sendRichMessage", "sendMessage"]
    rich, plain = (p for _, p in _calls_to(seen, chat))
    assert "copy_text" not in rich["rich_message"]["html"]
    text = plain["text"]  # the same content, readable without markup; the buttons are lost with the markup
    assert text == R.strip_html(rich["rich_message"]["html"])
    assert (
        text.startswith("Plain text\nOy | Qoldiq (so'm) | Muddat\n") and "Jami qoldiq: 600 000 so'm" in text
    )
    assert "reply_markup" not in plain and "<" not in text
    sent = [m for m in (await ok(await tenant.get("/v1/outbox")))["items"] if m["body"] == "Plain text"]
    assert [m["status"] for m in sent] == ["sent"]


async def test_other_messages_are_never_given_a_debt_table(pg_server: dict[str, Any], tenant: Tenant) -> None:
    a = await debtor(tenant, "Manual")
    chat = int(a["guardian"]["telegram_chat_id"])
    await ok(
        await tenant.post(
            "/v1/outbox",
            {
                "student_id": a["student"]["id"],
                "guardian_id": a["guardian"]["id"],
                "channel": "telegram",
                "body": "Only a note",
                "client_ref": "debt-reminder-pretend-0001",  # the prefix cannot be set from outside
            },
        ),
        201,
    )
    seen: list[tuple[str, dict[str, Any]]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.url.path.rsplit("/", 1)[1], json.loads(req.content)))
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

    await _run_worker(_sending_worker(pg_server, handler))
    assert _calls_to(seen, chat) == [
        (
            "sendMessage",
            {"chat_id": chat, "text": "Only a note", "link_preview_options": {"is_disabled": True}},
        )
    ]


async def test_only_the_owner_changes_the_requisites_and_never_per_branch(
    tenant: Tenant, client: httpx.AsyncClient
) -> None:
    for role in ("manager", "admin"):  # both may change other settings, neither the requisites
        _, email = await _add_staff(tenant, role)
        staff = await _login(client, email, "staff-password-123", tenant.org_id)
        assert (await staff.patch("/v1/settings", {"pay_info": "my own card"})).status_code == 403
    assert (await ok(await tenant.get("/v1/settings")))["pay_info"] is None
    assert (await ok(await tenant.patch("/v1/settings", {"pay_info": "  card 1  "})))["pay_info"] == "card 1"
    assert (await tenant.patch("/v1/settings", {"pay_info": "x" * 257})).status_code == 422
    branch = await ok(await tenant.post("/v1/branches", {"name": "Requisites branch"}), 201)
    r = await tenant.patch("/v1/settings", {"pay_info": "card 2"}, headers={"X-Branch": branch["id"]})
    assert r.status_code == 422
    assert (await ok(await tenant.patch("/v1/settings", {"pay_info": ""})))["pay_info"] is None


# ---- lesson package reminders (Sheets menu "To'lov eslatma loyihalarini yaratish") ---------------------------------
PACKAGE_PATH = "/v1/reports/packages/payment-needed/reminders"


async def package_student(t: Tenant, name: str, *, chat: bool = True) -> dict[str, Any]:
    """A student with an exhausted package balance: enrolled in a package group, nothing bought yet, one lesson held."""
    course = await mk_course(t)
    teacher = await mk_teacher(t)
    group = await mk_group(
        t,
        course_id=course["id"],
        teacher_id=teacher["id"],
        billing_mode="package",
        package_lessons=8,
        package_price="800000",
    )
    a = await debtor(t, name, chat=chat)
    await enroll(t, group["id"], a["student"]["id"], (TODAY - timedelta(days=30)).isoformat())
    return a


async def test_package_reminders_are_previewed_then_approved_and_share_the_cooldown(
    pg_server: dict[str, Any], tenant: Tenant, client: httpx.AsyncClient
) -> None:
    a = await package_student(tenant, "Paket")
    await package_student(tenant, "PaketNoChat", chat=False)
    preview = await ok(await tenant.get(PACKAGE_PATH))
    assert [(d["student_name"], d["need"]) for d in preview["drafts"]] == [("Paket", "exhausted")]
    assert "abonementdagi darslar tugadi" in preview["drafts"][0]["text"]
    assert [(s["student_name"], s["reason"]) for s in preview["skipped"]] == [("PaketNoChat", "no_chat")]
    assert (await ok(await tenant.get("/v1/outbox")))["items"] == []  # a preview stores nothing

    body = {"messages": [{"student_id": a["student"]["id"], "text": "Package text"}]}
    sent = await ok(await tenant.post(PACKAGE_PATH, body), 201)
    assert len(sent["queued"]) == 1 and sent["refused"] == []
    # one cooldown for every kind of reminder, as in the Sheets edition
    again = await ok(await tenant.post(PACKAGE_PATH, body), 201)
    assert again["refused"] == [{"student_id": a["student"]["id"], "reason": "cooldown"}]
    assert (await ok(await tenant.get(PATH)))["drafts"] == []

    seen: list[tuple[str, dict[str, Any]]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.url.path.rsplit("/", 1)[1], json.loads(req.content)))
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

    await _run_worker(_sending_worker(pg_server, handler))
    [(method, payload)] = _calls_to(seen, int(a["guardian"]["telegram_chat_id"]))
    assert (
        method == "sendRichMessage"
    )  # as in the Sheets edition: the same table and buttons under every reminder
    assert payload["rich_message"]["html"].startswith("<p>Package text</p><table striped compact>")

    # who may not: another center's student is a 404, and a role without the rights is refused
    other = await make_tenant(client, "package-foreign")
    assert (await other.post(PACKAGE_PATH, body)).status_code == 404
    _, email = await _add_staff(tenant, "accountant")  # finance:read, no students:write
    staff = await _login(client, email, "staff-password-123", tenant.org_id)
    assert (await staff.get(PACKAGE_PATH)).status_code == 403
    assert (await staff.post(PACKAGE_PATH, body)).status_code == 403
