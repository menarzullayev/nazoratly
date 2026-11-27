"""Guardian cabinet, the guardian's side (Mini App and web portal use these endpoints; the bot uses the same service).

Sign-in: Telegram Mini App `initData` (signature checked with the bot token) or phone + a 6-digit code delivered to the
guardian's own Telegram chat. The result is an opaque session token (`gs_...`). A guardian sees only the students linked
to him, and only after the privacy consent is accepted; every action he takes is a REQUEST that the center approves."""

from __future__ import annotations

import hmac
import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import Field

from nazoratly.db import Database, Session, execute, fetch_all, fetch_one
from nazoratly.deps import DB, Cfg, request_id_of
from nazoratly.errors import Forbidden, NotFound, Unauthorized
from nazoratly.guardian_service import (
    GuardianCtx,
    attendance_view,
    balance_view,
    cabinet_settings,
    cancel_request,
    create_absence,
    create_makeup,
    create_promise,
    create_session,
    documents_view,
    grant_consent,
    linked_students,
    list_requests,
    makeup_view,
    new_login_code,
    resolve_session,
    results_view,
    schedule_view,
    sha256_hex,
    student_of,
    upcoming_lessons_for_absence,
)
from nazoratly.guardian_telegram import verify_init_data
from nazoratly.rules import guardian as G
from nazoratly.schemas import Dec2, Model, Out
from nazoratly.telegram_delivery import send_text
from nazoratly.telegram_registry import shared_token

router = APIRouter(prefix="/v1/cabinet", tags=["guardian cabinet"])
_bearer = HTTPBearer(auto_error=False, description="Guardian session token (gs_...) from /v1/cabinet/auth/*")
_ANON = Session(user_id=None, org_id=None, actor_type="system")


async def current_guardian(
    request: Request, db: DB, creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]
) -> GuardianCtx:
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials.startswith("gs_"):
        raise Unauthorized("Missing guardian session", headers={"WWW-Authenticate": "Bearer"})
    rid = request_id_of(request)
    async with db.tx(Session(user_id=None, org_id=None, request_id=rid, actor_type="system")) as conn:
        session_id, org_id, guardian_id = await resolve_session(conn, creds.credentials)
    ctx = GuardianCtx(org_id, guardian_id, session_id, rid)
    async with db.tx(ctx.session()) as conn:
        enabled, _ = await cabinet_settings(conn)
        still = await fetch_one(
            conn, "SELECT 1 AS x FROM student_guardians WHERE guardian_id = %s LIMIT 1", (guardian_id,)
        )
    if not enabled:
        raise Forbidden(
            "The guardian cabinet is switched off for this center", details={"reason": "cabinet_disabled"}
        )
    if still is None:
        raise Unauthorized("No student is linked to this account")
    return ctx


Me = Annotated[GuardianCtx, Depends(current_guardian)]


# ---- sign-in -----------------------------------------------------------------------------------------------------
class TokenOut(Out):
    token: str
    expires_at: datetime
    kind: Literal["miniapp", "portal"]


class TelegramLoginIn(Model):
    init_data: str = Field(min_length=10, max_length=4096)
    choice: int | None = Field(
        default=None, ge=0, description="which center, when the Telegram account is linked in several"
    )


