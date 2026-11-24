"""Guardian cabinet rules (G7), pure functions shared with the Sheets edition through tests/golden/guardian.json.

Dates and times are naive local (organization) values: ISO strings in the golden file, `date`/`datetime` here.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Final, Literal

CODE_ALPHABET: Final = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE_LENGTH: Final = 8
CODE_TTL_HOURS: Final = 72
LOGIN_CODE_LENGTH: Final = 6
LOGIN_TTL_S: Final = 600
LOGIN_MAX_ATTEMPTS: Final = 5
REASON_MAX: Final = 300
MAKEUP_OPTIONS_LIMIT: Final = 6

LINK_METHODS: Final = ("code", "phone", "qr", "manual")
REQUEST_KINDS: Final = ("absence_reason", "payment_promise", "makeup_choice")

CodeState = Literal["ok", "used", "expired", "revoked"]
LinkDecision = Literal["active", "pending", "denied"]
LoginCodeState = Literal["ok", "used", "expired", "locked"]
RequestStatus = Literal["pending", "approved", "rejected", "cancelled"]


def normalize_code(text: str) -> str:
    """What a guardian typed -> the canonical code: spaces, dashes, underscores and tabs dropped, upper case."""
    return re.sub(r"[\s\-_]+", "", text).upper()


def code_format_valid(code: str) -> bool:
    return len(code) == CODE_LENGTH and all(ch in CODE_ALPHABET for ch in code)


def code_state(*, expires_at: datetime, now: datetime, used: bool, revoked: bool) -> CodeState:
    """A one-time link code: revoked beats used beats expired (the instant of expiry is already expired)."""
    if revoked:
        return "revoked"
    if used:
        return "used"
    if now >= expires_at:
        return "expired"
    return "ok"


def link_decision(*, method: str, phone_verified: bool, phone_matches: bool) -> LinkDecision:
    """code, manual: the center issued/decided it, so the link is active. qr: the card can be photographed, so the
    center approves first. phone: only Telegram's own verified number that the center already has."""
    if method in ("code", "manual"):
        return "active"
    if method == "qr":
        return "pending"
    if method == "phone":
        return "active" if phone_verified and phone_matches else "denied"
    return "denied"


def phone_key(phone: str) -> str:
    """The last nine digits of a phone number ('' when there are fewer): +998 90 123-45-67 and 901234567 match."""
    digits = re.sub(r"\D", "", phone)
    return digits[-9:] if len(digits) >= 9 else ""


def login_code_state(
    *, expires_at: datetime, now: datetime, attempts: int, max_attempts: int, used: bool
) -> LoginCodeState:
    if used:
        return "used"
    if attempts >= max_attempts:
        return "locked"
    if now >= expires_at:
        return "expired"
    return "ok"


def absence_check(
    *,
    reason: str,
    lesson_start: datetime,
    now: datetime,
    lesson_status: str,
    in_group: bool,
    existing_mark: str | None,
) -> str:
    """Why a guardian cannot report this absence, or 'ok'. Reported BEFORE the lesson starts."""
    text = reason.strip()
    if not text:
        return "reason_required"
    if len(text) > REASON_MAX:
        return "reason_too_long"
    if not in_group:
        return "not_in_group"
    if lesson_status == "cancelled":
        return "lesson_cancelled"
    if now >= lesson_start:
        return "lesson_started"
    if existing_mark is not None:
        return "already_marked"
    return "ok"


def promise_check(
    *,
    today: date,
    promise_date: date,
    outstanding: Decimal,
    amount: Decimal | None,
    max_days: int,
    has_active: bool,
) -> str:
    if outstanding <= 0:
        return "no_debt"
    if has_active:
        return "duplicate"
    if promise_date < today:
        return "date_past"
    if promise_date > today + timedelta(days=max_days):
        return "date_too_far"
    if amount is not None and (amount <= 0 or amount > outstanding):
        return "amount_invalid"
    return "ok"


def promise_state(*, status: str, promise_date: date, today: date, outstanding: Decimal) -> str:
    """Effective state of a promise: only an approved one can be kept/broken; it is kept once the debt is gone."""
    if status != "approved":
        return status
    if outstanding <= 0:
        return "kept"
    return "broken" if promise_date < today else "active"


@dataclass(frozen=True)
class SlotCandidate:
    id: str
    date: date
    start: str  # "HH:MM"
    seats_left: int


def makeup_options(
    *,
    candidates: Sequence[SlotCandidate],
    today: date,
    expires_on: date,
    limit: int = MAKEUP_OPTIONS_LIMIT,
) -> list[str]:
    """Slots a guardian may choose: strictly after today, not after the right's last day, with a free seat; soonest first."""
    ok = [c for c in candidates if today < c.date <= expires_on and c.seats_left > 0]
    ok.sort(key=lambda c: (c.date, c.start, c.id))
    return [c.id for c in ok[:limit]]


def makeup_check(
    *, kind: str, status: str, expires_on: date, today: date, slot: str, options: Sequence[str]
) -> str:
    if kind != "makeup":
        return "not_makeup"
    if status != "open":
        return "not_open"
    if expires_on < today:
        return "expired"
    if slot not in options:
        return "slot_unavailable"
    return "ok"


_TRANSITIONS: Final = {
    ("pending", "approve"): "approved",
    ("pending", "reject"): "rejected",
    ("pending", "cancel"): "cancelled",
}


def request_transition(*, status: str, action: str) -> str:
    return _TRANSITIONS.get((status, action), "invalid")


_EFFECTS: Final = {
    "absence_reason": "mark_excused",
    "payment_promise": "record_promise",
    "makeup_choice": "schedule_makeup",
}


def request_effect(*, kind: str) -> str | None:
    return _EFFECTS.get(kind)
