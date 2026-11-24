"""Multi-branch administration (G6): the view scope, the per-branch report next to the total, moving a student between
branches, prices and settings per branch, the default branch. Branch CRUD itself lives in routers/org.py.

How separation works: every business row carries a branch mark and the database narrows each session to its branch
(row-level security keyed on `app.branch_id`), so staff of a branch see only their branch in every list, report and the
ledger. Center-wide staff (membership without a branch) see the total and may narrow the view with the `X-Branch` header.
Rules shared with the Sheets edition: rules/branches.py (golden tests in tests/golden/branches.json)."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, StringConstraints

from nazoratly.accounting import org_today
from nazoratly.branches import branch_by_public
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.settings import SettingsOut, load_settings_at, set_branch_overrides
from nazoratly.rules.branches import branch_totals, effective_value, transfer_check
from nazoratly.schemas import Dec2, Message, Model, Money, Out

router = APIRouter(prefix="/v1", tags=["branches"], route_class=IdempotentRoute)

Reason = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


# ---- the view scope --------------------------------------------------------------------------------------------
class ScopeOut(Out):
    center_wide: bool = Field(description="false = the staff member belongs to one branch and sees only it")
    member_branch_id: uuid.UUID | None = Field(
        description="the branch of the staff member (None = center-wide)"
    )
    view_branch_id: uuid.UUID | None = Field(
        description="the branch this request works in (X-Branch, or the member's own); None = the whole center"
    )
    view_branch_name: str | None


@router.get(
    "/branch-scope",
    response_model=ScopeOut,
    summary="Which branch do my requests work in? (send X-Branch to narrow a center-wide view to one branch)",
)
async def my_scope(p: Annotated[Principal, Depends(require("org:read"))], db: DB) -> ScopeOut:
    async with db.tx(p.session(unscoped=True) if p.center_wide else p.session()) as conn:
        member = (
            None
            if p.branch_id is None
            else await fetch_one(conn, "SELECT public_id, name FROM branches WHERE id = %s", (p.branch_id,))
        )
        view = (
            None
            if p.scope_branch_id is None
            else await fetch_one(
                conn, "SELECT public_id, name FROM branches WHERE id = %s", (p.scope_branch_id,)
            )
        )
    return ScopeOut(
        center_wide=p.center_wide,
        member_branch_id=None if member is None else member["public_id"],
        view_branch_id=None if view is None else view["public_id"],
        view_branch_name=None if view is None else view["name"],
    )


# ---- report: per branch and total ------------------------------------------------------------------------------
class BranchReportRow(Out):
    branch_id: uuid.UUID | None = Field(description="None on the total row")
    name: str
    students_active: int
    groups_active: int
    enrollments_active: int
    revenue: Dec2 = Field(description="payments received in the month minus the part given back, so'm")
    charges: Dec2 = Field(description="tuition and other charges of the month (after discounts), so'm")
    expenses: Dec2 = Field(description="expenses of the month, so'm")
    net: Dec2 = Field(description="revenue minus expenses")
    debt: Dec2 = Field(description="unpaid charges of the branch, today")
    cash_balance: Dec2 = Field(
        description="what the books say the branch's cash desk holds at the end of the month"
    )


class BranchReportOut(Out):
    month: date
    rows: list[BranchReportRow]
    total: BranchReportRow = Field(description="always the sum of the rows")


@router.get(
    "/branch-report",
    response_model=BranchReportOut,
    summary="Per-branch figures of a month next to the center total (staff of a branch see only their own row)",
)
async def branch_report(
    p: Annotated[Principal, Depends(require("reports:read"))],
    db: DB,
    month: Annotated[date | None, Query(description="first day of the month; default: this month")] = None,
) -> BranchReportOut:
    async with db.tx(p.session()) as conn:
        today = await org_today(conn)
        first = (month or today).replace(day=1)
        nxt = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
        last = nxt - timedelta(days=1)
        tz = await fetch_one(conn, "SELECT timezone FROM organizations WHERE id = %s", (p.org_id,))
        assert tz is not None
        branches = await fetch_all(
            conn,
            "SELECT id, public_id, name FROM branches WHERE deleted_at IS NULL ORDER BY is_default DESC, lower(name), id",
        )
        facts: list[dict[str, Any]] = []
        for kind, sql, args in (
            (
                "payment",
                "SELECT branch_id, sum(amount - refunded) AS amt FROM payments WHERE voided_at IS NULL "
                "AND (paid_at AT TIME ZONE %s)::date BETWEEN %s AND %s GROUP BY branch_id",
                (tz["timezone"], first, last),
            ),
            (
                "charge",
                "SELECT branch_id, sum(amount) AS amt FROM charges WHERE voided_at IS NULL "
                "AND period_month = %s GROUP BY branch_id",
                (first,),
            ),
            (
                "expense",
                "SELECT branch_id, sum(amount) AS amt FROM expenses WHERE voided_at IS NULL "
                "AND spent_at BETWEEN %s AND %s GROUP BY branch_id",
                (first, last),
            ),
        ):
            for r in await fetch_all(conn, sql, args):
                facts.append(
                    {"branch": r["branch_id"], "kind": kind, "amount": str(r["amt"]), "voided": False}
                )
        folded = branch_totals([{"id": b["id"]} for b in branches], facts)
        counts = {
            int(r["branch_id"]): r
            for r in await fetch_all(
                conn,
                "SELECT b.id AS branch_id,"
                " (SELECT count(*) FROM students s WHERE s.branch_id = b.id AND s.status = 'active' AND s.deleted_at IS NULL) AS students,"
                " (SELECT count(*) FROM study_groups g WHERE g.branch_id = b.id AND g.status = 'active' AND g.deleted_at IS NULL) AS groups,"
                " (SELECT count(*) FROM enrollments e WHERE e.branch_id = b.id AND e.status = 'active') AS enrollments,"
                " COALESCE((SELECT sum(v.outstanding) FROM v_charge_balance v JOIN charges c ON c.id = v.charge_id"
                "           WHERE c.branch_id = b.id), 0) AS debt,"
                " COALESCE((SELECT sum(l.debit - l.credit) FROM journal_lines l JOIN journal_entries je ON je.org_id = l.org_id AND je.id = l.entry_id"
                "           JOIN cash_accounts ca ON ca.org_id = l.org_id AND ca.account_id = l.account_id"
                "           WHERE l.branch_id = b.id AND ca.kind = 'cash' AND je.entry_date <= %s), 0) AS cash "
                "FROM branches b WHERE b.deleted_at IS NULL",
                (last,),
            )
        }
    rows: list[BranchReportRow] = []
    for b, money in zip(branches, folded["rows"], strict=True):
        c = counts[int(b["id"])]
        rows.append(
            BranchReportRow(
                branch_id=b["public_id"],
                name=b["name"],
                students_active=int(c["students"]),
                groups_active=int(c["groups"]),
                enrollments_active=int(c["enrollments"]),
                revenue=Decimal(money["revenue"]),
                charges=Decimal(money["charges"]),
                expenses=Decimal(money["expenses"]),
                net=Decimal(money["net"]),
                debt=Decimal(c["debt"]),
                cash_balance=Decimal(c["cash"]),
            )
        )
    t = folded["total"]
    total = BranchReportRow(
        branch_id=None,
        name="Jami",
        students_active=sum(r.students_active for r in rows),
        groups_active=sum(r.groups_active for r in rows),
        enrollments_active=sum(r.enrollments_active for r in rows),
        revenue=Decimal(t["revenue"]),
        charges=Decimal(t["charges"]),
        expenses=Decimal(t["expenses"]),
        net=Decimal(t["net"]),
        debt=sum((r.debt for r in rows), Decimal(0)),
        cash_balance=sum((r.cash_balance for r in rows), Decimal(0)),
    )
    return BranchReportOut(month=first, rows=rows, total=total)


# ---- the default branch ----------------------------------------------------------------------------------------
@router.post(
    "/branches/{branch_id}/default",
    response_model=Message,
    summary="Make this branch the center's default (where rows land when no branch is chosen)",
)
async def make_default(
    branch_id: uuid.UUID, p: Annotated[Principal, Depends(require("branches:manage"))], db: DB
) -> Message:
    async with db.tx(p.session(unscoped=True)) as conn:
        b = await branch_by_public(conn, branch_id)
        if b["status"] != "active":
            raise Conflict("A closed branch cannot be the default")
        await execute(
            conn, "UPDATE branches SET is_default = false WHERE is_default AND id <> %s", (b["id"],)
        )
        await execute(conn, "UPDATE branches SET is_default = true WHERE id = %s", (b["id"],))
    return Message(message="default branch changed")


# ---- prices per branch -----------------------------------------------------------------------------------------
class PriceIn(Model):
    monthly_fee: Money


class PriceOut(Out):
    course_id: uuid.UUID
    course_name: str
    course_fee: Dec2 = Field(description="the course's own default fee")
    branch_fee: Dec2 | None = Field(description="the price in this branch (None = the course fee applies)")
    effective_fee: Dec2 = Field(description="the default monthly fee of a new group of this branch")


_PRICE_SQL = (
    "SELECT c.public_id AS course_id, c.name AS course_name, c.default_monthly_fee AS course_fee, bp.monthly_fee AS branch_fee "
    "FROM courses c LEFT JOIN branch_course_prices bp ON bp.org_id = c.org_id AND bp.course_id = c.id AND bp.branch_id = %s "
    "WHERE c.deleted_at IS NULL"
)


def _price(row: dict[str, Any]) -> PriceOut:
    fee = effective_value(
        override=None if row["branch_fee"] is None else str(row["branch_fee"]), base=str(row["course_fee"])
    )
    assert fee is not None
    return PriceOut(**row, effective_fee=Decimal(fee))


@router.get(
    "/branches/{branch_id}/prices",
    response_model=list[PriceOut],
    summary="Course prices in a branch (course default unless the branch has its own)",
)
async def list_prices(
    branch_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:read"))], db: DB
) -> list[PriceOut]:
    async with db.tx(p.session()) as conn:
        b = await branch_by_public(conn, branch_id)
        rows = await fetch_all(conn, f"{_PRICE_SQL} ORDER BY lower(c.name)", (b["id"],))
    return [_price(r) for r in rows]


@router.put(
    "/branches/{branch_id}/prices/{course_id}",
    response_model=PriceOut,
    summary="Set the price of a course in a branch",
)
async def put_price(
    branch_id: uuid.UUID,
    course_id: uuid.UUID,
    body: PriceIn,
    p: Annotated[Principal, Depends(require("branches:manage"))],
    db: DB,
) -> PriceOut:
    async with db.tx(p.session(unscoped=True)) as conn:
        b = await branch_by_public(conn, branch_id)
        cid = await resolve(conn, "courses", course_id, what="course")
        await execute(
            conn,
            "INSERT INTO branch_course_prices (org_id, branch_id, course_id, monthly_fee) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (branch_id, course_id) DO UPDATE SET monthly_fee = EXCLUDED.monthly_fee",
            (p.org_id, b["id"], cid, body.monthly_fee),
        )
        row = await fetch_one(conn, f"{_PRICE_SQL} AND c.id = %s", (b["id"], cid))
    assert row is not None
    return _price(row)


@router.delete(
    "/branches/{branch_id}/prices/{course_id}",
    response_model=Message,
    summary="Remove the branch price (the course fee applies again)",
)
async def delete_price(
    branch_id: uuid.UUID,
    course_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("branches:manage"))],
    db: DB,
) -> Message:
    async with db.tx(p.session(unscoped=True)) as conn:
        b = await branch_by_public(conn, branch_id)
        cid = await resolve(conn, "courses", course_id, what="course")
        await execute(
            conn, "DELETE FROM branch_course_prices WHERE branch_id = %s AND course_id = %s", (b["id"], cid)
        )
    return Message(message="branch price removed")


async def price_for_new_group(conn: Conn, branch_id: int, course_id: int) -> Decimal:
    """The default monthly fee of a new group: the branch's price for the course, else the course's own."""
    row = await fetch_one(
        conn,
        "SELECT c.default_monthly_fee AS course_fee, bp.monthly_fee AS branch_fee FROM courses c "
        "LEFT JOIN branch_course_prices bp ON bp.org_id = c.org_id AND bp.course_id = c.id AND bp.branch_id = %s "
        "WHERE c.id = %s",
        (branch_id, course_id),
    )
    if row is None:
        raise NotFound("course not found")
    fee = effective_value(
        override=None if row["branch_fee"] is None else str(row["branch_fee"]), base=str(row["course_fee"])
    )
    assert fee is not None
    return Decimal(fee)


# ---- settings per branch ---------------------------------------------------------------------------------------
_OVERRIDES = (
    "trial_free_lessons",
    "trial_free_days",
    "excused_mode",
    "makeup_expiry_days",
    "makeup_lapses",
    "package_expiry_days",
    "package_low_lessons",
    "lead_reminder_days",
    "family_discount_2nd_percent",
    "family_discount_3rd_percent",
    "requisites",
)


class BranchSettingsOut(Out):
    effective: SettingsOut = Field(
        description="what applies in this branch (its own values over the center's)"
    )
    overrides: dict[str, Any] = Field(
        description="the branch's own values; a missing or null key = inherited"
    )


class BranchSettingsPatch(Model):
    """Send only what changes; `null` makes the branch inherit the center's value again."""

    trial_free_lessons: Annotated[int, Field(ge=0, le=100)] | None = None
    trial_free_days: Annotated[int, Field(ge=0, le=365)] | None = None
    excused_mode: Literal["makeup", "credit", "none"] | None = None
    makeup_expiry_days: Annotated[int, Field(ge=0, le=365)] | None = None
    makeup_lapses: bool | None = None
    package_expiry_days: Annotated[int, Field(ge=1, le=730)] | None = None
    package_low_lessons: Annotated[int, Field(ge=0, le=50)] | None = None
    lead_reminder_days: Annotated[int, Field(ge=1, le=60)] | None = None
    family_discount_2nd_percent: (
        Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)] | None
    ) = None
    family_discount_3rd_percent: (
        Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)] | None
    ) = None
    requisites: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None = None


