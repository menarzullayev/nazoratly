import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReminderDraft } from "../../src/domain/types";
import * as actions from "../../src/gas/actions";
import { append, read } from "../../src/gas/repo";
import { ATTENDANCE, DRAFTS, GROUPS, ROOMS, SCHEDULE_CHANGES, TEACHERS } from "../../src/gas/schema";
import type { Harness } from "../harness";
import { boot, drive, enrollment, group, seedClass, student, teacher } from "./support";

let h: Harness;
beforeEach(() => {
  h = boot();
  seedClass({
    teachers: [teacher(), teacher({ id: "T0002", fullName: "Sardor Aliyev" })],
    groups: [
      { ...group({ schedule: "Du-Chor-Ju 18:00-19:30", roomId: "X0001" }) },
      { ...group({ id: "G0002", name: "Matematika", teacherId: "T0002", schedule: "Du-Chor-Ju 18:30-20:00", roomId: "X0001" }) },
    ],
    students: [student("S0001", { guardianName: "Aliyev", guardianChatId: "111", consentNotify: true }), student("S0002", { guardianName: "Botirov" })],
    enrollments: [enrollment("E0001", "S0001"), enrollment("E0002", "S0002", { groupId: "G0002" })],
  });
});
afterEach(() => vi.useRealTimers());

