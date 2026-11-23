"""PDF receipts and invoices: numbering, content, immutability, isolation."""

from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime
from io import BytesIO
from typing import Any

from pypdf import PdfReader

from nazoratly.rules.documents import FOOTER
from tests.conftest import Tenant
from tests.helpers import mk_student, ok
from tests.test_plans import charge, d, pay, put_plan

TODAY = datetime.now(UTC).date()


def pdf_text(data: bytes) -> str:
    reader = PdfReader(BytesIO(data))
    return " ".join(" ".join(page.extract_text().split()) for page in reader.pages)


async def pdf_of(t: Tenant, doc_id: str) -> bytes:
    r = await t.get(f"/v1/documents/{doc_id}/pdf")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    return r.content


async def set_requisites(t: Tenant, text: str = "Toshkent sh., Chilonzor 9\nTel: +998 90 123 45 67") -> None:
    await ok(await t.patch("/v1/settings", {"requisites": text}))


async def test_receipt_carries_center_requisites_number_and_no_fiscal_claim(tenant: Tenant) -> None:
    await set_requisites(tenant)
    st = await mk_student(tenant, "Aliyev Vali")
    ch = await charge(tenant, st["id"], "900000", due=-5)
    await ok(await put_plan(tenant, ch["id"], [("300000", -5), ("300000", 20), ("300000", 50)]))
    payment = await pay(tenant, st["id"], "350000")
    doc = await ok(await tenant.post("/v1/documents/receipts", {"payment_id": payment["id"]}), 201)
    assert re.fullmatch(r"KV-\d{4}-000001", doc["number"]) and doc["kind"] == "receipt"
    assert (doc["total"], doc["payment_id"], doc["student_name"]) == (
        "350000.00",
        payment["id"],
        "Aliyev Vali",
    )
    text = pdf_text(await pdf_of(tenant, doc["id"]))
    center = (await ok(await tenant.get("/v1/organization")))["name"]
    for needle in (
        center,
        "Toshkent sh., Chilonzor 9",
        "+998 90 123 45 67",
        "KVITANSIYA",
        doc["number"],
        "Aliyev Vali",
        "350 000",
        "Qolgan qarz: 550 000",
        FOOTER,
    ):
        assert needle in text, needle
    assert "QQS" not in text and "STIR" not in text  # no tax words: the document makes no fiscal claim
    r = await tenant.get(f"/v1/documents/{doc['id']}/pdf")
    assert r.headers["content-disposition"] == f'attachment; filename="{doc["number"]}.pdf"'
    assert r.content.startswith(b"%PDF")


async def test_cyrillic_and_uzbek_apostrophes_render(tenant: Tenant) -> None:
    await set_requisites(tenant, "Ғулом Мирзо кўчаси 5\noʻqish markazi")
    st = await mk_student(tenant, "Ғуломов Жасур Oʻktam oʻgʻli")
    await charge(tenant, st["id"], "100000", due=-1)
    doc = await ok(await tenant.post("/v1/documents/invoices", {"student_id": st["id"]}), 201)
    text = pdf_text(await pdf_of(tenant, doc["id"]))
    for needle in ("Ғуломов Жасур Oʻktam oʻgʻli", "Ғулом Мирзо кўчаси 5", "oʻqish markazi"):
        assert needle in text, needle


