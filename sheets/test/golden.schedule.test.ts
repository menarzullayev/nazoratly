import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capacityCheck, changeMessage, effectiveTeacher, findConflicts, overlaps, parseSchedule, payrollEffect, weekRange, type Slot, type TeacherPay } from "../src/domain/schedule";

type RawSlot = { id: string; date: string; start: string; end: string; room: string | null; teacher: string | null; cancelled: boolean };
type RawPay = { id: string; pay_model: TeacherPay["payModel"]; pay_rate: string } | null;
type G = {
  overlaps: { name: string; in: { a_start: string; a_end: string; b_start: string; b_end: string }; out: boolean }[];
  find_conflicts: { name: string; in: { candidate: RawSlot; others: RawSlot[] }; out: { kind: string; other_id: string }[] }[];
  capacity_check: { name: string; in: { group_capacity: number | null; enrolled: number; room_capacity: number | null }; out: string }[];
  effective_teacher: { name: string; in: { group: string | null; lesson: string | null; substitute: string | null }; out: string | null }[];
  payroll_effect: { name: string; in: { kind: "cancel" | "substitute" | "move"; old_date: string; new_date: string | null; teacher: RawPay; substitute: RawPay }; out: { teacher: string; month: string; delta: string }[] }[];
  change_message: { name: string; in: { kind: "cancel" | "move"; guardian: string; student: string; group: string; old_date: string; old_start: string; new_date: string | null; new_start: string | null; reason: string | null; center: string }; out: string }[];
  parse_schedule: { name: string; in: { text: string }; out: { weekday: number; start: string; end: string }[] | null }[];
  week_range: { name: string; in: { day: string }; out: { monday: string; sunday: string } }[];
};
// The same file the Python suite reads (backend/tests/test_golden_schedule.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/schedule.json", import.meta.url), "utf8")) as G;
const slot = (s: RawSlot): Slot => ({ ...s });
const pay = (p: RawPay): TeacherPay | null => (p === null ? null : { id: p.id, payModel: p.pay_model, payRate: Number(p.pay_rate) });

describe("golden: schedule rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(60);
  });
  it.each(golden.overlaps)("overlaps: $name", (c) => expect(overlaps(c.in.a_start, c.in.a_end, c.in.b_start, c.in.b_end)).toBe(c.out));
  it.each(golden.find_conflicts)("findConflicts: $name", (c) =>
    expect(findConflicts(slot(c.in.candidate), c.in.others.map(slot)).map((x) => ({ kind: x.kind, other_id: x.otherId }))).toEqual(c.out));
  it.each(golden.capacity_check)("capacityCheck: $name", (c) => expect(capacityCheck({ groupCapacity: c.in.group_capacity, enrolled: c.in.enrolled, roomCapacity: c.in.room_capacity })).toBe(c.out));
  it.each(golden.effective_teacher)("effectiveTeacher: $name", (c) => expect(effectiveTeacher(c.in)).toBe(c.out));
  it.each(golden.payroll_effect)("payrollEffect: $name", (c) => {
    const got = payrollEffect({ kind: c.in.kind, oldDate: c.in.old_date, newDate: c.in.new_date, teacher: pay(c.in.teacher), substitute: pay(c.in.substitute) });
    expect(got.map((e) => ({ teacher: e.teacher, month: e.month, delta: e.delta }))).toEqual(c.out.map((o) => ({ teacher: o.teacher, month: o.month, delta: Number(o.delta) })));
  });
  it.each(golden.change_message)("changeMessage: $name", (c) =>
    expect(changeMessage({ kind: c.in.kind, guardian: c.in.guardian, student: c.in.student, group: c.in.group, oldDate: c.in.old_date, oldStart: c.in.old_start, newDate: c.in.new_date, newStart: c.in.new_start, reason: c.in.reason, center: c.in.center })).toBe(c.out));
  it.each(golden.parse_schedule)("parseSchedule: $name", (c) => expect(parseSchedule(c.in.text)).toEqual(c.out));
  it.each(golden.week_range)("weekRange: $name", (c) => expect(weekRange(c.in.day)).toEqual(c.out));
  it("rejects unknown change kinds", () => {
    expect(() => payrollEffect({ kind: "teleport" as never, oldDate: "2026-12-01", newDate: null, teacher: null })).toThrow();
    expect(() => changeMessage({ kind: "substitute" as never, guardian: "G", student: "S", group: "X", oldDate: "2026-12-01", oldStart: "10:00", newDate: null, newStart: null, reason: null, center: "C" })).toThrow();
  });
});
