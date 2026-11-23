"""QR attendance: student codes, printable cards, sending a card to a guardian, and scanning to mark `present`.

Rules (`rules/qr.py`, golden-tested together with the Sheets edition): a scan marks `present` only when the student is
in the lesson's roster and the lesson is not cancelled; an existing present/late mark is kept; absent/excused are
overwritten (the student showed up). Manual marking stays as it is."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response

from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Principal, require
from nazoratly.errors import (
    BadQrCode,
    Conflict,
    LessonCancelled,
    NotInGroup,
    UnknownQrCode,
)
from nazoratly.idempotency import IdempotentRoute
from nazoratly.qrcards import Card, card_filename, ensure_code, render_cards_pdf
from nazoratly.routers.academics import assert_group_access
from nazoratly.routers.entitlements import sync_entitlement
from nazoratly.routers.lessons import _lesson_for, _roster
from nazoratly.rules import qr as Q
from nazoratly.schemas import Model, Out

router = APIRouter(prefix="/v1", tags=["qr attendance"], route_class=IdempotentRoute)

PDF: dict[int | str, dict[str, Any]] = {200: {"content": {"application/pdf": {}}}}


class QrIn(Model):
    rotate: bool = False


class QrOut(Out):
    student_id: uuid.UUID
    code: str
    issued_at: datetime
    rotated: bool


class ScanIn(Model):
    code: str
    lesson_id: uuid.UUID


class ScanOut(Out):
    result: Literal["marked", "already_present"]
    student_id: uuid.UUID
    student_name: str
    lesson_id: uuid.UUID
    status: str
    previous_status: str | None


class SendCardIn(Model):
    guardian_id: uuid.UUID


class SendCardOut(Out):
    message_id: uuid.UUID
    student_id: uuid.UUID
    guardian_id: uuid.UUID
    status: str


async def _org_name(conn: Conn, org_id: int) -> str:
    row = await fetch_one(conn, "SELECT name FROM organizations WHERE id = %s", (org_id,))
    return str(row["name"]) if row else ""


@router.post(
    "/students/{student_id}/qr",
    response_model=QrOut,
    summary="The student's QR code (created on first use; `rotate` replaces it and the old card stops working)",
)
async def student_qr(
    student_id: uuid.UUID,
    body: QrIn,
    p: Annotated[Principal, Depends(require("students:write"))],
    db: DB,
) -> QrOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        code, changed = await ensure_code(conn, sid, rotate=body.rotate)
        row = await fetch_one(conn, "SELECT qr_issued_at FROM students WHERE id = %s", (sid,))
    assert row is not None
    return QrOut(
        student_id=student_id, code=code, issued_at=row["qr_issued_at"], rotated=changed and body.rotate
    )


@router.get(
    "/students/{student_id}/qr-card",
    response_class=Response,
    responses=PDF,
    summary="Printable QR card of a student (PDF); the code is created on first use",
)
async def student_card(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> Response:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        code, _ = await ensure_code(conn, sid)
        row = await fetch_one(conn, "SELECT full_name FROM students WHERE id = %s", (sid,))
        assert row is not None
        center = await _org_name(conn, p.org_id)
    pdf = render_cards_pdf([Card(str(row["full_name"]), code, center)], title=f"QR karta: {row['full_name']}")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{card_filename(str(row["full_name"]))}"'},
    )


@router.get(
    "/groups/{group_id}/qr-cards",
    response_class=Response,
    responses=PDF,
    summary="QR cards of every active and trial student of a group on A4 sheets (PDF)",
)
async def group_cards(
    group_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("academics:read", "students:write"))],
    db: DB,
) -> Response:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        await assert_group_access(conn, p, gid)
        grp = await fetch_one(conn, "SELECT name FROM study_groups WHERE id = %s", (gid,))
        assert grp is not None
        members = await fetch_all(
            conn,
            "SELECT s.id, s.full_name FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
            "WHERE e.group_id = %s AND e.status IN ('trial', 'active') AND s.deleted_at IS NULL "
            "ORDER BY lower(s.full_name), s.id",
            (gid,),
        )
        center = await _org_name(conn, p.org_id)
        cards = []
        for m in members:
            code, _ = await ensure_code(conn, int(m["id"]))
            cards.append(Card(str(m["full_name"]), code, center, str(grp["name"])))
    pdf = render_cards_pdf(cards, title=f"QR kartalar: {grp['name']}")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{card_filename(str(grp["name"]))}"'},
    )


@router.post(
    "/students/{student_id}/qr-card/send",
    response_model=SendCardOut,
    status_code=201,
    summary="Approve and queue the QR card for a guardian's Telegram (a message plus the PDF)",
)
async def send_card(
    student_id: uuid.UUID,
    body: SendCardIn,
    response: Response,
    p: Annotated[Principal, Depends(require("students:write"))],
    db: DB,
) -> SendCardOut:
    """This call IS the approval. The database applies the same rules as for every message: the guardian must be linked
    to the student, receive reminders and have a Telegram chat, and the student needs an active notifications consent."""
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        gid = await resolve(conn, "guardians", body.guardian_id, what="guardian")
        code, _ = await ensure_code(conn, sid)
        student = await fetch_one(conn, "SELECT full_name FROM students WHERE id = %s", (sid,))
        guardian = await fetch_one(conn, "SELECT telegram_chat_id FROM guardians WHERE id = %s", (gid,))
        assert student is not None and guardian is not None
        key = f"qr-{student_id}-{body.guardian_id}-{code}"  # one message per guardian and code; a new code sends again
        prev = await fetch_one(
            conn, "SELECT public_id, status FROM outbox_messages WHERE idempotency_key = %s", (key,)
        )
        if prev is not None:
            response.status_code = 200
            return SendCardOut(
                message_id=prev["public_id"],
                student_id=student_id,
                guardian_id=body.guardian_id,
                status=prev["status"],
            )
        if guardian["telegram_chat_id"] is None:
            raise Conflict("Guardian has not linked the Telegram bot yet")
        linked = await fetch_one(
            conn,
            "SELECT 1 AS x FROM student_guardians WHERE student_id = %s AND guardian_id = %s AND receives_reminders",
            (sid, gid),
        )
        if linked is None:
            raise Conflict("Guardian is not linked to this student or does not receive messages")
        consent = await fetch_one(
            conn,
            "SELECT 1 AS x FROM data_consents WHERE student_id = %s AND purpose = 'notifications' AND revoked_at IS NULL",
            (sid,),
        )
        if consent is None:
            raise Conflict("The student has no active consent for notifications")
        center = await _org_name(conn, p.org_id)
        pdf = render_cards_pdf([Card(str(student["full_name"]), code, center)], title="QR karta")
        text = (
            f"{student['full_name']} uchun davomat QR kartasi. Darsga kirishda shu kodni skanerlang. "
            f"Kartani yo'qotsangiz, markazga xabar bering: yangisi beriladi. {center}"
        ).strip()
        row = await fetch_one(
            conn,
            "INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, idempotency_key) "
            "VALUES (%s, %s, %s, 'telegram', %s, %s) RETURNING id, public_id, status",
            (p.org_id, sid, gid, text, key),
        )
        assert row is not None
        await execute(
            conn,
            "INSERT INTO outbox_attachments (message_id, org_id, filename, pdf) VALUES (%s, %s, %s, %s)",
            (row["id"], p.org_id, card_filename(str(student["full_name"])), pdf),
        )
    return SendCardOut(
        message_id=row["public_id"], student_id=student_id, guardian_id=body.guardian_id, status=row["status"]
    )


@router.post(
    "/attendance/scan",
    response_model=ScanOut,
    summary="Scan a student's QR code at a lesson: marks `present` when the student belongs to the lesson",
)
async def scan(
    body: ScanIn, p: Annotated[Principal, Depends(require("attendance:write"))], db: DB
) -> ScanOut:
    async with db.tx(p.session()) as conn:
        lesson = await _lesson_for(conn, p, body.lesson_id)  # 404, or 403 for a teacher's foreign lesson
        code = Q.parse_payload(body.code)
        student = None
        if code is not None:
            student = await fetch_one(
                conn,
                "SELECT id, public_id, full_name FROM students WHERE qr_code = %s AND deleted_at IS NULL",
                (code,),
            )
        roster = {int(r["sid"]): r for r in await _roster(conn, lesson)}  # type: ignore[call-overload]
        mine = roster.get(int(student["id"])) if student else None
        decision = Q.scan_decision(
            code_text=body.code,
            known=student is not None,
            lesson_status=str(lesson["status"]),
            in_roster=mine is not None,
            existing=str(mine["status"]) if mine and mine["status"] else None,
        )
        if decision.result == "bad_code":
            raise BadQrCode("This is not a nazoratly QR code")
        if decision.result == "unknown_code":
            raise UnknownQrCode("Unknown QR code (the card may have been replaced)")
        assert student is not None
        if decision.result == "lesson_cancelled":
            raise LessonCancelled("The lesson is cancelled")
        if decision.result == "not_in_group":
            raise NotInGroup(
                "The student is not in this lesson's group",
                details={"student_name": str(student["full_name"])},
            )
        if decision.write:
            await execute(
                conn,
                "INSERT INTO attendance (org_id, lesson_id, student_id, status, minutes_late, marked_by_user_id, marked_via) "
                "VALUES (%s, %s, %s, 'present', 0, %s, 'qr') ON CONFLICT (lesson_id, student_id) DO UPDATE "
                "SET status = 'present', minutes_late = 0, marked_by_user_id = EXCLUDED.marked_by_user_id, "
                "marked_via = 'qr', marked_at = now()",
                (p.org_id, lesson["id"], student["id"], p.user_id),
            )
            await sync_entitlement(
                conn, org_id=p.org_id, lesson=lesson, student_id=int(student["id"]), new_status="present"
            )
            if lesson["status"] == "planned":
                await execute(conn, "UPDATE lessons SET status = 'held' WHERE id = %s", (lesson["id"],))
    return ScanOut(
        result="marked" if decision.write else "already_present",
        student_id=student["public_id"],
        student_name=str(student["full_name"]),
        lesson_id=body.lesson_id,
        status="present" if decision.write else str(decision.previous),
        previous_status=decision.previous,
    )
