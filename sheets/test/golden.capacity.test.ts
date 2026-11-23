import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canEnrollFromWaitlist, canJoinWaitlist, directEnrollAllowed, freeSeats, offerText, offers, queuePosition, waitlistOrder, type WaitEntry } from "../src/domain/capacity";

type RawEntry = { id: string; group_id: string; joined_at: string; n: number };
type G = {
  free_seats: { name: string; in: { capacity: number | null; occupied: number }; out: number | null }[];
  can_join_waitlist: { name: string; in: { capacity: number | null; occupied: number; waiting: number }; out: boolean }[];
  direct_enroll_allowed: { name: string; in: { capacity: number | null; occupied: number; waiting: number; ignore_waitlist: boolean }; out: boolean }[];
  can_enroll_from_waitlist: { name: string; in: { capacity: number | null; occupied: number; position: number }; out: boolean }[];
  waitlist_order: { name: string; in: { entries: RawEntry[] }; out: string[] }[];
  queue_position: { name: string; in: { entries: RawEntry[]; id: string }; out: number | null }[];
  offers: { name: string; in: { groups: { group_id: string; capacity: number | null; occupied: number }[]; entries: RawEntry[] }; out: { group_id: string; entry_id: string; position: number; free_seats: number }[] }[];
  offer_text: { name: string; in: { guardian: string; student: string; group: string; free_seats: number; center: string }; out: string }[];
};
// The same file the Python suite reads (backend/tests/test_golden_capacity.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/capacity.json", import.meta.url), "utf8")) as G;
const entries = (raw: RawEntry[]): WaitEntry[] => raw.map((e) => ({ id: e.id, groupId: e.group_id, joinedAt: e.joined_at, n: e.n }));

describe("golden: capacity and waiting list", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(34);
  });
  it.each(golden.free_seats)("freeSeats: $name", (c) => expect(freeSeats(c.in.capacity, c.in.occupied)).toBe(c.out));
  it.each(golden.can_join_waitlist)("canJoinWaitlist: $name", (c) => expect(canJoinWaitlist(c.in)).toBe(c.out));
  it.each(golden.direct_enroll_allowed)("directEnrollAllowed: $name", (c) =>
    expect(directEnrollAllowed({ capacity: c.in.capacity, occupied: c.in.occupied, waiting: c.in.waiting, ignoreWaitlist: c.in.ignore_waitlist })).toBe(c.out));
  it.each(golden.can_enroll_from_waitlist)("canEnrollFromWaitlist: $name", (c) => expect(canEnrollFromWaitlist(c.in)).toBe(c.out));
  it.each(golden.waitlist_order)("waitlistOrder: $name", (c) => expect(waitlistOrder(entries(c.in.entries)).map((e) => e.id)).toEqual(c.out));
  it.each(golden.queue_position)("queuePosition: $name", (c) => expect(queuePosition(entries(c.in.entries), c.in.id)).toBe(c.out));
  it.each(golden.offers)("offers: $name", (c) => {
    const got = offers(c.in.groups.map((g) => ({ groupId: g.group_id, capacity: g.capacity, occupied: g.occupied })), entries(c.in.entries));
    expect(got.map((o) => ({ group_id: o.groupId, entry_id: o.entryId, position: o.position, free_seats: o.freeSeats }))).toEqual(c.out);
  });
  it.each(golden.offer_text)("offerText: $name", (c) => expect(offerText({ guardian: c.in.guardian, student: c.in.student, group: c.in.group, freeSeats: c.in.free_seats, center: c.in.center })).toBe(c.out));
});
