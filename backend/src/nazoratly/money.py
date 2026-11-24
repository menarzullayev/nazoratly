"""Money service of group G1: the discount rules applied while charges are generated, the early-payment discount that is
earned (or lost again) when allocations change, and releasing allocations for refunds.

The rules themselves (amounts, order, caps, the early test) live in `rules/money.py` and are golden-tested against the
Sheets edition (tests/golden/money.json). This module only loads facts and writes rows, inside the caller's transaction.
There is deliberately no late-payment penalty anywhere: overdue money only triggers reminders."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any

from nazoratly.db import Conn, execute, fetch_all, fetch_one
from nazoratly.rules.money import DiscountLine, early_granted

ZERO = Decimal(0)


# ---- discount rules at generation time -----------------------------------------------------------------------------
async def rules_for_month(
    conn: Conn, student_ids: list[int], first: date, last: date
) -> dict[int, list[dict[str, Any]]]:
    """The student rules valid inside the month (valid_from before its end, valid_to missing or not before its start)."""
    if not student_ids:
        return {}
    rows = await fetch_all(
        conn,
        "SELECT id, student_id, enrollment_id, kind, percent, amount, pay_by_day, reason FROM student_discounts "
        "WHERE student_id = ANY(%s) AND valid_from <= %s AND (valid_to IS NULL OR valid_to >= %s) ORDER BY id",
        (student_ids, last, first),
    )
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        out[r["student_id"]].append(r)
    return out


async def family_ranks(conn: Conn, billable_student_ids: list[int]) -> dict[int, int]:
    """Rank of each billable student inside his family (1 = first child). A family is the set of students connected
    through shared guardians; children are ranked by registration order (student id)."""
    if not billable_student_ids:
        return {}
    links = await fetch_all(
        conn,
        "SELECT student_id, guardian_id FROM student_guardians WHERE student_id = ANY(%s)",
        (billable_student_ids,),
    )
    parent = {s: s for s in billable_student_ids}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    first_of_guardian: dict[int, int] = {}
    for link in links:
        s, g = link["student_id"], link["guardian_id"]
        if g in first_of_guardian:
            parent[find(s)] = find(first_of_guardian[g])
        else:
            first_of_guardian[g] = s
    families: dict[int, list[int]] = defaultdict(list)
    for s in sorted(set(billable_student_ids)):
        families[find(s)].append(s)
    ranks: dict[int, int] = {}
    for members in families.values():
        for i, s in enumerate(members, start=1):
            ranks[s] = i
    return ranks


async def write_discount_lines(
    conn: Conn,
    org_id: int,
    enrollment: dict[str, Any],
    month: date,
    lines: list[DiscountLine],
    meta: list[dict[str, Any] | None],
    family_pct: Decimal,
    charge_id: int | None,
) -> None:
    """Records what each lasting discount took off an enrollment's month (`charge_id` None for a free month with no
    charge). Safe to repeat: a line exists once per enrollment, month, kind and rule."""
    for line in lines:
        src = meta[line.index]
        await execute(
            conn,
            "INSERT INTO discount_lines (org_id, student_id, enrollment_id, charge_id, period_month, kind, source_id, percent, amount, reason) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (enrollment_id, period_month, kind, (COALESCE(source_id, 0))) DO NOTHING",
            (
                org_id,
                enrollment["student_id"],
                enrollment["enrollment_id"],
                charge_id,
                month,
                line.kind,
                src["id"] if src else None,
                src["percent"] if src else family_pct,
                line.amount,
                src["reason"] if src else "family discount",
            ),
        )


# ---- the early-payment discount --------------------------------------------------------------------------------------
async def _allocations_with_dates(conn: Conn, charge_id: int) -> list[dict[str, Any]]:
    return await fetch_all(
        conn,
        "SELECT pa.id, pa.payment_id, pa.amount, (p.paid_at AT TIME ZONE o.timezone)::date AS paid_on "
        "FROM payment_allocations pa JOIN payments p ON p.org_id = pa.org_id AND p.id = pa.payment_id "
        "JOIN organizations o ON o.id = pa.org_id WHERE pa.charge_id = %s ORDER BY p.paid_at, pa.id",
        (charge_id,),
    )


async def grant_early_discount(conn: Conn, charge_id: int) -> Decimal:
    """Earns the early-payment discount of a charge when money paid on or before the pay-by date covers the reduced
    price: the charge shrinks by the offer, a discount line is written and any money allocated beyond the reduced price is
    released again (latest payments first; it returns to the student's credit). Returns the released amount."""
    c = await fetch_one(
        conn,
        "SELECT id, org_id, student_id, enrollment_id, period_month, amount, early_discount, early_pay_by, early_source_id "
        "FROM charges WHERE id = %s AND voided_at IS NULL AND early_discount > 0 AND early_granted_at IS NULL FOR UPDATE",
        (charge_id,),
    )
    if c is None or c["enrollment_id"] is None:
        return ZERO
    if await fetch_one(
        conn, "SELECT 1 AS x FROM charge_installments WHERE charge_id = %s LIMIT 1", (charge_id,)
    ):
        return ZERO  # a charge with a payment plan never gets the early discount
    allocs = await _allocations_with_dates(conn, charge_id)
    verdict = early_granted(
        pay_by=c["early_pay_by"],
        payments=[(a["paid_on"], a["amount"]) for a in allocs],
        amount=c["amount"],
        early=c["early_discount"],
    )
    if not verdict.granted:
        return ZERO
    excess = verdict.excess
    released = ZERO
    for a in sorted(allocs, key=lambda x: (x["paid_on"], x["id"]), reverse=True):  # latest money leaves first
        if excess <= 0:
            break
        take = min(excess, a["amount"])
        if take == a["amount"]:
            await execute(conn, "DELETE FROM payment_allocations WHERE id = %s", (a["id"],))
        else:
            await execute(
                conn, "UPDATE payment_allocations SET amount = amount - %s WHERE id = %s", (take, a["id"])
            )
        excess -= take
        released += take
    await execute(
        conn,
        "UPDATE charges SET amount = amount - early_discount, early_granted_at = now() WHERE id = %s",
        (charge_id,),
    )
    rule = await fetch_one(
        conn, "SELECT percent, reason FROM student_discounts WHERE id = %s", (c["early_source_id"],)
    )
    await execute(
        conn,
        "INSERT INTO discount_lines (org_id, student_id, enrollment_id, charge_id, period_month, kind, source_id, percent, amount, reason) "
        "VALUES (%s, %s, %s, %s, %s, 'early_pay', %s, %s, %s, %s) "
        "ON CONFLICT (enrollment_id, period_month, kind, (COALESCE(source_id, 0))) DO NOTHING",
        (
            c["org_id"],
            c["student_id"],
            c["enrollment_id"],
            charge_id,
            c["period_month"],
            c["early_source_id"],
            rule["percent"] if rule else None,
            c["early_discount"],
            rule["reason"] if rule else None,
        ),
    )
    return released


async def revoke_unearned_early(conn: Conn, charge_ids: list[int]) -> None:
    """Gives back the early discount of charges whose paying allocations are gone (payment voided, allocation removed,
    money refunded): the charge returns to its full price and the offer is open again. The discount line stays as history
    but reports count only granted offers."""
    for cid in dict.fromkeys(charge_ids):
        c = await fetch_one(
            conn,
            "SELECT id, amount, early_discount, early_pay_by FROM charges "
            "WHERE id = %s AND voided_at IS NULL AND early_granted_at IS NOT NULL FOR UPDATE",
            (cid,),
        )
        if c is None:
            continue
        allocs = await _allocations_with_dates(conn, cid)
        full = c["amount"] + c["early_discount"]
        verdict = early_granted(
            pay_by=c["early_pay_by"],
            payments=[(a["paid_on"], a["amount"]) for a in allocs],
            amount=full,
            early=c["early_discount"],
        )
        if not verdict.granted:
            await execute(
                conn,
                "UPDATE charges SET amount = amount + early_discount, early_granted_at = NULL WHERE id = %s",
                (cid,),
            )


# ---- releasing money from charges (refunds) ---------------------------------------------------------------------------
async def release_from_charge(conn: Conn, charge_id: int, amount: Decimal) -> list[tuple[int, Decimal]]:
    """Takes `amount` of allocated money off a charge, newest payments first. Returns (payment_id, released) pairs."""
    allocs = await fetch_all(
        conn,
        "SELECT pa.id, pa.payment_id, pa.amount FROM payment_allocations pa JOIN payments p ON p.org_id = pa.org_id AND p.id = pa.payment_id "
        "WHERE pa.charge_id = %s ORDER BY p.paid_at DESC, pa.id DESC FOR UPDATE OF pa",
        (charge_id,),
    )
    left = amount
    out: list[tuple[int, Decimal]] = []
    for a in allocs:
        if left <= 0:
            break
        take = min(left, a["amount"])
        if take == a["amount"]:
            await execute(conn, "DELETE FROM payment_allocations WHERE id = %s", (a["id"],))
        else:
            await execute(
                conn, "UPDATE payment_allocations SET amount = amount - %s WHERE id = %s", (take, a["id"])
            )
        out.append((a["payment_id"], take))
        left -= take
    return out


async def release_from_payment(conn: Conn, payment_id: int, amount: Decimal) -> list[int]:
    """Takes `amount` of allocated money off a payment (charges with the latest due date first; those charges become
    open debt again). Returns the charge ids that were touched."""
    allocs = await fetch_all(
        conn,
        "SELECT pa.id, pa.charge_id, pa.amount FROM payment_allocations pa JOIN charges c ON c.org_id = pa.org_id AND c.id = pa.charge_id "
        "WHERE pa.payment_id = %s ORDER BY c.due_date DESC, pa.id DESC FOR UPDATE OF pa",
        (payment_id,),
    )
    left = amount
    touched: list[int] = []
    for a in allocs:
        if left <= 0:
            break
        take = min(left, a["amount"])
        if take == a["amount"]:
            await execute(conn, "DELETE FROM payment_allocations WHERE id = %s", (a["id"],))
        else:
            await execute(
                conn, "UPDATE payment_allocations SET amount = amount - %s WHERE id = %s", (take, a["id"])
            )
        touched.append(a["charge_id"])
        left -= take
    return touched
