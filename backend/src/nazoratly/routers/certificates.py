"""Course-completion certificates (PDF) with a verification code.

A certificate is numbered per center and year, exists once per enrollment (a voided one may be replaced), is frozen when
issued and can only be voided with a reason. Issuing is an act of a person with `results:approve`; sending it to a
guardian is a separate approving call (nothing leaves without a person). `GET /v1/verify/certificate/{code}` is public:
anybody holding a code may check it, and the holder's name is masked."""

from __future__ import annotations

import asyncio
import secrets
import uuid
from datetime import date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from psycopg import errors as pgerr
from pydantic import Field, StringConstraints

from nazoratly.accounting import org_today
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.results_pdf import CertificateSnapshot, render_certificate_pdf
from nazoratly.routers.academics import assert_group_access
from nazoratly.routers.results import teacher_scope
from nazoratly.routers.settings import load_settings
from nazoratly.rules import results as R
from nazoratly.schemas import Model, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["certificates"], route_class=IdempotentRoute)


class CertificateIn(Model):
    enrollment_id: uuid.UUID
    completed_on: date | None = Field(
        default=None, description="default: the enrollment's end date, else the group's end date, else today"
    )


class VoidIn(Model):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class SendIn(Model):
    guardian_id: uuid.UUID


class CertificateOut(Out):
    id: uuid.UUID
    number: str
    code: str
    student_id: uuid.UUID
    student_name: str
    enrollment_id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    course_name: str
    issued_on: date
    completed_on: date
    voided_at: datetime | None
    void_reason: str | None
    created_at: datetime


class SendOut(Out):
    message_id: uuid.UUID
    certificate_id: uuid.UUID
    guardian_id: uuid.UUID
    status: str


class VerifyOut(Out):
    valid: bool
    status: str  # "valid" | "voided"
    number: str
    center: str
    course: str
    holder: str  # masked
    issued_on: date
    completed_on: date


_SQL = (
    "SELECT c.public_id AS id, c.number, c.code, s.public_id AS student_id, s.full_name AS student_name,"
    " e.public_id AS enrollment_id, g.public_id AS group_id, g.name AS group_name, c.snapshot->>'course_name' AS course_name,"
    " c.issued_on, c.completed_on, c.voided_at, c.void_reason, c.created_at "
    "FROM certificates c JOIN students s ON s.org_id = c.org_id AND s.id = c.student_id "
    "JOIN enrollments e ON e.org_id = c.org_id AND e.id = c.enrollment_id "
    "JOIN study_groups g ON g.org_id = c.org_id AND g.id = c.group_id"
)


async def _out(conn: Conn, cid: int) -> CertificateOut:
    row = await fetch_one(conn, f"{_SQL} WHERE c.id = %s", (cid,))
    assert row is not None
    return CertificateOut.model_validate(row)


async def _cert_for(conn: Conn, p: Principal, public: uuid.UUID) -> int:
    cid = await resolve(conn, "certificates", public, what="certificate")
    row = await fetch_one(conn, "SELECT group_id FROM certificates WHERE id = %s", (cid,))
    assert row is not None
    await assert_group_access(conn, p, row["group_id"])
    return cid


