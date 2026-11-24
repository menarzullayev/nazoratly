"""AI assistant reports: weekly owner summary, debt follow-up advice, churn-risk list.

Pipeline: facts (read under RLS) -> the shared rules (`rules/insights.py`, golden-tested against the Sheets edition) ->
prose. The prose is written by the AI worker when the center allows it and the limit is not reached, otherwise by the
rule-based text builders below. Everything is a suggestion: nothing is sent to a guardian, student or lead from here
(Model B); the debt drafts are texts for a person to read, edit and send.

Privacy: the AI sees pseudonyms and numbers only (`ai_privacy.Pseudonymizer`); real names are added to the prompt only
when the center switched "AI sees names" on, and the answer is restored locally either way. Phones, guardian names, ids,
group names and the center name never go into a prompt.

The work is split so that no database connection is held while waiting for the AI: `prepare` (read facts), `finish`
(rules text or AI call, no database), `store` (insert the report)."""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Final, Literal

from nazoratly.ai_privacy import Pseudonymizer
from nazoratly.ai_transport import AiTransport, AiUnavailable
from nazoratly.db import Conn, fetch_all, fetch_one
from nazoratly.routers.settings import SettingsOut
from nazoratly.rules.dashboard import EnrollmentFact, student_movement
from nazoratly.rules.insights import (
    DebtFact,
    RiskFact,
    WeekFacts,
    churn_risk,
    debt_age_days,
    debt_followup,
    debt_line,
    debt_message,
    fmt_money,
    risk_line,
    weekly_summary,
)
from nazoratly.rules.lifecycle import trial_status

Kind = Literal["weekly_summary", "debt_followup", "churn_risk"]
KINDS: Final = ("weekly_summary", "debt_followup", "churn_risk")
Reason = Literal[
    "ai_disabled",
    "ai_not_configured",
    "ai_limit_reached",
    "ai_unavailable",
    "ai_bad_output",
    "nothing_to_report",
]