@router.post(
    "/auth/telegram",
    response_model=TokenOut,
    summary="Mini App sign-in: send Telegram's `initData`; the signature and its age are checked",
)
async def auth_telegram(body: TelegramLoginIn, request: Request, db: DB, cfg: Cfg) -> TokenOut:
    token_of_bot = await shared_token(db, cfg, request.app.state.secrets_box)
    if token_of_bot is None:
        raise NotFound("Telegram sign-in is not configured")
    user = verify_init_data(body.init_data, token_of_bot)
    if user is None:
        raise Unauthorized("Telegram data is not valid or has expired")
    tg = int(user["id"])
    async with db.tx(_ANON) as conn:
        found = await fetch_all(conn, "SELECT * FROM guardian_find_by_telegram(%s)", (tg,))
    if not found:
        raise Forbidden("This Telegram account is not linked to a student", details={"reason": "not_linked"})
    if len(found) > 1 and body.choice is None:
        raise Forbidden(
            "This Telegram account is linked in several centers: choose one",
            details={
                "reason": "choose_center",
                "choices": [{"index": i, "center": r["center_name"]} for i, r in enumerate(found)],
            },
        )
    pick = found[body.choice or 0] if (body.choice or 0) < len(found) else None
    if pick is None:
        raise Unauthorized("Unknown choice")
    ctx = GuardianCtx(int(pick["org_id"]), int(pick["guardian_id"]), None, "")
    async with db.tx(ctx.session()) as conn:
        enabled, _ = await cabinet_settings(conn)
        if not enabled:
            raise Forbidden(
                "The guardian cabinet is switched off for this center", details={"reason": "cabinet_disabled"}
            )
        token, exp = await create_session(
            conn, org_id=ctx.org_id, guardian_id=ctx.guardian_id, kind="miniapp", telegram_user_id=tg
        )
    return TokenOut(token=token, expires_at=exp, kind="miniapp")


class PhoneIn(Model):
    phone: str = Field(min_length=1, max_length=30)


class LoginCodeAccepted(Out):
    status: Literal["sent"] = "sent"


@router.post(
    "/auth/code/request",
    response_model=LoginCodeAccepted,
    status_code=202,
    summary="Portal sign-in, step 1: a 6-digit code is sent to the guardian's own Telegram chat (always 202: no enumeration)",
)
async def auth_code_request(body: PhoneIn, request: Request, db: DB, cfg: Cfg) -> LoginCodeAccepted:
    key = G.phone_key(body.phone)
    if not key:
        return LoginCodeAccepted()
    async with db.tx(_ANON) as conn:
        found = await fetch_all(conn, "SELECT * FROM guardian_find_by_phone(%s)", (key,))
    for f in found:
        ctx = GuardianCtx(int(f["org_id"]), int(f["guardian_id"]), None, "")
        code = new_login_code()
        async with db.tx(ctx.session()) as conn:
            g = await fetch_one(
                conn, "SELECT telegram_chat_id FROM guardians WHERE id = %s", (ctx.guardian_id,)
            )
            linked = await fetch_one(
                conn,
                "SELECT 1 AS x FROM student_guardians WHERE guardian_id = %s LIMIT 1",
                (ctx.guardian_id,),
            )
            recent = await fetch_one(
                conn,
                "SELECT count(*) AS n FROM guardian_login_codes WHERE guardian_id = %s AND created_at > now() - interval '1 hour'",
                (ctx.guardian_id,),
            )
            if g is None or g["telegram_chat_id"] is None or linked is None or (recent and recent["n"] >= 5):
                continue
            await execute(
                conn,
                "UPDATE guardian_login_codes SET used_at = now() WHERE guardian_id = %s AND used_at IS NULL",
                (ctx.guardian_id,),
            )
            await execute(
                conn,
                "INSERT INTO guardian_login_codes (org_id, guardian_id, code_hash, expires_at) "
                "VALUES (%s, %s, %s, now() + make_interval(secs => %s))",
                (ctx.org_id, ctx.guardian_id, sha256_hex(code), G.LOGIN_TTL_S),
            )
            chat = int(g["telegram_chat_id"])
        await send_text(
            db,
            cfg,
            request.app.state.secrets_box,
            getattr(request.app.state, "outbound_transport", None),
            org_id=ctx.org_id,
            chat_id=chat,
            text=f"Nazoratly kirish kodi: {code}\n10 daqiqa amal qiladi. Siz so'ramagan bo'lsangiz, e'tibor bermang.",
        )
    return LoginCodeAccepted()


class CodeLoginIn(Model):
    phone: str = Field(min_length=5, max_length=30)
    code: str = Field(min_length=4, max_length=12)


