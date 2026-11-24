"""Learning results: the teacher's note and grade per lesson or month, simple exam results, and a student's results.

Rules (`rules/results.py`, golden-tested with the Sheets edition): a grade is a whole number 1..5; an exam score is
`score` of `max_score`; a mark or score belongs to a student of the group (the database also enforces it). Teachers see
and write only the groups they teach."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import Field, StringConstraints, model_validator

from nazoratly.accounting import org_today
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.academics import assert_group_access, my_teacher_id
from nazoratly.rules import results as R
from nazoratly.schemas import Dec2, Model, Out, Page, make_page

router = APIRouter(prefix="/v1", tags=["learning results"], route_class=IdempotentRoute)

Month = Annotated[str, StringConstraints(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")]
Grade = Annotated[int, Field(ge=R.GRADE_MIN, le=R.GRADE_MAX, description="whole number 1..5")]
MarkNote = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
Score = Annotated[Decimal, Field(max_digits=8, decimal_places=2, ge=0)]
MaxScore = Annotated[Decimal, Field(max_digits=8, decimal_places=2, gt=0)]


def month_start(text: str) -> date:
    return date(int(text[:4]), int(text[5:7]), 1)


async def teacher_scope(conn: Conn, p: Principal) -> int | None:
    """None = every group; for a teacher the id of their profile (-1 when they have none: nothing matches)."""
    if p.role != "teacher":
        return None
    mine = await my_teacher_id(conn, p)
    return mine if mine is not None else -1


async def assert_not_future(conn: Conn, month: date) -> None:
    today = await org_today(conn)
    if month > today.replace(day=1):
        raise Unprocessable("A month in the future cannot have a note, grade or report yet")


# ---- marks ---------------------------------------------------------------------------------------------------
class MarkIn(Model):
    student_id: uuid.UUID
    group_id: uuid.UUID
    scope: Literal["lesson", "month"]
    lesson_id: uuid.UUID | None = Field(default=None, description="scope=lesson: the lesson of this group")
    month: Month | None = Field(default=None, description="scope=month: yyyy-mm")
    grade: Grade | None = None
    note: MarkNote | None = None

    @model_validator(mode="after")
    def _shape(self) -> MarkIn:
        if self.scope == "lesson" and (self.lesson_id is None or self.month is not None):
            raise ValueError("scope 'lesson' needs lesson_id and no month")
        if self.scope == "month" and (self.month is None or self.lesson_id is not None):
            raise ValueError("scope 'month' needs month and no lesson_id")
        if self.grade is None and self.note is None:
            raise ValueError("a mark needs a grade, a note or both (use DELETE to remove it)")
        return self


class MarkOut(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_id: uuid.UUID
    group_name: str
    teacher_name: str | None
    scope: str
    lesson_id: uuid.UUID | None
    lesson_date: date | None
    month: str | None
    grade: int | None
    note: str | None
    created_at: datetime
    updated_at: datetime


_MARK_SQL = (
    "SELECT m.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, g.public_id AS group_id,"
    " g.name AS group_name, t.full_name AS teacher_name, m.scope, l.public_id AS lesson_id, l.lesson_date,"
    " to_char(m.period_month, 'YYYY-MM') AS month, m.grade, m.note, m.created_at, m.updated_at "
    "FROM learning_marks m JOIN students s ON s.org_id = m.org_id AND s.id = m.student_id "
    "JOIN study_groups g ON g.org_id = m.org_id AND g.id = m.group_id "
    "LEFT JOIN teachers t ON t.org_id = g.org_id AND t.id = g.teacher_id "
    "LEFT JOIN lessons l ON l.org_id = m.org_id AND l.id = m.lesson_id"
)


@router.put(
    "/marks",
    response_model=MarkOut,
    summary="Write or replace the note/grade of a student for one lesson or one month (upsert)",
)
async def put_mark(
    body: MarkIn, response: Response, p: Annotated[Principal, Depends(require("results:write"))], db: DB
) -> MarkOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", body.student_id, what="student")
        gid = await resolve(conn, "study_groups", body.group_id, what="group")
        await assert_group_access(conn, p, gid)
        if body.scope == "lesson":
            assert body.lesson_id is not None
            lid = await resolve(conn, "lessons", body.lesson_id, what="lesson")
            lesson = await fetch_one(conn, "SELECT group_id, status FROM lessons WHERE id = %s", (lid,))
            assert lesson is not None
            if lesson["group_id"] != gid:
                raise Unprocessable("The lesson does not belong to this group")
            if lesson["status"] == "cancelled":
                raise Conflict("Lesson is cancelled")
            row = await fetch_one(
                conn,
                "INSERT INTO learning_marks (org_id, student_id, group_id, scope, lesson_id, grade, note, author_user_id) "
                "VALUES (%s, %s, %s, 'lesson', %s, %s, %s, %s) "
                "ON CONFLICT (student_id, lesson_id) WHERE scope = 'lesson' DO UPDATE "
                "SET grade = EXCLUDED.grade, note = EXCLUDED.note, author_user_id = EXCLUDED.author_user_id "
                "RETURNING id, (xmax = 0) AS created",
                (p.org_id, sid, gid, lid, body.grade, body.note, p.user_id),
            )
        else:
            assert body.month is not None
            month = month_start(body.month)
            await assert_not_future(conn, month)
            row = await fetch_one(
                conn,
                "INSERT INTO learning_marks (org_id, student_id, group_id, scope, period_month, grade, note, author_user_id) "
                "VALUES (%s, %s, %s, 'month', %s, %s, %s, %s) "
                "ON CONFLICT (student_id, group_id, period_month) WHERE scope = 'month' DO UPDATE "
                "SET grade = EXCLUDED.grade, note = EXCLUDED.note, author_user_id = EXCLUDED.author_user_id "
                "RETURNING id, (xmax = 0) AS created",
                (p.org_id, sid, gid, month, body.grade, body.note, p.user_id),
            )
        assert row is not None
        out = await fetch_one(conn, f"{_MARK_SQL} WHERE m.id = %s", (row["id"],))
    assert out is not None
    response.status_code = 201 if row["created"] else 200
    return MarkOut.model_validate(out)


@router.get("/marks", response_model=Page[MarkOut], summary="Notes and grades, newest first")
async def list_marks(
    p: Annotated[Principal, Depends(require("results:read"))],
    db: DB,
    pg: Paging,
    student_id: uuid.UUID | None = None,
    group_id: uuid.UUID | None = None,
    lesson_id: uuid.UUID | None = None,
    month: Month | None = None,
) -> Page[MarkOut]:
    async with db.tx(p.session()) as conn:
        mine = await teacher_scope(conn, p)
        rows = await fetch_all(
            conn,
            f"{_MARK_SQL} WHERE (%(mine)s::bigint IS NULL OR g.teacher_id = %(mine)s)"
            " AND (%(sid)s::uuid IS NULL OR s.public_id = %(sid)s) AND (%(gid)s::uuid IS NULL OR g.public_id = %(gid)s)"
            " AND (%(lid)s::uuid IS NULL OR l.public_id = %(lid)s)"
            " AND (%(month)s::date IS NULL OR m.period_month = %(month)s OR date_trunc('month', l.lesson_date)::date = %(month)s)"
            " ORDER BY m.updated_at DESC, m.id DESC LIMIT %(limit)s OFFSET %(offset)s",
            {
                "mine": mine,
                "sid": student_id,
                "gid": group_id,
                "lid": lesson_id,
                "month": month_start(month) if month else None,
                "limit": pg.limit + 1,
                "offset": pg.offset,
            },
        )
    return make_page(rows, pg.limit, pg.offset, MarkOut)


@router.delete("/marks/{mark_id}", status_code=204, summary="Remove a note/grade")
async def delete_mark(
    mark_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:write"))], db: DB
) -> Response:
    async with db.tx(p.session()) as conn:
        mid = await resolve(conn, "learning_marks", mark_id, what="mark")
        row = await fetch_one(conn, "SELECT group_id FROM learning_marks WHERE id = %s", (mid,))
        assert row is not None
        await assert_group_access(conn, p, row["group_id"])
        await execute(conn, "DELETE FROM learning_marks WHERE id = %s", (mid,))
    return Response(status_code=204)


# ---- exams ---------------------------------------------------------------------------------------------------
class ExamIn(Model):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    held_on: date
    max_score: MaxScore


class ExamPatch(Model):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)] | None = (
        None
    )
    held_on: date | None = None
    max_score: MaxScore | None = None


class ExamOut(Out):
    id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    title: str
    held_on: date
    max_score: Dec2
    results_count: int


class ExamResultOut(Out):
    student_id: uuid.UUID
    student_name: str
    score: Dec2 | None
    percent: int | None
    note: str | None


class ExamDetail(ExamOut):
    results: list[ExamResultOut]


class ResultRecord(Model):
    student_id: uuid.UUID
    score: Score
    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)] | None = None


class ResultsIn(Model):
    records: Annotated[list[ResultRecord], Field(min_length=1, max_length=500)]


_EXAM_SQL = (
    "SELECT e.public_id AS id, g.public_id AS group_id, g.name AS group_name, e.title, e.held_on, e.max_score,"
    " (SELECT count(*) FROM exam_results r WHERE r.exam_id = e.id) AS results_count "
    "FROM exams e JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id"
)


async def _exam(conn: Conn, p: Principal, exam_public: uuid.UUID) -> tuple[int, int]:
    """(exam id, group id) with the teacher-only-own-groups rule applied."""
    eid = await resolve(conn, "exams", exam_public, what="exam")
    row = await fetch_one(conn, "SELECT group_id FROM exams WHERE id = %s", (eid,))
    assert row is not None
    await assert_group_access(conn, p, row["group_id"])
    return eid, int(row["group_id"])


async def _exam_detail(conn: Conn, eid: int, group_id: int) -> ExamDetail:
    head = await fetch_one(conn, f"{_EXAM_SQL} WHERE e.id = %s", (eid,))
    assert head is not None
    rows = await fetch_all(
        conn,
        "SELECT s.public_id AS student_id, s.full_name AS student_name, r.score, r.note "
        "FROM students s "
        "JOIN (SELECT student_id FROM enrollments WHERE group_id = %(g)s AND status IN ('trial','active') "
        "      UNION SELECT student_id FROM exam_results WHERE exam_id = %(e)s) m ON m.student_id = s.id "
        "LEFT JOIN exam_results r ON r.exam_id = %(e)s AND r.student_id = s.id "
        "ORDER BY lower(s.full_name), s.id",
        {"g": group_id, "e": eid},
    )
    max_score: Decimal = head["max_score"]
    results = [
        ExamResultOut(
            student_id=r["student_id"],
            student_name=r["student_name"],
            score=r["score"],
            percent=None if r["score"] is None else R.exam_percent(r["score"], max_score),
            note=r["note"],
        )
        for r in rows
    ]
    return ExamDetail(**head, results=results)


@router.post(
    "/groups/{group_id}/exams",
    response_model=ExamDetail,
    status_code=201,
    summary="Add an exam/test to a group",
)
async def create_exam(
    group_id: uuid.UUID, body: ExamIn, p: Annotated[Principal, Depends(require("results:write"))], db: DB
) -> ExamDetail:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        await assert_group_access(conn, p, gid)
        row = await fetch_one(
            conn,
            "INSERT INTO exams (org_id, group_id, title, held_on, max_score, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, gid, body.title, body.held_on, body.max_score, p.user_id),
        )
        assert row is not None
        return await _exam_detail(conn, row["id"], gid)


@router.get(
    "/groups/{group_id}/exams", response_model=Page[ExamOut], summary="Exams of a group, newest first"
)
async def list_exams(
    group_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:read"))], db: DB, pg: Paging
) -> Page[ExamOut]:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        await assert_group_access(conn, p, gid)
        rows = await fetch_all(
            conn,
            f"{_EXAM_SQL} WHERE e.group_id = %s ORDER BY e.held_on DESC, e.id DESC LIMIT %s OFFSET %s",
            (gid, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, ExamOut)


@router.get("/exams/{exam_id}", response_model=ExamDetail, summary="An exam with every student's score")
async def get_exam(
    exam_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:read"))], db: DB
) -> ExamDetail:
    async with db.tx(p.session()) as conn:
        eid, gid = await _exam(conn, p, exam_id)
        return await _exam_detail(conn, eid, gid)


@router.patch("/exams/{exam_id}", response_model=ExamDetail)
async def patch_exam(
    exam_id: uuid.UUID, body: ExamPatch, p: Annotated[Principal, Depends(require("results:write"))], db: DB
) -> ExamDetail:
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    async with db.tx(p.session()) as conn:
        eid, gid = await _exam(conn, p, exam_id)
        if changes:
            sets = ", ".join(f"{k} = %({k})s" for k in changes)
            await conn.execute(f"UPDATE exams SET {sets} WHERE id = %(_id)s", {**changes, "_id": eid})
        return await _exam_detail(conn, eid, gid)


@router.delete("/exams/{exam_id}", status_code=204, summary="Delete an exam with its results")
async def delete_exam(
    exam_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:write"))], db: DB
) -> Response:
    async with db.tx(p.session()) as conn:
        eid, _ = await _exam(conn, p, exam_id)
        await execute(conn, "DELETE FROM exams WHERE id = %s", (eid,))
    return Response(status_code=204)


@router.put(
    "/exams/{exam_id}/results", response_model=ExamDetail, summary="Save scores (upsert, one per student)"
)
async def put_results(
    exam_id: uuid.UUID, body: ResultsIn, p: Annotated[Principal, Depends(require("results:write"))], db: DB
) -> ExamDetail:
    async with db.tx(p.session()) as conn:
        eid, gid = await _exam(conn, p, exam_id)
        seen: set[uuid.UUID] = set()
        for rec in body.records:
            if rec.student_id in seen:
                raise Unprocessable("A student appears twice in the request")
            seen.add(rec.student_id)
        for rec in body.records:
            sid = await resolve(conn, "students", rec.student_id, what="student")
            await execute(
                conn,
                "INSERT INTO exam_results (org_id, exam_id, student_id, score, note, entered_by_user_id) "
                "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (exam_id, student_id) DO UPDATE "
                "SET score = EXCLUDED.score, note = EXCLUDED.note, entered_by_user_id = EXCLUDED.entered_by_user_id",
                (p.org_id, eid, sid, rec.score, rec.note, p.user_id),
            )
        return await _exam_detail(conn, eid, gid)


@router.delete("/exams/{exam_id}/results/{student_id}", status_code=204, summary="Remove one student's score")
async def delete_result(
    exam_id: uuid.UUID,
    student_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("results:write"))],
    db: DB,
) -> Response:
    async with db.tx(p.session()) as conn:
        eid, _ = await _exam(conn, p, exam_id)
        sid = await resolve(conn, "students", student_id, what="student")
        if (
            await execute(conn, "DELETE FROM exam_results WHERE exam_id = %s AND student_id = %s", (eid, sid))
            == 0
        ):
            raise NotFound("score not found")
    return Response(status_code=204)


# ---- a student's results (the guardian cabinet reads this) -------------------------------------------------------
class StudentExam(Out):
    exam_id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    title: str
    held_on: date
    score: Dec2
    max_score: Dec2
    percent: int
    note: str | None


class ReportBrief(Out):
    id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    month: str
    status: str


class CertificateBrief(Out):
    id: uuid.UUID
    number: str
    group_name: str
    course_name: str
    issued_on: date


class StudentResults(Out):
    student_id: uuid.UUID
    marks: list[MarkOut]
    exams: list[StudentExam]
    reports: list[ReportBrief]
    certificates: list[CertificateBrief]


@router.get(
    "/students/{student_id}/results",
    response_model=StudentResults,
    summary="Everything a student has: notes and grades, exam scores, progress reports, certificates",
)
async def student_results(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("results:read"))], db: DB
) -> StudentResults:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        mine = await teacher_scope(conn, p)
        args: dict[str, Any] = {"sid": sid, "mine": mine}
        marks = await fetch_all(
            conn,
            f"{_MARK_SQL} WHERE m.student_id = %(sid)s AND (%(mine)s::bigint IS NULL OR g.teacher_id = %(mine)s)"
            " ORDER BY coalesce(l.lesson_date, m.period_month) DESC, m.id DESC LIMIT 500",
            args,
        )
        exam_rows = await fetch_all(
            conn,
            "SELECT e.public_id AS exam_id, g.public_id AS group_id, g.name AS group_name, e.title, e.held_on,"
            " r.score, e.max_score, r.note "
            "FROM exam_results r JOIN exams e ON e.org_id = r.org_id AND e.id = r.exam_id "
            "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
            "WHERE r.student_id = %(sid)s AND (%(mine)s::bigint IS NULL OR g.teacher_id = %(mine)s) "
            "ORDER BY e.held_on DESC, e.id DESC LIMIT 200",
            args,
        )
        reports = await fetch_all(
            conn,
            "SELECT pr.public_id AS id, g.public_id AS group_id, g.name AS group_name,"
            " to_char(pr.period_month, 'YYYY-MM') AS month, pr.status "
            "FROM progress_reports pr JOIN study_groups g ON g.org_id = pr.org_id AND g.id = pr.group_id "
            "WHERE pr.student_id = %(sid)s AND (%(mine)s::bigint IS NULL OR g.teacher_id = %(mine)s) "
            "ORDER BY pr.period_month DESC, pr.id DESC LIMIT 200",
            args,
        )
        certs = await fetch_all(
            conn,
            "SELECT c.public_id AS id, c.number, g.name AS group_name, c.snapshot->>'course_name' AS course_name, c.issued_on "
            "FROM certificates c JOIN study_groups g ON g.org_id = c.org_id AND g.id = c.group_id "
            "WHERE c.student_id = %(sid)s AND c.voided_at IS NULL AND (%(mine)s::bigint IS NULL OR g.teacher_id = %(mine)s) "
            "ORDER BY c.issued_on DESC, c.id DESC",
            args,
        )
    return StudentResults(
        student_id=student_id,
        marks=[MarkOut.model_validate(r) for r in marks],
        exams=[StudentExam(**r, percent=R.exam_percent(r["score"], r["max_score"])) for r in exam_rows],
        reports=[ReportBrief.model_validate(r) for r in reports],
        certificates=[CertificateBrief.model_validate(r) for r in certs],
    )
