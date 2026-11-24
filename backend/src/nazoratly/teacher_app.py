"""Teacher app services shared by the API, the Telegram bot and the reminder loop: invitation codes, per-center settings,
the teacher's own groups, direct messages to guardians (with their limits and log) and the reminder sweep.

The pure rules live in `nazoratly.rules.teacher` (golden-tested against the TypeScript twin); this module only reads and
writes the database around them."""

from __future__ import annotations

import asyncio
import contextlib
import secrets
import uuid
from datetime import date, datetime, timedelta
from typing import Any

import structlog

from nazoratly.db import Conn, Database, Session, execute, fetch_all, fetch_one
from nazoratly.errors import Conflict, Forbidden, TooManyRequests, Unprocessable
from nazoratly.rules import teacher as R
from nazoratly.security import sha256

log = structlog.get_logger("teacher_app")

_STAMP = "%Y-%m-%dT%H:%M"


# ---- invitation codes ---------------------------------------------------------------------------------------------
def new_invite_code() -> str:
    return R.format_invite_code("".join(secrets.choice(R.INVITE_ALPHABET) for _ in range(R.INVITE_LEN)))


def invite_hash(code: str) -> str:
    """The only form of a code the database ever sees. The input must already be canonical (T-XXXXXXXX)."""
    return sha256(code).hex()


def canonical_invite(text: str) -> str:
    code = R.normalize_invite_code(text)
    if code is None:
        raise Unprocessable("This is not an invitation code (it looks like T-XXXXXXXX)")
    return code


# ---- time and settings --------------------------------------------------------------------------------------------
async def org_now(conn: Conn) -> datetime:
    """The center's local wall-clock time as a naive datetime (rules work on local naive timestamps)."""
    row = await fetch_one(
        conn,
        "SELECT date_trunc('minute', now() AT TIME ZONE o.timezone) AS t FROM organizations o WHERE o.id = app_org_id()",
    )
    assert row is not None
    t: datetime = row["t"]
    return t


def stamp(t: datetime) -> str:
    return t.strftime(_STAMP)


async def load_app_settings(conn: Conn, org_id: int) -> dict[str, Any]:
    await execute(
        conn,
        "INSERT INTO teacher_app_settings (org_id) VALUES (%s) ON CONFLICT (org_id) DO NOTHING",
        (org_id,),
    )
    row = await fetch_one(
        conn,
        "SELECT reminder_after_hours, guardian_daily_limit, to_char(digest_after, 'HH24:MI') AS digest_after "
        "FROM teacher_app_settings WHERE org_id = %s",
        (org_id,),
    )
    assert row is not None
    return dict(row)


# ---- the teacher's own things -------------------------------------------------------------------------------------
async def my_teacher(conn: Conn, user_id: int) -> dict[str, Any] | None:
    return await fetch_one(
        conn,
        "SELECT id, public_id, full_name, phone, pay_model, pay_rate, guardian_messaging_enabled "
        "FROM teachers WHERE user_id = %s AND deleted_at IS NULL AND status = 'active'",
        (user_id,),
    )


async def require_teacher(conn: Conn, user_id: int) -> dict[str, Any]:
    t = await my_teacher(conn, user_id)
    if t is None:
        raise Forbidden("Your account has no active teacher profile")
    return t


async def own_groups(conn: Conn, teacher_id: int) -> list[dict[str, Any]]:
    """Groups the teacher teaches (the group's teacher): the unit of "own groups" for people and messages."""
    return await fetch_all(
        conn,
        "SELECT g.id, g.public_id, g.name, g.status, c.name AS course_name, "
        "(SELECT count(*) FROM enrollments e WHERE e.org_id = g.org_id AND e.group_id = g.id AND e.status = 'active') AS students "
        "FROM study_groups g JOIN courses c ON c.org_id = g.org_id AND c.id = g.course_id "
        "WHERE g.teacher_id = %s AND g.deleted_at IS NULL AND g.status IN ('planned','active') ORDER BY lower(g.name), g.id",
        (teacher_id,),
    )


