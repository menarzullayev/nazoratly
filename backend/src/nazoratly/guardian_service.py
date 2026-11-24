"""Guardian cabinet service layer: codes, linking, sessions, what a guardian reads, and his requests with their approval.

Used by the staff router (`/v1/guardian`), the cabinet router (`/v1/cabinet`) and the Telegram bot. Every function takes a
connection that is already inside the right tenant session; guardian sessions are additionally fenced by the database
(migration 0064). The rules (what is allowed, status transitions, effects) live in `rules/guardian.py`."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from nazoratly.accounting import org_today
from nazoratly.db import Conn, Session, execute, fetch_all, fetch_one
from nazoratly.deps import Principal
from nazoratly.errors import Conflict, Forbidden, NotFound, Unauthorized, Unprocessable
from nazoratly.routers.entitlements import sync_entitlement
from nazoratly.routers.lessons import _roster
from nazoratly.routers.plans import _plan
from nazoratly.rules import guardian as G

SESSION_HOURS = {"miniapp": 24, "portal": 12}
POLICY_VERSION = "guardian-cabinet-2026-11"
LINK_ATTEMPTS_PER_HOUR = 10
GUARDIAN_NO_SEAT_LIMIT = 999  # a group without capacity has no seat limit

REASON_TEXT = {
    "reason_required": "Sababni yozing.",
    "reason_too_long": f"Sabab {G.REASON_MAX} belgidan oshmasligi kerak.",
    "not_in_group": "O'quvchi bu darsning guruhida emas.",
    "lesson_cancelled": "Bu dars bekor qilingan.",
    "lesson_started": "Dars boshlanib bo'lgan: ogohlantirishni darsdan oldin yuboring.",
    "already_marked": "Bu dars uchun davomat belgilangan.",
    "no_debt": "Qarz yo'q.",
    "duplicate": "Kutilayotgan yoki amaldagi va'da bor.",
    "date_past": "Sana o'tib ketgan.",
    "date_too_far": "Sana juda uzoq: markaz ruxsat bergan muddatdan oshmasin.",
    "amount_invalid": "Summa noto'g'ri: qarzdan oshmasin.",
    "not_makeup": "Bu huquq qoplash darsi emas.",
    "not_open": "Qoplash huquqi ochiq emas.",
    "expired": "Qoplash huquqi muddati tugagan.",
    "slot_unavailable": "Bu vaqt endi mavjud emas, boshqasini tanlang.",
}


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def tok(public_id: uuid.UUID | str) -> str:
    """Short stable token of a public id for Telegram callback data (64 bytes max)."""
    return str(public_id).replace("-", "")[:12]


def new_link_code() -> str:
    return "".join(secrets.choice(G.CODE_ALPHABET) for _ in range(G.CODE_LENGTH))


def new_login_code() -> str:
    return f"{secrets.randbelow(10**G.LOGIN_CODE_LENGTH):0{G.LOGIN_CODE_LENGTH}d}"


async def org_now(conn: Conn) -> datetime:
    """The organization's wall-clock time as a naive datetime (lesson times are local)."""
    row = await fetch_one(
        conn, "SELECT (now() AT TIME ZONE o.timezone) AS n FROM organizations o WHERE o.id = app_org_id()"
    )
    assert row is not None
    n: datetime = row["n"]
    return n


def unprocessable(reason: str) -> Unprocessable:
    return Unprocessable(REASON_TEXT.get(reason, reason), details={"reason": reason})


# ---- the authenticated guardian ----------------------------------------------------------------------------------
@dataclass(frozen=True)
class GuardianCtx:
    org_id: int
    guardian_id: int
    session_id: int | None
    request_id: str

    def session(self) -> Session:
        return Session(
            user_id=None,
            org_id=self.org_id,
            request_id=self.request_id,
            actor_type="system",
            guardian_id=self.guardian_id,
        )


async def cabinet_settings(conn: Conn) -> tuple[bool, int]:
    row = await fetch_one(
        conn,
        "SELECT guardian_cabinet_enabled, guardian_promise_max_days FROM org_settings WHERE org_id = app_org_id()",
    )
    if row is None:
        return True, 14
    return bool(row["guardian_cabinet_enabled"]), int(row["guardian_promise_max_days"])