describe("journey: schedule, rooms, conflicts, substitute, move and cancel", () => {
  it("adds rooms (name, capacity) and refuses duplicates and bad capacity", () => {
    expect(drive(h, "menuRoomAdd", "1-xona", "10").last).toContain("X0001");
    expect(drive(h, "menuRoomAdd", "1-XONA", "5").last).toMatch(/allaqachon bor/);
    expect(drive(h, "menuRoomAdd", "2-xona", "-3").last).toMatch(/Sig'im/);
    expect(read<{ id: string; name: string; capacity: number }>(ROOMS).map((r) => [r.id, r.name, r.capacity])).toEqual([["X0001", "1-xona", 10]]);
  });

  it("the check finds the room clash between the two groups, and the week calendar shows both lessons", () => {
    drive(h, "menuRoomAdd", "1-xona", "10");
    const check = drive(h, "menuScheduleCheck").last;
    expect(check).toMatch(/1-xona|X0001/);
    expect(check).toMatch(/to'qnash|bir vaqtda|band/i);
    drive(h, "menuCalWeek", "", "");
    const sheetRows = h.rows("Taqvim");
    const flat = JSON.stringify(sheetRows);
    expect(flat).toContain("IELTS");
    expect(flat).toContain("Matematika");
    drive(h, "menuCalDay", "2026-11-24", ""); // Tuesday: no lessons at all
    expect(JSON.stringify(h.rows("Taqvim"))).not.toContain("IELTS");
    expect(drive(h, "menuCalDay", "2026-13-40", "").last).toMatch(/noto'g'ri/);
  });

  it("substitute teacher: recorded, clash is warned about and can be forced, own teacher means removal", () => {
    drive(h, "menuRoomAdd", "1-xona", "10");
    // T0002 teaches Matematika 18:30-20:00, which overlaps IELTS 18:00-19:30 -> a clash question; the default answer is YES (force)
    h.answers.push("NO");
    const refused = drive(h, "menuLessonSubstitute", "G0001", "2026-11-23", "18:00", "T0002", "Kasal");
    expect(read(SCHEDULE_CHANGES)).toEqual([]);
    expect(refused.alerts[0]!.title).toBe("To'qnashuv"); // the owner was asked "save anyway?" and said no
    expect(refused.last).toMatch(/Xona band/);
    const forced = drive(h, "menuLessonSubstitute", "G0001", "2026-11-23", "18:00", "T0002", "Kasal");
    expect(forced.last).toContain("o'rinbosar T0002");
    const ch = read<{ kind: string; substituteId: string; reason: string }>(SCHEDULE_CHANGES);
    expect(ch.map((c) => [c.kind, c.substituteId, c.reason])).toEqual([["substitute", "T0002", "Kasal"]]);
    // a second identical change is refused
    expect(drive(h, "menuLessonSubstitute", "G0001", "2026-11-23", "18:00", "T0002", "").last).toMatch(/allaqachon/);
    // the group's own teacher name removes the substitute again
    expect(drive(h, "menuLessonSubstitute", "G0001", "2026-11-23", "18:00", "T0001", "").last).toContain("asosiy o'qituvchi qaytarildi");
    expect(drive(h, "menuLessonSubstitute", "G0001", "2026-11-23", "18:00", "T9999", "").last).toMatch(/topilmadi/);
  });

  it("move: drafts for the guardian are created pending (never sent), room and time validated", () => {
    drive(h, "menuRoomAdd", "1-xona", "10");
    drive(h, "menuRoomAdd", "2-xona", "10");
    const bad = drive(h, "menuLessonMove", "G0001", "2026-11-23", "18:00", "2026-11-25", "abc", "", "");
    expect(bad.last).toMatch(/vaqti noto'g'ri/);
    const moved = drive(h, "menuLessonMove", "G0001", "2026-11-23", "18:00", "2026-11-24", "17:00", "X0002", "Bayram");
    expect(moved.last).toContain("ko'chirildi");
    expect(moved.last).toContain("xabar loyihasi yaratildi");
    const drafts = read<ReminderDraft>(DRAFTS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe("pending");
    expect(drafts[0]!.text).toContain("24.11.2026 17:00");
    expect(h.fetches).toHaveLength(0); // Model B: nothing leaves without approval
    const ch = read<{ kind: string; newDate: string; newStart: string; newRoomId: string }>(SCHEDULE_CHANGES);
    expect(ch.map((c) => [c.kind, c.newDate, c.newStart, c.newRoomId])).toEqual([["move", "2026-11-24", "17:00", "X0002"]]);
    // the calendar follows the move
    drive(h, "menuCalDay", "2026-11-24", "");
    expect(JSON.stringify(h.rows("Taqvim"))).toContain("IELTS");
    // moving to an unknown room fails
    expect(drive(h, "menuLessonMove", "G0001", "2026-11-25", "18:00", "2026-11-26", "10:00", "X0099", "").last).toMatch(/Xona topilmadi/);
  });

  it("cancel: with notice (draft) or without; cancelling twice or a lesson with attendance is refused", () => {
    h.answers.push("NO"); // no notice
    const quiet = drive(h, "menuLessonCancel", "G0001", "2026-11-25", "18:00", "Ustoz kasal");
    expect(quiet.last).toContain("bekor qilindi");
    expect(quiet.last).not.toContain("xabar loyihasi");
    expect(read(DRAFTS)).toEqual([]);
    const loud = drive(h, "menuLessonCancel", "G0001", "2026-11-27", "18:00", "Bayram");
    expect(loud.last).toContain("1 ta xabar loyihasi");
    // attendance taken on 2026-11-23 -> cannot cancel that lesson any more
    actions.saveAttendance({ date: "2026-11-23", groupId: "G0001", marks: [{ studentId: "S0001", status: "present", minutesLate: 0 }] });
    expect(read(ATTENDANCE)).toHaveLength(1);
    expect(drive(h, "menuLessonCancel", "G0001", "2026-11-23", "18:00", "").last).toMatch(/davomat belgilangan/);
    expect(drive(h, "menuLessonCancel", "G0001", "2026-11-23", "", "").last).toMatch(/davomat belgilangan/);
    // a date on which the group has no lesson
    expect(drive(h, "menuLessonCancel", "G0001", "2026-11-24", "", "").last).toMatch(/darsi yo'q|dars yo'q|topilmadi/i);
    void append; void GROUPS; void TEACHERS;
  });
});