@router.post(
    "/auth/code/verify",
    response_model=TokenOut,
    summary="Portal sign-in, step 2: the code from Telegram (5 attempts per code, 10 minutes)",
)
async def auth_code_verify(body: CodeLoginIn, db: DB) -> TokenOut:
    key = G.phone_key(body.phone)
    async with db.tx(_ANON) as conn:
        found = await fetch_all(conn, "SELECT * FROM guardian_find_by_phone(%s)", (key,)) if key else []
    wrong = Unauthorized("The code is not valid")
    digits = "".join(ch for ch in body.code if ch.isdigit())
    for f in found:
        ctx = GuardianCtx(int(f["org_id"]), int(f["guardian_id"]), None, "")
        async with db.tx(ctx.session()) as conn:
            row = await fetch_one(
                conn,
                "SELECT id, code_hash, attempts, used_at, expires_at, now() AS now FROM guardian_login_codes "
                "WHERE guardian_id = %s ORDER BY id DESC LIMIT 1 FOR UPDATE",
                (ctx.guardian_id,),
            )
            if row is None:
                continue
            state = G.login_code_state(
                expires_at=row["expires_at"],
                now=row["now"],
                attempts=int(row["attempts"]),
                max_attempts=G.LOGIN_MAX_ATTEMPTS,
                used=row["used_at"] is not None,
            )
            if state != "ok":
                continue
            if not hmac.compare_digest(sha256_hex(digits), row["code_hash"]):
                await execute(
                    conn,
                    "UPDATE guardian_login_codes SET attempts = attempts + 1 WHERE id = %s",
                    (row["id"],),
                )
                continue
            enabled, _ = await cabinet_settings(conn)
            if not enabled:
                raise Forbidden(
                    "The guardian cabinet is switched off for this center",
                    details={"reason": "cabinet_disabled"},
                )
            await execute(conn, "UPDATE guardian_login_codes SET used_at = now() WHERE id = %s", (row["id"],))
            token, exp = await create_session(
                conn, org_id=ctx.org_id, guardian_id=ctx.guardian_id, kind="portal", telegram_user_id=None
            )
            return TokenOut(token=token, expires_at=exp, kind="portal")
    raise wrong


@router.post("/auth/logout", status_code=204, summary="End this session")
async def logout(ctx: Me, db: DB) -> Response:
    async with db.tx(ctx.session()) as conn:
        await execute(
            conn, "UPDATE guardian_sessions SET revoked_at = now() WHERE id = %s", (ctx.session_id,)
        )
    return Response(status_code=204)


# ---- who am I ----------------------------------------------------------------------------------------------------
class StudentBrief(Out):
    id: uuid.UUID
    full_name: str
    relation: str
    consent: bool


class MeOut(Out):
    guardian_id: uuid.UUID
    full_name: str
    center: str
    promise_max_days: int
    students: list[StudentBrief]


@router.get("/me", response_model=MeOut, summary="The guardian, his center and the students linked to him")
async def me(ctx: Me, db: DB) -> MeOut:
    async with db.tx(ctx.session()) as conn:
        g = await fetch_one(
            conn, "SELECT public_id, full_name FROM guardians WHERE id = %s", (ctx.guardian_id,)
        )
        org = await fetch_one(conn, "SELECT name FROM organizations WHERE id = %s", (ctx.org_id,))
        students = await linked_students(conn, ctx.guardian_id)
        _, max_days = await cabinet_settings(conn)
    assert g is not None and org is not None
    return MeOut(
        guardian_id=g["public_id"],
        full_name=g["full_name"],
        center=org["name"],
        promise_max_days=max_days,
        students=[StudentBrief.model_validate(s) for s in students],
    )


class ConsentOut(Out):
    student_id: uuid.UUID
    consent: bool


@router.post(
    "/students/{student_id}/consent",
    response_model=ConsentOut,
    summary="The guardian accepts the privacy terms for this student (needed before anything is shown)",
)
async def accept_consent(student_id: uuid.UUID, ctx: Me, db: DB) -> ConsentOut:
    async with db.tx(ctx.session()) as conn:
        s = await student_of(conn, ctx.guardian_id, student_id, need_consent=False)
        await grant_consent(conn, org_id=ctx.org_id, student_id=int(s["sid"]), guardian_id=ctx.guardian_id)
    return ConsentOut(student_id=student_id, consent=True)