async def create_session(
    conn: Conn, *, org_id: int, guardian_id: int, kind: str, telegram_user_id: int | None
) -> tuple[str, datetime]:
    token = "gs_" + secrets.token_urlsafe(32)
    row = await fetch_one(
        conn,
        "INSERT INTO guardian_sessions (org_id, guardian_id, token_hash, kind, telegram_user_id, expires_at) "
        "VALUES (%s, %s, %s, %s, %s, now() + make_interval(hours => %s)) RETURNING expires_at",
        (org_id, guardian_id, sha256_hex(token), kind, telegram_user_id, SESSION_HOURS[kind]),
    )
    assert row is not None
    return token, row["expires_at"]


async def resolve_session(conn: Conn, token: str) -> tuple[int, int, int]:
    """(session id, org id, guardian id) of a live token; Unauthorized otherwise. Runs without a center."""
    row = await fetch_one(
        conn,
        "SELECT session_id, org_id, guardian_id, (expires_at > now() AND revoked_at IS NULL) AS live "
        "FROM guardian_session_find(%s)",
        (sha256_hex(token),),
    )
    if row is None or not row["live"]:
        raise Unauthorized("Session is not valid", headers={"WWW-Authenticate": "Bearer"})
    return int(row["session_id"]), int(row["org_id"]), int(row["guardian_id"])


# ---- staff: one-time codes ---------------------------------------------------------------------------------------
async def issue_link_code(
    conn: Conn, *, org_id: int, student_id: int, guardian_id: int | None, relation: str, user_id: int
) -> tuple[str, dict[str, Any]]:
    code = new_link_code()
    row = await fetch_one(
        conn,
        "INSERT INTO guardian_link_codes (org_id, student_id, guardian_id, relation, code_hash, created_by_user_id, expires_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, now() + make_interval(hours => %s)) RETURNING id, public_id, expires_at",
        (org_id, student_id, guardian_id, relation, sha256_hex(code), user_id, G.CODE_TTL_HOURS),
    )
    assert row is not None
    return code, row


# ---- linking -----------------------------------------------------------------------------------------------------
async def ensure_guardian(
    conn: Conn,
    *,
    org_id: int,
    telegram_user_id: int,
    name: str | None,
    phone: str | None,
    guardian_id: int | None,
) -> int:
    """The guardian record a Telegram user becomes: the named one, one he already is in this center, or a new one."""
    if guardian_id is not None:
        cur = await fetch_one(
            conn,
            "SELECT telegram_chat_id FROM guardians WHERE id = %s AND deleted_at IS NULL",
            (guardian_id,),
        )
        if cur is None:
            raise NotFound("guardian not found")
        if cur["telegram_chat_id"] not in (None, telegram_user_id):
            raise Conflict("This guardian is already linked to another Telegram account")
        await execute(
            conn, "UPDATE guardians SET telegram_chat_id = %s WHERE id = %s", (telegram_user_id, guardian_id)
        )
        return guardian_id
    own = await fetch_one(
        conn,
        "SELECT id FROM guardians WHERE telegram_chat_id = %s AND deleted_at IS NULL ORDER BY id LIMIT 1",
        (telegram_user_id,),
    )
    if own is not None:
        return int(own["id"])
    row = await fetch_one(
        conn,
        "INSERT INTO guardians (org_id, full_name, phone, telegram_chat_id) VALUES (%s, %s, %s, %s) RETURNING id",
        (org_id, (name or "Vasiy").strip()[:200] or "Vasiy", phone, telegram_user_id),
    )
    assert row is not None
    return int(row["id"])


async def link_student(
    conn: Conn, *, org_id: int, student_id: int, guardian_id: int, relation: str, via: str
) -> None:
    primary = await fetch_one(
        conn, "SELECT 1 AS x FROM student_guardians WHERE student_id = %s AND is_primary", (student_id,)
    )
    await execute(
        conn,
        "INSERT INTO student_guardians (org_id, student_id, guardian_id, relation, is_primary, linked_via) "
        "VALUES (%s, %s, %s, %s, %s, %s) "
        "ON CONFLICT (student_id, guardian_id) DO UPDATE SET linked_via = COALESCE(student_guardians.linked_via, EXCLUDED.linked_via)",
        (org_id, student_id, guardian_id, relation, primary is None, via),
    )


