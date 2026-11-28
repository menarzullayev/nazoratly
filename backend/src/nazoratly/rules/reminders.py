"""Debt reminder drafts. Pure functions, mirrored in TypeScript (sheets/src/domain/reminders.ts: `planReminders` and
`planUpcomingReminders`); both are checked against the same cases in tests/golden/reminders.json.

Nothing is sent from here: a person reads each draft and approves it. A student is skipped without a notifications
consent or a linked Telegram chat, after leaving or pausing, below the debt threshold, or when a reminder was already
made within the cooldown.

The second half is what is added to an approved text WHEN IT IS SENT (sheets/src/domain/messages.ts: `reminderRich` and
`stripHtml`; the paid-claim texts are in sheets/src/gas/webhook.ts), checked against the same golden file."""

from __future__ import annotations

import re
from calendar import timegm
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Final, Literal, cast

from nazoratly.rules.packages import Need, package_reminder_text

DEFAULT_TEMPLATE: Final = (
    "Assalomu alaykum, {guardian}! {student} uchun {amount} so'm to'lov muddati {days} kun oldin o'tgan. "
    "Iltimos, to'lovni amalga oshiring. Savollar bo'lsa, markazga murojaat qiling. {center}"
)
INSTALLMENT_TEMPLATE: Final = (
    "Assalomu alaykum, {guardian}! {student} uchun {installment}-to'lov ({amount} so'm) muddati {due} edi "
    "({days} kun o'tdi). Jami muddati o'tgan qarz: {total} so'm. Iltimos, to'lovni amalga oshiring. "
    "Savollar bo'lsa, markazga murojaat qiling. {center}"
)
UPCOMING_TEMPLATE: Final = (
    "Assalomu alaykum, {guardian}! {student} uchun {installment}-to'lov ({amount} so'm) muddati {due} ({left}). "
    "Iltimos, to'lovni o'z vaqtida amalga oshiring. Savollar bo'lsa, markazga murojaat qiling. {center}"
)

Kind = Literal["overdue", "upcoming"]
SkipReason = Literal[
    "no_consent", "no_chat", "cooldown", "below_threshold", "student_inactive", "already_overdue"
]
_PLACEHOLDER = re.compile(r"\{(\w+)\}", re.ASCII)


@dataclass(frozen=True)
class InstallmentRef:
    seq: int
    count: int
    due_date: date
    outstanding: Decimal


@dataclass(frozen=True)
class StudentFacts:
    id: str
    name: str
    status: str
    guardian_name: str | None
    has_chat: bool
    consent: bool
    last_reminded_on: date | None


@dataclass(frozen=True)
class DebtFacts:
    student_id: str
    overdue: Decimal
    max_days_overdue: int
    overdue_installment: InstallmentRef | None = None  # set when the oldest debt is an installment of a plan
    next_installment: InstallmentRef | None = None  # the earliest open installment not yet past due


@dataclass(frozen=True)
class Draft:
    student_id: str
    kind: Kind
    text: str


@dataclass(frozen=True)
class Skip:
    student_id: str
    reason: SkipReason


def format_dmy(day: date) -> str:
    return f"{day.day:02d}.{day.month:02d}.{day.year:04d}"


def format_som(amount: Decimal) -> str:
    return f"{int(amount.quantize(Decimal(1), rounding=ROUND_HALF_UP)):,}".replace(",", " ")


def render(template: str, values: Mapping[str, str]) -> str:
    return _PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), template)


def _inactive(student: StudentFacts | None) -> bool:
    return student is None or student.status in ("left", "paused")


def _blocked(student: StudentFacts, today: date, cooldown_days: int) -> SkipReason | None:
    if not student.consent:
        return "no_consent"
    if not student.has_chat:
        return "no_chat"
    last = student.last_reminded_on
    return "cooldown" if last is not None and (today - last).days < cooldown_days else None


