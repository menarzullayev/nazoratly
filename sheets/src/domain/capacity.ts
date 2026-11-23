/**
 * Group capacity and waiting-list rules. Pure functions, mirrored in Python (backend/src/nazoratly/rules/capacity.py);
 * both are checked against the same cases in tests/golden/capacity.json.
 */

export interface WaitEntry {
  id: string;
  groupId: string;
  /** ISO timestamp or date; compared as text, so the producer keeps one format. */
  joinedAt: string;
  /** Tie-break: row number / identity, grows with insertion order. */
  n: number;
}
export interface GroupSeats {
  groupId: string;
  capacity: number | null;
  /** trial + active enrollments */
  occupied: number;
}
export interface Offer {
  groupId: string;
  entryId: string;
  position: number;
  freeSeats: number;
}

/** Seats left; null when the group has no limit. Never negative (a group can be over capacity after a patch). */
export function freeSeats(capacity: number | null, occupied: number): number | null {
  return capacity === null ? null : Math.max(0, capacity - occupied);
}

export function waitlistOrder(entries: WaitEntry[]): WaitEntry[] {
  return [...entries].sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : a.n - b.n));
}

/** 1-based place among the entries of the SAME group; null when absent. */
export function queuePosition(entries: WaitEntry[], entryId: string): number | null {
  const mine = entries.find((e) => e.id === entryId);
  if (!mine) return null;
  const same = waitlistOrder(entries.filter((e) => e.groupId === mine.groupId));
  return same.findIndex((e) => e.id === entryId) + 1;
}

/** A student queues when the group is full, or when somebody already waits (free seats are reserved for the queue). */
export function canJoinWaitlist(a: { capacity: number | null; occupied: number; waiting: number }): boolean {
  const free = freeSeats(a.capacity, a.occupied);
  if (free === null) return false;
  return free === 0 || a.waiting > 0;
}

/** Enrolling somebody who is not the next in line: needs a free seat that no waiting student is entitled to. */
export function directEnrollAllowed(a: { capacity: number | null; occupied: number; waiting: number; ignoreWaitlist: boolean }): boolean {
  const free = freeSeats(a.capacity, a.occupied);
  if (free === null) return true;
  if (free === 0) return false;
  return a.ignoreWaitlist || free > a.waiting;
}

/** Only the first `free` students in line may take a free seat. */
export function canEnrollFromWaitlist(a: { capacity: number | null; occupied: number; position: number }): boolean {
  const free = freeSeats(a.capacity, a.occupied);
  return free === null || a.position <= free;
}

export function offers(groups: GroupSeats[], entries: WaitEntry[]): Offer[] {
  const out: Offer[] = [];
  for (const g of groups) {
    const free = freeSeats(g.capacity, g.occupied);
    if (!free) continue;
    const line = waitlistOrder(entries.filter((e) => e.groupId === g.groupId));
    line.slice(0, free).forEach((e, i) => out.push({ groupId: g.groupId, entryId: e.id, position: i + 1, freeSeats: free }));
  }
  return out;
}

/** Guardian message DRAFT (a person approves it before anything is sent). */
export function offerText(a: { guardian: string; student: string; group: string; freeSeats: number; center: string }): string {
  const seats = a.freeSeats === 1 ? "1 ta o'rin" : `${a.freeSeats} ta o'rin`;
  return `Assalomu alaykum, ${a.guardian}! ${a.group} guruhida ${seats} bo'shadi. ${a.student} uchun o'rinni band qilmoqchi bo'lsangiz, bizga javob bering. ${a.center}`;
}