async def unlink_student(conn: Conn, *, student_id: int, guardian_id: int) -> bool:
    n = await execute(
        conn,
        "DELETE FROM student_guardians WHERE student_id = %s AND guardian_id = %s",
        (student_id, guardian_id),
    )
    if n:
        left = await fetch_one(
            conn, "SELECT 1 AS x FROM student_guardians WHERE guardian_id = %s", (guardian_id,)
        )
        if left is None:  # nothing left to see: the guardian's sessions end
            await execute(
                conn,
                "UPDATE guardian_sessions SET revoked_at = now() WHERE guardian_id = %s AND revoked_at IS NULL",
                (guardian_id,),
            )
    return bool(n)


# ---- what a guardian reads ---------------------------------------------------------------------------------------
async def linked_students(conn: Conn, guardian_id: int) -> list[dict[str, Any]]:
    return await fetch_all(
        conn,
        "SELECT s.id AS sid, s.public_id AS id, s.full_name, s.status, sg.relation, "
        "EXISTS (SELECT 1 FROM data_consents dc WHERE dc.student_id = s.id AND dc.purpose = 'data_processing' "
        "        AND dc.revoked_at IS NULL) AS consent "
        "FROM student_guardians sg JOIN students s ON s.org_id = sg.org_id AND s.id = sg.student_id "
        "WHERE sg.guardian_id = %s AND s.deleted_at IS NULL ORDER BY s.full_name, s.id",
        (guardian_id,),
    )


async def student_of(
    conn: Conn, guardian_id: int, student_public: uuid.UUID, *, need_consent: bool = True
) -> dict[str, Any]:
    """The linked student, or NotFound (a foreign student is indistinguishable from a missing one)."""
    for s in await linked_students(conn, guardian_id):
        if s["id"] == student_public:
            if need_consent and not s["consent"]:
                raise Forbidden(
                    "The privacy consent has not been accepted yet", details={"reason": "consent_required"}
                )
            return s
    raise NotFound("student not found")


async def grant_consent(conn: Conn, *, org_id: int, student_id: int, guardian_id: int) -> None:
    for purpose in ("data_processing", "notifications"):
        await execute(
            conn,
            "INSERT INTO data_consents (org_id, student_id, given_by_guardian_id, purpose, policy_version, evidence) "
            "VALUES (%s, %s, %s, %s, %s, 'guardian cabinet') ON CONFLICT (student_id, purpose) WHERE revoked_at IS NULL DO NOTHING",
            (org_id, student_id, guardian_id, purpose, POLICY_VERSION),
        )


async def attendance_view(conn: Conn, sid: int, days: int = 90) -> dict[str, Any]:
    since = (await org_today(conn)) - timedelta(days=days)
    rows = await fetch_all(
        conn,
        "SELECT l.lesson_date, l.start_time, g.name AS group_name, a.status, a.minutes_late, l.kind "
        "FROM attendance a JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id "
        "JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
        "WHERE a.student_id = %s AND l.lesson_date >= %s ORDER BY l.lesson_date DESC, l.start_time DESC LIMIT 300",
        (sid, since),
    )
    counts = dict.fromkeys(("present", "late", "absent", "excused"), 0)
    for r in rows:
        counts[r["status"]] += 1
    return {"since": since, "counts": counts, "records": rows}


