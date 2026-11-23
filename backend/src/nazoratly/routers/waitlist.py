"""Group waiting list: queue a student for a full group, list the queue, remove, "next in line" offers and one-click
enrollment. Seat rules live in `rules/capacity.py` (shared with the Sheets edition, tests/golden/capacity.json)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends

from nazoratly.accounting import org_today
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import AlreadyEnrolled, AlreadyWaiting, Conflict, SeatAvailable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.academics import (
    _ENR_SQL,
    EnrollmentOut,
    assert_group_access,
    insert_enrollment,
    seat_counts,
)
from nazoratly.rules import capacity as C
from nazoratly.schemas import LongText, Model, Out, Page, make_page
from nazoratly.waitlist import load_offers

router = APIRouter(prefix="/v1", tags=["waiting list"], route_class=IdempotentRoute)


class WaitlistIn(Model):
    student_id: uuid.UUID
    note: LongText | None = None


class EnrollFromWaitlistIn(Model):
    started_on: date | None = None
    status: Literal["trial", "active"] = "active"


class WaitlistOut(Out):
    id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    student_id: uuid.UUID
    student_name: str
    status: Literal["waiting", "enrolled", "removed"]
    position: int | None
    note: str | None
    joined_at: datetime
    resolved_at: datetime | None


class OfferOut(Out):
    entry_id: uuid.UUID
    group_id: uuid.UUID
    group_name: str
    student_id: uuid.UUID
    student_name: str
    position: int
    free_seats: int
    guardian: str
    offer_text: str


_ENTRY_SQL = (
    "SELECT w.public_id AS id, g.public_id AS group_id, g.name AS group_name, s.public_id AS student_id, "
    "s.full_name AS student_name, w.status, w.note, w.joined_at, w.resolved_at, "
    "CASE WHEN w.status = 'waiting' THEN (SELECT count(*) FROM waitlist_entries w2 WHERE w2.group_id = w.group_id "
    "  AND w2.status = 'waiting' AND (w2.joined_at, w2.id) <= (w.joined_at, w.id)) END AS position "
    "FROM waitlist_entries w JOIN study_groups g ON g.org_id = w.org_id AND g.id = w.group_id "
    "JOIN students s ON s.org_id = w.org_id AND s.id = w.student_id"
)


@router.post(
    "/groups/{group_id}/waitlist",
    response_model=WaitlistOut,
    status_code=201,
    summary="Put a student on the waiting list of a full group",
)
async def join_waitlist(
    group_id: uuid.UUID,
    body: WaitlistIn,
    p: Annotated[Principal, Depends(require("academics:write", "students:read"))],
    db: DB,
) -> WaitlistOut:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        sid = await resolve(conn, "students", body.student_id, what="student")
        grp = await fetch_one(
            conn, "SELECT capacity, status FROM study_groups WHERE id = %s FOR UPDATE", (gid,)
        )
        assert grp is not None
        if grp["status"] in ("finished", "cancelled"):
            raise Conflict(f"Group is {grp['status']}")
        if await fetch_one(
            conn,
            "SELECT 1 FROM enrollments WHERE group_id = %s AND student_id = %s AND status IN ('trial','active','frozen')",
            (gid, sid),
        ):
            raise AlreadyEnrolled("The student is already in this group")
        if await fetch_one(
            conn,
            "SELECT 1 FROM waitlist_entries WHERE group_id = %s AND student_id = %s AND status = 'waiting'",
            (gid, sid),
        ):
            raise AlreadyWaiting("The student is already on the waiting list of this group")
        occupied, waiting = await seat_counts(conn, gid)
        if not C.can_join_waitlist(capacity=grp["capacity"], occupied=occupied, waiting=waiting):
            raise SeatAvailable(
                "The group has no capacity limit or has a free seat: enroll the student directly",
                details={"capacity": grp["capacity"], "occupied": occupied, "waiting": waiting},
            )
        row = await fetch_one(
            conn,
            "INSERT INTO waitlist_entries (org_id, group_id, student_id, note, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, gid, sid, body.note, p.user_id),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_ENTRY_SQL} WHERE w.id = %s", (row["id"],))
    assert out is not None
    return WaitlistOut.model_validate(out)


@router.get(
    "/groups/{group_id}/waitlist",
    response_model=Page[WaitlistOut],
    summary="The waiting list of a group, in order",
)
async def group_waitlist(
    group_id: uuid.UUID,
    p: Annotated[Principal, Depends(require("academics:read"))],
    db: DB,
    pg: Paging,
    status: Literal["waiting", "enrolled", "removed"] = "waiting",
) -> Page[WaitlistOut]:
    async with db.tx(p.session()) as conn:
        gid = await resolve(conn, "study_groups", group_id, what="group")
        await assert_group_access(conn, p, gid)
        rows = await fetch_all(
            conn,
            f"{_ENTRY_SQL} WHERE w.group_id = %s AND w.status = %s ORDER BY w.joined_at, w.id LIMIT %s OFFSET %s",
            (gid, status, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, WaitlistOut)


async def _waiting_entry(conn: Conn, entry_id: uuid.UUID) -> dict[str, object]:
    eid = await resolve(conn, "waitlist_entries", entry_id, what="waiting-list entry")
    row = await fetch_one(
        conn, "SELECT id, group_id, student_id, status FROM waitlist_entries WHERE id = %s FOR UPDATE", (eid,)
    )
    assert row is not None
    if row["status"] != "waiting":
        raise Conflict(f"The entry is already {row['status']}")
    return row


@router.delete(
    "/waitlist/{entry_id}", response_model=WaitlistOut, summary="Take a student off the waiting list"
)
async def remove_from_waitlist(
    entry_id: uuid.UUID, p: Annotated[Principal, Depends(require("academics:write"))], db: DB
) -> WaitlistOut:
    async with db.tx(p.session()) as conn:
        row = await _waiting_entry(conn, entry_id)
        await execute(
            conn,
            "UPDATE waitlist_entries SET status = 'removed', resolved_at = now() WHERE id = %s",
            (row["id"],),
        )
        out = await fetch_one(conn, f"{_ENTRY_SQL} WHERE w.id = %s", (row["id"],))
    assert out is not None
    return WaitlistOut.model_validate(out)


@router.get(
    "/waitlist/offers",
    response_model=list[OfferOut],
    summary="Seats that freed up: the next students in line, with a suggested message for the guardian",
)
async def offers(
    p: Annotated[Principal, Depends(require("academics:read", "students:read"))], db: DB
) -> list[OfferOut]:
    async with db.tx(p.session()) as conn:
        rows = await load_offers(conn, p.org_id)
    return [
        OfferOut(
            entry_id=r.entry_public_id,
            group_id=r.group_public_id,
            group_name=r.group_name,
            student_id=r.student_public_id,
            student_name=r.student_name,
            position=r.position,
            free_seats=r.free_seats,
            guardian=r.guardian,
            offer_text=r.text,
        )
        for r in rows
    ]


@router.post(
    "/waitlist/{entry_id}/enroll",
    response_model=EnrollmentOut,
    status_code=201,
    summary="Enroll the next student in line (one click); only while a seat is free for their place",
)
async def enroll_from_waitlist(
    entry_id: uuid.UUID,
    body: EnrollFromWaitlistIn,
    p: Annotated[Principal, Depends(require("academics:write", "students:read"))],
    db: DB,
) -> EnrollmentOut:
    async with db.tx(p.session()) as conn:
        row = await _waiting_entry(conn, entry_id)
        eid = await insert_enrollment(
            conn,
            org_id=p.org_id,
            student_id=int(row["student_id"]),  # type: ignore[call-overload]
            group_id=int(row["group_id"]),  # type: ignore[call-overload]
            started_on=body.started_on or await org_today(conn),
            status=body.status,
        )
        out = await fetch_one(conn, f"{_ENR_SQL} WHERE e.id = %s", (eid,))
    assert out is not None
    return EnrollmentOut.model_validate(out)