# ---- reads -------------------------------------------------------------------------------------------------------
class AttendanceRecord(Out):
    lesson_date: date
    start_time: time
    group_name: str
    status: Literal["present", "absent", "late", "excused"]
    minutes_late: int
    kind: str


class AttendanceOut(Out):
    since: date
    counts: dict[str, int]
    records: list[AttendanceRecord]


@router.get(
    "/students/{student_id}/attendance",
    response_model=AttendanceOut,
    summary="Attendance of the last 90 days",
)
async def attendance(
    student_id: uuid.UUID, ctx: Me, db: DB, days: Annotated[int, Query(ge=1, le=365)] = 90
) -> AttendanceOut:
    async with db.tx(ctx.session()) as conn:
        s = await student_of(conn, ctx.guardian_id, student_id)
        data = await attendance_view(conn, int(s["sid"]), days)
    return AttendanceOut.model_validate(data)


class OpenChargeOut(Out):
    id: uuid.UUID
    kind: str
    period_month: date
    due_date: date
    amount: Dec2
    paid: Dec2
    outstanding: Dec2
    overdue: bool
    overdue_amount: Dec2
    next_due: date | None
    plan: dict[str, Any] | None


class PaymentBrief(Out):
    id: uuid.UUID
    amount: Dec2
    method: str
    paid_at: datetime


class PromiseOut(Out):
    id: uuid.UUID
    status: str
    state: str
    promise_date: date
    promise_amount: Dec2 | None
    created_at: datetime
    decision_note: str | None


class BalanceOut(Out):
    outstanding_total: Dec2
    overdue_total: Dec2
    credit: Dec2
    open_charges: list[OpenChargeOut]
    recent_payments: list[PaymentBrief]
    promises: list[PromiseOut]


@router.get(
    "/students/{student_id}/balance",
    response_model=BalanceOut,
    summary="Debt, payment plan, recent payments, promises",
)
async def balance(student_id: uuid.UUID, ctx: Me, db: DB) -> BalanceOut:
    async with db.tx(ctx.session()) as conn:
        s = await student_of(conn, ctx.guardian_id, student_id)
        data = await balance_view(conn, int(s["sid"]))
    return BalanceOut.model_validate(data)


class DocumentBrief(Out):
    id: uuid.UUID
    kind: Literal["receipt", "invoice"]
    number: str
    issued_on: date
    total: Dec2


@router.get(
    "/students/{student_id}/documents", response_model=list[DocumentBrief], summary="Receipts and invoices"
)
async def documents(student_id: uuid.UUID, ctx: Me, db: DB) -> list[DocumentBrief]:
    async with db.tx(ctx.session()) as conn:
        s = await student_of(conn, ctx.guardian_id, student_id)
        rows = await documents_view(conn, int(s["sid"]))
    return [DocumentBrief.model_validate(r) for r in rows]


_PDF: dict[int | str, dict[str, Any]] = {200: {"content": {"application/pdf": {}}}}


async def _pdf(db: Database, ctx: GuardianCtx, sql: str, public_id: uuid.UUID, name: str) -> Response:
    async with db.tx(ctx.session()) as conn:
        row = await fetch_one(conn, sql, (public_id,))
        if row is not None:  # consent of the student the file belongs to
            s = await fetch_one(
                conn,
                "SELECT 1 AS x FROM data_consents WHERE student_id = %s AND purpose = 'data_processing' AND revoked_at IS NULL",
                (row["student_id"],),
            )
            if s is None:
                raise Forbidden(
                    "The privacy consent has not been accepted yet", details={"reason": "consent_required"}
                )
    if row is None:
        raise NotFound("file not found")
    return Response(
        content=bytes(row["pdf"]),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{name.format(**row)}"'},
    )


@router.get(
    "/documents/{document_id}/pdf",
    response_class=Response,
    responses=_PDF,
    summary="PDF of a receipt or invoice",
)
async def document_pdf(document_id: uuid.UUID, ctx: Me, db: DB) -> Response:
    return await _pdf(
        db,
        ctx,
        "SELECT d.student_id, d.number, f.pdf FROM documents d JOIN document_files f ON f.org_id = d.org_id AND f.document_id = d.id WHERE d.public_id = %s",
        document_id,
        "{number}.pdf",
    )


