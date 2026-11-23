"""Sending a receipt or invoice to the guardian: explicit approval, consent rules, rich text then the PDF."""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import psycopg

from nazoratly.rules.documents import FOOTER
from tests.conftest import Tenant
from tests.helpers import consent, mk_student, ok
from tests.test_documents import set_requisites
from tests.test_plans import charge, pay
from tests.test_worker import _status, _worker


async def _family(
    t: Tenant, *, chat_id: int | None, linked: bool = True, notify: bool = True
) -> tuple[dict[str, Any], dict[str, Any]]:
    st = await mk_student(t, "Karimov Anvar")
    guardian = await ok(
        await t.post(
            "/v1/guardians",
            {
                "full_name": "Karimova Dilnoza",
                **({"telegram_chat_id": chat_id} if chat_id else {"phone": "+998901112233"}),
            },
        ),
        201,
    )
    if linked:
        await ok(
            await t.post(
                f"/v1/students/{st['id']}/guardians", {"guardian_id": guardian["id"], "relation": "mother"}
            ),
            201,
        )
    if notify:
        await consent(t, st["id"], "notifications", guardian["id"] if linked else None)
    return st, guardian


async def _receipt(t: Tenant, st: dict[str, Any]) -> dict[str, Any]:
    await charge(t, st["id"], "400000", due=-1)
    payment = await pay(t, st["id"], "150000")
    return await ok(await t.post("/v1/documents/receipts", {"payment_id": payment["id"]}), 201)  # type: ignore[no-any-return]


class FakeTelegram:
    """Records the calls for one chat; every other chat (other tests' messages) is simply accepted."""

    def __init__(self, chat: int, fail_document_times: int = 0, reject_rich: bool = False) -> None:
        self.chat, self.calls = chat, []  # type: ignore[var-annotated]
        self.fail_document_times, self.reject_rich = fail_document_times, reject_rich

    def __call__(self, req: httpx.Request) -> httpx.Response:
        method = req.url.path.rsplit("/", 1)[1]
        if method == "sendDocument":
            raw = req.content
            if f'name="chat_id"\r\n\r\n{self.chat}'.encode() not in raw:
                return httpx.Response(200, json={"ok": True})
            self.calls.append({"method": method, "file": raw})
            if self.fail_document_times > 0:
                self.fail_document_times -= 1
                return httpx.Response(502, text="bad gateway")
            return httpx.Response(200, json={"ok": True})
        payload = json.loads(req.content)
        if payload.get("chat_id") != self.chat:
            return httpx.Response(200, json={"ok": True})
        self.calls.append({"method": method, "json": payload})
        if method == "sendRichMessage" and self.reject_rich:
            return httpx.Response(400, json={"ok": False, "description": "Bad Request: unsupported"})
        return httpx.Response(200, json={"ok": True})


async def _run(pg_server: dict[str, Any], fake: FakeTelegram) -> None:
    w = _worker(pg_server, fake)
    await w.open()
    try:
        await w.run_once()
    finally:
        await w.close()


async def test_send_queues_one_message_and_worker_delivers_rich_text_then_pdf(
    pg_server: dict[str, Any], tenant: Tenant
) -> None:
    await set_requisites(tenant)
    chat = 880_000 + uuid.uuid4().int % 100_000
    st, guardian = await _family(tenant, chat_id=chat)
    doc = await _receipt(tenant, st)
    sent = await ok(
        await tenant.post(f"/v1/documents/{doc['id']}/send", {"guardian_id": guardian["id"]}), 201
    )
    assert sent["status"] == "queued" and sent["document_id"] == doc["id"]
    again = await tenant.post(f"/v1/documents/{doc['id']}/send", {"guardian_id": guardian["id"]})
    assert (
        again.status_code == 200 and again.json()["message_id"] == sent["message_id"]
    )  # never a second message

    fake = FakeTelegram(chat)
    await _run(pg_server, fake)
    assert [c["method"] for c in fake.calls] == ["sendRichMessage", "sendDocument"]
    html = fake.calls[0]["json"]["rich_message"]["html"]
    assert doc["number"] in html and "150 000" in html and FOOTER in html and "Karimov Anvar" in html
    upload = fake.calls[1]["file"]
    assert f'filename="{doc["number"]}.pdf"'.encode() in upload and b"%PDF" in upload
    done = await _status(tenant, sent["message_id"])
    assert done["status"] == "sent" and done["attempts"] == 1
    await _run(pg_server, fake)  # nothing left to send
    assert len(fake.calls) == 2


