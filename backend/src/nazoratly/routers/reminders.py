"""Debt reminders to guardians: drafts computed from the books, approved by a person, then queued in the outbox.

The Sheets edition keeps drafts in a tab; here a draft is not stored. `GET` computes the drafts, `POST` is the person's
approval: it recomputes them under a lock and queues only students who are still eligible, with the text the person
approved (edited or not). Cooldown counts the reminders queued by this route that were not cancelled."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import Field, StringConstraints

from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Principal, require
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.settings import load_settings_at
from nazoratly.rules import reminders as R
from nazoratly.schemas import Dec2, Model, Out

router = APIRouter(prefix="/v1", tags=["finance"], route_class=IdempotentRoute)

_PATH = "/reports/debtors/reminders"
_KEY_PREFIX = "debt-reminder-"


class ReminderDraftOut(Out):
    student_id: uuid.UUID
    student_name: str
    guardian_id: uuid.UUID
    guardian_name: str
    kind: R.Kind
    overdue_total: Dec2
    text: str


class ReminderSkipOut(Out):
    student_id: uuid.UUID
    student_name: str
    reason: R.SkipReason


class ReminderPreviewOut(Out):
    drafts: list[ReminderDraftOut]
    skipped: list[ReminderSkipOut]


class ReminderMessageIn(Model):
    student_id: uuid.UUID
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


class ReminderSendIn(Model):
    messages: Annotated[list[ReminderMessageIn], Field(min_length=1, max_length=200)]


class ReminderQueuedOut(Out):
    student_id: uuid.UUID
    message_id: uuid.UUID


class ReminderRefusedOut(Out):
    student_id: uuid.UUID
    reason: str = Field(
        description="a skip reason of the preview, or `not_due` when nothing calls for a reminder"
    )


class ReminderSendOut(Out):
    queued: list[ReminderQueuedOut]
    refused: list[ReminderRefusedOut]


# One row per student with an open charge: what is overdue and since when (installment plans included).
_DEBTS = (
    "SELECT b.student_id, sum(b.overdue_outstanding) AS overdue, min(b.next_due) AS oldest, CURRENT_DATE AS today "
    "FROM v_charge_balance b JOIN students s ON s.org_id = b.org_id AND s.id = b.student_id "
    "WHERE b.outstanding > 0 AND s.deleted_at IS NULL GROUP BY b.student_id "
    "ORDER BY sum(b.overdue_outstanding) DESC, b.student_id"
)
_INSTALLMENTS = (
    "SELECT b.student_id, i.charge_id, i.seq, i.due_date, i.outstanding,"
    " count(*) OVER (PARTITION BY i.charge_id) AS total "
    "FROM v_installment_balance i JOIN v_charge_balance b ON b.org_id = i.org_id AND b.charge_id = i.charge_id"
)
_INSTALLMENT_ROWS = (
    f"SELECT * FROM ({_INSTALLMENTS}) x WHERE x.outstanding > 0 ORDER BY x.due_date, x.charge_id, x.seq"
)
_STUDENTS = (
    "SELECT s.id, s.public_id, s.full_name, s.status, g.public_id AS guardian_public_id,"
    " g.full_name AS guardian_name, g.id AS guardian_id, (g.telegram_chat_id IS NOT NULL) AS has_chat,"
    " EXISTS (SELECT 1 FROM data_consents d WHERE d.org_id = s.org_id AND d.student_id = s.id"
    "   AND d.purpose = 'notifications' AND d.revoked_at IS NULL) AS consent,"
    " (SELECT max((m.created_at AT TIME ZONE o.timezone)::date) FROM outbox_messages m"
    "   JOIN organizations o ON o.id = m.org_id WHERE m.org_id = s.org_id AND m.student_id = s.id"
    "   AND m.status <> 'cancelled' AND starts_with(m.idempotency_key, %(prefix)s)) AS last_reminded_on "
    "FROM students s LEFT JOIN LATERAL ("
    "  SELECT gu.id, gu.public_id, gu.full_name, gu.telegram_chat_id FROM student_guardians sg"
    "  JOIN guardians gu ON gu.org_id = sg.org_id AND gu.id = sg.guardian_id"
    "  WHERE sg.org_id = s.org_id AND sg.student_id = s.id AND sg.receives_reminders AND gu.deleted_at IS NULL"
    "  ORDER BY (gu.telegram_chat_id IS NOT NULL) DESC, sg.is_primary DESC, gu.id LIMIT 1) g ON TRUE "
    "WHERE s.id = ANY(%(ids)s)"
)


def _ref(row: dict[str, Any]) -> R.InstallmentRef:
    return R.InstallmentRef(int(row["seq"]), int(row["total"]), row["due_date"], row["outstanding"])


async def _plan(
    conn: Conn, org_id: int
) -> tuple[list[R.Draft], list[R.Skip], dict[str, dict[str, Any]], dict[str, Decimal]]:
    settings = await load_settings_at(conn, org_id, None)
    center = await fetch_one(conn, "SELECT name FROM organizations WHERE id = %s", (org_id,))
    assert center is not None
    debt_rows = await fetch_all(conn, _DEBTS)
    if not debt_rows:
        return [], [], {}, {}
    today: date = debt_rows[0]["today"]
    ids = [r["student_id"] for r in debt_rows]
    people = {r["id"]: r for r in await fetch_all(conn, _STUDENTS, {"ids": ids, "prefix": _KEY_PREFIX})}
    overdue_ref: dict[int, dict[str, Any]] = {}
    next_ref: dict[int, dict[str, Any]] = {}
    for row in await fetch_all(conn, _INSTALLMENT_ROWS):  # earliest first: the first hit of each kind wins
        target = overdue_ref if row["due_date"] < today else next_ref
        target.setdefault(row["student_id"], row)

    debts: list[R.DebtFacts] = []
    students: dict[str, R.StudentFacts] = {}
    by_key: dict[str, dict[str, Any]] = {}
    overdue: dict[str, Decimal] = {}
    for d in debt_rows:
        s = people[d["student_id"]]
        key = str(s["public_id"])
        first = overdue_ref.get(d["student_id"])
        upcoming = next_ref.get(d["student_id"])
        debts.append(
            R.DebtFacts(
                key,
                d["overdue"],
                max((today - d["oldest"]).days, 0) if d["oldest"] else 0,
                # the installment is named only when it IS the oldest debt (an older plain charge speaks for itself)
                _ref(first) if first and first["due_date"] == d["oldest"] else None,
                _ref(upcoming) if upcoming else None,
            )
        )
        students[key] = R.StudentFacts(
            key,
            s["full_name"],
            s["status"],
            s["guardian_name"],
            bool(s["has_chat"]),
            bool(s["consent"]),
            s["last_reminded_on"],
        )
        by_key[key] = s
        overdue[key] = d["overdue"]
    drafts, skipped = R.plan(
        debts=debts,
        students=students,
        today=today,
        cooldown_days=settings.reminder_cooldown_days,
        min_overdue=Decimal(settings.reminder_min_overdue),
        remind_days=settings.installment_remind_days,
        template=settings.reminder_template or R.DEFAULT_TEMPLATE,
        center=center["name"],
    )
    return drafts, skipped, by_key, overdue


@router.get(
    _PATH,
    response_model=ReminderPreviewOut,
    summary="Draft debt reminders (nothing is stored or sent) and who was left out",
)
async def preview_reminders(
    p: Annotated[Principal, Depends(require("finance:read", "students:write"))], db: DB
) -> ReminderPreviewOut:
    async with db.tx(p.session()) as conn:
        drafts, skipped, people, overdue = await _plan(conn, p.org_id)
    return ReminderPreviewOut(
        drafts=[
            ReminderDraftOut(
                student_id=uuid.UUID(d.student_id),
                student_name=people[d.student_id]["full_name"],
                guardian_id=people[d.student_id]["guardian_public_id"],
                guardian_name=people[d.student_id]["guardian_name"],
                kind=d.kind,
                overdue_total=overdue[d.student_id],
                text=d.text,
            )
            for d in drafts
        ],
        skipped=[
            ReminderSkipOut(
                student_id=uuid.UUID(s.student_id),
                student_name=people[s.student_id]["full_name"],
                reason=s.reason,
            )
            for s in skipped
        ],
    )


@router.post(
    _PATH,
    response_model=ReminderSendOut,
    status_code=201,
    summary="Approve reminders: queue them for the guardians (this call IS the person's approval)",
)
async def send_reminders(
    body: ReminderSendIn,
    p: Annotated[Principal, Depends(require("finance:read", "students:write"))],
    db: DB,
) -> ReminderSendOut:
    queued: list[ReminderQueuedOut] = []
    refused: list[ReminderRefusedOut] = []
    async with db.tx(p.session()) as conn:
        # two people approving at once must not both pass the cooldown
        await execute(conn, "SELECT pg_advisory_xact_lock(hashtext('debt-reminders'), %s::int)", (p.org_id,))
        for message in body.messages:
            await resolve(
                conn, "students", message.student_id, what="student"
            )  # another center's id is a 404
        drafts, skipped, people, _ = await _plan(conn, p.org_id)
        eligible = {d.student_id for d in drafts}
        why = {s.student_id: s.reason for s in skipped}
        for message in body.messages:
            key = str(message.student_id)
            if key not in eligible:
                refused.append(
                    ReminderRefusedOut(student_id=message.student_id, reason=why.get(key, "not_due"))
                )
                continue
            eligible.discard(key)  # the same student twice in one request is queued once
            why[key] = "cooldown"
            person = people[key]
            row = await fetch_one(
                conn,
                "INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, idempotency_key) "
                "VALUES (%s, %s, %s, 'telegram', %s, %s) RETURNING public_id",
                (
                    p.org_id,
                    person["id"],
                    person["guardian_id"],
                    message.text,
                    f"{_KEY_PREFIX}{uuid.uuid4().hex}",
                ),
            )
            assert row is not None
            queued.append(ReminderQueuedOut(student_id=message.student_id, message_id=row["public_id"]))
    return ReminderSendOut(queued=queued, refused=refused)