def plan(
    *,
    debts: list[DebtFacts],
    students: Mapping[str, StudentFacts],
    today: date,
    cooldown_days: int,
    min_overdue: Decimal,
    remind_days: int,
    template: str,
    center: str,
) -> tuple[list[Draft], list[Skip]]:
    """Overdue reminders first (debtors in the given order), then reminders ahead of an installment that is due within
    `remind_days` days (0 = off). A student drafted for the overdue debt gets no second draft."""
    drafts: list[Draft] = []
    skipped: list[Skip] = []
    for debt in debts:
        if debt.overdue <= 0 or debt.max_days_overdue < 1:
            continue
        student = students.get(debt.student_id)
        if student is None or _inactive(student):
            skipped.append(Skip(debt.student_id, "student_inactive"))
            continue
        if debt.overdue < min_overdue:
            skipped.append(Skip(debt.student_id, "below_threshold"))
            continue
        reason = _blocked(student, today, cooldown_days)
        if reason is not None:
            skipped.append(Skip(debt.student_id, reason))
            continue
        ref = debt.overdue_installment
        text = render(
            INSTALLMENT_TEMPLATE if ref else template,
            {
                "guardian": student.guardian_name or "ota-ona",
                "student": student.name,
                "amount": format_som(ref.outstanding if ref else debt.overdue),
                "total": format_som(debt.overdue),
                "days": str(debt.max_days_overdue),
                "installment": f"{ref.seq}/{ref.count}" if ref else "",
                "due": format_dmy(ref.due_date) if ref else "",
                "center": center,
            },
        )
        drafts.append(Draft(student.id, "overdue", text))

    if remind_days <= 0:
        return drafts, skipped
    drafted = {d.student_id for d in drafts}
    for debt in debts:
        ref = debt.next_installment
        if ref is None:
            continue
        left = (ref.due_date - today).days
        if left < 0 or left > remind_days or debt.student_id in drafted:
            continue
        student = students.get(debt.student_id)
        if student is None or _inactive(student):
            skipped.append(Skip(debt.student_id, "student_inactive"))
            continue
        reason = "already_overdue" if debt.overdue > 0 else _blocked(student, today, cooldown_days)
        if reason is not None:
            skipped.append(Skip(debt.student_id, reason))
            continue
        text = render(
            UPCOMING_TEMPLATE,
            {
                "guardian": student.guardian_name or "ota-ona",
                "student": student.name,
                "amount": format_som(ref.outstanding),
                "installment": f"{ref.seq}/{ref.count}",
                "due": format_dmy(ref.due_date),
                "left": "bugun" if left == 0 else f"{left} kun qoldi",
                "center": center,
            },
        )
        drafts.append(Draft(student.id, "upcoming", text))
    return drafts, skipped


# ---- lesson packages (sheets/src/domain/reminders.ts: `planPackageReminders`) --------------------------------------
_PACKAGE_RANK: Final = {"debt": 0, "exhausted": 1, "low": 2}


@dataclass(frozen=True)
class PackageFacts:
    student_id: str
    need: str  # "low" | "exhausted" | "debt" ("ok" rows are ignored)
    balance: int  # lessons left; negative = lessons attended without cover
    debt_amount: Decimal


@dataclass(frozen=True)
class PackageDraft:
    student_id: str
    need: str
    text: str


def plan_packages(
    *,
    balances: list[PackageFacts],
    students: Mapping[str, StudentFacts],
    today: date,
    cooldown_days: int,
    center: str,
) -> tuple[list[PackageDraft], list[Skip]]:
    """One draft per student whose lesson package needs a payment: the worst of the student's package groups. The same
    consent, chat and cooldown rules as every reminder."""
    worst: dict[str, PackageFacts] = {}
    for b in balances:
        if b.need not in _PACKAGE_RANK:
            continue
        cur = worst.get(b.student_id)
        if cur is None or (_PACKAGE_RANK[b.need], b.balance) < (_PACKAGE_RANK[cur.need], cur.balance):
            worst[b.student_id] = b
    drafts: list[PackageDraft] = []
    skipped: list[Skip] = []
    for key, b in worst.items():
        student = students.get(key)
        if student is None or _inactive(student):
            skipped.append(Skip(key, "student_inactive"))
            continue
        reason = _blocked(student, today, cooldown_days)
        if reason is not None:
            skipped.append(Skip(key, reason))
            continue
        text = package_reminder_text(
            need=cast(Need, b.need),
            guardian=student.guardian_name or "ota-ona",
            student=student.name,
            balance=b.balance,
            debt_amount=b.debt_amount,
            center=center,
        )
        drafts.append(PackageDraft(key, b.need, text))
    return drafts, skipped


