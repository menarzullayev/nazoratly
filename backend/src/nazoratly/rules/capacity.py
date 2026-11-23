"""Group capacity and waiting-list rules. Pure functions, mirrored in TypeScript (sheets/src/domain/capacity.ts);
both are checked against the same cases in tests/golden/capacity.json."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WaitEntry:
    id: str
    group_id: str
    joined_at: str  # ISO timestamp or date; compared as text, so the producer must keep one format
    n: int  # tie-break: identity / row number, grows with insertion order


@dataclass(frozen=True)
class GroupSeats:
    group_id: str
    capacity: int | None
    occupied: int  # trial + active enrollments


@dataclass(frozen=True)
class Offer:
    group_id: str
    entry_id: str
    position: int
    free_seats: int


def free_seats(capacity: int | None, occupied: int) -> int | None:
    """Seats left; None when the group has no limit. Never negative (a group can be over capacity after a patch)."""
    if capacity is None:
        return None
    return max(0, capacity - occupied)


def waitlist_order(entries: list[WaitEntry]) -> list[WaitEntry]:
    return sorted(entries, key=lambda e: (e.joined_at, e.n))


def queue_position(entries: list[WaitEntry], entry_id: str) -> int | None:
    """1-based place among the entries of the SAME group; None when absent."""
    mine = next((e for e in entries if e.id == entry_id), None)
    if mine is None:
        return None
    same = waitlist_order([e for e in entries if e.group_id == mine.group_id])
    return next(i + 1 for i, e in enumerate(same) if e.id == entry_id)


def can_join_waitlist(*, capacity: int | None, occupied: int, waiting: int) -> bool:
    """A student queues when the group is full, or when somebody already waits (free seats are reserved for the queue)."""
    free = free_seats(capacity, occupied)
    if free is None:
        return False
    return free == 0 or waiting > 0


def direct_enroll_allowed(
    *, capacity: int | None, occupied: int, waiting: int, ignore_waitlist: bool
) -> bool:
    """Enrolling somebody who is not the next in line: needs a free seat that no waiting student is entitled to."""
    free = free_seats(capacity, occupied)
    if free is None:
        return True
    if free == 0:
        return False
    return ignore_waitlist or free > waiting


def can_enroll_from_waitlist(*, capacity: int | None, occupied: int, position: int) -> bool:
    """Only the first `free` students in line may take a free seat."""
    free = free_seats(capacity, occupied)
    return free is None or position <= free


def offers(groups: list[GroupSeats], entries: list[WaitEntry]) -> list[Offer]:
    out: list[Offer] = []
    for g in groups:
        free = free_seats(g.capacity, g.occupied)
        if not free:
            continue
        line = waitlist_order([e for e in entries if e.group_id == g.group_id])
        out.extend(Offer(g.group_id, e.id, i + 1, free) for i, e in enumerate(line[:free]))
    return out


def offer_text(*, guardian: str, student: str, group: str, free_seats: int, center: str) -> str:
    """Guardian message DRAFT (a person approves it before anything is sent)."""
    seats = "1 ta o'rin" if free_seats == 1 else f"{free_seats} ta o'rin"
    return (
        f"Assalomu alaykum, {guardian}! {group} guruhida {seats} bo'shadi. "
        f"{student} uchun o'rinni band qilmoqchi bo'lsangiz, bizga javob bering. {center}"
    )
