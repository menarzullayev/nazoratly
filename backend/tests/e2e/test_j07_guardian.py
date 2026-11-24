"""Journey 7: the guardian cabinet. Four ways to link a guardian (one-time code, phone contact, student QR card, manual), the
consent gate, and the three guardian actions (absence reason, payment promise, make-up choice): every one waits for the
center, changes nothing before the decision, and nothing is pushed to the guardian when the center decides (Model B)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx

from tests.conftest import Tenant
from tests.e2e.journeys import TODAY
from tests.helpers import mk_course, ok
from tests.test_guardian import (  # noqa: F401  (tg is a fixture)
    FakeBot,
    contact,
    debt,
    family,
    hook,
    lessons_group,
    makeup_setup,
    mark_of,
    msg,
    outbox_count,
    sign_in,
    tg,
)


async def accept_consent(client: httpx.AsyncClient, headers: dict[str, str], student_id: str) -> None:
    await ok(await client.post(f"/v1/cabinet/students/{student_id}/consent", headers=headers))


async def test_four_links_consent_gate_and_requests_wait_for_the_center(
    client: httpx.AsyncClient, tenant: Tenant, tg: FakeBot, super_dsn: str
) -> None:
    t = tenant
    course = await mk_course(t)
    group = await lessons_group(t, course["id"])

    # ---- 1. a one-time code: linked at once, but consent comes first
    f_code = await family(t, link=False, accepted=False, group=group)
    code = (await ok(await t.post("/v1/guardian/codes", {"student_id": f_code.student["id"], "relation": "father"}), 201))["code"]
    await hook(client, msg(f_code.chat, f"/start {code}"))
    # ---- 2. the phone: only Telegram's own contact card vouches for the number
    f_phone = await family(t, link=False, accepted=False, group=group)
    await ok(await t.post(f"/v1/students/{f_phone.student['id']}/guardians", {"guardian_id": f_phone.guardian["id"], "relation": "mother"}), 201)
    await hook(client, contact(f_phone.chat, f_phone.guardian["phone"]))
    # ---- 3. the student's QR card: the center must confirm because the card can be photographed
    f_qr = await family(t, link=False, accepted=False, group=group)
    qr = (await ok(await t.post(f"/v1/students/{f_qr.student['id']}/qr", {})))["code"]
    await hook(client, msg(f_qr.chat, qr))
    assert await ok(await t.get("/v1/guardian/links", params={"student_id": f_qr.student["id"]})) == []
    pending = await ok(await t.get("/v1/guardian/link-requests"))
    assert [p["student_id"] for p in pending] == [f_qr.student["id"]]
    await ok(await t.post(f"/v1/guardian/link-requests/{pending[0]['id']}/approve", {"relation": "mother"}))
    # ---- 4. manual: the center links the guardian itself
    f_manual = await family(t, link=True, accepted=False, group=group)

    families = {"code": f_code, "phone": f_phone, "qr": f_qr, "manual": f_manual}
    via = {}
    for name, fam in families.items():
        (link,) = await ok(await t.get("/v1/guardian/links", params={"student_id": fam.student["id"]}))
        assert link["telegram_linked"] is True
        via[name] = link["linked_via"]
    assert via == {"code": "code", "phone": "phone", "qr": "qr", "manual": "manual"}

    # ---- consent gate: nothing is visible before the guardian accepts, everything after
    heads: dict[str, dict[str, str]] = {}
    for name, fam in families.items():
        heads[name] = await sign_in(client, fam.chat)
        sid = fam.student["id"]
        gate = await client.get(f"/v1/cabinet/students/{sid}/attendance", headers=heads[name])
        assert gate.status_code == 403 and gate.json()["error"]["details"]["reason"] == "consent_required"
        await accept_consent(client, heads[name], sid)
        assert (await client.get(f"/v1/cabinet/students/{sid}/attendance", headers=heads[name])).status_code == 200

    # ---- a guardian never reaches another family's student
    mine, theirs = heads["code"], f_phone.student["id"]
    for part in ("attendance", "balance", "schedule", "results", "documents"):
        assert (await client.get(f"/v1/cabinet/students/{theirs}/{part}", headers=mine)).status_code in (403, 404), part
    assert (await client.get("/v1/cabinet/me")).status_code == 401  # and nobody without a session

    # ---- requests: absence reason (code family), payment promise (phone family), make-up (a fresh set-up)
    assert outbox_count(super_dsn, t.org_id) == 0
    lesson = (await ok(await client.get(f"/v1/cabinet/students/{f_code.student['id']}/absence-lessons", headers=heads["code"])))[0]
    absence = await ok(
        await client.post("/v1/cabinet/requests", headers=heads["code"], json={"kind": "absence_reason", "student_id": f_code.student["id"], "lesson_id": lesson["id"], "reason": "Kasal bo'ldi"}),
        201,
    )
    await debt(t, f_phone.student, "600000", due=2)
    promise = await ok(
        await client.post(
            "/v1/cabinet/requests",
            headers=heads["phone"],
            json={"kind": "payment_promise", "student_id": f_phone.student["id"], "promise_date": (TODAY + timedelta(days=3)).isoformat(), "amount": "250000"},
        ),
        201,
    )
    fam_m, _home, _other, h_m = await makeup_setup(t, client)
    await accept_consent(client, h_m, fam_m.student["id"])
    right = (await ok(await client.get(f"/v1/cabinet/students/{fam_m.student['id']}/makeup", headers=h_m)))[0]
    choice = await ok(
        await client.post(
            "/v1/cabinet/requests",
            headers=h_m,
            json={"kind": "makeup_choice", "student_id": fam_m.student["id"], "entitlement_id": right["id"], "slot_lesson_id": right["slots"][0]["lesson_id"]},
        ),
        201,
    )

    # nothing has changed anywhere: no mark, no promise on the books, no lesson scheduled, nothing queued
    assert await mark_of(t, lesson, f_code.student["id"]) is None
    bal = await ok(await client.get(f"/v1/cabinet/students/{f_phone.student['id']}/balance", headers=heads["phone"]))
    assert bal["promises"][0]["state"] == "pending"
    ent = (await ok(await t.get("/v1/entitlements", params={"student_id": fam_m.student["id"]})))["items"][0]
    assert ent["status"] == "open"
    inbox = await ok(await t.get("/v1/guardian/requests"))
    assert {r["id"] for r in inbox} == {absence["id"], promise["id"], choice["id"]}
    assert outbox_count(super_dsn, t.org_id) == 0

    # a teacher-level staff member cannot decide; the owner approves two and rejects one
    bot_calls = len(tg.calls)
    await ok(await t.post(f"/v1/guardian/requests/{absence['id']}/approve", {"note": "Tuzalsin"}))
    await ok(await t.post(f"/v1/guardian/requests/{promise['id']}/reject", {"note": "Sana mos emas"}))
    await ok(await t.post(f"/v1/guardian/requests/{choice['id']}/approve", {}))
    assert await mark_of(t, lesson, f_code.student["id"]) == "excused"
    bal = await ok(await client.get(f"/v1/cabinet/students/{f_phone.student['id']}/balance", headers=heads["phone"]))
    assert bal["promises"] == [] or bal["promises"][0]["state"] != "active"
    ent = (await ok(await t.get("/v1/entitlements", params={"student_id": fam_m.student["id"]})))["items"][0]
    assert ent["status"] == "scheduled"
    # the guardians read the verdicts themselves; no push message was produced by the decisions
    mine_reqs = await ok(await client.get("/v1/cabinet/requests", headers=heads["code"]))
    assert mine_reqs[0]["status"] == "approved" and mine_reqs[0]["decision_note"] == "Tuzalsin"
    assert (await ok(await client.get("/v1/cabinet/requests", headers=heads["phone"])))[0]["status"] == "rejected"
    assert len(tg.calls) == bot_calls and outbox_count(super_dsn, t.org_id) == 0
    for rid in (absence["id"], promise["id"], choice["id"]):
        assert (await t.post(f"/v1/guardian/requests/{rid}/approve", {})).status_code == 409  # a decision is final

    # ---- unlinking ends the guardian's session at once (the guardian record made by the code link is the one to unlink)
    (link,) = await ok(await t.get("/v1/guardian/links", params={"student_id": f_code.student["id"]}))
    gone = await t.delete("/v1/guardian/links", params={"student_id": f_code.student["id"], "guardian_id": link["guardian_id"]})
    assert gone.status_code == 204
    assert (await client.get("/v1/cabinet/me", headers=heads["code"])).status_code == 401