@router.post(
    "/certificates",
    response_model=CertificateOut,
    status_code=201,
    summary="Issue the certificate of a finished course (the live one is returned on a repeat)",
)
async def issue_certificate(
    body: CertificateIn,
    response: Response,
    p: Annotated[Principal, Depends(require("results:approve"))],
    db: DB,
) -> CertificateOut:
    async with db.tx(p.session()) as conn:
        eid = await resolve(conn, "enrollments", body.enrollment_id, what="enrollment")
        enr = await fetch_one(
            conn,
            "SELECT e.student_id, e.group_id, e.status, e.started_on, e.ended_on, g.status AS group_status, g.end_date, "
            "g.name AS group_name, c.name AS course_name, s.full_name AS student_name, o.name AS center "
            "FROM enrollments e JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
            "JOIN courses c ON c.org_id = g.org_id AND c.id = g.course_id "
            "JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id JOIN organizations o ON o.id = e.org_id "
            "WHERE e.id = %s FOR UPDATE OF e",
            (eid,),
        )
        assert enr is not None
        prev = await fetch_one(
            conn, "SELECT id FROM certificates WHERE enrollment_id = %s AND voided_at IS NULL", (eid,)
        )
        if prev is not None:
            response.status_code = 200
            return await _out(conn, prev["id"])
        if not R.certificate_eligible(enr["status"], enr["group_status"]):
            raise Conflict(
                "A certificate is given for a completed course: the enrollment must be finished, "
                "or active in a finished group"
            )
        today = await org_today(conn)
        completed: date = body.completed_on or enr["ended_on"] or enr["end_date"] or today
        if completed < enr["started_on"] or completed > today:
            raise Unprocessable("The completion date must be between the start of the enrollment and today")
        settings = await load_settings(conn, p.org_id)
        row = await fetch_one(conn, "SELECT next_certificate_serial(%s) AS serial", (today.year,))
        assert row is not None
        number = R.certificate_number(today.year, int(row["serial"]))
        snap_kwargs: dict[str, Any] = {
            "center_name": enr["center"],
            "requisites": settings.requisites,
            "student_name": enr["student_name"],
            "course_name": enr["course_name"],
            "group_name": enr["group_name"],
            "started_on": enr["started_on"],
            "completed_on": completed,
            "issued_on": today,
            "number": number,
        }
        for _ in range(5):  # a collision of two random 60-bit codes is not expected; retry anyway
            code = R.new_certificate_code(secrets.token_bytes(R.CODE_LEN))
            snap = CertificateSnapshot(code=code, **snap_kwargs)
            pdf = await asyncio.to_thread(render_certificate_pdf, snap)
            try:
                async with conn.transaction():
                    ins = await fetch_one(
                        conn,
                        "INSERT INTO certificates (org_id, enrollment_id, student_id, group_id, year, serial, number, code,"
                        " issued_on, completed_on, snapshot, issued_by_user_id) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s) RETURNING id",
                        (
                            p.org_id,
                            eid,
                            enr["student_id"],
                            enr["group_id"],
                            today.year,
                            int(row["serial"]),
                            number,
                            code,
                            today,
                            completed,
                            snap.model_dump_json(),
                            p.user_id,
                        ),
                    )
            except pgerr.UniqueViolation as exc:
                if exc.diag.constraint_name != "certificates_code_key":
                    raise
                continue
            assert ins is not None
            await execute(
                conn,
                "INSERT INTO certificate_files (org_id, certificate_id, pdf) VALUES (%s, %s, %s)",
                (p.org_id, ins["id"], pdf),
            )
            return await _out(conn, ins["id"])
    raise Conflict("Could not allocate a verification code, please retry")  # pragma: no cover


@router.get("/certificates", response_model=Page[CertificateOut], summary="Certificates, newest first")
async def list_certificates(
    p: Annotated[Principal, Depends(require("results:read"))],
    db: DB,
    pg: Paging,
    student_id: uuid.UUID | None = None,
    group_id: uuid.UUID | None = None,
    include_voided: bool = False,
) -> Page[CertificateOut]:
    async with db.tx(p.session()) as conn:
        mine = await teacher_scope(conn, p)
        rows = await fetch_all(
            conn,
            f"{_SQL} WHERE (%(mine)s::bigint IS NULL OR g.teacher_id = %(mine)s)"
            " AND (%(sid)s::uuid IS NULL OR s.public_id = %(sid)s) AND (%(gid)s::uuid IS NULL OR g.public_id = %(gid)s)"
            " AND (%(voided)s OR c.voided_at IS NULL) ORDER BY c.created_at DESC, c.id DESC LIMIT %(limit)s OFFSET %(offset)s",
            {
                "mine": mine,
                "sid": student_id,
                "gid": group_id,
                "voided": include_voided,
                "limit": pg.limit + 1,
                "offset": pg.offset,
            },
        )
    return make_page(rows, pg.limit, pg.offset, CertificateOut)


@router.get("/certificates/{certificate_id}", response_model=CertificateOut)
async def get_certificate(
    certificate_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:read"))], db: DB
) -> CertificateOut:
    async with db.tx(p.session()) as conn:
        return await _out(conn, await _cert_for(conn, p, certificate_id))


@router.get(
    "/certificates/{certificate_id}/pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
    summary="The certificate PDF",
)
async def certificate_pdf(
    certificate_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:read"))], db: DB
) -> Response:
    async with db.tx(p.session()) as conn:
        cid = await _cert_for(conn, p, certificate_id)
        row = await fetch_one(
            conn,
            "SELECT c.number, f.pdf FROM certificates c JOIN certificate_files f ON f.org_id = c.org_id AND f.certificate_id = c.id WHERE c.id = %s",
            (cid,),
        )
    if row is None:
        raise NotFound("certificate file not found")
    return Response(
        content=bytes(row["pdf"]),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{row["number"]}.pdf"'},
    )