async def test_receipt_is_issued_once_per_payment_and_voided_payment_is_refused(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    await charge(tenant, st["id"], "400000", due=-1)
    payment = await pay(tenant, st["id"], "100000")
    first = await ok(await tenant.post("/v1/documents/receipts", {"payment_id": payment["id"]}), 201)
    again = await tenant.post("/v1/documents/receipts", {"payment_id": payment["id"]})
    assert again.status_code == 200 and again.json()["id"] == first["id"]
    other = await pay(tenant, st["id"], "50000")
    await ok(await tenant.post(f"/v1/payments/{other['id']}/void", {"reason": "entered by mistake"}))
    refused = await tenant.post("/v1/documents/receipts", {"payment_id": other["id"]})
    assert refused.status_code == 409
    # an unallocated remainder is shown as its own line
    st2 = await mk_student(tenant)
    big = await pay(tenant, st2["id"], "70000")
    doc = await ok(await tenant.post("/v1/documents/receipts", {"payment_id": big["id"]}), 201)
    assert [line["label"] for line in doc["snapshot"]["lines"]] == ["Hisobda qoldi (keyingi hisoblar uchun)"]
    assert doc["total"] == "70000.00"


async def test_invoice_lists_open_installments_and_only_what_is_still_owed(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    planned = await charge(tenant, st["id"], "900000", due=-40)
    await ok(await put_plan(tenant, planned["id"], [("300000", -40), ("300000", -10), ("300000", 20)]))
    plain = await charge(tenant, st["id"], "200000", due=3)
    await pay(tenant, st["id"], "450000")
    doc = await ok(await tenant.post("/v1/documents/invoices", {"student_id": st["id"]}), 201)
    lines = doc["snapshot"]["lines"]
    assert [(line["amount"], line["due_date"], line["overdue"]) for line in lines] == [
        ("150000.00", d(-10), True),
        ("300000.00", d(20), False),
        ("200000.00", d(3), False),
    ]
    assert "2/3-to'lov" in lines[0]["label"] and "3/3-to'lov" in lines[1]["label"]
    assert doc["total"] == "650000.00" and re.fullmatch(r"TH-\d{4}-000001", doc["number"])
    text = pdf_text(await pdf_of(tenant, doc["id"]))
    assert "TO'LOV HISOBI" in text and "650 000" in text and "muddati o'tgan" in text
    only = await ok(
        await tenant.post("/v1/documents/invoices", {"student_id": st["id"], "charge_id": plain["id"]}), 201
    )
    assert only["total"] == "200000.00" and only["number"].endswith("000002")


async def test_invoice_with_nothing_owed_is_refused(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    r = await tenant.post("/v1/documents/invoices", {"student_id": st["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "nothing_owed"
    ch = await charge(tenant, st["id"], "100000", due=-1)
    await pay(tenant, st["id"], "100000")
    assert ch["id"]
    assert (await tenant.post("/v1/documents/invoices", {"student_id": st["id"]})).status_code == 409


async def test_numbers_are_unique_gapless_per_kind_under_concurrency(tenant: Tenant) -> None:
    st = await mk_student(tenant)
    await charge(tenant, st["id"], "500000", due=-1)
    docs = await asyncio.gather(
        *[tenant.post("/v1/documents/invoices", {"student_id": st["id"]}) for _ in range(20)]
    )
    assert all(r.status_code == 201 for r in docs), [r.text for r in docs if r.status_code != 201]
    serials = sorted(int(r.json()["number"].rsplit("-", 1)[1]) for r in docs)
    assert serials == list(range(1, 21))
    payment = await pay(tenant, st["id"], "10000")
    receipt = await ok(await tenant.post("/v1/documents/receipts", {"payment_id": payment["id"]}), 201)
    assert receipt["number"].endswith("-000001")  # receipts count on their own


async def test_issued_document_never_changes(tenant: Tenant) -> None:
    await set_requisites(tenant, "Old address 1")
    st = await mk_student(tenant, "Frozen Student")
    await charge(tenant, st["id"], "100000", due=-1)
    doc = await ok(await tenant.post("/v1/documents/invoices", {"student_id": st["id"]}), 201)
    before = await pdf_of(tenant, doc["id"])
    await set_requisites(tenant, "New address 2")
    await ok(await tenant.patch(f"/v1/students/{st['id']}", {"full_name": "Renamed Student"}))
    again = await ok(await tenant.get(f"/v1/documents/{doc['id']}"))
    assert (
        again["snapshot"]["requisites"] == "Old address 1"
        and again["snapshot"]["student_name"] == "Frozen Student"
    )
    assert await pdf_of(tenant, doc["id"]) == before
    listed = (
        await ok(await tenant.get("/v1/documents", params={"student_id": st["id"], "kind": "invoice"}))
    )["items"]
    assert [x["id"] for x in listed] == [doc["id"]]
    assert (await tenant.get("/v1/documents", params={"kind": "receipt", "student_id": st["id"]})).json()[
        "items"
    ] == []
    for method in (tenant.patch, tenant.put):
        assert (await method(f"/v1/documents/{doc['id']}", {"total": "1"})).status_code in (404, 405)
    assert (await tenant.delete(f"/v1/documents/{doc['id']}")).status_code in (404, 405)


async def test_foreign_tenant_and_idempotent_replay(tenant: Tenant, tenant_b: Tenant) -> None:
    st = await mk_student(tenant)
    await charge(tenant, st["id"], "100000", due=-1)
    key = {"Idempotency-Key": "invoice-replay-0001"}
    first = await tenant.post("/v1/documents/invoices", {"student_id": st["id"]}, headers=key)
    replay = await tenant.post("/v1/documents/invoices", {"student_id": st["id"]}, headers=key)
    assert first.status_code == replay.status_code == 201
    assert first.json()["number"] == replay.json()["number"]
    assert replay.headers.get("Idempotent-Replayed") == "true"
    doc_id: Any = first.json()["id"]
    assert (await tenant_b.get(f"/v1/documents/{doc_id}")).status_code == 404
    assert (await tenant_b.get(f"/v1/documents/{doc_id}/pdf")).status_code == 404
    assert (await tenant_b.post("/v1/documents/invoices", {"student_id": st["id"]})).status_code == 404
    other = await pay(tenant, st["id"], "1000")
    assert (await tenant_b.post("/v1/documents/receipts", {"payment_id": other["id"]})).status_code == 404
    assert (await tenant_b.get("/v1/documents")).json()["items"] == []
