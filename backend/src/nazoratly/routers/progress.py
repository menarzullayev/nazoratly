"""Monthly progress reports (attendance + grades + notes + exam results) as PDFs.

A report is a DRAFT until a person approves it for a guardian: the approving call queues the Telegram message with the
PDF through the outbox (consent and linking rules are enforced by the database) and freezes the report. Nothing is sent
by automation (Model B). Regenerating a draft replaces its content; an approved report is final."""

from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response

from nazoratly.accounting import org_today
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.results_pdf import ReportExam, ReportLesson, ReportSnapshot, render_report_pdf
from nazoratly.routers.academics import assert_group_access
from nazoratly.routers.results import Month, month_start, teacher_scope
from nazoratly.routers.settings import load_settings
from nazoratly.rules import results as R
from nazoratly.schemas import Model, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["progress reports"], route_class=IdempotentRoute)


class ReportIn(Model):
    student_id: uuid.UUID
    group_id: uuid.UUID
    month: Month


class BulkIn(Model):
    group_id: uuid.UUID
    month: Month


class ReportOut(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_id: uuid.UUID
    group_name: str
    month: str
    status: str
    attendance_percent: int | None
    average_grade: str | None
    generated_at: datetime
    approved_at: datetime | None


class ReportDetail(ReportOut):
    snapshot: dict[str, Any]


class BulkOut(Out):
    created: int
    regenerated: int
    skipped_approved: int
    reports: list[ReportOut]


class ApproveIn(Model):
    guardian_id: uuid.UUID


class ApproveOut(Out):
    message_id: uuid.UUID
    report_id: uuid.UUID
    guardian_id: uuid.UUID
    status: str


_REPORT_SQL = (
    "SELECT r.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, g.public_id AS group_id,"
    " g.name AS group_name, to_char(r.period_month, 'YYYY-MM') AS month, r.status,"
    " (r.snapshot->>'attendance_percent')::int AS attendance_percent, r.snapshot->>'average_grade' AS average_grade,"
    " r.generated_at, r.approved_at, r.snapshot "
    "FROM progress_reports r JOIN students s ON s.org_id = r.org_id AND s.id = r.student_id "
    "JOIN study_groups g ON g.org_id = r.org_id AND g.id = r.group_id"
)


async def _build(conn: Conn, p: Principal, sid: int, gid: int, month: date) -> ReportSnapshot:
    enrolled = await fetch_one(
        conn, "SELECT 1 AS x FROM enrollments WHERE student_id = %s AND group_id = %s LIMIT 1", (sid, gid)
    )
    if enrolled is None:
        raise Unprocessable("The student is not enrolled in this group")
    head = await fetch_one(
        conn,
        "SELECT o.name AS center, s.full_name AS student, g.name AS grp, c.name AS course, t.full_name AS teacher "
        "FROM organizations o, students s, study_groups g JOIN courses c ON c.org_id = g.org_id AND c.id = g.course_id "
        "LEFT JOIN teachers t ON t.org_id = g.org_id AND t.id = g.teacher_id "
        "WHERE o.id = %s AND s.id = %s AND g.id = %s",
        (p.org_id, sid, gid),
    )
    assert head is not None
    settings = await load_settings(conn, p.org_id)
    nxt = date(month.year + (month.month // 12), month.month % 12 + 1, 1)
    statuses = [
        r["status"]
        for r in await fetch_all(
            conn,
            "SELECT a.status FROM attendance a JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id "
            "WHERE a.student_id = %s AND l.group_id = %s AND l.lesson_date >= %s AND l.lesson_date < %s "
            "AND l.status <> 'cancelled' ORDER BY l.lesson_date",
            (sid, gid, month, nxt),
        )
    ]
    summary = R.attendance_summary(statuses)
    lesson_rows = await fetch_all(
        conn,
        "SELECT l.lesson_date, m.grade, m.note FROM learning_marks m JOIN lessons l ON l.org_id = m.org_id AND l.id = m.lesson_id "
        "WHERE m.student_id = %s AND m.group_id = %s AND m.scope = 'lesson' AND l.lesson_date >= %s AND l.lesson_date < %s "
        "ORDER BY l.lesson_date, l.id",
        (sid, gid, month, nxt),
    )
    month_row = await fetch_one(
        conn,
        "SELECT grade, note FROM learning_marks WHERE student_id = %s AND group_id = %s AND scope = 'month' AND period_month = %s",
        (sid, gid, month),
    )
    grades = [r["grade"] for r in lesson_rows if r["grade"] is not None]
    if month_row is not None and month_row["grade"] is not None:
        grades.append(month_row["grade"])
    exam_rows = await fetch_all(
        conn,
        "SELECT e.title, e.held_on, r.score, e.max_score FROM exam_results r JOIN exams e ON e.org_id = r.org_id AND e.id = r.exam_id "
        "WHERE r.student_id = %s AND e.group_id = %s AND e.held_on >= %s AND e.held_on < %s ORDER BY e.held_on, e.id",
        (sid, gid, month, nxt),
    )
    return ReportSnapshot(
        center_name=head["center"],
        requisites=settings.requisites,
        student_name=head["student"],
        group_name=head["grp"],
        course_name=head["course"],
        teacher_name=head["teacher"],
        period_month=month,
        month_label=R.month_label(month.year, month.month),
        present=summary["present"],
        late=summary["late"],
        absent=summary["absent"],
        excused=summary["excused"],
        attendance_percent=summary["percent"],
        average_grade=R.average_grade(grades),
        month_grade=month_row["grade"] if month_row else None,
        month_note=month_row["note"] if month_row else None,
        lessons=[
            ReportLesson(lesson_date=r["lesson_date"], grade=r["grade"], note=r["note"]) for r in lesson_rows
        ],
        exams=[
            ReportExam(
                title=r["title"],
                held_on=r["held_on"],
                score=r["score"],
                max_score=r["max_score"],
                percent=R.exam_percent(r["score"], r["max_score"]),
            )
            for r in exam_rows
        ],
        generated_on=await org_today(conn),
    )


async def _upsert(
    conn: Conn, p: Principal, sid: int, gid: int, month: date
) -> tuple[int, Literal["created", "regenerated", "approved"]]:
    existing = await fetch_one(
        conn,
        "SELECT id, status FROM progress_reports WHERE student_id = %s AND group_id = %s AND period_month = %s FOR UPDATE",
        (sid, gid, month),
    )
    if existing is not None and existing["status"] == "approved":
        return int(existing["id"]), "approved"
    snap = await _build(conn, p, sid, gid, month)
    pdf = await asyncio.to_thread(render_report_pdf, snap)
    payload = snap.model_dump_json()
    if existing is None:
        row = await fetch_one(
            conn,
            "INSERT INTO progress_reports (org_id, student_id, group_id, period_month, snapshot, generated_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s::jsonb, %s) RETURNING id",
            (p.org_id, sid, gid, month, payload, p.user_id),
        )
        assert row is not None
        await execute(
            conn,
            "INSERT INTO progress_report_files (org_id, report_id, pdf) VALUES (%s, %s, %s)",
            (p.org_id, row["id"], pdf),
        )
        return int(row["id"]), "created"
    await execute(
        conn,
        "UPDATE progress_reports SET snapshot = %s::jsonb, generated_by_user_id = %s, generated_at = now() WHERE id = %s",
        (payload, p.user_id, existing["id"]),
    )
    await execute(
        conn, "UPDATE progress_report_files SET pdf = %s WHERE report_id = %s", (pdf, existing["id"])
    )
    return int(existing["id"]), "regenerated"


async def _detail(conn: Conn, rid: int) -> ReportDetail:
    row = await fetch_one(conn, f"{_REPORT_SQL} WHERE r.id = %s", (rid,))
    assert row is not None
    return ReportDetail.model_validate(row)


async def _report_for(conn: Conn, p: Principal, public: uuid.UUID) -> int:
    rid = await resolve(conn, "progress_reports", public, what="progress report")
    row = await fetch_one(conn, "SELECT group_id FROM progress_reports WHERE id = %s", (rid,))
    assert row is not None
    await assert_group_access(conn, p, row["group_id"])
    return rid


@router.post(
    "/reports/progress",
    response_model=ReportDetail,
    status_code=201,
    summary="Create (or regenerate, while it is still a draft) a student's monthly progress report",
)
async def make_report(
    body: ReportIn,
    response: Response,
    p: Annotated[Principal, Depends(require("results:write"))],
    db: DB,
) -> ReportDetail:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", body.student_id, what="student")
        gid = await resolve(conn, "study_groups", body.group_id, what="group")
        await assert_group_access(conn, p, gid)
        month = month_start(body.month)
        today = await org_today(conn)
        if month > today.replace(day=1):
            raise Unprocessable("A report for a month in the future cannot be created yet")
        rid, state = await _upsert(conn, p, sid, gid, month)
        if state == "approved":
            raise Conflict("This report was approved and sent: it is final")
        response.status_code = 201 if state == "created" else 200
        return await _detail(conn, rid)


@router.post(
    "/reports/progress/generate",
    response_model=BulkOut,
    summary="Create draft reports for every active student of a group for a month (nothing is sent)",
)
async def generate_reports(
    body: BulkIn, p: Annotated[Principal, Depends(require("results:write"))], db: DB
) -> BulkOut:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", body.group_id, what="group")
        await assert_group_access(conn, p, gid)
        month = month_start(body.month)
        today = await org_today(conn)
        if month > today.replace(day=1):
            raise Unprocessable("A report for a month in the future cannot be created yet")
        students = await fetch_all(
            conn,
            "SELECT DISTINCT e.student_id FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
            "WHERE e.group_id = %s AND e.status IN ('trial','active') AND s.deleted_at IS NULL ORDER BY e.student_id",
            (gid,),
        )
        counts = {"created": 0, "regenerated": 0, "approved": 0}
        ids: list[int] = []
        for st in students:
            rid, state = await _upsert(conn, p, int(st["student_id"]), gid, month)
            counts[state] += 1
            ids.append(rid)
        rows = [await _detail(conn, rid) for rid in ids]
    return BulkOut(
        created=counts["created"],
        regenerated=counts["regenerated"],
        skipped_approved=counts["approved"],
        reports=rows,
    )


@router.get(
    "/reports/progress", response_model=Page[ReportOut], summary="Progress reports, newest month first"
)
async def list_reports(
    p: Annotated[Principal, Depends(require("results:read"))],
    db: DB,
    pg: Paging,
    group_id: uuid.UUID | None = None,
    student_id: uuid.UUID | None = None,
    month: Month | None = None,
    status: Literal["draft", "approved"] | None = None,
) -> Page[ReportOut]:
    async with db.tx(p.session()) as conn:
        mine = await teacher_scope(conn, p)
        rows = await fetch_all(
            conn,
            f"{_REPORT_SQL} WHERE (%(mine)s::bigint IS NULL OR g.teacher_id = %(mine)s)"
            " AND (%(gid)s::uuid IS NULL OR g.public_id = %(gid)s) AND (%(sid)s::uuid IS NULL OR s.public_id = %(sid)s)"
            " AND (%(month)s::date IS NULL OR r.period_month = %(month)s) AND (%(st)s::text IS NULL OR r.status = %(st)s)"
            " ORDER BY r.period_month DESC, lower(s.full_name), r.id LIMIT %(limit)s OFFSET %(offset)s",
            {
                "mine": mine,
                "gid": group_id,
                "sid": student_id,
                "month": month_start(month) if month else None,
                "st": status,
                "limit": pg.limit + 1,
                "offset": pg.offset,
            },
        )
    return make_page(rows, pg.limit, pg.offset, ReportOut)


@router.get("/reports/progress/{report_id}", response_model=ReportDetail)
async def get_report(
    report_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:read"))], db: DB
) -> ReportDetail:
    async with db.tx(p.session()) as conn:
        return await _detail(conn, await _report_for(conn, p, report_id))


@router.get(
    "/reports/progress/{report_id}/pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
    summary="The PDF of a progress report",
)
async def report_pdf(
    report_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:read"))], db: DB
) -> Response:
    async with db.tx(p.session()) as conn:
        rid = await _report_for(conn, p, report_id)
        row = await fetch_one(
            conn,
            "SELECT to_char(r.period_month, 'YYYY-MM') AS month, f.pdf FROM progress_reports r "
            "JOIN progress_report_files f ON f.org_id = r.org_id AND f.report_id = r.id WHERE r.id = %s",
            (rid,),
        )
    if row is None:
        raise NotFound("report file not found")
    return Response(
        content=bytes(row["pdf"]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="hisobot-{row["month"]}-{str(report_id)[:8]}.pdf"'
        },
    )


@router.delete("/reports/progress/{report_id}", status_code=204, summary="Delete a draft report")
async def delete_report(
    report_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:write"))], db: DB
) -> Response:
    async with db.tx(p.session()) as conn:
        rid = await _report_for(conn, p, report_id)
        row = await fetch_one(conn, "SELECT status FROM progress_reports WHERE id = %s", (rid,))
        assert row is not None
        if row["status"] == "approved":
            raise Conflict("An approved report was sent and cannot be deleted")
        await execute(conn, "DELETE FROM progress_reports WHERE id = %s", (rid,))
    return Response(status_code=204)


@router.post(
    "/reports/progress/{report_id}/approve",
    response_model=ApproveOut,
    status_code=201,
    summary="Approve the report and queue it for a guardian's Telegram (message plus the PDF)",
)
async def approve_report(
    report_id: uuid.UUID,
    body: ApproveIn,
    response: Response,
    p: Annotated[Principal, Depends(require("results:approve"))],
    db: DB,
) -> ApproveOut:
    """This call IS the approval by a signed-in person. The database applies the standard rules for every message: the
    guardian must be linked to the student, receive reminders and have a Telegram chat, and the student needs an active
    notifications consent. The report is frozen by the first approval; the same PDF can go to another guardian."""
    async with db.tx(p.session()) as conn:
        rid = await _report_for(conn, p, report_id)
        gid = await resolve(conn, "guardians", body.guardian_id, what="guardian")
        rep = await fetch_one(
            conn,
            "SELECT r.student_id, r.status, r.snapshot, to_char(r.period_month, 'YYYY-MM') AS month FROM progress_reports r WHERE r.id = %s FOR UPDATE",
            (rid,),
        )
        guardian = await fetch_one(conn, "SELECT telegram_chat_id FROM guardians WHERE id = %s", (gid,))
        assert rep is not None and guardian is not None
        key = f"report-{report_id}-{body.guardian_id}"
        prev = await fetch_one(
            conn, "SELECT public_id, status FROM outbox_messages WHERE idempotency_key = %s", (key,)
        )
        if prev is not None:  # approved before: never a second message
            response.status_code = 200
            return ApproveOut(
                message_id=prev["public_id"],
                report_id=report_id,
                guardian_id=body.guardian_id,
                status=prev["status"],
            )
        if guardian["telegram_chat_id"] is None:
            raise Conflict("Guardian has not linked the Telegram bot yet")
        linked = await fetch_one(
            conn,
            "SELECT 1 AS x FROM student_guardians WHERE student_id = %s AND guardian_id = %s AND receives_reminders",
            (rep["student_id"], gid),
        )
        if linked is None:
            raise Conflict("Guardian is not linked to this student or does not receive messages")
        consent = await fetch_one(
            conn,
            "SELECT 1 AS x FROM data_consents WHERE student_id = %s AND purpose = 'notifications' AND revoked_at IS NULL",
            (rep["student_id"],),
        )
        if consent is None:
            raise Conflict("The student has no active consent for notifications")
        snap = ReportSnapshot.model_validate(rep["snapshot"])
        text = R.report_caption(
            snap.center_name, snap.student_name, snap.month_label, snap.attendance_percent, snap.average_grade
        )
        file_row = await fetch_one(conn, "SELECT pdf FROM progress_report_files WHERE report_id = %s", (rid,))
        assert file_row is not None
        row = await fetch_one(
            conn,
            "INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, idempotency_key) "
            "VALUES (%s, %s, %s, 'telegram', %s, %s) RETURNING id, public_id, status",
            (p.org_id, rep["student_id"], gid, text, key),
        )
        assert row is not None
        await execute(
            conn,
            "INSERT INTO outbox_attachments (message_id, org_id, filename, pdf) VALUES (%s, %s, %s, %s)",
            (row["id"], p.org_id, f"hisobot-{rep['month']}-{str(report_id)[:8]}.pdf", bytes(file_row["pdf"])),
        )
        if rep["status"] == "draft":
            await execute(
                conn,
                "UPDATE progress_reports SET status = 'approved', approved_at = now(), approved_by_user_id = %s WHERE id = %s",
                (p.user_id, rid),
            )
    return ApproveOut(
        message_id=row["public_id"], report_id=report_id, guardian_id=body.guardian_id, status=row["status"]
    )