# ---- the message as it is sent ------------------------------------------------------------------------------------
PAY_INFO_BUTTON: Final = "Rekvizitlarni nusxalash"
PAID_BUTTON: Final = "To'lov qildim"
PAID_THANKS: Final = "Rahmat! Markaz to'lovni tekshiradi."
PAID_NOT_LINKED: Final = "Bu o'quvchi sizga ulanmagan"
_PARAGRAPHS = re.compile(r"\n{2,}")


@dataclass(frozen=True)
class OpenCharge:
    month: date
    due_date: date
    outstanding: Decimal


def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _tg_time(day: date) -> str:
    """`<tg-time>` shows the date in the reader's language and time zone; noon in Tashkent (07:00 UTC) keeps the day."""
    unix = timegm((day.year, day.month, day.day, 7, 0, 0))
    return f'<tg-time unix="{unix}" format="D">{day.isoformat()}</tg-time>'


def charges_table(charges: Sequence[OpenCharge]) -> str:
    if not charges:
        return ""
    rows = "".join(
        f'<tr><td>{c.month.isoformat()[:7]}</td><td align="right">{format_som(c.outstanding)}</td>'
        f"<td>{_tg_time(c.due_date)}</td></tr>"
        for c in charges
    )
    return f"<table striped compact><tr><th>Oy</th><th>Qoldiq (so'm)</th><th>Muddat</th></tr>{rows}</table>"


def reminder_rich(*, text: str, paid_data: str, charges: Sequence[OpenCharge], pay_info: str) -> str:
    """The approved text, a table of what is owed now (oldest due date first, as given), its total and two one-tap
    buttons. `pay_info` is what the copy button copies ("" = no such button)."""
    body = "".join(f"<p>{_esc(part).replace(chr(10), '<br>')}</p>" for part in _PARAGRAPHS.split(text))
    total = sum((c.outstanding for c in charges), Decimal(0))
    summary = f"<p><b>Jami qoldiq: {format_som(total)} so'm</b></p>" if total > 0 else ""
    copy = (
        f'<tg-button type="copy_text" style="primary" text="{_esc(pay_info[:256])}">{PAY_INFO_BUTTON}</tg-button>'
        if pay_info
        else ""
    )
    paid = f'<tg-button type="callback_data" style="success" data="{_esc(paid_data[:64])}">{PAID_BUTTON}</tg-button>'
    return (
        f'{body}{charges_table(charges)}{summary}<tg-button-row align="center">{copy}{paid}</tg-button-row>'
    )


def strip_html(html: str) -> str:
    """The plain text sent when Telegram refuses the rich message."""
    out = re.sub(r"</(p|h3|tr|table|tg-button-row)>", "\n", html)
    out = re.sub(r"<br\s*/?>", "\n", out)
    out = re.sub(r"</t[dh]>", " | ", out)
    out = re.sub(r"<[^>]+>", "", out)
    out = out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&amp;", "&")
    out = re.sub(r"[ \t]*\|[ \t]*\n", "\n", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def paid_note_line(today: date) -> str:
    return f'[{today.isoformat()}: vasiy "to\'lov qildim" dedi]'


def paid_owner_text(student_name: str) -> str:
    return f'{student_name}: vasiy "{PAID_BUTTON}" tugmasini bosdi. To\'lovni tekshirib kiriting.'