class LessonOut(Out):
    id: uuid.UUID
    lesson_date: date
    start_time: time
    end_time: time
    status: Literal["planned", "held", "cancelled"]
    kind: str
    group_name: str


class WeeklySlot(Out):
    group_name: str
    weekday: int
    start_time: time
    end_time: time


class ScheduleOut(Out):
    from_: date = Field(alias="from")
    to: date
    lessons: list[LessonOut]
    weekly: list[WeeklySlot]


@router.get(
    "/students/{student_id}/schedule",
    response_model=ScheduleOut,
    response_model_by_alias=True,
    summary="Lessons of the next 30 days and the weekly timetable",
)
async def schedule(student_id: uuid.UUID, ctx: Me, db: DB) -> ScheduleOut:
    async with db.tx(ctx.session()) as conn:
        s = await student_of(conn, ctx.guardian_id, student_id)
        data = await schedule_view(conn, int(s["sid"]))
    return ScheduleOut.model_validate(data)


class MarkBrief(Out):
    id: uuid.UUID
    group_name: str
    scope: Literal["lesson", "month"]
    lesson_date: date | None
    month: str | None
    grade: int | None
    note: str | None


class ExamBrief(Out):
    id: uuid.UUID
    group_name: str
    title: str
    held_on: date
    score: Dec2
    max_score: Dec2
    note: str | None


class ReportBrief(Out):
    id: uuid.UUID
    group_name: str
    month: str


class CertificateBrief(Out):
    id: uuid.UUID
    number: str
    group_name: str
    issued_on: date


class ResultsOut(Out):
    marks: list[MarkBrief]
    exams: list[ExamBrief]
    reports: list[ReportBrief]
    certificates: list[CertificateBrief]


@router.get(
    "/students/{student_id}/results",
    response_model=ResultsOut,
    summary="Notes, grades, exams, approved progress reports, certificates",
)
async def results(student_id: uuid.UUID, ctx: Me, db: DB) -> ResultsOut:
    async with db.tx(ctx.session()) as conn:
        s = await student_of(conn, ctx.guardian_id, student_id)
        data = await results_view(conn, int(s["sid"]))
    return ResultsOut.model_validate(data)


@router.get(
    "/reports/{report_id}/pdf",
    response_class=Response,
    responses=_PDF,
    summary="PDF of an approved progress report",
)
async def report_pdf(report_id: uuid.UUID, ctx: Me, db: DB) -> Response:
    return await _pdf(
        db,
        ctx,
        "SELECT r.student_id, to_char(r.period_month, 'YYYY-MM') AS month, f.pdf FROM progress_reports r "
        "JOIN progress_report_files f ON f.org_id = r.org_id AND f.report_id = r.id WHERE r.public_id = %s AND r.status = 'approved'",
        report_id,
        "hisobot-{month}.pdf",
    )


@router.get(
    "/certificates/{certificate_id}/pdf",
    response_class=Response,
    responses=_PDF,
    summary="PDF of a certificate",
)
async def certificate_pdf(certificate_id: uuid.UUID, ctx: Me, db: DB) -> Response:
    return await _pdf(
        db,
        ctx,
        "SELECT c.student_id, c.number, f.pdf FROM certificates c "
        "JOIN certificate_files f ON f.org_id = c.org_id AND f.certificate_id = c.id WHERE c.public_id = %s AND c.voided_at IS NULL",
        certificate_id,
        "{number}.pdf",
    )


# ---- requests ----------------------------------------------------------------------------------------------------
class AbsenceLesson(Out):
    id: uuid.UUID
    lesson_date: date
    start_time: time
    end_time: time
    group_name: str
    kind: str


@router.get(
    "/students/{student_id}/absence-lessons",
    response_model=list[AbsenceLesson],
    summary="Upcoming lessons a guardian can still announce an absence for",
)
async def absence_lessons(student_id: uuid.UUID, ctx: Me, db: DB) -> list[AbsenceLesson]:
    async with db.tx(ctx.session()) as conn:
        s = await student_of(conn, ctx.guardian_id, student_id)
        rows = await upcoming_lessons_for_absence(conn, int(s["sid"]))
    return [AbsenceLesson.model_validate(r) for r in rows]


