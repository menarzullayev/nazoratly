"""Teacher-app rules: invitation codes, unmarked lessons and their reminders, the owner's end-of-day list, the checks and
texts of a teacher's direct message to a guardian, and a teacher's month hours and pay estimate. Pure functions, mirrored
in TypeScript (sheets/src/domain/teacher.ts); both are checked against the same cases in tests/golden/teacher.json.

Times are local, naive ISO strings ("2026-11-24T17:30"): the caller converts to the center's time zone first."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # same 32 symbols as the QR and certificate codes
INVITE_LEN = 8
INVITE_TTL_DAYS = 7
INVITE_PREFIX = "T"

REMINDER_AFTER_HOURS_DEFAULT = 2
DIGEST_AFTER_DEFAULT = "20:00"
DAILY_LIMIT_DEFAULT = 20
MAX_TEXT = 1000

_INVITE_BODY = re.compile(rf"^[{INVITE_ALPHABET}]{{{INVITE_LEN}}}$")
_STAMP = "%Y-%m-%dT%H:%M"


def _half_up(x: Decimal, places: str) -> Decimal:
    return x.quantize(Decimal(places), rounding=ROUND_HALF_UP)


# ---- invitation codes ---------------------------------------------------------------------------------------------
def format_invite_code(raw: str) -> str:
    """`ABCDEFGH` -> `T-ABCDEFGH` (the form the owner hands out and the bot's start parameter carries)."""
    return f"{INVITE_PREFIX}-{raw}"


def normalize_invite_code(text: str) -> str | None:
    """What a person typed or pasted -> the canonical `T-XXXXXXXX`, or None when it is not an invitation code.
    Case, spaces and a missing dash are forgiven; symbols outside the alphabet (I, O, 0, 1) are not."""
    t = re.sub(r"[\s-]+", "", text or "").upper()
    if not t.startswith(INVITE_PREFIX):
        return None
    body = t[len(INVITE_PREFIX) :]
    return format_invite_code(body) if _INVITE_BODY.match(body) else None


def invite_state(status: str, expires_at: str, now: str) -> str:
    """valid | used | revoked | expired. A used or revoked invitation never becomes valid again; `expires_at` is the
    first instant the code no longer works."""
    if status in ("used", "revoked"):
        return status
    return "expired" if datetime.strptime(now, _STAMP) >= datetime.strptime(expires_at, _STAMP) else "valid"


def invite_expires_at(now: str) -> str:
    return (datetime.strptime(now, _STAMP) + timedelta(days=INVITE_TTL_DAYS)).strftime(_STAMP)


# ---- unmarked lessons -----------------------------------------------------------------------------------------------
def unmarked_lessons(lessons: list[dict[str, Any]], now: str, after_hours: int) -> list[dict[str, Any]]:
    """Lessons whose roll call was never saved although they are over. Input rows: id, date (ISO day), end_time (HH:MM),
    status, marked (number of attendance rows), reminded (a teacher reminder was already queued). Output (oldest first,
    then id): id, ended_at, reminder_at and `state`: `waiting` (over, but the teacher still has time), `reminder_due`
    (the wait is over, no reminder yet) or `reminded`. Cancelled lessons, marked lessons and lessons still running are
    never listed."""
    t_now = datetime.strptime(now, _STAMP)
    out: list[dict[str, Any]] = []
    for lesson in lessons:
        if lesson["status"] == "cancelled" or lesson["marked"] > 0:
            continue
        ended = datetime.strptime(f"{lesson['date']}T{lesson['end_time']}", _STAMP)
        if ended > t_now:
            continue
        remind_at = ended + timedelta(hours=after_hours)
        if lesson["reminded"]:
            state = "reminded"
        else:
            state = "reminder_due" if remind_at <= t_now else "waiting"
        out.append(
            {
                "id": lesson["id"],
                "ended_at": ended.strftime(_STAMP),
                "reminder_at": remind_at.strftime(_STAMP),
                "state": state,
            }
        )
    out.sort(key=lambda r: (r["ended_at"], str(r["id"])))
    return out


def reminder_text(group: str, day: str, start: str, end: str) -> str:
    """The reminder a teacher receives (internal, staff only)."""
    return f"Eslatma: {group} guruhining {day} {start}-{end} darsi uchun davomat belgilanmagan. Iltimos, belgilang."


def digest_due(now: str, digest_after: str, today_count: int, already_sent: bool) -> bool:
    """The owner's end-of-day list is sent once, after `digest_after`, and only when something is unmarked today."""
    if already_sent or today_count <= 0:
        return False
    return datetime.strptime(now, _STAMP).strftime("%H:%M") >= digest_after


def digest_text(day: str, items: list[dict[str, Any]]) -> str:
    """The owner's list: one line per lesson (start-end, group, teacher). Items: start, end, group, teacher."""
    lines = [f"{day}: davomat belgilanmagan darslar ({len(items)}):"]
    for i, it in enumerate(items, 1):
        who = f" ({it['teacher']})" if it.get("teacher") else ""
        lines.append(f"{i}. {it['start']}-{it['end']} {it['group']}{who}")
    return "\n".join(lines)


# ---- a teacher's message to a guardian --------------------------------------------------------------------------------
TEMPLATES: dict[str, str] = {
    "absent": "{student} bugun ({date}) {group} darsiga kelmadi. Sababini bilsak bo'ladimi?",
    "late": "{student} bugun ({date}) {group} darsiga kechikib keldi.",
    "homework": "{student} {group} bo'yicha uy vazifasini bajarmadi. Iltimos, e'tibor bering.",
    "praise": "{student} bugun ({date}) {group} darsida a'lo qatnashdi. Rahmat!",
    "meeting": "{student} haqida suhbatlashish uchun markazga tashrif buyurishingizni so'raymiz ({group}).",
}


def render_template(code: str, student: str, group: str, day: str) -> str | None:
    t = TEMPLATES.get(code)
    return None if t is None else t.format(student=student, group=group, date=day)


def signed_text(text: str, teacher: str, center: str) -> str:
    """The text a guardian reads: the teacher's words and who wrote them."""
    return f"{text.strip()}\n\n— {teacher}, {center}"


def check_message(
    *, enabled: bool, own_student: bool, text: str, recipients: int, sent_today: int, limit: int
) -> dict[str, Any]:
    """May this teacher send this message now? Checked in this order: the right is on, the student is in one of the
    teacher's own groups, the text is 1..1000 characters, there is somebody who can receive it, the daily limit holds
    (counted per recipient; all or nothing). Returns {"ok": True} or {"ok": False, "error": code}."""
    if not enabled:
        return {"ok": False, "error": "right_off"}
    if not own_student:
        return {"ok": False, "error": "not_own_student"}
    body = text.strip()
    if not body:
        return {"ok": False, "error": "empty_text"}
    if len(body) > MAX_TEXT:
        return {"ok": False, "error": "text_too_long"}
    if recipients <= 0:
        return {"ok": False, "error": "no_recipient"}
    if sent_today + recipients > limit:
        return {"ok": False, "error": "daily_limit"}
    return {"ok": True}


# ---- hours and pay ---------------------------------------------------------------------------------------------------
def month_summary(minutes: list[int], pay_model: str, pay_rate: str, collected: str) -> dict[str, Any]:
    """A teacher's month: lessons held, minutes, hours (one decimal, half up) and the pay estimate in whole so'm:
    `fixed` = the rate, `per_lesson` = lessons x rate, `percent` = collected tuition x rate / 100."""
    n, total = len(minutes), sum(minutes)
    rate = Decimal(pay_rate)
    if pay_model == "fixed":
        pay = rate
    elif pay_model == "per_lesson":
        pay = rate * n
    else:
        pay = Decimal(collected) * rate / 100
    return {
        "lessons": n,
        "minutes": total,
        "hours": str(_half_up(Decimal(total) / 60, "0.1")),
        "estimate": int(_half_up(pay, "1")),
    }