async def own_student_group(
    conn: Conn, teacher_id: int, student_id: int, group_id: int | None = None
) -> dict[str, Any] | None:
    """The own group through which this student is the teacher's (an active enrollment), or None."""
    return await fetch_one(
        conn,
        "SELECT g.id, g.public_id, g.name FROM study_groups g "
        "JOIN enrollments e ON e.org_id = g.org_id AND e.group_id = g.id AND e.student_id = %(s)s AND e.status = 'active' "
        "WHERE g.teacher_id = %(t)s AND g.deleted_at IS NULL AND g.status IN ('planned','active') "
        "AND (%(g)s::bigint IS NULL OR g.id = %(g)s) ORDER BY g.id LIMIT 1",
        {"s": student_id, "t": teacher_id, "g": group_id},
    )


# ---- direct messages to guardians ---------------------------------------------------------------------------------
async def reachable_guardians(
    conn: Conn, student_id: int, guardian_id: int | None = None
) -> list[dict[str, Any]]:
    """Guardians a message can actually reach: linked with reminders on, a Telegram chat, and the student's active
    notifications consent (the same conditions the outbox trigger enforces, checked up front for a clean error)."""
    return await fetch_all(
        conn,
        "SELECT gd.id, gd.public_id, gd.full_name FROM student_guardians sg "
        "JOIN guardians gd ON gd.org_id = sg.org_id AND gd.id = sg.guardian_id "
        "WHERE sg.student_id = %(s)s AND sg.receives_reminders AND gd.deleted_at IS NULL AND gd.telegram_chat_id IS NOT NULL "
        "AND EXISTS (SELECT 1 FROM data_consents dc WHERE dc.org_id = sg.org_id AND dc.student_id = sg.student_id "
        "AND dc.purpose = 'notifications' AND dc.revoked_at IS NULL) "
        "AND (%(g)s::bigint IS NULL OR gd.id = %(g)s) ORDER BY sg.is_primary DESC, gd.id",
        {"s": student_id, "g": guardian_id},
    )


async def messages_today(conn: Conn, teacher_id: int) -> int:
    row = await fetch_one(
        conn,
        "SELECT count(*) AS n FROM teacher_guardian_messages m JOIN organizations o ON o.id = m.org_id "
        "WHERE m.teacher_id = %s AND m.created_at >= (date_trunc('day', now() AT TIME ZONE o.timezone) AT TIME ZONE o.timezone)",
        (teacher_id,),
    )
    assert row is not None
    return int(row["n"])


_ERRORS = {
    "right_off": (Forbidden, "Writing to guardians is switched off for you"),
    "not_own_student": (Forbidden, "This student is not in one of your own groups"),
    "empty_text": (Unprocessable, "The message is empty"),
    "text_too_long": (Unprocessable, f"The message is longer than {R.MAX_TEXT} characters"),
    "no_recipient": (
        Conflict,
        "No guardian of this student can receive a Telegram message (link, reminders, consent)",
    ),
    "daily_limit": (TooManyRequests, "The daily limit of messages to guardians is used up"),
}
_CODES = {
    "right_off": "messaging_off",
    "not_own_student": "not_own_student",
    "daily_limit": "daily_limit",
    "no_recipient": "no_recipient",
}


def check_error(code: str) -> Exception:
    cls, msg = _ERRORS[code]
    err = cls(msg)
    if code in _CODES:
        err.code = _CODES[code]
    return err