async def test_retry_after_failed_upload_does_not_repeat_the_rich_message(
    pg_server: dict[str, Any], tenant: Tenant, super_dsn: str
) -> None:
    chat = 890_000 + uuid.uuid4().int % 100_000
    st, guardian = await _family(tenant, chat_id=chat)
    doc = await _receipt(tenant, st)
    sent = await ok(
        await tenant.post(f"/v1/documents/{doc['id']}/send", {"guardian_id": guardian["id"]}), 201
    )
    fake = FakeTelegram(chat, fail_document_times=1)
    await _run(pg_server, fake)
    first = await _status(tenant, sent["message_id"])
    assert first["status"] == "queued" and "502" in first["last_error"]
    with psycopg.connect(super_dsn, autocommit=True) as c:
        c.execute("UPDATE outbox_messages SET send_after = now() WHERE public_id = %s", (sent["message_id"],))
    await _run(pg_server, fake)
    assert [c["method"] for c in fake.calls] == ["sendRichMessage", "sendDocument", "sendDocument"]
    assert (await _status(tenant, sent["message_id"]))["status"] == "sent"


async def test_rejected_rich_message_falls_back_to_plain_text(
    pg_server: dict[str, Any], tenant: Tenant
) -> None:
    chat = 870_000 + uuid.uuid4().int % 100_000
    st, guardian = await _family(tenant, chat_id=chat)
    doc = await _receipt(tenant, st)
    await ok(await tenant.post(f"/v1/documents/{doc['id']}/send", {"guardian_id": guardian["id"]}), 201)
    fake = FakeTelegram(chat, reject_rich=True)
    await _run(pg_server, fake)
    assert [c["method"] for c in fake.calls] == ["sendRichMessage", "sendMessage", "sendDocument"]
    assert doc["number"] in fake.calls[1]["json"]["text"]


async def test_send_is_refused_without_chat_link_or_consent(tenant: Tenant, tenant_b: Tenant) -> None:
    st, no_chat = await _family(tenant, chat_id=None)
    doc = await _receipt(tenant, st)
    r = await tenant.post(f"/v1/documents/{doc['id']}/send", {"guardian_id": no_chat["id"]})
    assert r.status_code == 409 and "Telegram" in r.json()["error"]["message"]

    st2, unlinked = await _family(tenant, chat_id=5551, linked=False)
    doc2 = await _receipt(tenant, st2)
    r = await tenant.post(f"/v1/documents/{doc2['id']}/send", {"guardian_id": unlinked["id"]})
    assert r.status_code == 409 and "not linked" in r.json()["error"]["message"]

    st3, no_consent = await _family(tenant, chat_id=5552, notify=False)
    doc3 = await _receipt(tenant, st3)
    r = await tenant.post(f"/v1/documents/{doc3['id']}/send", {"guardian_id": no_consent["id"]})
    assert r.status_code == 409 and "consent" in r.json()["error"]["message"]

    # a guardian of ANOTHER student is not linked to this one
    st4, _ = await _family(tenant, chat_id=5553)
    _, other_guardian = await _family(tenant, chat_id=5554)
    doc4 = await _receipt(tenant, st4)
    assert (
        await tenant.post(f"/v1/documents/{doc4['id']}/send", {"guardian_id": other_guardian["id"]})
    ).status_code == 409
    items = (await ok(await tenant.get("/v1/outbox", params={"limit": 200})))["items"]
    assert items == []  # nothing was queued by any refused send

    # another center cannot send this center's document
    assert (
        await tenant_b.post(f"/v1/documents/{doc['id']}/send", {"guardian_id": no_chat["id"]})
    ).status_code == 404


async def test_nothing_is_queued_by_issuing_a_document(tenant: Tenant) -> None:
    chat = 860_000 + uuid.uuid4().int % 100_000
    st, _ = await _family(tenant, chat_id=chat)
    await _receipt(tenant, st)
    assert (await ok(await tenant.get("/v1/outbox", params={"limit": 200})))[
        "items"
    ] == []  # issuing never sends