class SlotOut(Out):
    lesson_id: uuid.UUID
    group_name: str
    date: date
    start_time: time
    end_time: time


class MakeupRight(Out):
    id: uuid.UUID
    group_name: str
    missed_on: date
    expires_on: date
    slots: list[SlotOut]


@router.get(
    "/students/{student_id}/makeup",
    response_model=list[MakeupRight],
    summary="Open make-up rights with the slots that can be chosen",
)
async def makeup(student_id: uuid.UUID, ctx: Me, db: DB) -> list[MakeupRight]:
    async with db.tx(ctx.session()) as conn:
        s = await student_of(conn, ctx.guardian_id, student_id)
        rows = await makeup_view(conn, int(s["sid"]))
    return [MakeupRight.model_validate(r) for r in rows]


class AbsenceIn(Model):
    kind: Literal["absence_reason"]
    student_id: uuid.UUID
    lesson_id: uuid.UUID
    reason: str = Field(max_length=2000)


class PromiseIn(Model):
    kind: Literal["payment_promise"]
    student_id: uuid.UUID
    promise_date: date
    amount: Annotated[Decimal, Field(max_digits=14, decimal_places=2)] | None = None


class MakeupIn(Model):
    kind: Literal["makeup_choice"]
    student_id: uuid.UUID
    entitlement_id: uuid.UUID
    slot_lesson_id: uuid.UUID


RequestIn = Annotated[AbsenceIn | PromiseIn | MakeupIn, Field(discriminator="kind")]


class MyRequest(Out):
    id: uuid.UUID
    kind: Literal["absence_reason", "payment_promise", "makeup_choice"]
    status: Literal["pending", "approved", "rejected", "cancelled"]
    student_id: uuid.UUID
    student_name: str
    reason: str | None
    lesson_date: date | None
    promise_date: date | None
    promise_amount: Dec2 | None
    slot_date: date | None
    created_at: datetime
    decided_at: datetime | None
    decision_note: str | None


async def _my_request(conn: Any, ctx: GuardianCtx, public_id: uuid.UUID) -> MyRequest:
    rows = await list_requests(conn, guardian_id=ctx.guardian_id, limit=500)
    return MyRequest.model_validate(next(r for r in rows if r["id"] == public_id))


@router.post(
    "/requests",
    response_model=MyRequest,
    status_code=201,
    summary="Ask the center for something (absence reason, payment promise, make-up slot). Nothing changes until it approves.",
)
async def create_request(body: RequestIn, ctx: Me, db: DB) -> MyRequest:
    async with db.tx(ctx.session()) as conn:
        s = await student_of(conn, ctx.guardian_id, body.student_id)
        if isinstance(body, AbsenceIn):
            pid = await create_absence(conn, ctx, s, body.lesson_id, body.reason)
        elif isinstance(body, PromiseIn):
            pid = await create_promise(conn, ctx, s, body.promise_date, body.amount)
        else:
            pid = await create_makeup(conn, ctx, s, body.entitlement_id, body.slot_lesson_id)
        return await _my_request(conn, ctx, pid)


@router.get("/requests", response_model=list[MyRequest], summary="My requests and what the center decided")
async def my_requests(ctx: Me, db: DB) -> list[MyRequest]:
    async with db.tx(ctx.session()) as conn:
        rows = await list_requests(conn, guardian_id=ctx.guardian_id, limit=100)
    return [MyRequest.model_validate(r) for r in rows]


@router.post(
    "/requests/{request_id}/cancel",
    response_model=MyRequest,
    summary="Withdraw a request that is still waiting",
)
async def cancel(request_id: uuid.UUID, ctx: Me, db: DB) -> MyRequest:
    async with db.tx(ctx.session()) as conn:
        await cancel_request(conn, ctx.guardian_id, request_id)
        return await _my_request(conn, ctx, request_id)
