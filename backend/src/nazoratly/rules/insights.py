"""Owner insights: debt follow-up order and tone with draft texts, churn-risk score, weekly summary lines.

Pure functions, mirrored in TypeScript (sheets/src/domain/insights.ts); both are checked against the same cases in
tests/golden/insights.json. Money is whole so'm (int). Every result is a suggestion for a person: nothing here sends,
bills or changes anything. The AI layer (ai_reports.py) only rewrites these facts into prose; when it is unavailable the
texts built here are the report."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Final

RECENT_MIN_LESSONS: Final = 2  # an attendance rate needs at least this many marked lessons in the window
HIGH_RISK: Final = 60
MEDIUM_RISK: Final = 30
SOFT_MAX_DAYS: Final = 7
FIRM_MAX_DAYS: Final = 30


def fmt_money(n: int) -> str:
    """12345678 -> '12 345 678' (thin groups of three, plain spaces); negatives keep the sign in front."""
    return f"{n:,}".replace(",", " ")


def _half_up(numerator: int, denominator: int) -> int:
    """round(numerator / denominator) half up, for numerator >= 0 and denominator > 0, integers only."""
    return (2 * numerator + denominator) // (2 * denominator)


def rate(attended: int, marked: int) -> int | None:
    """Attendance percent, None when fewer than RECENT_MIN_LESSONS lessons were marked (too little to judge)."""
    if marked < RECENT_MIN_LESSONS:
        return None
    return _half_up(attended * 100, marked)


def week_rate(attended: int, marked: int) -> int | None:
    """Attendance percent of a whole week, None when nothing was marked."""
    if marked <= 0:
        return None
    return _half_up(attended * 100, marked)


# ---- debt follow-up ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class DebtFact:
    id: str
    outstanding: int
    overdue: int
    oldest_due: (
        date | None
    )  # due date of the oldest unpaid charge or installment, None when nothing is unpaid


def debt_age_days(*, overdue: int, oldest_due: date | None, today: date) -> int:
    if overdue <= 0 or oldest_due is None:
        return 0
    return max(0, (today - oldest_due).days)


def debt_tone(*, overdue: int, age_days: int) -> str:
    if overdue <= 0:
        return "reminder"
    if age_days <= SOFT_MAX_DAYS:
        return "soft"
    if age_days <= FIRM_MAX_DAYS:
        return "firm"
    return "final"


def debt_message(tone: str, name: str, amount: int, days: int) -> str:
    """The draft a person may send to the guardian. No penalty and no threat: only a request and an offer to talk."""
    money = fmt_money(amount)
    if tone == "reminder":
        return (
            f"Assalomu alaykum! {name} uchun {money} so'm to'lov muddati yaqinlashmoqda. "
            "Qulay vaqtda to'lab qo'ysangiz, minnatdor bo'lamiz."
        )
    if tone == "soft":
        return (
            f"Assalomu alaykum! {name} uchun {money} so'm to'lov muddati o'tib ketdi. "
            "Iltimos, yaqin kunlarda to'lab qo'ying. Savolingiz bo'lsa, yozing."
        )
    if tone == "firm":
        return (
            f"Assalomu alaykum! {name} uchun {money} so'm qarz {days} kundan beri to'lanmagan. "
            "Iltimos, shu hafta ichida to'lang yoki to'lov kunini bizga ayting."
        )
    return (
        f"Assalomu alaykum! {name} uchun {money} so'm qarz {days} kundan beri to'lanmagan. "
        "Iltimos, biz bilan bog'laning: to'lov rejasini birga kelishib olamiz."
    )


def debt_followup(students: list[DebtFact], *, today: date) -> list[dict[str, Any]]:
    """Students with an open amount, most urgent first. score = min(60, 2 * age_days) + min(40, outstanding // 100000)."""
    items: list[dict[str, Any]] = []
    for s in students:
        if s.outstanding <= 0:
            continue
        age = debt_age_days(overdue=s.overdue, oldest_due=s.oldest_due, today=today)
        items.append(
            {
                "id": s.id,
                "outstanding": s.outstanding,
                "overdue": s.overdue,
                "age_days": age,
                "tone": debt_tone(overdue=s.overdue, age_days=age),
                "score": min(60, 2 * age) + min(40, s.outstanding // 100_000),
            }
        )
    items.sort(key=lambda i: (-i["score"], i["id"]))
    return items


# ---- churn risk -------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class RiskFact:
    id: str
    attended_recent: int
    marked_recent: int
    attended_prev: int
    marked_prev: int
    overdue_age_days: int  # 0 = nothing overdue
    trial_days_over: int | None  # None = not on an undecided trial; else days past the trial limit (>= 0)


def churn_risk(students: list[RiskFact]) -> list[dict[str, Any]]:
    """Medium and high risk students, highest score first. Points: attendance fall (up to 40), debt age (up to 30),
    undecided trial (10 + 5 per day over, up to 30). score = min(100, sum); high >= 60, medium >= 30."""
    items: list[dict[str, Any]] = []
    for s in students:
        recent = rate(s.attended_recent, s.marked_recent)
        prev = rate(s.attended_prev, s.marked_prev)
        att_points = (
            min(40, prev - recent) if recent is not None and prev is not None and prev > recent else 0
        )
        debt_points = min(30, max(0, s.overdue_age_days))
        trial_points = 0 if s.trial_days_over is None else 10 + min(20, 5 * max(0, s.trial_days_over))
        score = min(100, att_points + debt_points + trial_points)
        level = "high" if score >= HIGH_RISK else "medium" if score >= MEDIUM_RISK else "low"
        if level == "low":
            continue
        reasons = []
        if att_points >= 10:
            reasons.append("attendance_drop")
        if debt_points > 0:
            reasons.append("debt")
        if s.trial_days_over is not None:
            reasons.append("trial_no_answer")
        items.append(
            {
                "id": s.id,
                "score": score,
                "level": level,
                "reasons": reasons,
                "attendance_recent": recent,
                "attendance_prev": prev,
            }
        )
    items.sort(key=lambda i: (-i["score"], i["id"]))
    return items


# ---- report lines (the rule-based text of the debt and risk reports) ---------------------------------------------
TONE_LABEL: Final = {"reminder": "eslatma", "soft": "yumshoq", "firm": "qat'iy", "final": "so'nggi"}
LEVEL_LABEL: Final = {"high": "yuqori", "medium": "o'rta"}
REASON_TEXT: Final = {
    "attendance_drop": "davomat pasaygan",
    "debt": "qarzi muddati o'tgan",
    "trial_no_answer": "sinovdan keyin javob yo'q",
}


def debt_line(rank: int, name: str, outstanding: int, age_days: int, tone: str) -> str:
    return f"{rank}. {name}: {fmt_money(outstanding)} so'm, {age_days} kun, ohang: {TONE_LABEL[tone]}."


def risk_line(rank: int, name: str, score: int, level: str, reasons: list[str]) -> str:
    why = ", ".join(REASON_TEXT[r] for r in reasons)
    return f"{rank}. {name}: xavf balli {score} ({LEVEL_LABEL[level]}); sabab: {why}."


# ---- weekly summary ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class WeekFacts:
    income: int
    income_prev: int
    expenses: int
    new_students: int
    left_students: int
    unpaid: int
    unpaid_total: int
    overdue: int
    attended: int
    marked: int
    attended_prev: int
    marked_prev: int
    high_risk: int
    medium_risk: int


def change_percent(now: int, before: int) -> int | None:
    """Signed percent change, None when there is no earlier value to compare with."""
    if before <= 0:
        return None
    magnitude = _half_up(abs(now - before) * 100, before)
    return magnitude if now >= before else -magnitude


def weekly_summary(f: WeekFacts) -> dict[str, Any]:
    change = change_percent(f.income, f.income_prev)
    att = week_rate(f.attended, f.marked)
    att_prev = week_rate(f.attended_prev, f.marked_prev)
    net = f.income - f.expenses
    compare = "" if change is None or change == 0 else f", {'+' if change > 0 else '-'}{abs(change)}%"
    lines = [
        f"Tushum: {fmt_money(f.income)} so'm (o'tgan hafta: {fmt_money(f.income_prev)} so'm{compare}).",
        f"Xarajat: {fmt_money(f.expenses)} so'm; sof natija: {fmt_money(net)} so'm.",
        f"Yangi o'quvchilar: {f.new_students}, ketganlar: {f.left_students}.",
        f"Qarzdorlar: {f.unpaid} ta, jami {fmt_money(f.unpaid_total)} so'm, shundan muddati o'tgan: {f.overdue} ta.",
    ]
    if att is None:
        lines.append("Davomat: bu hafta belgilangan dars yo'q.")
    elif att_prev is None:
        lines.append(f"Davomat: {att}%.")
    else:
        lines.append(f"Davomat: {att}% (o'tgan hafta: {att_prev}%).")
    lines.append(f"Ketish xavfi ostidagi o'quvchilar: yuqori {f.high_risk}, o'rta {f.medium_risk}.")
    return {
        "income": f.income,
        "income_prev": f.income_prev,
        "income_change_percent": change,
        "expenses": f.expenses,
        "net": net,
        "new_students": f.new_students,
        "left_students": f.left_students,
        "unpaid": f.unpaid,
        "unpaid_total": f.unpaid_total,
        "overdue": f.overdue,
        "attendance_percent": att,
        "attendance_prev_percent": att_prev,
        "high_risk": f.high_risk,
        "medium_risk": f.medium_risk,
        "lines": lines,
    }
