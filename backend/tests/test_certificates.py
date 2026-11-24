"""Certificates: eligibility, numbering, PDF, void, public verification (masked), delivery after approval."""

from __future__ import annotations

import re
import uuid
from typing import Any

import httpx

from nazoratly.rules import results as R
from tests.conftest import Tenant
from tests.helpers import consent, enroll, mk_group, mk_student, mk_teacher, ok, org_today
from tests.test_document_delivery import FakeTelegram, _family, _run
from tests.test_documents import pdf_text
from tests.test_results import staff

YEAR = org_today().year


async def finished(
    t: Tenant, name: str = "Ғуломов Жасур", **group: Any
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """(group, student, enrollment) with a finished enrollment."""
    grp = await mk_group(t, **group)
    st = await mk_student(t, name)
    e = await enroll(t, grp["id"], st["id"], "2026-01-10")
    e = await ok(await t.patch(f"/v1/enrollments/{e['id']}", {"status": "finished"}))
    return grp, st, e


async def issue(t: Tenant, enrollment: dict[str, Any], **kw: Any) -> httpx.Response:
    return await t.post("/v1/certificates", {"enrollment_id": enrollment["id"], **kw})


async def test_issue_number_code_and_pdf(tenant: Tenant) -> None:
    grp, st, e = await finished(tenant)
    cert = await ok(await issue(tenant, e), 201)
    assert re.fullmatch(rf"SR-{YEAR}-000001", cert["number"])
    assert R.parse_certificate_code(cert["code"]) == cert["code"] and cert["code"].startswith("NZC-")
    assert (cert["student_id"], cert["enrollment_id"], cert["group_id"]) == (st["id"], e["id"], grp["id"])
    assert (
        cert["completed_on"] == e["ended_on"]
        and cert["issued_on"] == org_today().isoformat()
        and cert["voided_at"] is None
    )
    pdf = await tenant.get(f"/v1/certificates/{cert['id']}/pdf")
    assert (
        pdf.status_code == 200
        and pdf.headers["content-type"] == "application/pdf"
        and pdf.content.startswith(b"%PDF")
    )
    assert pdf.headers["content-disposition"] == f'attachment; filename="{cert["number"]}.pdf"'
    text = pdf_text(pdf.content)
    center = (await ok(await tenant.get("/v1/organization")))["name"]
    for needle in (
        center,
        "SERTIFIKAT",
        cert["number"],
        "Ғуломов Жасур",
        cert["course_name"],
        cert["code"],
        grp["name"],
    ):
        assert needle in text, needle
    # one live certificate per enrollment: the same one comes back
    again = await issue(tenant, e)
    assert (
        again.status_code == 200 and again.json()["id"] == cert["id"] and again.json()["code"] == cert["code"]
    )
    # the next enrollment gets the next number and another code
    _, _, e2 = await finished(tenant, "Ali Valiyev")
    second = await ok(await issue(tenant, e2), 201)
    assert second["number"] == f"SR-{YEAR}-000002" and second["code"] != cert["code"]
    got = await ok(await tenant.get(f"/v1/certificates/{cert['id']}"))
    assert got["code"] == cert["code"]
    listing = (await ok(await tenant.get("/v1/certificates")))["items"]
    assert [c["number"] for c in listing] == [second["number"], cert["number"]]
    assert [
        c["id"]
        for c in (await ok(await tenant.get("/v1/certificates", params={"student_id": st["id"]})))["items"]
    ] == [cert["id"]]
    on_card = await ok(await tenant.get(f"/v1/students/{st['id']}/results"))
    assert [c["number"] for c in on_card["certificates"]] == [cert["number"]]


async def test_numbers_are_per_center(tenant: Tenant, tenant_b: Tenant) -> None:
    _, _, ea = await finished(tenant)
    _, _, eb = await finished(tenant_b)
    a = await ok(await issue(tenant, ea), 201)
    b = await ok(await issue(tenant_b, eb), 201)
    assert a["number"].endswith("-000001") and b["number"].endswith("-000001") and a["code"] != b["code"]
    for path in ("", "/pdf"):
        assert (await tenant_b.get(f"/v1/certificates/{a['id']}{path}")).status_code == 404
    assert (await tenant_b.post(f"/v1/certificates/{a['id']}/void", {"reason": "x"})).status_code == 404
    assert (await tenant_b.post("/v1/certificates", {"enrollment_id": ea["id"]})).status_code == 404
    assert (await ok(await tenant_b.get("/v1/certificates")))["items"][0]["id"] == b["id"]


async def test_eligibility_follows_the_course_state(tenant: Tenant) -> None:
    grp = await mk_group(tenant)
    active, trial, frozen, done = [await mk_student(tenant, f"Pupil {i}") for i in range(4)]
    ea = await enroll(tenant, grp["id"], active["id"], "2026-01-10")
    et = await enroll(tenant, grp["id"], trial["id"], "2026-01-10", status="trial")
    ef = await enroll(tenant, grp["id"], frozen["id"], "2026-01-10")
    await ok(await tenant.patch(f"/v1/enrollments/{ef['id']}", {"status": "frozen"}))
    ed = await enroll(tenant, grp["id"], done["id"], "2026-01-10")
    # nobody has finished anything yet
    for e in (ea, et, ef, ed):
        r = await issue(tenant, e)
        assert r.status_code == 409 and "completed course" in r.json()["error"]["message"]
    # the group finishes: active students qualify, trial and frozen ones never do
    await ok(await tenant.patch(f"/v1/groups/{grp['id']}", {"status": "finished"}))
    assert (await issue(tenant, ea)).status_code == 201
    assert (await issue(tenant, et)).status_code == 409
    assert (await issue(tenant, ef)).status_code == 409
    # a finished enrollment qualifies in an active group too
    other, _, eo = await finished(tenant)
    assert (await issue(tenant, eo)).status_code == 201 and other["status"] != "finished"
    assert (await tenant.post("/v1/certificates", {"enrollment_id": str(uuid.uuid4())})).status_code == 404


async def test_completion_date_rules(tenant: Tenant) -> None:
    _, _, e = await finished(tenant)
    assert (
        await issue(tenant, e, completed_on="2026-01-09")
    ).status_code == 422  # before the enrollment started
    future = org_today().replace(year=org_today().year + 1).isoformat()
    assert (await issue(tenant, e, completed_on=future)).status_code == 422
    assert (await issue(tenant, e, completed_on="not-a-date")).status_code == 422
    assert (await tenant.post("/v1/certificates", {"enrollment_id": e["id"], "extra": 1})).status_code == 422
    cert = await ok(await issue(tenant, e, completed_on="2026-06-30"), 201)
    assert cert["completed_on"] == "2026-06-30"


async def test_void_and_reissue(tenant: Tenant) -> None:
    _, _, e = await finished(tenant)
    cert = await ok(await issue(tenant, e), 201)
    assert (await tenant.post(f"/v1/certificates/{cert['id']}/void", {"reason": "  "})).status_code == 422
    assert (await tenant.post(f"/v1/certificates/{cert['id']}/void", {})).status_code == 422
    voided = await ok(
        await tenant.post(f"/v1/certificates/{cert['id']}/void", {"reason": "Ism xato yozilgan"})
    )
    assert voided["voided_at"] and voided["void_reason"] == "Ism xato yozilgan"
    assert (await tenant.post(f"/v1/certificates/{cert['id']}/void", {"reason": "again"})).status_code == 409
    assert (await ok(await tenant.get("/v1/certificates")))["items"] == []
    assert (
        len((await ok(await tenant.get("/v1/certificates", params={"include_voided": "true"})))["items"]) == 1
    )
    v = await ok(await tenant.get(f"/v1/verify/certificate/{cert['code']}"))
    assert v["valid"] is False and v["status"] == "voided"
    # a corrected certificate: new number and code, the old code stays voided
    new = await ok(await issue(tenant, e), 201)
    assert new["id"] != cert["id"] and new["code"] != cert["code"] and new["number"].endswith("-000002")
    assert (await ok(await tenant.get(f"/v1/verify/certificate/{new['code']}")))["valid"] is True
    assert (await ok(await tenant.get(f"/v1/verify/certificate/{cert['code']}")))["status"] == "voided"
    guardian = await ok(
        await tenant.post("/v1/guardians", {"full_name": "G", "telegram_chat_id": 5_550_001}), 201
    )
    assert (
        await tenant.post(f"/v1/certificates/{cert['id']}/send", {"guardian_id": guardian["id"]})
    ).status_code == 409


async def test_public_verification_masks_the_name_and_needs_no_login(
    client: httpx.AsyncClient, tenant: Tenant
) -> None:
    grp, st, e = await finished(tenant, "Valiyev Ali Karimovich")
    cert = await ok(await issue(tenant, e), 201)
    anon = await client.get(f"/v1/verify/certificate/{cert['code']}")  # no Authorization header
    v = await ok(anon)
    assert v["valid"] is True and v["status"] == "valid" and v["number"] == cert["number"]
    assert v["holder"] == "V****** A** K*********" and v["course"] == cert["course_name"]
    assert v["completed_on"] == cert["completed_on"] and v["center"]
    raw = anon.text
    assert "Valiyev" not in raw and "Karimovich" not in raw and st["id"] not in raw and cert["id"] not in raw
    # forgiving about how the code was typed
    typed = cert["code"].lower().replace("-", " ")
    assert (await ok(await client.get("/v1/verify/certificate/" + typed.replace(" ", "%20"))))[
        "number"
    ] == cert["number"]
    # anything that is not a real code is just "not found"
    for bad in ("NZC-AAAA-AAAA-AAAA", "NZC-ABCD-EFGH", "hello", "NZC-ABCD-EFGH-JKLI"):
        r = await client.get(f"/v1/verify/certificate/{bad}")
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert grp["name"] not in raw


async def test_certificate_is_sent_only_after_approval(pg_server: dict[str, Any], tenant: Tenant) -> None:
    chat = 710_000 + uuid.uuid4().int % 100_000
    st, guardian = await _family(tenant, chat_id=chat)
    grp = await mk_group(tenant)
    e = await enroll(tenant, grp["id"], st["id"], "2026-01-10")
    e = await ok(await tenant.patch(f"/v1/enrollments/{e['id']}", {"status": "finished"}))
    cert = await ok(await issue(tenant, e), 201)
    fake = FakeTelegram(chat)
    await _run(pg_server, fake)
    assert fake.calls == []  # issuing sends nothing
    sent = await ok(
        await tenant.post(f"/v1/certificates/{cert['id']}/send", {"guardian_id": guardian["id"]}), 201
    )
    again = await tenant.post(f"/v1/certificates/{cert['id']}/send", {"guardian_id": guardian["id"]})
    assert again.status_code == 200 and again.json()["message_id"] == sent["message_id"]
    await _run(pg_server, fake)
    assert [c["method"] for c in fake.calls] == ["sendMessage", "sendDocument"]
    text = fake.calls[0]["json"]["text"]
    assert cert["code"] in text and cert["number"] in text and st["full_name"] in text
    stored = (await tenant.get(f"/v1/certificates/{cert['id']}/pdf")).content
    assert (
        stored in fake.calls[1]["file"]
        and f'filename="{cert["number"]}.pdf"'.encode() in fake.calls[1]["file"]
    )


async def test_send_rules(tenant: Tenant) -> None:
    async def cert_for(**family: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        st, g = await _family(tenant, **family)
        grp = await mk_group(tenant)
        e = await enroll(tenant, grp["id"], st["id"], "2026-01-10")
        e = await ok(await tenant.patch(f"/v1/enrollments/{e['id']}", {"status": "finished"}))
        return await ok(await issue(tenant, e), 201), g

    c, g = await cert_for(chat_id=None)
    r = await tenant.post(f"/v1/certificates/{c['id']}/send", {"guardian_id": g["id"]})
    assert r.status_code == 409 and "Telegram" in r.json()["error"]["message"]
    c, g = await cert_for(chat_id=720_001, linked=False)
    r = await tenant.post(f"/v1/certificates/{c['id']}/send", {"guardian_id": g["id"]})
    assert r.status_code == 409 and "not linked" in r.json()["error"]["message"]
    c, g = await cert_for(chat_id=720_002, notify=False)
    r = await tenant.post(f"/v1/certificates/{c['id']}/send", {"guardian_id": g["id"]})
    assert r.status_code == 409 and "consent" in r.json()["error"]["message"]


async def test_permissions(client: httpx.AsyncClient, tenant: Tenant) -> None:
    grp, st, e = await finished(tenant)
    viewer, _ = await staff(client, tenant, "viewer")
    assert (await issue(viewer, e)).status_code == 403
    manager, _ = await staff(client, tenant, "manager")
    cert = await ok(await issue(manager, e), 201)  # managers approve results
    assert (await viewer.get(f"/v1/certificates/{cert['id']}")).status_code == 200
    assert (await viewer.post(f"/v1/certificates/{cert['id']}/void", {"reason": "x"})).status_code == 403
    teacher, member = await staff(client, tenant, "teacher")
    prof = await mk_teacher(tenant, staff_id=member["id"])
    assert (await teacher.get(f"/v1/certificates/{cert['id']}")).status_code == 403  # not their group yet
    await ok(await tenant.patch(f"/v1/groups/{grp['id']}", {"teacher_id": prof["id"]}))
    assert (await teacher.get(f"/v1/certificates/{cert['id']}")).status_code == 200
    assert [c["id"] for c in (await ok(await teacher.get("/v1/certificates")))["items"]] == [cert["id"]]
    assert (await teacher.post(f"/v1/certificates/{cert['id']}/void", {"reason": "x"})).status_code == 403
    guardian = await ok(await tenant.post("/v1/guardians", {"full_name": "G", "phone": "+998901117777"}), 201)
    assert (
        await teacher.post(f"/v1/certificates/{cert['id']}/send", {"guardian_id": guardian["id"]})
    ).status_code == 403
    await consent(tenant, st["id"], "notifications")


async def test_certificate_rows_are_frozen_in_the_database(super_dsn: str, tenant: Tenant) -> None:
    import psycopg

    _, _, e = await finished(tenant)
    cert = await ok(await issue(tenant, e), 201)
    with psycopg.connect(super_dsn, autocommit=True) as c:
        for stmt in (
            "UPDATE certificates SET number = 'X' WHERE public_id = %s",
            "DELETE FROM certificates WHERE public_id = %s",
        ):
            try:
                c.execute(stmt, (cert["id"],))  # type: ignore[call-overload]
            except psycopg.errors.CheckViolation:
                continue
            raise AssertionError(f"{stmt} must be refused")
