"""Waiting-list offers ("next in line") from the database, shared by the API, the dashboard and the MCP server.

The offer is derived, not event-driven: whenever a group has free seats (somebody left, a trial was dropped, the capacity
was raised) the first `free` waiting students are offered, so no seat change can ever be missed. Nothing is sent or
enrolled automatically: the owner enrolls with one click and a person approves any guardian message."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from nazoratly.db import Conn, fetch_all
from nazoratly.rules import capacity as C

FALLBACK_GUARDIAN = "hurmatli ota-ona"


@dataclass(frozen=True)
class OfferRow:
    entry_id: int
    entry_public_id: Any
    group_id: int
    group_public_id: Any
    group_name: str
    student_id: int
    student_public_id: Any
    student_name: str
    position: int
    free_seats: int
    guardian: str
    text: str
    joined_at: datetime


def stamp(ts: datetime) -> str:
    """One fixed, sortable text form for the rules (they compare timestamps as text)."""
    return ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")


async def _guardians(conn: Conn, student_ids: list[int]) -> dict[int, str]:
    rows = await fetch_all(
        conn,
        "SELECT sg.student_id, gd.full_name FROM student_guardians sg "
        "JOIN guardians gd ON gd.org_id = sg.org_id AND gd.id = sg.guardian_id AND gd.deleted_at IS NULL "
        "WHERE sg.student_id = ANY(%s) AND sg.receives_reminders ORDER BY sg.student_id, sg.is_primary DESC, sg.id",
        (student_ids,),
    )
    out: dict[int, str] = {}
    for r in rows:
        out.setdefault(int(r["student_id"]), str(r["full_name"]))
    return out


async def load_offers(conn: Conn, org_id: int) -> list[OfferRow]:
    """Offers of every open group of the caller's center, ordered by group then place in line."""
    rows = await fetch_all(
        conn,
        "SELECT w.id AS entry_id, w.public_id AS entry_public_id, w.group_id, g.public_id AS group_public_id, "
        "g.name AS group_name, g.capacity, "
        "(SELECT count(*) FROM enrollments e WHERE e.org_id = w.org_id AND e.group_id = w.group_id "
        "   AND e.status IN ('trial', 'active')) AS occupied, "
        "w.student_id, s.public_id AS student_public_id, s.full_name AS student_name, w.joined_at "
        "FROM waitlist_entries w JOIN study_groups g ON g.org_id = w.org_id AND g.id = w.group_id "
        "JOIN students s ON s.org_id = w.org_id AND s.id = w.student_id "
        "WHERE w.status = 'waiting' AND g.deleted_at IS NULL AND g.status IN ('planned', 'active') "
        "AND s.deleted_at IS NULL ORDER BY w.group_id, w.joined_at, w.id",
    )
    if not rows:
        return []
    groups = {
        int(r["group_id"]): C.GroupSeats(str(r["group_id"]), r["capacity"], int(r["occupied"])) for r in rows
    }
    entries = [
        C.WaitEntry(str(r["entry_id"]), str(r["group_id"]), stamp(r["joined_at"]), int(r["entry_id"]))
        for r in rows
    ]
    chosen = C.offers(list(groups.values()), entries)
    by_entry = {int(r["entry_id"]): r for r in rows}
    org = await fetch_all(conn, "SELECT name FROM organizations WHERE id = %s", (org_id,))
    center = str(org[0]["name"]) if org else ""
    guardians = await _guardians(conn, [int(by_entry[int(o.entry_id)]["student_id"]) for o in chosen])
    out: list[OfferRow] = []
    for o in chosen:
        r = by_entry[int(o.entry_id)]
        guardian = guardians.get(int(r["student_id"]), FALLBACK_GUARDIAN)
        out.append(
            OfferRow(
                entry_id=int(r["entry_id"]),
                entry_public_id=r["entry_public_id"],
                group_id=int(r["group_id"]),
                group_public_id=r["group_public_id"],
                group_name=str(r["group_name"]),
                student_id=int(r["student_id"]),
                student_public_id=r["student_public_id"],
                student_name=str(r["student_name"]),
                position=o.position,
                free_seats=o.free_seats,
                guardian=guardian,
                text=C.offer_text(
                    guardian=guardian,
                    student=str(r["student_name"]),
                    group=str(r["group_name"]),
                    free_seats=o.free_seats,
                    center=center,
                ),
                joined_at=r["joined_at"],
            )
        )
    return out
