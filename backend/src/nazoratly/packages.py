"""Lesson balance of enrollments in package-billed groups.

The rules live in `rules/packages.py` (golden-tested, shared with the Sheets edition). This module only loads the facts:
the active enrollments of package groups, their packages (with what was paid on each package's charge) and the
attendance marks that consume a lesson. The same loader serves staff (row-level security views) and the AI agent
(consent-filtered agent views), so both see the same numbers."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Literal

from nazoratly.db import Conn, fetch_all
from nazoratly.rules.packages import (
    Balance,
    Need,
    PackageInput,
    credited_lessons,
    lessons_money,
    package_balance,
    payment_need,
)

Source = Literal["app", "agent"]

_SQL: dict[Source, dict[str, str]] = {
    "app": {
        "enrollments": (
            "SELECT e.id AS enrollment_id, e.student_id, s.full_name, g.id AS group_id, g.public_id AS group_public_id, "
            "g.name AS group_name, g.package_lessons, g.package_price "
            "FROM enrollments e JOIN students s ON s.org_id = e.org_id AND s.id = e.student_id "
            "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id AND g.billing_mode = 'package' "
            "WHERE e.status = ANY(%(statuses)s) AND s.deleted_at IS NULL AND g.deleted_at IS NULL "
            "AND (%(student)s::bigint IS NULL OR e.student_id = %(student)s) ORDER BY e.id"
        ),
        "packages": "SELECT enrollment_id, lessons, price, paid, purchased_on, expires_on FROM v_lesson_packages WHERE enrollment_id = ANY(%s) ORDER BY purchased_on, package_id",
        "consumption": "SELECT enrollment_id, lesson_date FROM v_package_consumption WHERE enrollment_id = ANY(%s)",
    },
    "agent": {
        "enrollments": (
            "SELECT enrollment_id, student_id, full_name, group_id, NULL::uuid AS group_public_id, group_name, package_lessons, package_price "
            "FROM agent_v_package_enrollments WHERE (%(student)s::bigint IS NULL OR student_id = %(student)s) ORDER BY enrollment_id"
        ),
        "packages": "SELECT enrollment_id, lessons, price, paid, purchased_on, expires_on FROM agent_v_package_packages WHERE enrollment_id = ANY(%s) ORDER BY purchased_on, package_id",
        "consumption": "SELECT enrollment_id, lesson_date FROM agent_v_package_consumption WHERE enrollment_id = ANY(%s)",
    },
}


@dataclass(frozen=True)
class EnrollmentBalance:
    enrollment_id: int
    student_id: int
    student_name: str
    group_id: int
    group_public_id: uuid.UUID | None
    group_name: str
    package_lessons: int
    package_price: Decimal
    balance: Balance
    need: Need
    debt_lessons: int
    debt_amount: Decimal


async def load_balances(
    conn: Conn,
    *,
    today: date,
    low_lessons: int,
    student_id: int | None = None,
    statuses: tuple[str, ...] = ("active",),
    source: Source = "app",
) -> list[EnrollmentBalance]:
    sql = _SQL[source]
    params: dict[str, Any] = {"student": student_id, "statuses": list(statuses)}
    enrollments = await fetch_all(conn, sql["enrollments"], params)
    if not enrollments:
        return []
    ids = [r["enrollment_id"] for r in enrollments]
    packages: dict[int, list[PackageInput]] = {}
    for r in await fetch_all(conn, sql["packages"], (ids,)):
        credited = credited_lessons(paid=r["paid"], price=r["price"], lessons=r["lessons"])
        packages.setdefault(r["enrollment_id"], []).append(
            PackageInput(credited, r["purchased_on"], r["expires_on"])
        )
    consumed: dict[int, list[date]] = {}
    for r in await fetch_all(conn, sql["consumption"], (ids,)):
        consumed.setdefault(r["enrollment_id"], []).append(r["lesson_date"])
    out: list[EnrollmentBalance] = []
    for e in enrollments:
        bal = package_balance(
            packages=packages.get(e["enrollment_id"], []),
            consumed_on=consumed.get(e["enrollment_id"], []),
            today=today,
        )
        out.append(
            EnrollmentBalance(
                enrollment_id=e["enrollment_id"],
                student_id=e["student_id"],
                student_name=e["full_name"],
                group_id=e["group_id"],
                group_public_id=e["group_public_id"],
                group_name=e["group_name"],
                package_lessons=e["package_lessons"],
                package_price=e["package_price"],
                balance=bal,
                need=payment_need(balance=bal.balance, low_lessons=low_lessons),
                debt_lessons=bal.uncovered,
                debt_amount=lessons_money(
                    lessons=bal.uncovered, price=e["package_price"], package_lessons=e["package_lessons"]
                ),
            )
        )
    return out


_SEVERITY: dict[str, int] = {"debt": 0, "exhausted": 1, "low": 2, "ok": 3}


def severity(need: Need) -> int:
    return _SEVERITY[need]