async def balance_view(conn: Conn, sid: int) -> dict[str, Any]:
    bal = await fetch_one(
        conn,
        "SELECT outstanding_total, overdue_total, credit FROM v_student_balance WHERE student_id = %s",
        (sid,),
    )
    charges = await fetch_all(
        conn,
        "SELECT c.id AS cid, c.public_id AS id, b.kind, b.period_month, b.due_date, b.amount, b.paid, b.outstanding, "
        "(b.overdue_outstanding > 0) AS overdue, b.overdue_outstanding AS overdue_amount, b.next_due "
        "FROM v_charge_balance b JOIN charges c ON c.id = b.charge_id WHERE b.student_id = %s AND b.outstanding > 0 "
        "ORDER BY b.due_date, b.charge_id",
        (sid,),
    )
    out_charges = []
    for c in charges:
        plan = await _plan(conn, c.pop("cid"), c["id"])
        out_charges.append({**c, "plan": None if plan is None else plan.model_dump(mode="json")})
    payments = await fetch_all(
        conn,
        "SELECT public_id AS id, amount, method, paid_at FROM payments WHERE student_id = %s AND voided_at IS NULL "
        "ORDER BY paid_at DESC, id DESC LIMIT 10",
        (sid,),
    )
    today = await org_today(conn)
    promises = await promises_view(conn, sid, today, Decimal(bal["outstanding_total"]) if bal else Decimal(0))
    return {
        "outstanding_total": bal["outstanding_total"] if bal else Decimal(0),
        "overdue_total": bal["overdue_total"] if bal else Decimal(0),
        "credit": bal["credit"] if bal else Decimal(0),
        "open_charges": out_charges,
        "recent_payments": payments,
        "promises": promises,
    }


async def promises_view(conn: Conn, sid: int, today: date, outstanding: Decimal) -> list[dict[str, Any]]:
    rows = await fetch_all(
        conn,
        "SELECT public_id AS id, status, promise_date, promise_amount, created_at, decision_note "
        "FROM guardian_requests WHERE student_id = %s AND kind = 'payment_promise' ORDER BY id DESC LIMIT 10",
        (sid,),
    )
    for r in rows:
        r["state"] = G.promise_state(
            status=r["status"], promise_date=r["promise_date"], today=today, outstanding=outstanding
        )
    return rows


async def documents_view(conn: Conn, sid: int) -> list[dict[str, Any]]:
    return await fetch_all(
        conn,
        "SELECT public_id AS id, kind, number, issued_on, total FROM documents WHERE student_id = %s "
        "ORDER BY created_at DESC, id DESC LIMIT 100",
        (sid,),
    )


async def schedule_view(conn: Conn, sid: int, days: int = 30) -> dict[str, Any]:
    today = await org_today(conn)
    lessons = await fetch_all(
        conn,
        "SELECT l.public_id AS id, l.lesson_date, l.start_time, l.end_time, l.status, l.kind, g.name AS group_name "
        "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
        "WHERE l.group_id IN (SELECT e.group_id FROM enrollments e WHERE e.student_id = %(sid)s AND e.status IN ('trial','active')) "
        "AND l.lesson_date BETWEEN %(a)s AND %(b)s "
        "AND (l.kind <> 'makeup' OR EXISTS (SELECT 1 FROM absence_entitlements ae WHERE ae.makeup_lesson_id = l.id AND ae.student_id = %(sid)s)) "
        "ORDER BY l.lesson_date, l.start_time, l.id",
        {"sid": sid, "a": today, "b": today + timedelta(days=days)},
    )
    weekly = await fetch_all(
        conn,
        "SELECT g.name AS group_name, s.weekday, s.start_time, s.end_time FROM group_schedules s "
        "JOIN study_groups g ON g.org_id = s.org_id AND g.id = s.group_id "
        "WHERE s.group_id IN (SELECT e.group_id FROM enrollments e WHERE e.student_id = %s AND e.status IN ('trial','active')) "
        "ORDER BY s.weekday, s.start_time",
        (sid,),
    )
    return {"from": today, "to": today + timedelta(days=days), "lessons": lessons, "weekly": weekly}