LIST_LIMIT: Final = 30  # students shown (and sent to the AI) per report
RISK_WINDOW_DAYS: Final = 28
MAX_TEXT: Final = 3000
MAX_ITEM_TEXT: Final = 1200
_URL = re.compile(r"https?://|www\.", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

SYSTEM_PROMPT: Final = (
    "You help the owner of an education center in Uzbekistan. Write short, practical suggestions in Uzbek (Latin script). "
    "Use ONLY the facts you are given: never invent numbers, names, dates or reasons. Refer to students ONLY by their codes "
    "(like S001), exactly as given. Never suggest fines, penalties, threats or stopping a child's lessons; never write links. "
    "You only suggest: a person decides and sends everything. "
    'Answer with ONE JSON object and nothing else: {"text": "<overall text, at most 1200 characters>", '
    '"items": {"S001": "<text for that student, at most 400 characters>"}}. When the task asks for no per-student texts, "items" is {}.'
)


def _whole(x: Decimal) -> int:
    return int(x.to_integral_value(rounding=ROUND_HALF_UP))


@dataclass(frozen=True)
class Student:
    id: int
    public_id: str
    name: str


@dataclass
class Prepared:
    kind: Kind
    today: date
    reveal_names: bool
    ai_reason: Reason | None  # None = try the AI
    names: dict[int, Student]
    rules_text: str
    data: dict[str, Any]
    ai_prompt: str
    pseudo: Pseudonymizer
    ai_ids: list[int] = field(default_factory=list)  # students in the prompt, in order
    amounts: dict[str, int] = field(default_factory=dict)  # token -> outstanding (debt drafts must state it)


@dataclass(frozen=True)
class Finished:
    kind: Kind
    today: date
    source: Literal["ai", "rules"]
    model: str | None
    fallback_reason: Reason | None
    content: str
    data: dict[str, Any]
    anonymized: bool


# ---- facts -------------------------------------------------------------------------------------------------------
async def _students(conn: Conn, ids: set[int]) -> dict[int, Student]:
    if not ids:
        return {}
    rows = await fetch_all(
        conn, "SELECT id, public_id, full_name FROM students WHERE id = ANY(%s)", (sorted(ids),)
    )
    return {r["id"]: Student(r["id"], str(r["public_id"]), r["full_name"]) for r in rows}


async def _debt_rows(conn: Conn) -> list[dict[str, Any]]:
    return await fetch_all(
        conn,
        "SELECT b.student_id AS id, b.outstanding_total AS outstanding, b.overdue_total AS overdue, "
        "(SELECT min(cb.next_due) FROM v_charge_balance cb WHERE cb.student_id = b.student_id "
        " AND cb.overdue_outstanding > 0) AS oldest_due "
        "FROM v_student_balance b WHERE b.outstanding_total > 0",
    )


def _debt_facts(rows: list[dict[str, Any]]) -> list[DebtFact]:
    return [
        DebtFact(str(r["id"]), _whole(r["outstanding"]), _whole(r["overdue"]), r["oldest_due"]) for r in rows
    ]


async def _attendance(conn: Conn, today: date, days: int) -> dict[int, tuple[int, int, int, int]]:
    """Per student (attended_recent, marked_recent, attended_prev, marked_prev) over two windows of `days` days ending
    today. Excused absences and cancelled lessons are not counted: they say nothing about the student's drift."""
    split = today - timedelta(days=days)
    start = today - timedelta(days=2 * days)
    rows = await fetch_all(
        conn,
        "SELECT a.student_id, "
        "count(*) FILTER (WHERE l.lesson_date > %(split)s AND a.status IN ('present','late')) AS att_recent, "
        "count(*) FILTER (WHERE l.lesson_date > %(split)s AND a.status IN ('present','late','absent')) AS marked_recent, "
        "count(*) FILTER (WHERE l.lesson_date <= %(split)s AND a.status IN ('present','late')) AS att_prev, "
        "count(*) FILTER (WHERE l.lesson_date <= %(split)s AND a.status IN ('present','late','absent')) AS marked_prev "
        "FROM attendance a JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id "
        "WHERE l.lesson_date > %(start)s AND l.lesson_date <= %(today)s AND l.status <> 'cancelled' "
        "GROUP BY a.student_id",
        {"split": split, "start": start, "today": today},
    )
    return {
        r["student_id"]: (r["att_recent"], r["marked_recent"], r["att_prev"], r["marked_prev"]) for r in rows
    }


async def _trial_days_over(conn: Conn, today: date, cfg: SettingsOut) -> dict[int, int]:
    """Students on a trial that needs a decision, with the days past the free-days limit (0 when only the lesson limit
    was reached). A trial that is still running is not a risk."""
    rows = await fetch_all(
        conn,
        "SELECT e.student_id, e.started_on, "
        "(SELECT count(*) FROM attendance a JOIN lessons l ON l.org_id = a.org_id AND l.id = a.lesson_id "
        "  WHERE a.student_id = e.student_id AND l.group_id = e.group_id AND l.lesson_date >= e.started_on "
        "  AND a.status IN ('present', 'late')) AS lessons_attended "
        "FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
        "WHERE e.status = 'trial' AND s.deleted_at IS NULL",
    )
    over: dict[int, int] = {}
    for r in rows:
        state = trial_status(
            started_on=r["started_on"],
            today=today,
            lessons_attended=int(r["lessons_attended"]),
            free_lessons=cfg.trial_free_lessons,
            free_days=cfg.trial_free_days,
        )
        if state == "decision_needed":
            days = max(0, (today - r["started_on"]).days - cfg.trial_free_days)
            over[r["student_id"]] = max(over.get(r["student_id"], 0), days)
    return over


async def _risk_items(
    conn: Conn, today: date, cfg: SettingsOut, debt_rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    people = await fetch_all(
        conn,
        "SELECT DISTINCT e.student_id AS id FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
        "WHERE s.deleted_at IS NULL AND e.status IN ('trial', 'active', 'frozen')",
    )
    att = await _attendance(conn, today, RISK_WINDOW_DAYS)
    trial = await _trial_days_over(conn, today, cfg)
    age = {
        r["id"]: debt_age_days(overdue=_whole(r["overdue"]), oldest_due=r["oldest_due"], today=today)
        for r in debt_rows
    }
    facts = []
    for p in people:
        a = att.get(p["id"], (0, 0, 0, 0))
        facts.append(RiskFact(str(p["id"]), a[0], a[1], a[2], a[3], age.get(p["id"], 0), trial.get(p["id"])))
    return churn_risk(facts)


async def _week_facts(
    conn: Conn, today: date, debt_rows: list[dict[str, Any]], risk: list[dict[str, Any]]
) -> WeekFacts:
    start = today - timedelta(days=6)
    prev_start = today - timedelta(days=13)
    prev_end = today - timedelta(days=7)

    async def income(a: date, b: date) -> int:
        row = await fetch_one(
            conn,
            "SELECT COALESCE(sum(total), 0) AS v FROM v_daily_revenue WHERE day BETWEEN %s AND %s",
            (a, b),
        )
        return _whole(row["v"]) if row else 0

    spent = await fetch_one(
        conn,
        "SELECT COALESCE(sum(amount), 0) AS v FROM expenses WHERE voided_at IS NULL AND spent_at BETWEEN %s AND %s",
        (start, today),
    )
    enrollments = await fetch_all(
        conn,
        "SELECT e.student_id, e.status, e.started_on, e.accepted_on, e.ended_on, "
        "(e.status = 'finished' AND e.accepted_on IS NULL AND e.dropped_reason IS NOT NULL) AS dropped_trial "
        "FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id WHERE s.deleted_at IS NULL",
    )
    movement = student_movement(
        [
            EnrollmentFact(
                str(r["student_id"]),
                r["status"],
                r["started_on"],
                r["accepted_on"],
                r["ended_on"],
                r["dropped_trial"],
            )
            for r in enrollments
        ],
        date_from=start,
        date_to=today,
    )
    week = await _attendance(conn, today, 7)
    attended = sum(v[0] for v in week.values())
    marked = sum(v[1] for v in week.values())
    attended_prev = sum(v[2] for v in week.values())
    marked_prev = sum(v[3] for v in week.values())
    return WeekFacts(
        income=await income(start, today),
        income_prev=await income(prev_start, prev_end),
        expenses=_whole(spent["v"]) if spent else 0,
        new_students=movement["new"],
        left_students=movement["left"],
        unpaid=len(debt_rows),
        unpaid_total=sum(_whole(r["outstanding"]) for r in debt_rows),
        overdue=sum(1 for r in debt_rows if _whole(r["overdue"]) > 0),
        attended=attended,
        marked=marked,
        attended_prev=attended_prev,
        marked_prev=marked_prev,
        high_risk=sum(1 for i in risk if i["level"] == "high"),
        medium_risk=sum(1 for i in risk if i["level"] == "medium"),
    )


async def _ai_reports_today(conn: Conn, today: date) -> int:
    row = await fetch_one(
        conn,
        "SELECT count(*) AS n FROM ai_reports r JOIN organizations o ON o.id = r.org_id "
        "WHERE r.source = 'ai' AND (r.created_at AT TIME ZONE o.timezone)::date = %s",
        (today,),
    )
    return int(row["n"]) if row else 0


# ---- prepare: facts -> rules -> rule text and prompt -------------------------------------------------------------
def _decide(cfg: SettingsOut, transport: AiTransport | None, used_today: int) -> Reason | None:
    if not cfg.ai_enabled:
        return "ai_disabled"
    if transport is None:
        return "ai_not_configured"
    if used_today >= cfg.ai_daily_limit:
        return "ai_limit_reached"
    return None


async def prepare(
    conn: Conn, *, kind: Kind, today: date, cfg: SettingsOut, transport: AiTransport | None
) -> Prepared:
    pseudo = Pseudonymizer(reveal_names=cfg.ai_sees_names)
    reason = _decide(cfg, transport, await _ai_reports_today(conn, today))
    debt_rows = await _debt_rows(conn)
    if kind == "debt_followup":
        return await _prepare_debt(conn, today, cfg, reason, pseudo, debt_rows)
    risk = await _risk_items(conn, today, cfg, debt_rows)
    if kind == "churn_risk":
        return await _prepare_risk(conn, today, cfg, reason, pseudo, risk)
    return await _prepare_weekly(conn, today, cfg, reason, pseudo, debt_rows, risk)


async def _prepare_debt(
    conn: Conn,
    today: date,
    cfg: SettingsOut,
    reason: Reason | None,
    pseudo: Pseudonymizer,
    debt_rows: list[dict[str, Any]],
) -> Prepared:
    items = debt_followup(_debt_facts(debt_rows), today=today)
    shown = items[:LIST_LIMIT]
    names = await _students(conn, {int(i["id"]) for i in shown})
    out: list[dict[str, Any]] = []
    prompt_lines: list[str] = []
    amounts: dict[str, int] = {}
    for i in shown:
        st = names[int(i["id"])]
        token = pseudo.token(st.public_id, st.name)
        amounts[token] = i["outstanding"]
        draft = debt_message(i["tone"], st.name, i["outstanding"], i["age_days"])
        out.append(
            {
                "student_id": st.public_id,
                "name": st.name,
                "outstanding": i["outstanding"],
                "overdue": i["overdue"],
                "age_days": i["age_days"],
                "tone": i["tone"],
                "score": i["score"],
                "draft": draft,
                "draft_source": "rules",
            }
        )
        prompt_lines.append(
            f"{pseudo.label(st.public_id, st.name)}: owes {fmt_money(i['outstanding'])} so'm (write exactly this amount), "
            f"overdue {fmt_money(i['overdue'])} so'm, {i['age_days']} days overdue, tone to use: {i['tone']} "
            f"(reminder = not due yet, soft, firm, final = polite but clear; never a threat)"
        )
    lines = [
        debt_line(rank, o["name"], o["outstanding"], o["age_days"], o["tone"])
        for rank, o in enumerate(out, 1)
    ]
    text = (
        "Qarz bo'yicha maslahat: avval bog'lanish kerak bo'lganlar (qarzi katta va eskilari yuqorida). "
        "Matnlar faqat qoralama: yuborishni odam hal qiladi.\n" + "\n".join(lines)
        if lines
        else "Qarzdor o'quvchi yo'q."
    )
    task = (
        f"Task: debt follow-up for {len(shown)} students listed in order of urgency (most urgent first). "
        'In "text": say in 3-5 sentences who to contact first and why, and what tone to keep. '
        'In "items": for EACH student code write the message draft for the guardian: greeting, the exact amount, the '
        "given tone, an offer to agree on a payment date. No links, no penalties, at most 400 characters."
    )
    return Prepared(
        "debt_followup", today, cfg.ai_sees_names, reason, names, text,
        {"items": out, "total": len(items)},
        task + "\nFacts:\n" + "\n".join(prompt_lines) if prompt_lines else "",
        pseudo, [int(i["id"]) for i in shown], amounts,
    )  # fmt: skip


async def _prepare_risk(
    conn: Conn,
    today: date,
    cfg: SettingsOut,
    reason: Reason | None,
    pseudo: Pseudonymizer,
    risk: list[dict[str, Any]],
) -> Prepared:
    shown = risk[:LIST_LIMIT]
    names = await _students(conn, {int(i["id"]) for i in shown})
    out: list[dict[str, Any]] = []
    prompt_lines: list[str] = []
    for i in shown:
        st = names[int(i["id"])]
        pseudo.token(st.public_id, st.name)
        out.append(
            {
                "student_id": st.public_id,
                "name": st.name,
                "score": i["score"],
                "level": i["level"],
                "reasons": i["reasons"],
                "attendance_recent": i["attendance_recent"],
                "attendance_prev": i["attendance_prev"],
                "suggestion": "",
                "suggestion_source": "rules",
            }
        )
        prompt_lines.append(
            f"{pseudo.label(st.public_id, st.name)}: risk score {i['score']} ({i['level']}); reasons: {', '.join(i['reasons'])}; "
            f"attendance last {RISK_WINDOW_DAYS} days {i['attendance_recent']}% vs the {RISK_WINDOW_DAYS} days before {i['attendance_prev']}% "
            "(null = too few lessons)"
        )
    lines = [
        risk_line(rank, o["name"], o["score"], o["level"], o["reasons"]) for rank, o in enumerate(out, 1)
    ]
    text = (
        "Ketish xavfi ostidagi o'quvchilar (ball qancha yuqori bo'lsa, xavf shuncha katta):\n"
        + "\n".join(lines)
        if lines
        else "Ketish xavfi ostidagi o'quvchi yo'q."
    )
    task = (
        f"Task: churn-risk list, {len(shown)} students, highest risk first. Reasons: attendance_drop, debt (overdue payment), "
        'trial_no_answer (trial ended, no decision yet). In "text": 3-5 sentences on what the owner should do first. '
        'In "items": for EACH student code one short sentence (at most 300 characters) with the next step for the staff.'
    )
    return Prepared(
        "churn_risk", today, cfg.ai_sees_names, reason, names, text, {"items": out},
        task + "\nFacts:\n" + "\n".join(prompt_lines) if prompt_lines else "",
        pseudo, [int(i["id"]) for i in shown], {},
    )  # fmt: skip


async def _prepare_weekly(
    conn: Conn,
    today: date,
    cfg: SettingsOut,
    reason: Reason | None,
    pseudo: Pseudonymizer,
    debt_rows: list[dict[str, Any]],
    risk: list[dict[str, Any]],
) -> Prepared:
    week = weekly_summary(await _week_facts(conn, today, debt_rows, risk))
    top_debt = debt_followup(_debt_facts(debt_rows), today=today)[:5]
    top_risk = risk[:5]
    names = await _students(conn, {int(i["id"]) for i in top_debt} | {int(i["id"]) for i in top_risk})
    data = {
        "summary": week,
        "top_debtors": [
            {"student_id": names[int(i["id"])].public_id, "name": names[int(i["id"])].name, "outstanding": i["outstanding"], "age_days": i["age_days"], "tone": i["tone"]}
            for i in top_debt
        ],
        "top_risk": [
            {"student_id": names[int(i["id"])].public_id, "name": names[int(i["id"])].name, "score": i["score"], "level": i["level"], "reasons": i["reasons"]}
            for i in top_risk
        ],
    }  # fmt: skip
    facts = [*week["lines"]]
    for i in top_debt:
        st = names[int(i["id"])]
        facts.append(
            f"Largest open debt: {pseudo.label(st.public_id, st.name)} owes {fmt_money(i['outstanding'])} so'm, {i['age_days']} days overdue."
        )
    for i in top_risk:
        st = names[int(i["id"])]
        facts.append(
            f"Risk of leaving: {pseudo.label(st.public_id, st.name)}, score {i['score']} ({i['level']}), reasons {', '.join(i['reasons'])}."
        )
    task = (
        'Task: weekly summary for the owner. In "text": 4-6 sentences. First what happened this week (money, students, '
        "attendance), then the 2-3 things the owner should act on first. Use the numbers exactly as written. "
        'No per-student texts: "items" must be {}.'
    )
    text = "Haftalik xulosa (oxirgi 7 kun):\n" + "\n".join(week["lines"])
    return Prepared(
        "weekly_summary", today, cfg.ai_sees_names, reason, names, text, data,
        task + "\nFacts:\n" + "\n".join(facts), pseudo, [], {},
    )  # fmt: skip


# ---- finish: AI prose or the rule text (no database here) --------------------------------------------------------
def _clean(text: str, limit: int) -> str:
    return _CONTROL.sub("", text).strip()[:limit]


def parse_ai_answer(raw: str, allowed: frozenset[str]) -> tuple[str, dict[str, str]]:
    """The model's JSON answer -> (overall text, per-student texts). Raises ValueError on anything unusable. Per-student
    texts for codes that were never issued, empty ones, over-long ones and ones with links are dropped, not trusted."""
    body = raw.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", body, re.DOTALL)
    if fence:
        body = fence.group(1)
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object")
    data = json.loads(body[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("not an object")
    text = data.get("text")
    if not isinstance(text, str) or not _clean(text, MAX_TEXT):
        raise ValueError("no text")
    if _URL.search(text):
        raise ValueError("link in text")
    items: dict[str, str] = {}
    raw_items = data.get("items")
    if isinstance(raw_items, dict):
        for key, value in raw_items.items():
            if key in allowed and isinstance(value, str):
                v = _clean(value, MAX_ITEM_TEXT)
                if v and not _URL.search(v):
                    items[key] = v
    return _clean(text, MAX_TEXT), items


async def finish(prep: Prepared, transport: AiTransport | None) -> Finished:
    if prep.ai_reason is not None:
        return _rules(prep, prep.ai_reason)
    if prep.kind != "weekly_summary" and not prep.ai_ids:
        return _rules(prep, "nothing_to_report")  # an empty list: no AI call, no daily quota used
    assert transport is not None  # ai_reason is None only when a transport exists
    try:
        raw = await transport.complete(system=SYSTEM_PROMPT, prompt=prep.ai_prompt)
        text, items = parse_ai_answer(raw, prep.pseudo.tokens)
    except AiUnavailable:
        return _rules(prep, "ai_unavailable")
    except ValueError:  # json.JSONDecodeError is a ValueError
        return _rules(prep, "ai_bad_output")
    return _with_ai(prep, transport.model, text, items)


def _rules(prep: Prepared, reason: Reason) -> Finished:
    return Finished(
        kind=prep.kind,
        today=prep.today,
        source="rules",
        model=None,
        fallback_reason=reason,
        content=prep.rules_text,
        data=prep.data,
        anonymized=not prep.reveal_names,
    )


def _with_ai(prep: Prepared, model: str, text: str, items: dict[str, str]) -> Finished:
    data = json.loads(json.dumps(prep.data))  # deep copy, the prepared data stays the rule-based record
    token_of = {s.public_id: tok for tok, s in _token_students(prep).items()}
    for entry in data.get("items", []):
        token = token_of.get(entry["student_id"])
        said = items.get(token or "")
        if said is None:
            continue
        restored = prep.pseudo.restore(said)
        if prep.kind == "debt_followup":
            # a draft must state the exact amount the books show, otherwise the rule-based draft stays
            if fmt_money(entry["outstanding"]) in restored:
                entry["draft"], entry["draft_source"] = restored, "ai"
        else:
            entry["suggestion"], entry["suggestion_source"] = restored, "ai"
    return Finished(
        kind=prep.kind,
        today=prep.today,
        source="ai",
        model=model,
        fallback_reason=None,
        content=prep.pseudo.restore(text),
        data=data,
        anonymized=not prep.reveal_names,
    )


def _token_students(prep: Prepared) -> dict[str, Student]:
    return {
        prep.pseudo.token(prep.names[i].public_id, prep.names[i].name): prep.names[i] for i in prep.ai_ids
    }


# ---- store -------------------------------------------------------------------------------------------------------
async def store(conn: Conn, fin: Finished, *, user_id: int, org_id: int) -> dict[str, Any]:
    row = await fetch_one(
        conn,
        "INSERT INTO ai_reports (org_id, kind, period_end, source, model, fallback_reason, content, data, anonymized, "
        "created_by_user_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s) "
        "RETURNING public_id, kind, period_end, source, model, fallback_reason, content, data, anonymized, created_at",
        (
            org_id, fin.kind, fin.today, fin.source, fin.model, fin.fallback_reason, fin.content,
            json.dumps(fin.data, ensure_ascii=False), fin.anonymized, user_id,
        ),
    )  # fmt: skip
    assert row is not None
    return row


async def list_reports(conn: Conn, *, kind: str | None, limit: int) -> list[dict[str, Any]]:
    return await fetch_all(
        conn,
        "SELECT public_id, kind, period_end, source, model, fallback_reason, content, data, anonymized, created_at "
        "FROM ai_reports WHERE (%s::text IS NULL OR kind = %s) ORDER BY created_at DESC, id DESC LIMIT %s",
        (kind, kind, limit),
    )


async def get_report(conn: Conn, public_id: uuid.UUID) -> dict[str, Any] | None:
    return await fetch_one(
        conn,
        "SELECT public_id, kind, period_end, source, model, fallback_reason, content, data, anonymized, created_at "
        "FROM ai_reports WHERE public_id = %s",
        (public_id,),
    )