async def _branch_settings(conn: Conn, org_id: int, branch: int) -> BranchSettingsOut:
    own = await fetch_one(
        conn,
        f"SELECT {', '.join(_OVERRIDES)} FROM branch_settings WHERE branch_id = %s",
        (branch,),
    )
    overrides = {k: (None if own is None else own[k]) for k in _OVERRIDES}
    return BranchSettingsOut(
        effective=await load_settings_at(conn, org_id, branch),
        overrides={k: (str(v) if isinstance(v, Decimal) else v) for k, v in overrides.items()},
    )


@router.get(
    "/branches/{branch_id}/settings",
    response_model=BranchSettingsOut,
    summary="Settings of a branch: effective values and the branch's own overrides",
)
async def get_branch_settings(
    branch_id: uuid.UUID, p: Annotated[Principal, Depends(require("org:read"))], db: DB
) -> BranchSettingsOut:
    async with db.tx(p.session()) as conn:
        b = await branch_by_public(conn, branch_id)
        return await _branch_settings(conn, p.org_id, int(b["id"]))


@router.patch(
    "/branches/{branch_id}/settings",
    response_model=BranchSettingsOut,
    summary="Change the branch's own settings (null = inherit the center's value again)",
)
async def patch_branch_settings(
    branch_id: uuid.UUID,
    body: BranchSettingsPatch,
    p: Annotated[Principal, Depends(require("branches:manage"))],
    db: DB,
) -> BranchSettingsOut:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session(unscoped=True)) as conn:
        b = await branch_by_public(conn, branch_id)
        await load_settings_at(conn, p.org_id, None)
        await set_branch_overrides(conn, p.org_id, int(b["id"]), changes)
        return await _branch_settings(conn, p.org_id, int(b["id"]))


