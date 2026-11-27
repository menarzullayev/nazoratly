"""Debt reminder drafts and "a QR code for every student": the two operations the Sheets edition had and the API
did not."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Any

import httpx

from tests.conftest import Tenant, make_tenant
from tests.helpers import consent, mk_student, ok, org_today

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