async def results_view(conn: Conn, sid: int) -> dict[str, Any]:
    marks = await fetch_all(
        conn,
        "SELECT m.public_id AS id, g.name AS group_name, m.scope, l.lesson_date, to_char(m.period_month, 'YYYY-MM') AS month, "
        "m.grade, m.note FROM learning_marks m JOIN study_groups g ON g.org_id = m.org_id AND g.id = m.group_id "
        "LEFT JOIN lessons l ON l.org_id = m.org_id AND l.id = m.lesson_id WHERE m.student_id = %s "
        "ORDER BY coalesce(l.lesson_date, m.period_month) DESC, m.id DESC LIMIT 200",
        (sid,),
    )
    exams = await fetch_all(
        conn,
        "SELECT e.public_id AS id, g.name AS group_name, e.title, e.held_on, r.score, e.max_score, r.note "
        "FROM exam_results r JOIN exams e ON e.org_id = r.org_id AND e.id = r.exam_id "
        "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id WHERE r.student_id = %s "
        "ORDER BY e.held_on DESC, e.id DESC LIMIT 100",
        (sid,),
    )
    reports = await fetch_all(
        conn,
        "SELECT pr.public_id AS id, g.name AS group_name, to_char(pr.period_month, 'YYYY-MM') AS month "
        "FROM progress_reports pr JOIN study_groups g ON g.org_id = pr.org_id AND g.id = pr.group_id "
        "WHERE pr.student_id = %s AND pr.status = 'approved' ORDER BY pr.period_month DESC LIMIT 100",
        (sid,),
    )
    certs = await fetch_all(
        conn,
        "SELECT c.public_id AS id, c.number, g.name AS group_name, c.issued_on FROM certificates c "
        "JOIN study_groups g ON g.org_id = c.org_id AND g.id = c.group_id WHERE c.student_id = %s AND c.voided_at IS NULL "
        "ORDER BY c.issued_on DESC LIMIT 50",
        (sid,),
    )
    return {"marks": marks, "exams": exams, "reports": reports, "certificates": certs}


async def upcoming_lessons_for_absence(conn: Conn, sid: int) -> list[dict[str, Any]]:
    """Lessons of the student's groups a guardian can still report an absence for (not started, not cancelled, not marked)."""
    now = await org_now(conn)
    rows = await fetch_all(
        conn,
        "SELECT l.public_id AS id, l.lesson_date, l.start_time, l.end_time, g.name AS group_name, l.kind "
        "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
        "WHERE l.group_id IN (SELECT e.group_id FROM enrollments e WHERE e.student_id = %(sid)s AND e.status IN ('trial','active')) "
        "AND l.lesson_date BETWEEN %(a)s AND %(b)s AND l.status = 'planned' "
        "AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.lesson_id = l.id AND a.student_id = %(sid)s) "
        "AND (l.kind <> 'makeup' OR EXISTS (SELECT 1 FROM absence_entitlements ae WHERE ae.makeup_lesson_id = l.id AND ae.student_id = %(sid)s)) "
        "ORDER BY l.lesson_date, l.start_time, l.id LIMIT 20",
        {"sid": sid, "a": now.date(), "b": now.date() + timedelta(days=14)},
    )
    return [r for r in rows if datetime.combine(r["lesson_date"], r["start_time"]) > now]


async def makeup_view(conn: Conn, sid: int) -> list[dict[str, Any]]:
    """Open make-up rights of the student with the slots a guardian may choose."""
    today = await org_today(conn)
    rights = await fetch_all(
        conn,
        "SELECT ae.id AS aid, ae.public_id AS id, ae.expires_on, g.name AS group_name, ml.lesson_date AS missed_on "
        "FROM absence_entitlements ae JOIN study_groups g ON g.org_id = ae.org_id AND g.id = ae.group_id "
        "JOIN lessons ml ON ml.org_id = ae.org_id AND ml.id = ae.missed_lesson_id "
        "WHERE ae.student_id = %s AND ae.kind = 'makeup' AND ae.status = 'open' AND ae.expires_on >= %s ORDER BY ae.expires_on, ae.id",
        (sid, today),
    )
    out = []
    for r in rights:
        slots = await slots_for(conn, r["aid"], today, r["expires_on"])
        r.pop("aid")
        out.append({**r, "slots": slots})
    return out