async def send_guardian_message(
    conn: Conn,
    *,
    org_id: int,
    user_id: int,
    teacher: dict[str, Any],
    student_id: int,
    group_id: int | None,
    template: str | None,
    text: str | None,
    guardian_id: int | None = None,
) -> dict[str, Any]:
    """Check the rules, queue one outbox message per reachable guardian and log each. The caller is a person acting
    (Model B): this is never called by automation."""
    settings = await load_app_settings(conn, org_id)
    group = await own_student_group(conn, int(teacher["id"]), student_id, group_id)
    student = await fetch_one(
        conn, "SELECT full_name FROM students WHERE id = %s AND deleted_at IS NULL", (student_id,)
    )
    today = (await org_now(conn)).date().isoformat()
    body = (text or "").strip()
    if template is not None:
        if group is None or student is None:
            body = "x"  # the own-student check below reports it; never render with a missing name
        else:
            rendered = R.render_template(template, str(student["full_name"]), str(group["name"]), today)
            if rendered is None:
                raise Unprocessable("Unknown template", details={"templates": sorted(R.TEMPLATES)})
            body = rendered
    recipients = await reachable_guardians(conn, student_id, guardian_id) if group is not None else []
    sent_today = await messages_today(conn, int(teacher["id"]))
    verdict = R.check_message(
        enabled=bool(teacher["guardian_messaging_enabled"]),
        own_student=group is not None and student is not None,
        text=body,
        recipients=len(recipients),
        sent_today=sent_today,
        limit=int(settings["guardian_daily_limit"]),
    )
    if not verdict["ok"]:
        raise check_error(str(verdict["error"]))
    center = await fetch_one(conn, "SELECT name FROM organizations WHERE id = %s", (org_id,))
    assert center is not None and group is not None
    final = R.signed_text(body, str(teacher["full_name"]), str(center["name"]))
    sent: list[dict[str, Any]] = []
    for g in recipients:
        ob = await fetch_one(
            conn,
            "INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, idempotency_key) "
            "VALUES (%s, %s, %s, 'telegram', %s, %s) RETURNING id",
            (org_id, student_id, g["id"], final, f"teacher-msg:{uuid.uuid4()}"),
        )
        assert ob is not None
        row = await fetch_one(
            conn,
            "INSERT INTO teacher_guardian_messages (org_id, teacher_id, student_id, guardian_id, group_id, template, body, "
            "outbox_message_id, sent_by_user_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING public_id, created_at",
            (org_id, teacher["id"], student_id, g["id"], group["id"], template, final, ob["id"], user_id),
        )
        assert row is not None
        sent.append({"id": row["public_id"], "guardian_id": g["public_id"], "created_at": row["created_at"]})
    return {"sent": sent, "remaining_today": int(settings["guardian_daily_limit"]) - sent_today - len(sent)}


# ---- unmarked lessons and the reminder sweep --------------------------------------------------------------------------
_UNMARKED_SQL = (
    "SELECT l.id, l.public_id, l.lesson_date, l.start_time, l.end_time, l.status, g.name AS group_name, g.branch_id AS branch_id, "
    "et.id AS teacher_pk, et.full_name AS teacher_name, et.user_id AS teacher_user_id, "
    "(SELECT count(*) FROM attendance a WHERE a.org_id = l.org_id AND a.lesson_id = l.id) AS marked, "
    "lesson_reminded(l.id) AS reminded "
    "FROM lessons l JOIN study_groups g ON g.org_id = l.org_id AND g.id = l.group_id "
    "LEFT JOIN teachers et ON et.org_id = l.org_id AND et.id = COALESCE(l.substitute_teacher_id, l.teacher_id, g.teacher_id) "
    "WHERE l.lesson_date BETWEEN %(from)s AND %(to)s AND l.status <> 'cancelled' "
    "AND (%(teacher)s::bigint IS NULL OR et.id = %(teacher)s) ORDER BY l.lesson_date, l.start_time, l.id"
)
LOOKBACK_DAYS = 7


async def unmarked_now(
    conn: Conn, *, teacher_pk: int | None, after_hours: int, now: datetime
) -> list[dict[str, Any]]:
    """Unmarked, finished lessons of the last week with the rule's state, joined back to their details."""
    rows = await fetch_all(
        conn,
        _UNMARKED_SQL,
        {"from": now.date() - timedelta(days=LOOKBACK_DAYS), "to": now.date(), "teacher": teacher_pk},
    )
    facts = [
        {
            "id": str(r["id"]),
            "date": r["lesson_date"].isoformat(),
            "end_time": r["end_time"].strftime("%H:%M"),
            "status": r["status"],
            "marked": int(r["marked"]),
            "reminded": bool(r["reminded"]),
        }
        for r in rows
    ]
    by_id = {str(r["id"]): r for r in rows}
    out: list[dict[str, Any]] = []
    for u in R.unmarked_lessons(facts, stamp(now), after_hours):
        r = by_id[u["id"]]
        out.append({**u, "row": r})
    return out


async def _notify(
    conn: Conn,
    *,
    org_id: int,
    user_id: int,
    kind: str,
    body: str,
    dedup: str,
    lesson_id: int | None,
    day: date | None,
) -> bool:
    row = await fetch_one(
        conn,
        "INSERT INTO staff_notifications (org_id, user_id, kind, body, dedup_key, lesson_id, day, delivery) "
        "SELECT %(o)s, u.id, %(k)s, %(b)s, %(d)s, %(l)s, %(day)s, "
        "CASE WHEN u.telegram_user_id IS NOT NULL THEN 'queued' ELSE 'none' END FROM users u WHERE u.id = %(u)s "
        "ON CONFLICT (org_id, dedup_key) DO NOTHING RETURNING id",
        {"o": org_id, "k": kind, "b": body, "d": dedup, "l": lesson_id, "day": day, "u": user_id},
    )
    return row is not None