@router.post(
    "/certificates/{certificate_id}/void",
    response_model=CertificateOut,
    summary="Void a certificate (with a reason)",
)
async def void_certificate(
    certificate_id: uuid.UUID,
    body: VoidIn,
    p: Annotated[Principal, Depends(require("results:approve"))],
    db: DB,
) -> CertificateOut:
    async with db.tx(p.session()) as conn:
        cid = await _cert_for(conn, p, certificate_id)
        row = await fetch_one(conn, "SELECT voided_at FROM certificates WHERE id = %s", (cid,))
        assert row is not None
        if row["voided_at"] is not None:
            raise Conflict("The certificate is already voided")
        await execute(
            conn,
            "UPDATE certificates SET voided_at = now(), void_reason = %s, voided_by_user_id = %s WHERE id = %s",
            (body.reason, p.user_id, cid),
        )
        return await _out(conn, cid)


@router.post(
    "/certificates/{certificate_id}/send",
    response_model=SendOut,
    status_code=201,
    summary="Approve and queue the certificate for a guardian's Telegram (message plus the PDF)",
)
async def send_certificate(
    certificate_id: uuid.UUID,
    body: SendIn,
    response: Response,
    p: Annotated[Principal, Depends(require("results:approve"))],
    db: DB,
) -> SendOut:
    """This call IS the approval. Same rules as every message: linked guardian with reminders and a Telegram chat, and an
    active notifications consent of the student."""
    async with db.tx(p.session()) as conn:
        cid = await _cert_for(conn, p, certificate_id)
        gid = await resolve(conn, "guardians", body.guardian_id, what="guardian")
        cert = await fetch_one(
            conn,
            "SELECT student_id, number, code, voided_at, snapshot FROM certificates WHERE id = %s",
            (cid,),
        )
        guardian = await fetch_one(conn, "SELECT telegram_chat_id FROM guardians WHERE id = %s", (gid,))
        assert cert is not None and guardian is not None
        key = f"cert-{certificate_id}-{body.guardian_id}"
        prev = await fetch_one(
            conn, "SELECT public_id, status FROM outbox_messages WHERE idempotency_key = %s", (key,)
        )
        if prev is not None:
            response.status_code = 200
            return SendOut(
                message_id=prev["public_id"],
                certificate_id=certificate_id,
                guardian_id=body.guardian_id,
                status=prev["status"],
            )
        if cert["voided_at"] is not None:
            raise Conflict("A voided certificate cannot be sent")
        if guardian["telegram_chat_id"] is None:
            raise Conflict("Guardian has not linked the Telegram bot yet")
        linked = await fetch_one(
            conn,
            "SELECT 1 AS x FROM student_guardians WHERE student_id = %s AND guardian_id = %s AND receives_reminders",
            (cert["student_id"], gid),
        )
        if linked is None:
            raise Conflict("Guardian is not linked to this student or does not receive messages")
        consent = await fetch_one(
            conn,
            "SELECT 1 AS x FROM data_consents WHERE student_id = %s AND purpose = 'notifications' AND revoked_at IS NULL",
            (cert["student_id"],),
        )
        if consent is None:
            raise Conflict("The student has no active consent for notifications")
        snap = cert["snapshot"]
        text = R.certificate_caption(
            snap["center_name"], snap["student_name"], snap["course_name"], cert["number"], cert["code"]
        )
        file_row = await fetch_one(
            conn, "SELECT pdf FROM certificate_files WHERE certificate_id = %s", (cid,)
        )
        assert file_row is not None
        row = await fetch_one(
            conn,
            "INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, idempotency_key) "
            "VALUES (%s, %s, %s, 'telegram', %s, %s) RETURNING id, public_id, status",
            (p.org_id, cert["student_id"], gid, text, key),
        )
        assert row is not None
        await execute(
            conn,
            "INSERT INTO outbox_attachments (message_id, org_id, filename, pdf) VALUES (%s, %s, %s, %s)",
            (row["id"], p.org_id, f"{cert['number']}.pdf", bytes(file_row["pdf"])),
        )
    return SendOut(
        message_id=row["public_id"],
        certificate_id=certificate_id,
        guardian_id=body.guardian_id,
        status=row["status"],
    )


@router.get(
    "/verify/certificate/{code}",
    response_model=VerifyOut,
    summary="Public: check a certificate by its verification code (the holder's name is masked)",
)
async def verify_certificate(code: str, db: DB) -> VerifyOut:
    canonical = R.parse_certificate_code(code)
    if canonical is None:
        raise NotFound("No certificate with this code")
    async with db.auth_tx() as conn:
        row = await fetch_one(conn, "SELECT * FROM certificate_verify(%s)", (canonical,))
    if row is None:
        raise NotFound("No certificate with this code")
    return VerifyOut(
        valid=not row["voided"],
        status="voided" if row["voided"] else "valid",
        number=row["number"],
        center=row["center"],
        course=row["course"],
        holder=R.mask_name(row["holder"]),
        issued_on=row["issued_on"],
        completed_on=row["completed_on"],
    )