async def slots_for(conn: Conn, entitlement_id: int, today: date, expires_on: date) -> list[dict[str, Any]]:
    rows = await fetch_all(conn, "SELECT * FROM guardian_makeup_slots(%s)", (entitlement_id,))
    by_id = {str(r["lesson_id"]): r for r in rows}
    cands = [
        G.SlotCandidate(
            str(r["lesson_id"]),
            r["lesson_date"],
            r["start_time"].strftime("%H:%M"),
            GUARDIAN_NO_SEAT_LIMIT if r["seats_left"] is None else int(r["seats_left"]),
        )
        for r in rows
    ]
    chosen = G.makeup_options(candidates=cands, today=today, expires_on=expires_on)
    return [
        {
            "lesson_id": by_id[i]["lesson_public_id"],
            "internal_id": int(i),
            "group_name": by_id[i]["group_name"],
            "date": by_id[i]["lesson_date"],
            "start_time": by_id[i]["start_time"],
            "end_time": by_id[i]["end_time"],
        }
        for i in chosen
    ]


# ---- requests ----------------------------------------------------------------------------------------------------
_REQUEST_SQL = (
    "SELECT r.public_id AS id, r.kind, r.status, r.created_at, r.decided_at, r.decision_note, r.reason, r.promise_date, "
    "r.promise_amount, s.public_id AS student_id, s.full_name AS student_name, gd.public_id AS guardian_id, "
    "gd.full_name AS guardian_name, l.lesson_date, l.start_time, sl.lesson_date AS slot_date, sl.start_time AS slot_start "
    "FROM guardian_requests r JOIN students s ON s.org_id = r.org_id AND s.id = r.student_id "
    "JOIN guardians gd ON gd.org_id = r.org_id AND gd.id = r.guardian_id "
    "LEFT JOIN lessons l ON l.org_id = r.org_id AND l.id = r.lesson_id "
    "LEFT JOIN lessons sl ON sl.org_id = r.org_id AND sl.id = r.slot_lesson_id"
)