async def sweep_center(conn: Conn, org_id: int, *, now: datetime | None = None) -> dict[str, int]:
    """One pass of the reminders of a center, in a system session: a reminder per unmarked lesson to the teacher who
    teaches it, once the wait is over; and, after the digest time, one list per owner/admin of today's unmarked lessons.
    Internal staff messages only. Safe to repeat (dedup keys)."""
    settings = await load_app_settings(conn, org_id)
    now = now or await org_now(conn)
    unmarked = await unmarked_now(
        conn, teacher_pk=None, after_hours=int(settings["reminder_after_hours"]), now=now
    )
    teacher_reminders = 0
    for u in unmarked:
        r = u["row"]
        if u["state"] != "reminder_due" or r["teacher_user_id"] is None:
            continue
        text = R.reminder_text(
            str(r["group_name"]),
            r["lesson_date"].isoformat(),
            r["start_time"].strftime("%H:%M"),
            r["end_time"].strftime("%H:%M"),
        )
        if await _notify(
            conn,
            org_id=org_id,
            user_id=int(r["teacher_user_id"]),
            kind="lesson_unmarked",
            body=text,
            dedup=f"lesson:{r['id']}",
            lesson_id=int(r["id"]),
            day=r["lesson_date"],
        ):
            teacher_reminders += 1
    today = now.date()
    todays = [u for u in unmarked if u["row"]["lesson_date"] == today]
    owners = await fetch_all(
        conn,
        "SELECT m.user_id, m.branch_id FROM memberships m WHERE m.org_id = %s AND m.role IN ('owner','admin') AND m.status = 'active'",
        (org_id,),
    )
    digests = 0
    for o in owners:
        mine = [u for u in todays if o["branch_id"] is None or u["row"]["branch_id"] == o["branch_id"]]
        dedup = f"digest:{today.isoformat()}:{o['user_id']}"
        sent = await fetch_one(
            conn,
            "SELECT 1 AS x FROM staff_notifications WHERE org_id = %s AND dedup_key = %s",
            (org_id, dedup),
        )
        if not R.digest_due(stamp(now), str(settings["digest_after"]), len(mine), sent is not None):
            continue
        items = [
            {
                "start": u["row"]["start_time"].strftime("%H:%M"),
                "end": u["row"]["end_time"].strftime("%H:%M"),
                "group": u["row"]["group_name"],
                "teacher": u["row"]["teacher_name"] or "",
            }
            for u in mine
        ]
        if await _notify(
            conn,
            org_id=org_id,
            user_id=int(o["user_id"]),
            kind="unmarked_digest",
            body=R.digest_text(today.isoformat(), items),
            dedup=dedup,
            lesson_id=None,
            day=today,
        ):
            digests += 1
    return {"teacher_reminders": teacher_reminders, "digests": digests}


async def sweep_all(db: Database) -> dict[str, int]:
    """One pass over every active center (system sessions)."""
    totals = {"teacher_reminders": 0, "digests": 0, "centers": 0}
    async with db.tx(Session(user_id=None, org_id=None, actor_type="system")) as conn:
        org_ids = [int(r["id"]) for r in await fetch_all(conn, "SELECT active_org_ids() AS id")]
    for org_id in org_ids:
        try:
            async with db.tx(Session(user_id=None, org_id=org_id, actor_type="system")) as conn:
                res = await sweep_center(conn, org_id)
        except Exception:
            log.exception("reminder_sweep_failed", org_id=org_id)
            continue
        totals["centers"] += 1
        totals["teacher_reminders"] += res["teacher_reminders"]
        totals["digests"] += res["digests"]
    return totals


async def reminder_loop(db: Database, interval_s: float, stop: asyncio.Event) -> None:
    """Background loop of the API process (several replicas are safe: the sweep is idempotent)."""
    while not stop.is_set():
        try:
            await sweep_all(db)
        except Exception:
            log.exception("reminder_loop_failed")
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
