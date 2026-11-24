"""Receipts (per payment) and invoices (per student's open debt) as numbered, frozen PDF documents.

Internal documents of the center: no fiscal claim. A document is rendered once from a snapshot and never changes.
Sending one to a guardian is a separate, explicit action (see the send endpoint): nothing leaves without a person.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import Field

from nazoratly.branches import branch_of
from nazoratly.db import Conn, fetch_all, fetch_one, resolve, resolve_opt
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.documents import KIND_LABEL, METHOD_LABEL, Line, Snapshot, delivery_text, render_pdf
from nazoratly.errors import Conflict, NotFound, NothingOwed
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.settings import load_settings
from nazoratly.rules.documents import DocumentKind, document_number
from nazoratly.schemas import Dec2, Model, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["documents"], route_class=IdempotentRoute)
ZERO = Decimal(0)


class ReceiptIn(Model):
    payment_id: uuid.UUID


class InvoiceIn(Model):
    student_id: uuid.UUID
    charge_id: uuid.UUID | None = Field(
        default=None, description="only this charge; default: everything open"
    )


class DocumentOut(Out):
    id: uuid.UUID
    kind: str
    number: str
    issued_on: date
    student_id: uuid.UUID
    student_name: str
    payment_id: uuid.UUID | None
    total: Dec2
    created_at: datetime


class DocumentDetail(DocumentOut):
    snapshot: dict[str, Any]


_DOC_SQL = (
    "SELECT d.public_id AS id, d.kind, d.number, d.issued_on, s.public_id AS student_id, s.full_name AS student_name,"
    " p.public_id AS payment_id, d.total, d.created_at, d.snapshot "
    "FROM documents d JOIN students s ON s.org_id = d.org_id AND s.id = d.student_id "
    "LEFT JOIN payments p ON p.org_id = d.org_id AND p.id = d.payment_id"
)


async def _document(conn: Conn, doc_id: int) -> DocumentDetail:
    row = await fetch_one(conn, f"{_DOC_SQL} WHERE d.id = %s", (doc_id,))
    assert row is not None
    return DocumentDetail.model_validate(row)


async def _header(conn: Conn, org_id: int, branch_id: int | None = None) -> tuple[str, str | None, date]:
    """Center name, the requisites of the branch (else the center's) and today's date in the center's time zone."""
    row = await fetch_one(
        conn,
        "SELECT o.name, (now() AT TIME ZONE o.timezone)::date AS today FROM organizations o WHERE o.id = %s",
        (org_id,),
    )
    assert row is not None
    settings = await load_settings(conn, org_id, branch_id)
    return row["name"], settings.requisites, row["today"]


async def _issue(
    conn: Conn,
    p: Principal,
    *,
    kind: DocumentKind,
    snap: Snapshot,
    student_id: int,
    payment_id: int | None,
) -> int:
    pdf = await asyncio.to_thread(render_pdf, snap)
    row = await fetch_one(
        conn,
        "INSERT INTO documents (org_id, kind, year, serial, number, student_id, payment_id, issued_on, total, snapshot, created_by_user_id) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s) RETURNING id",
        (
            p.org_id,
            kind,
            snap.issued_on.year,
            int(snap.number.rsplit("-", 1)[1]),
            snap.number,
            student_id,
            payment_id,
            snap.issued_on,
            snap.total,
            snap.model_dump_json(),
            p.user_id,
        ),
    )
    assert row is not None
    await conn.execute(
        "INSERT INTO document_files (org_id, document_id, pdf) VALUES (%s, %s, %s)",
        (p.org_id, row["id"], pdf),
    )
    return int(row["id"])


async def _next_number(conn: Conn, kind: DocumentKind, year: int) -> str:
    row = await fetch_one(conn, "SELECT next_document_serial(%s, %s) AS serial", (kind, year))
    assert row is not None
    return document_number(kind, year, int(row["serial"]))


@router.post(
    "/documents/receipts",
    response_model=DocumentDetail,
    status_code=201,
    summary="Issue the receipt of a payment (the same document is returned on a repeat)",
)
async def issue_receipt(
    body: ReceiptIn, response: Response, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> DocumentDetail:
    async with db.tx(p.session()) as conn:
        pid = await resolve(conn, "payments", body.payment_id, what="payment")
        pay = await fetch_one(
            conn,
            "SELECT p.student_id, p.amount, p.method, p.voided_at, gu.full_name AS payer_name,"
            " (p.paid_at AT TIME ZONE o.timezone)::date AS paid_on "
            "FROM payments p JOIN organizations o ON o.id = p.org_id "
            "LEFT JOIN guardians gu ON gu.org_id = p.org_id AND gu.id = p.payer_guardian_id "
            "WHERE p.id = %s FOR UPDATE OF p",
            (pid,),
        )
        assert pay is not None
        if pay["voided_at"] is not None:
            raise Conflict("Payment is voided; no receipt can be issued for it")
        prev = await fetch_one(
            conn, "SELECT id FROM documents WHERE payment_id = %s AND kind = 'receipt'", (pid,)
        )
        if prev is not None:
            response.status_code = 200
            return await _document(conn, prev["id"])
        center, requisites, today = await _header(conn, p.org_id, await branch_of(conn, "payments", pid))
        student = await fetch_one(conn, "SELECT full_name FROM students WHERE id = %s", (pay["student_id"],))
        assert student is not None
        allocs = await fetch_all(
            conn,
            "SELECT c.kind, c.period_month, pa.amount FROM payment_allocations pa "
            "JOIN charges c ON c.org_id = pa.org_id AND c.id = pa.charge_id WHERE pa.payment_id = %s ORDER BY c.due_date, c.id",
            (pid,),
        )
        lines = [
            Line(label=f"{KIND_LABEL[a['kind']]} {a['period_month']:%Y-%m}", amount=a["amount"])
            for a in allocs
        ]
        rest: Decimal = pay["amount"] - sum((a["amount"] for a in allocs), ZERO)
        if rest > 0:
            lines.append(Line(label="Hisobda qoldi (keyingi hisoblar uchun)", amount=rest))
        debt = await fetch_one(
            conn,
            "SELECT outstanding_total FROM v_student_balance WHERE student_id = %s",
            (pay["student_id"],),
        )
        number = await _next_number(conn, "receipt", today.year)
        snap = Snapshot(
            kind="receipt",
            number=number,
            issued_on=today,
            center_name=center,
            requisites=requisites,
            student_name=student["full_name"],
            payer_name=pay["payer_name"],
            method=METHOD_LABEL[pay["method"]],
            paid_on=pay["paid_on"],
            lines=lines,
            total=pay["amount"],
            debt_after=debt["outstanding_total"] if debt else ZERO,
        )
        doc_id = await _issue(
            conn, p, kind="receipt", snap=snap, student_id=pay["student_id"], payment_id=pid
        )
        return await _document(conn, doc_id)


@router.post(
    "/documents/invoices",
    response_model=DocumentDetail,
    status_code=201,
    summary="Issue an invoice (to'lov hisobi) for a student's open debt",
)
async def issue_invoice(
    body: InvoiceIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> DocumentDetail:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", body.student_id, what="student")
        cid = await resolve_opt(conn, "charges", body.charge_id, what="charge")
        center, requisites, today = await _header(conn, p.org_id, await branch_of(conn, "students", sid))
        student = await fetch_one(conn, "SELECT full_name FROM students WHERE id = %s", (sid,))
        assert student is not None
        charges = await fetch_all(
            conn,
            "SELECT b.charge_id, b.kind, b.period_month, b.due_date, b.outstanding FROM v_charge_balance b "
            "WHERE b.student_id = %s AND b.outstanding > 0 AND (%s::bigint IS NULL OR b.charge_id = %s) "
            "ORDER BY b.due_date, b.charge_id",
            (sid, cid, cid),
        )
        lines: list[Line] = []
        for c in charges:
            name = f"{KIND_LABEL[c['kind']]} {c['period_month']:%Y-%m}"
            parts = await fetch_all(
                conn,
                "SELECT seq, due_date, outstanding, (SELECT count(*) FROM charge_installments x WHERE x.charge_id = ib.charge_id) AS n "
                "FROM v_installment_balance ib WHERE ib.charge_id = %s AND ib.outstanding > 0 ORDER BY seq",
                (c["charge_id"],),
            )
            if parts:
                lines += [
                    Line(
                        label=f"{name}, {r['seq']}/{r['n']}-to'lov",
                        due_date=r["due_date"],
                        amount=r["outstanding"],
                        overdue=r["due_date"] < today,
                    )
                    for r in parts
                ]
            else:
                lines.append(
                    Line(
                        label=name,
                        due_date=c["due_date"],
                        amount=c["outstanding"],
                        overdue=c["due_date"] < today,
                    )
                )
        if not lines:
            raise NothingOwed("The student owes nothing: there is nothing to invoice")
        number = await _next_number(conn, "invoice", today.year)
        snap = Snapshot(
            kind="invoice",
            number=number,
            issued_on=today,
            center_name=center,
            requisites=requisites,
            student_name=student["full_name"],
            lines=lines,
            total=sum((line.amount for line in lines), ZERO),
        )
        doc_id = await _issue(conn, p, kind="invoice", snap=snap, student_id=sid, payment_id=None)
        return await _document(conn, doc_id)


@router.get("/documents", response_model=Page[DocumentOut])
async def list_documents(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    pg: Paging,
    student_id: uuid.UUID | None = None,
    kind: Literal["receipt", "invoice"] | None = None,
) -> Page[DocumentOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_DOC_SQL} WHERE (%s::uuid IS NULL OR s.public_id = %s) AND (%s::text IS NULL OR d.kind = %s) "
            "ORDER BY d.created_at DESC, d.id DESC LIMIT %s OFFSET %s",
            (student_id, student_id, kind, kind, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, DocumentOut)


@router.get("/documents/{document_id}", response_model=DocumentDetail)
async def get_document(
    document_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> DocumentDetail:
    async with db.tx(p.session()) as conn:
        return await _document(conn, await resolve(conn, "documents", document_id, what="document"))


@router.get(
    "/documents/{document_id}/pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
    summary="The PDF file of the document",
)
async def get_document_pdf(
    document_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> Response:
    async with db.tx(p.session()) as conn:
        did = await resolve(conn, "documents", document_id, what="document")
        row = await fetch_one(
            conn,
            "SELECT d.number, f.pdf FROM documents d JOIN document_files f ON f.org_id = d.org_id AND f.document_id = d.id WHERE d.id = %s",
            (did,),
        )
    if row is None:
        raise NotFound("document file not found")
    return Response(
        content=bytes(row["pdf"]),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{row["number"]}.pdf"'},
    )


class SendIn(Model):
    guardian_id: uuid.UUID


class SendOut(Out):
    message_id: uuid.UUID
    document_id: uuid.UUID
    guardian_id: uuid.UUID
    status: str


@router.post(
    "/documents/{document_id}/send",
    response_model=SendOut,
    status_code=201,
    summary="Approve and queue the document for a guardian's Telegram (rich message plus the PDF)",
)
async def send_document(
    document_id: uuid.UUID,
    body: SendIn,
    response: Response,
    p: Annotated[Principal, Depends(require("finance:write"))],
    db: DB,
) -> SendOut:
    """This call IS the approval: a signed-in person decides to send this document to this guardian. The guardian must
    be linked to the student, receive reminders and the student must have an active notifications consent."""
    async with db.tx(p.session()) as conn:
        did = await resolve(conn, "documents", document_id, what="document")
        gid = await resolve(conn, "guardians", body.guardian_id, what="guardian")
        doc = await fetch_one(conn, "SELECT student_id, snapshot FROM documents WHERE id = %s", (did,))
        guardian = await fetch_one(conn, "SELECT telegram_chat_id FROM guardians WHERE id = %s", (gid,))
        assert doc is not None and guardian is not None
        key = f"doc-{document_id}-{body.guardian_id}"
        prev = await fetch_one(
            conn, "SELECT public_id, status FROM outbox_messages WHERE idempotency_key = %s", (key,)
        )
        if prev is not None:  # approved before: never a second message
            response.status_code = 200
            return SendOut(
                message_id=prev["public_id"],
                document_id=document_id,
                guardian_id=body.guardian_id,
                status=prev["status"],
            )
        if guardian["telegram_chat_id"] is None:
            raise Conflict("Guardian has not linked the Telegram bot yet")
        linked = await fetch_one(
            conn,
            "SELECT 1 AS x FROM student_guardians WHERE student_id = %s AND guardian_id = %s AND receives_reminders",
            (doc["student_id"], gid),
        )
        if linked is None:
            raise Conflict("Guardian is not linked to this student or does not receive messages")
        consent = await fetch_one(
            conn,
            "SELECT 1 AS x FROM data_consents WHERE student_id = %s AND purpose = 'notifications' AND revoked_at IS NULL",
            (doc["student_id"],),
        )
        if consent is None:
            raise Conflict("The student has no active consent for notifications")
        plain, rich = delivery_text(Snapshot.model_validate(doc["snapshot"]))
        row = await fetch_one(
            conn,
            "INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, body_html, document_id, idempotency_key) "
            "VALUES (%s, %s, %s, 'telegram', %s, %s, %s, %s) RETURNING public_id, status",
            (p.org_id, doc["student_id"], gid, plain, rich, did, key),
        )
        assert row is not None
    return SendOut(
        message_id=row["public_id"],
        document_id=document_id,
        guardian_id=body.guardian_id,
        status=row["status"],
    )
