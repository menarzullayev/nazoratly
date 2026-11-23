"""Lesson packages (abonement): sell a package, list, extend, lesson balance per student, "payment needed" report.

A package is an ordinary charge of kind `package` plus a `lesson_packages` row, so payments, FIFO, receipts, invoices
and payment plans keep working. Lessons credited = floor(paid * lessons / price); balance and need come from
`rules/packages.py` (shared with the Sheets edition, tests/golden/packages.json)."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field

from nazoratly.accounting import post_payment
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.packages import load_balances, severity
from nazoratly.routers.finance import _insert_allocation, allocate_fifo, month_start
from nazoratly.routers.settings import load_settings
from nazoratly.rules.packages import Need, credited_lessons, package_expires_on, package_reminder_text
from nazoratly.schemas import Dec2, Model, Out, Page, PositiveMoney

router = APIRouter(prefix="/v1", tags=["lesson packages"], route_class=IdempotentRoute)

MAX_EXTENSION_DAYS = 730  # an extension may not push the expiry beyond this many days after the purchase


class PayIn(Model):
    amount: PositiveMoney
    method: Literal["cash", "card", "bank_transfer", "other"]
    note: Annotated[str, Field(max_length=500)] | None = None


class PackageIn(Model):
    enrollment_id: uuid.UUID
    purchased_on: date | None = Field(default=None, description="defaults to today")
    pay: PayIn | None = Field(
        default=None, description="record the payment now: it goes to THIS package first, the rest FIFO"
    )


class ExtendIn(Model):
    expires_on: date


class PackageOut(Out):
    id: uuid.UUID
    student_id: uuid.UUID
    student_name: str
    group_id: uuid.UUID
    group_name: str
    enrollment_id: uuid.UUID
    charge_id: uuid.UUID
    lessons: int
    price: Dec2
    paid: Dec2
    credited_lessons: int
    purchased_on: date
    expires_on: date


_PKG_SQL = (
    "SELECT p.public_id AS id, s.public_id AS student_id, s.full_name AS student_name, g.public_id AS group_id, "
    "g.name AS group_name, e.public_id AS enrollment_id, c.public_id AS charge_id, p.lessons, p.price, p.paid, "
    "p.purchased_on, p.expires_on, p.package_id AS pid "
    "FROM v_lesson_packages p JOIN students s ON s.org_id = p.org_id AND s.id = p.student_id "
    "JOIN enrollments e ON e.org_id = p.org_id AND e.id = p.enrollment_id "
    "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
    "JOIN charges c ON c.org_id = p.org_id AND c.id = p.charge_id"
)


def _out(row: dict[str, Any]) -> PackageOut:
    return PackageOut.model_validate(
        {
            **row,
            "credited_lessons": credited_lessons(
                paid=row["paid"], price=row["price"], lessons=row["lessons"]
            ),
        }
    )


async def _today(conn: Conn) -> date:
    row = await fetch_one(conn, "SELECT CURRENT_DATE AS d")
    assert row is not None
    return row["d"]  # type: ignore[no-any-return]


async def _package(conn: Conn, package_id: int) -> PackageOut:
    row = await fetch_one(conn, f"{_PKG_SQL} WHERE p.package_id = %s", (package_id,))
    if row is None:
        raise Conflict("The package's charge is voided")
    return _out(row)


@router.post(
    "/packages",
    response_model=PackageOut,
    status_code=201,
    summary="Sell a package: a charge, lessons and an expiry; optionally record the payment",
)
async def sell_package(
    body: PackageIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> PackageOut:
    async with db.tx(p.session()) as conn:
        eid = await resolve(conn, "enrollments", body.enrollment_id, what="enrollment")
        e = await fetch_one(
            conn,
            "SELECT e.student_id, e.status, g.billing_mode, g.package_lessons, g.package_price, g.name "
            "FROM enrollments e JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
            "WHERE e.id = %s FOR UPDATE OF e",
            (eid,),
        )
        assert e is not None
        if e["billing_mode"] != "package":
            raise Conflict("This enrollment's group is billed monthly, not by package")
        if e["status"] != "active":
            raise Conflict("Packages are sold only to active enrollments (accept a trial first)")
        cfg = await load_settings(conn, p.org_id)
        purchased = body.purchased_on or date.today()
        lessons: int = e["package_lessons"]
        price: Decimal = e["package_price"]
        charge = await fetch_one(
            conn,
            "INSERT INTO charges (org_id, student_id, enrollment_id, kind, period_month, description, amount, due_date, created_by_user_id) "
            "VALUES (%s, %s, %s, 'package', %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                e["student_id"],
                eid,
                month_start(purchased),
                f"Package {lessons} lessons ({e['name']})",
                price,
                purchased,
                p.user_id,
            ),
        )
        assert charge is not None
        pkg = await fetch_one(
            conn,
            "INSERT INTO lesson_packages (org_id, student_id, enrollment_id, charge_id, lessons, price, purchased_on, expires_on, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                e["student_id"],
                eid,
                charge["id"],
                lessons,
                price,
                purchased,
                package_expires_on(purchased, cfg.package_expiry_days),
                p.user_id,
            ),
        )
        assert pkg is not None
        if body.pay is not None:
            pay = await fetch_one(
                conn,
                "INSERT INTO payments (org_id, student_id, amount, method, note, received_by_user_id) "
                "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                (p.org_id, e["student_id"], body.pay.amount, body.pay.method, body.pay.note, p.user_id),
            )
            assert pay is not None
            await _insert_allocation(conn, p.org_id, pay["id"], charge["id"], min(body.pay.amount, price))
            await allocate_fifo(conn, p.org_id, pay["id"])
            await post_payment(conn, p.org_id, p.user_id, pay["id"])
        return await _package(conn, pkg["id"])


@router.get("/packages", response_model=Page[PackageOut], summary="Packages (voided ones are not listed)")
async def list_packages(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    pg: Paging,
    student_id: uuid.UUID | None = None,
    group_id: uuid.UUID | None = None,
    active: Annotated[bool | None, Query(description="true: not expired today; false: expired")] = None,
) -> Page[PackageOut]:
    where: list[str] = ["TRUE"]
    params: list[Any] = []
    if student_id:
        where.append("s.public_id = %s")
        params.append(student_id)
    if group_id:
        where.append("g.public_id = %s")
        params.append(group_id)
    if active is True:
        where.append("p.expires_on >= CURRENT_DATE")
    if active is False:
        where.append("p.expires_on < CURRENT_DATE")
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_PKG_SQL} WHERE {' AND '.join(where)} ORDER BY p.purchased_on DESC, p.package_id DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    return Page[PackageOut](
        items=[_out(r) for r in rows[: pg.limit]],
        limit=pg.limit,
        offset=pg.offset,
        has_more=len(rows) > pg.limit,
    )


@router.post(
    "/packages/{package_id}/extend",
    response_model=PackageOut,
    summary="Extend the expiry of a package (only to a later date)",
)
async def extend_package(
    package_id: uuid.UUID,
    body: ExtendIn,
    p: Annotated[Principal, Depends(require("finance:write"))],
    db: DB,
) -> PackageOut:
    async with db.tx(p.session()) as conn:
        pid = await resolve(conn, "lesson_packages", package_id, what="package")
        cur = await fetch_one(
            conn, "SELECT purchased_on, expires_on FROM lesson_packages WHERE id = %s FOR UPDATE", (pid,)
        )
        assert cur is not None
        if body.expires_on <= cur["expires_on"]:
            raise Unprocessable("The new expiry must be later than the current one")
        if body.expires_on > cur["purchased_on"] + timedelta(days=MAX_EXTENSION_DAYS):
            raise Unprocessable(f"An expiry cannot be more than {MAX_EXTENSION_DAYS} days after the purchase")
        await execute(
            conn, "UPDATE lesson_packages SET expires_on = %s WHERE id = %s", (body.expires_on, pid)
        )
        return await _package(conn, pid)


# ---- lesson balance and payment needed -------------------------------------------------------------------
class BalanceOut(Out):
    enrollment_id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    package_lessons: int
    package_price: Dec2
    available: int = Field(description="lessons left in packages that have not expired")
    burned: int = Field(description="lessons left in packages that expired")
    debt_lessons: int = Field(description="lessons attended without cover (negative lessons)")
    balance_lessons: int = Field(description="available - debt_lessons; negative means debt")
    debt_amount: Dec2 = Field(description="debt_lessons in so'm at the group's package price")
    need: Need
    next_expiry: date | None


class PaymentNeededRow(Out):
    student_id: uuid.UUID
    student_name: str
    enrollment_id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    balance_lessons: int
    debt_lessons: int
    debt_amount: Dec2
    need: Need
    next_expiry: date | None
    guardian_name: str
    reminder_text: str = Field(
        description="suggested reminder DRAFT: nothing is sent; a person approves every message"
    )


async def _enrollment_publics(conn: Conn, ids: list[int]) -> dict[int, uuid.UUID]:
    rows = await fetch_all(conn, "SELECT id, public_id FROM enrollments WHERE id = ANY(%s)", (ids,))
    return {r["id"]: r["public_id"] for r in rows}


@router.get(
    "/students/{student_id}/lesson-balance",
    response_model=list[BalanceOut],
    summary="Lesson balance of a student in each package-billed group",
)
async def lesson_balance(
    student_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> list[BalanceOut]:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", student_id, what="student")
        cfg = await load_settings(conn, p.org_id)
        today = await _today(conn)
        rows = await load_balances(
            conn,
            today=today,
            low_lessons=cfg.package_low_lessons,
            student_id=sid,
            statuses=("active", "frozen"),
        )
        publics = await _enrollment_publics(conn, [r.enrollment_id for r in rows])
    return [
        BalanceOut(
            enrollment_id=publics[r.enrollment_id],
            group_id=r.group_public_id or uuid.UUID(int=0),
            group_name=r.group_name,
            package_lessons=r.package_lessons,
            package_price=r.package_price,
            available=r.balance.available,
            burned=r.balance.burned,
            debt_lessons=r.debt_lessons,
            balance_lessons=r.balance.balance,
            debt_amount=r.debt_amount,
            need=r.need,
            next_expiry=r.balance.next_expiry,
        )
        for r in rows
    ]


@router.get(
    "/reports/packages/payment-needed",
    response_model=list[PaymentNeededRow],
    summary="Students whose package balance is low, exhausted or negative, with a reminder draft text",
)
async def payment_needed(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    need: Literal["low", "exhausted", "debt"] | None = None,
) -> list[PaymentNeededRow]:
    async with db.tx(p.session()) as conn:
        cfg = await load_settings(conn, p.org_id)
        rows = await load_balances(conn, today=await _today(conn), low_lessons=cfg.package_low_lessons)
        rows = [r for r in rows if r.need != "ok" and (need is None or r.need == need)]
        rows.sort(
            key=lambda r: (severity(r.need), r.balance.balance, r.student_name.lower(), r.enrollment_id)
        )
        if not rows:
            return []
        publics = await _enrollment_publics(conn, [r.enrollment_id for r in rows])
        students = {
            r["id"]: r["public_id"]
            for r in await fetch_all(
                conn, "SELECT id, public_id FROM students WHERE id = ANY(%s)", ([r.student_id for r in rows],)
            )
        }
        guardians = {
            r["student_id"]: r["full_name"]
            for r in await fetch_all(
                conn,
                "SELECT DISTINCT ON (sg.student_id) sg.student_id, g.full_name FROM student_guardians sg "
                "JOIN guardians g ON g.org_id = sg.org_id AND g.id = sg.guardian_id "
                "WHERE sg.student_id = ANY(%s) AND sg.receives_reminders AND g.deleted_at IS NULL "
                "ORDER BY sg.student_id, sg.is_primary DESC, sg.id",
                ([r.student_id for r in rows],),
            )
        }
        center_row = await fetch_one(conn, "SELECT name FROM organizations WHERE id = %s", (p.org_id,))
        center = center_row["name"] if center_row else ""
    out: list[PaymentNeededRow] = []
    for r in rows:
        guardian = guardians.get(r.student_id, "Hurmatli ota-ona")
        out.append(
            PaymentNeededRow(
                student_id=students[r.student_id],
                student_name=r.student_name,
                enrollment_id=publics[r.enrollment_id],
                group_id=r.group_public_id or uuid.UUID(int=0),
                group_name=r.group_name,
                balance_lessons=r.balance.balance,
                debt_lessons=r.debt_lessons,
                debt_amount=r.debt_amount,
                need=r.need,
                next_expiry=r.balance.next_expiry,
                guardian_name=guardian,
                reminder_text=package_reminder_text(
                    need=r.need,
                    guardian=guardian,
                    student=r.student_name,
                    balance=r.balance.balance,
                    debt_amount=r.debt_amount,
                    center=center,
                ),
            )
        )
    return out