# ---- moving a student between branches -------------------------------------------------------------------------
class TransferIn(Model):
    branch_id: uuid.UUID = Field(description="the branch the student moves to")
    end_enrollments: bool = Field(
        default=False,
        description="end his live enrollments in groups of other branches (otherwise the move is refused while he has any)",
    )
    moved_on: date | None = Field(default=None, description="defaults to today (the center's date)")
    reason: Reason | None = None


class TransferOut(Out):
    student_id: uuid.UUID
    from_branch_id: uuid.UUID
    to_branch_id: uuid.UUID
    moved_on: date
    ended_enrollments: int


class MoveOut(Out):
    id: uuid.UUID
    from_branch_id: uuid.UUID | None = Field(description="None when the branch left is not visible to you")
    to_branch_id: uuid.UUID | None
    moved_on: date
    reason: str | None
    ended_enrollments: int


@router.post(
    "/students/{student_id}/transfer",
    response_model=TransferOut,
    summary="Move a student to another branch (center-wide staff). History and money stay in the branch where they arose",
)
async def transfer_student(
    student_id: uuid.UUID,
    body: TransferIn,
    p: Annotated[Principal, Depends(require("students:write"))],
    db: DB,
) -> TransferOut:
    async with db.tx(p.session(unscoped=True)) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        student = await fetch_one(conn, "SELECT branch_id FROM students WHERE id = %s FOR UPDATE", (sid,))
        assert student is not None
        target = await branch_by_public(conn, body.branch_id)
        enrollments = await fetch_all(
            conn,
            "SELECT e.id, g.branch_id FROM enrollments e JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
            "WHERE e.student_id = %s AND e.status IN ('trial', 'active', 'frozen')",
            (sid,),
        )
        verdict = transfer_check(
            from_branch=int(student["branch_id"]),
            to_branch=int(target["id"]),
            to_status=str(target["status"]),
            enrollment_branches=[int(e["branch_id"]) for e in enrollments],
            end_enrollments=body.end_enrollments,
        )
        if not verdict["ok"]:
            error = verdict["error"]
            if error == "target_closed":
                raise Unprocessable("The target branch is closed", details={"errors": [error]})
            raise Conflict(
                {
                    "same_branch": "The student is already in this branch",
                    "enrollments_in_old_branch": "The student is enrolled in groups of another branch: "
                    "end those enrollments first or send end_enrollments=true",
                }[str(error)],
                details={"errors": [error], "enrollments": verdict["end_count"]},
            )
        moved_on = body.moved_on or await org_today(conn)
        ended = 0
        if verdict["end_count"]:
            cur = await conn.execute(
                "UPDATE enrollments e SET status = 'finished', ended_on = GREATEST(%s, e.started_on) FROM study_groups g "
                "WHERE e.student_id = %s AND e.status IN ('trial', 'active', 'frozen') AND g.org_id = e.org_id AND g.id = e.group_id "
                "AND g.branch_id <> %s",
                (moved_on, sid, target["id"]),
            )
            ended = cur.rowcount
        await execute(
            conn,
            "UPDATE waitlist_entries w SET status = 'removed', resolved_at = now() FROM study_groups g "
            "WHERE w.student_id = %s AND w.status = 'waiting' AND g.org_id = w.org_id AND g.id = w.group_id AND g.branch_id <> %s",
            (sid, target["id"]),
        )
        await conn.execute("SELECT set_config('app.branch_move', 'on', true)")
        await execute(conn, "UPDATE students SET branch_id = %s WHERE id = %s", (target["id"], sid))
        await execute(
            conn, "UPDATE student_guardians SET branch_id = %s WHERE student_id = %s", (target["id"], sid)
        )
        await conn.execute("SELECT set_config('app.branch_move', '', true)")
        await execute(
            conn,
            "INSERT INTO student_branch_moves (org_id, student_id, from_branch_id, branch_id, moved_on, reason, ended_enrollments, moved_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (p.org_id, sid, student["branch_id"], target["id"], moved_on, body.reason, ended, p.user_id),
        )
        old = await fetch_one(conn, "SELECT public_id FROM branches WHERE id = %s", (student["branch_id"],))
        assert old is not None
    return TransferOut(
        student_id=student_id,
        from_branch_id=old["public_id"],
        to_branch_id=target["public_id"],
        moved_on=moved_on,
        ended_enrollments=ended,
    )


@router.get(
    "/students/{student_id}/branch-moves",
    response_model=list[MoveOut],
    summary="Where this student has been (newest first)",
)
async def student_moves(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:read"))], db: DB
) -> list[MoveOut]:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        rows = await fetch_all(
            conn,
            "SELECT m.public_id AS id, f.public_id AS from_branch_id, t.public_id AS to_branch_id, m.moved_on, m.reason, "
            "m.ended_enrollments FROM student_branch_moves m "
            "LEFT JOIN branches f ON f.org_id = m.org_id AND f.id = m.from_branch_id "
            "LEFT JOIN branches t ON t.org_id = m.org_id AND t.id = m.branch_id "
            "WHERE m.student_id = %s ORDER BY m.moved_on DESC, m.id DESC",
            (sid,),
        )
    return [MoveOut.model_validate(r) for r in rows]