async def list_requests(
    conn: Conn,
    *,
    guardian_id: int | None = None,
    status: str | None = None,
    kind: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    return await fetch_all(
        conn,
        f"{_REQUEST_SQL} WHERE (%s::bigint IS NULL OR r.guardian_id = %s) AND (%s::text IS NULL OR r.status = %s) "
        "AND (%s::text IS NULL OR r.kind = %s) ORDER BY r.id DESC LIMIT %s",
        (guardian_id, guardian_id, status, status, kind, kind, limit),
    )


async def create_absence(
    conn: Conn, ctx: GuardianCtx, student: dict[str, Any], lesson_public: uuid.UUID, reason: str
) -> uuid.UUID:
    lesson = await fetch_one(
        conn,
        "SELECT l.id, l.group_id, l.lesson_date, l.start_time, l.status, l.kind FROM lessons l WHERE l.public_id = %s",
        (lesson_public,),
    )
    if lesson is None:
        raise NotFound("lesson not found")
    roster = {r["sid"]: r for r in await _roster(conn, lesson)}
    mine = roster.get(student["sid"])
    verdict = G.absence_check(
        reason=reason,
        lesson_start=datetime.combine(lesson["lesson_date"], lesson["start_time"]),
        now=await org_now(conn),
        lesson_status=str(lesson["status"]),
        in_group=mine is not None,
        existing_mark=None if mine is None or mine["status"] is None else str(mine["status"]),
    )
    if verdict != "ok":
        raise unprocessable(verdict)
    if await fetch_one(
        conn,
        "SELECT 1 AS x FROM guardian_requests WHERE student_id = %s AND lesson_id = %s AND kind = 'absence_reason' AND status = 'pending'",
        (student["sid"], lesson["id"]),
    ):
        raise Conflict("Bu dars uchun so'rov allaqachon yuborilgan va markaz javobini kutmoqda.")
    row = await fetch_one(
        conn,
        "INSERT INTO guardian_requests (org_id, guardian_id, student_id, kind, lesson_id, reason) "
        "VALUES (%s, %s, %s, 'absence_reason', %s, %s) RETURNING public_id",
        (ctx.org_id, ctx.guardian_id, student["sid"], lesson["id"], reason.strip()),
    )
    assert row is not None
    return row["public_id"]  # type: ignore[no-any-return]


async def create_promise(
    conn: Conn, ctx: GuardianCtx, student: dict[str, Any], promise_date: date, amount: Decimal | None
) -> uuid.UUID:
    today = await org_today(conn)
    _, max_days = await cabinet_settings(conn)
    bal = await fetch_one(
        conn, "SELECT outstanding_total FROM v_student_balance WHERE student_id = %s", (student["sid"],)
    )
    outstanding = Decimal(bal["outstanding_total"]) if bal else Decimal(0)
    active = await fetch_one(
        conn,
        "SELECT 1 AS x FROM guardian_requests WHERE student_id = %s AND kind = 'payment_promise' "
        "AND (status = 'pending' OR (status = 'approved' AND promise_date >= %s))",
        (student["sid"], today),
    )
    verdict = G.promise_check(
        today=today,
        promise_date=promise_date,
        outstanding=outstanding,
        amount=amount,
        max_days=max_days,
        has_active=active is not None,
    )
    if verdict != "ok":
        raise unprocessable(verdict)
    row = await fetch_one(
        conn,
        "INSERT INTO guardian_requests (org_id, guardian_id, student_id, kind, promise_date, promise_amount) "
        "VALUES (%s, %s, %s, 'payment_promise', %s, %s) RETURNING public_id",
        (ctx.org_id, ctx.guardian_id, student["sid"], promise_date, amount),
    )
    assert row is not None
    return row["public_id"]  # type: ignore[no-any-return]


async def create_makeup(
    conn: Conn,
    ctx: GuardianCtx,
    student: dict[str, Any],
    entitlement_public: uuid.UUID,
    slot_public: uuid.UUID,
) -> uuid.UUID:
    ae = await fetch_one(
        conn,
        "SELECT id, kind, status, expires_on FROM absence_entitlements WHERE public_id = %s AND student_id = %s",
        (entitlement_public, student["sid"]),
    )
    if ae is None:
        raise NotFound("make-up right not found")
    today = await org_today(conn)
    slots = await slots_for(conn, ae["id"], today, ae["expires_on"])
    verdict = G.makeup_check(
        kind=ae["kind"],
        status=ae["status"],
        expires_on=ae["expires_on"],
        today=today,
        slot=str(slot_public),
        options=[str(s["lesson_id"]) for s in slots],
    )
    if verdict != "ok":
        raise unprocessable(verdict)
    if await fetch_one(
        conn,
        "SELECT 1 AS x FROM guardian_requests WHERE entitlement_id = %s AND kind = 'makeup_choice' AND status = 'pending'",
        (ae["id"],),
    ):
        raise Conflict("Bu huquq uchun tanlov allaqachon yuborilgan va markaz javobini kutmoqda.")
    internal = next(s["internal_id"] for s in slots if s["lesson_id"] == slot_public)
    row = await fetch_one(
        conn,
        "INSERT INTO guardian_requests (org_id, guardian_id, student_id, kind, entitlement_id, slot_lesson_id) "
        "VALUES (%s, %s, %s, 'makeup_choice', %s, %s) RETURNING public_id",
        (ctx.org_id, ctx.guardian_id, student["sid"], ae["id"], internal),
    )
    assert row is not None
    return row["public_id"]  # type: ignore[no-any-return]


async def cancel_request(conn: Conn, guardian_id: int, request_public: uuid.UUID) -> None:
    row = await fetch_one(
        conn,
        "SELECT id, status FROM guardian_requests WHERE public_id = %s AND guardian_id = %s FOR UPDATE",
        (request_public, guardian_id),
    )
    if row is None:
        raise NotFound("request not found")
    if G.request_transition(status=row["status"], action="cancel") == "invalid":
        raise Conflict(f"The request is already {row['status']}")
    await execute(
        conn,
        "UPDATE guardian_requests SET status = 'cancelled', decided_at = now() WHERE id = %s",
        (row["id"],),
    )


async def decide_request(
    conn: Conn, p: Principal, request_public: uuid.UUID, action: str, note: str | None
) -> dict[str, Any]:
    """Staff approve/reject. Approval applies the effect inside the same transaction (all or nothing)."""
    req = await fetch_one(
        conn,
        "SELECT id, kind, status, student_id, lesson_id, entitlement_id, slot_lesson_id FROM guardian_requests "
        "WHERE public_id = %s FOR UPDATE",
        (request_public,),
    )
    if req is None:
        raise NotFound("request not found")
    new_status = G.request_transition(status=req["status"], action=action)
    if new_status == "invalid":
        raise Conflict(f"The request is already {req['status']}")
    if action == "approve":
        effect = G.request_effect(kind=req["kind"])
        if effect == "mark_excused":
            await _apply_absence(conn, p, req)
        elif effect == "schedule_makeup":
            await _apply_makeup(conn, req)
        # record_promise: the approved request itself is the promise
    await execute(
        conn,
        "UPDATE guardian_requests SET status = %s, decided_by_user_id = %s, decided_at = now(), decision_note = %s WHERE id = %s",
        (new_status, p.user_id, note, req["id"]),
    )
    out = await fetch_one(conn, f"{_REQUEST_SQL} WHERE r.id = %s", (req["id"],))
    assert out is not None
    return out


async def _apply_absence(conn: Conn, p: Principal, req: dict[str, Any]) -> None:
    lesson = await fetch_one(
        conn,
        "SELECT l.id, l.group_id, l.lesson_date, l.start_time, l.status, l.kind FROM lessons l WHERE l.id = %s",
        (req["lesson_id"],),
    )
    assert lesson is not None
    if lesson["status"] == "cancelled":
        raise Conflict("The lesson is cancelled")
    roster = {r["sid"]: r for r in await _roster(conn, lesson)}
    mine = roster.get(req["student_id"])
    if mine is None:
        raise Conflict("The student is no longer in this lesson's roster")
    if mine["status"] in ("present", "late"):
        raise Conflict("The student is already marked present for this lesson")
    await execute(
        conn,
        "INSERT INTO attendance (org_id, lesson_id, student_id, status, minutes_late, marked_by_user_id) "
        "VALUES (%s, %s, %s, 'excused', 0, %s) ON CONFLICT (lesson_id, student_id) DO UPDATE "
        "SET status = 'excused', minutes_late = 0, marked_by_user_id = EXCLUDED.marked_by_user_id, marked_at = now()",
        (p.org_id, lesson["id"], req["student_id"], p.user_id),
    )
    await sync_entitlement(
        conn, org_id=p.org_id, lesson=lesson, student_id=int(req["student_id"]), new_status="excused"
    )


async def _apply_makeup(conn: Conn, req: dict[str, Any]) -> None:
    ae = await fetch_one(
        conn,
        "SELECT id, org_id, kind, status, expires_on, group_id, enrollment_id FROM absence_entitlements WHERE id = %s FOR UPDATE",
        (req["entitlement_id"],),
    )
    assert ae is not None
    today = await org_today(conn)
    slots = await slots_for(conn, ae["id"], today, ae["expires_on"])
    chosen = next((s for s in slots if s["internal_id"] == req["slot_lesson_id"]), None)
    verdict = G.makeup_check(
        kind=ae["kind"],
        status=ae["status"],
        expires_on=ae["expires_on"],
        today=today,
        slot="" if chosen is None else str(chosen["lesson_id"]),
        options=[str(s["lesson_id"]) for s in slots],
    )
    if verdict != "ok" or chosen is None:
        raise Conflict(
            REASON_TEXT.get(verdict, "The slot is no longer available"), details={"reason": verdict}
        )
    active = await fetch_one(
        conn, "SELECT 1 AS x FROM enrollments WHERE id = %s AND status = 'active'", (ae["enrollment_id"],)
    )
    if active is None:
        raise Conflict("The student is no longer actively enrolled in this group")
    src = await fetch_one(conn, "SELECT teacher_id FROM lessons WHERE id = %s", (chosen["internal_id"],))
    assert src is not None
    row = await fetch_one(
        conn,
        "INSERT INTO lessons (org_id, group_id, teacher_id, lesson_date, start_time, end_time, kind) "
        "VALUES (%s, %s, %s, %s, %s, %s, 'makeup') RETURNING id",
        (
            ae["org_id"],
            ae["group_id"],
            src["teacher_id"],
            chosen["date"],
            chosen["start_time"],
            chosen["end_time"],
        ),
    )
    assert row is not None
    await execute(
        conn,
        "UPDATE absence_entitlements SET status = 'scheduled', makeup_lesson_id = %s WHERE id = %s",
        (row["id"], ae["id"]),
    )
