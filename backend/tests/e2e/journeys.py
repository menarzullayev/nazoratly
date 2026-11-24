"""Shared building blocks for the end-to-end journeys: small helpers on top of tests.helpers (HTTP only, no SQL)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

import psycopg

from tests.conftest import Tenant
from tests.helpers import ok, org_today

A = "/v1/accounting"
TODAY = org_today()


def d(offset: int = 0) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


def phone() -> str:
    return f"+99890{uuid.uuid4().int % 10_000_000:07d}"


def money(x: Any) -> int:
    """'1234.00' -> 1234 (the API's decimal strings are whole so'm in these journeys)."""
    s = str(x)
    whole, _, frac = s.partition(".")
    assert not frac.strip("0"), f"not a whole amount: {s}"
    return int(whole)


async def pay(
    t: Tenant, student_id: str, amount: str, paid_at: str | None = None, method: str = "cash", **kw: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {"student_id": student_id, "amount": amount, "method": method, **kw}
    if paid_at:
        body["paid_at"] = paid_at
    return await ok(await t.post("/v1/payments", body), 201)


async def link_guardian(t: Tenant, student_id: str, guardian_id: str, relation: str = "mother") -> None:
    await ok(
        await t.post(
            f"/v1/students/{student_id}/guardians", {"guardian_id": guardian_id, "relation": relation}
        ),
        201,
    )


async def lessons_of(t: Tenant, group_id: str, date_from: str, date_to: str) -> list[dict[str, Any]]:
    return (
        await ok(
            await t.get(
                "/v1/lessons",
                params={"date_from": date_from, "date_to": date_to, "group_id": group_id, "limit": 200},
            )
        )
    )["items"]


async def mark_present(
    t: Tenant, lesson_id: str, student_ids: list[str], status: str = "present"
) -> dict[str, Any]:
    return await ok(
        await t.put(
            f"/v1/lessons/{lesson_id}/attendance",
            {"records": [{"student_id": s, "status": status} for s in student_ids]},
        )
    )


async def entries(t: Tenant, **params: Any) -> list[dict[str, Any]]:
    return (await ok(await t.get(f"{A}/entries", params={"limit": 200, **params})))["items"]


async def assert_books_sound(t: Tenant) -> dict[str, Any]:
    """The invariants that must hold after ANY sequence of operations: the journal chain verifies, the trial balance and the
    balance sheet balance, and no journal entry is unbalanced."""
    assert (await ok(await t.get(f"{A}/verify")))["ok"] is True
    tb = await ok(await t.get(f"{A}/reports/trial-balance"))
    assert tb["balanced"] is True
    bs = await ok(await t.get(f"{A}/reports/balance-sheet"))
    assert bs["balanced"] is True
    for e in await entries(t):
        assert sum(money(ln["debit"]) for ln in e["lines"]) == sum(
            money(ln["credit"]) for ln in e["lines"]
        ), e
    return tb


def outbox_rows(super_dsn: str, org_public: str) -> list[tuple[Any, ...]]:
    with psycopg.connect(super_dsn) as c:
        return c.execute(
            "SELECT o.channel, o.status FROM outbox_messages o JOIN organizations g ON g.id = o.org_id WHERE g.public_id::text = %s ORDER BY o.id",
            (org_public,),
        ).fetchall()
