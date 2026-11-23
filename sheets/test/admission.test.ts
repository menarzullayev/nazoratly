import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monthLessonDates, parseWeekdays } from "../src/domain/lifecycle";
import type { AttendanceRow, Charge, Enrollment, Lead, Student } from "../src/domain/types";
import * as admission from "../src/gas/admission";
import { append, read } from "../src/gas/repo";
import { ATTENDANCE, CHARGES, ENROLLMENTS, GROUPS, LEADS, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

describe("lesson calendar from the weekly schedule text", () => {
  it("understands Uzbek day abbreviations, numbers and ignores times", () => {
    expect(parseWeekdays("Du-Chor-Ju 18:00")).toEqual([1, 3, 5]);
    expect(parseWeekdays("1, 3 va 5")).toEqual([1, 3, 5]);
    expect(parseWeekdays("Se Pay Sha Yak")).toEqual([2, 4, 6, 7]);
    expect(parseWeekdays("")).toEqual([]);
    expect(parseWeekdays("kechqurun 18:00")).toEqual([]);
  });

  it("lists the lesson dates of a month", () => {
    expect(monthLessonDates("2026-11-01", "Du")).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
    expect(monthLessonDates("2026-11-15", "Du-Ju")).toHaveLength(9);
    expect(monthLessonDates("2026-11-01", "")).toEqual([]);
  });
});

let h: Harness;
const alertText = () => h.alerts.map((a) => a.message).join("\n");

function seed(opts: { schedule?: string; fee?: number } = {}): void {
  append(STUDENTS, [{ id: "S0001", fullName: "Ali Valiyev", status: "active", phone: "+998901112233", guardianName: "Karim", guardianChatId: "", consentNotify: false }]);
  append(GROUPS, [{ id: "G0001", name: "IELTS", teacherId: "T0001", monthlyFee: opts.fee ?? 600_000, schedule: opts.schedule ?? "Du", status: "active" }]);
  append(ENROLLMENTS, [{ id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-11-02", endedOn: "", discountPercent: 0, status: "trial" }]);
}
const enrollment = (id = "E0001") => read<Enrollment>(ENROLLMENTS).find((e) => e.id === id)!;
const charges = () => read<Charge>(CHARGES);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z")); // a Monday
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("pending trials", () => {
  it("lists a trial once its free lesson was attended, with the reason", () => {
    seed();
    admission.pendingTrials();
    expect(h.rows("Qaror kutayotganlar")).toHaveLength(2); // header + the trial: 21 days since 2026-11-02 >= 7
    const row = h.rows("Qaror kutayotganlar")[1]!;
    expect(String(row[0])).toBe("E0001");
    expect(String(row[6])).toMatch(/kun/);
  });

  it("does not list a trial that is still inside both limits", () => {
    seed();
    updateStart("E0001", "2026-11-22");
    admission.pendingTrials();
    expect(h.rows("Qaror kutayotganlar")).toHaveLength(1);
  });

  it("an attended lesson makes it due for the lesson reason", () => {
    seed();
    updateStart("E0001", "2026-11-22");
    append(ATTENDANCE, [{ date: "2026-11-23", groupId: "G0001", studentId: "S0001", status: "present", minutesLate: 0 } satisfies AttendanceRow]);
    admission.pendingTrials();
    const rows = h.rows("Qaror kutayotganlar");
    expect(rows).toHaveLength(2);
    expect(String(rows[1]![6])).toMatch(/dars/);
  });
});

function updateStart(id: string, day: string): void {
  const sh = h.sheets.get(ENROLLMENTS.sheet)!;
  const rowIdx = sh.data.findIndex((r) => r[0] === id);
  sh.data[rowIdx]![3] = new Date(`${day}T00:00:00Z`);
}

describe("accept a trial", () => {
  it("prorated: charges the remaining share of the month's lessons (2 of 5 Mondays)", () => {
    seed();
    h.prompts.push("1");
    admission.acceptTrial("E0001");
    expect(charges().map((c) => c.amount)).toEqual([240_000]);
    expect(charges()[0]!.dueDate).toBe("2026-11-23"); // due on the acceptance day when that is after the 10th
    const e = enrollment();
    expect([e.status, e.acceptedOn, e.firstMonthMode]).toEqual(["active", "2026-11-23", "prorated"]);
  });

  it("full month and free until next month", () => {
    seed();
    h.prompts.push("2");
    admission.acceptTrial("E0001");
    expect(charges().map((c) => c.amount)).toEqual([600_000]);

    append(STUDENTS, [{ id: "S0002", fullName: "Vali", status: "active", phone: "", guardianName: "", guardianChatId: "", consentNotify: false }]);
    append(ENROLLMENTS, [{ id: "E0002", studentId: "S0002", groupId: "G0001", startedOn: "2026-11-02", endedOn: "", discountPercent: 0, status: "trial" }]);
    h.prompts.push("3");
    admission.acceptTrial("E0002");
    expect(charges()).toHaveLength(1); // nothing for the free month
    expect(enrollment("E0002").firstMonthMode).toBe("free_until_next");
  });

  it("without a lesson schedule, prorating falls back to the full month and says so", () => {
    seed({ schedule: "" });
    h.prompts.push("1");
    admission.acceptTrial("E0001");
    expect(charges().map((c) => c.amount)).toEqual([600_000]);
    expect(alertText()).toMatch(/to'liq oy/);
  });

  it("refuses a second acceptance and a non-trial, never double billing", () => {
    seed();
    h.prompts.push("1");
    admission.acceptTrial("E0001");
    h.prompts.push("1");
    expect(() => admission.acceptTrial("E0001")).toThrow(/allaqachon qabul/);
    expect(charges()).toHaveLength(1);
    expect(() => admission.acceptTrial("E9999")).toThrow(/topilmadi/);
  });

  it("an invalid mode answer changes nothing", () => {
    seed();
    h.prompts.push("x");
    expect(() => admission.acceptTrial("E0001")).toThrow(/1, 2 yoki 3/);
    expect(enrollment().status).toBe("trial");
    expect(charges()).toHaveLength(0);
  });

  it("sends nothing to Telegram", () => {
    seed();
    h.prompts.push("1");
    admission.acceptTrial("E0001");
    expect(h.fetches).toHaveLength(0);
  });
});

describe("drop a trial", () => {
  it("finishes the enrollment without any charge; refuses non-trials", () => {
    seed();
    admission.dropTrial("E0001");
    const e = enrollment();
    expect([e.status, e.endedOn]).toEqual(["finished", "2026-11-23"]);
    expect(charges()).toHaveLength(0);
    expect(() => admission.dropTrial("E0001")).toThrow(/faqat sinov/i);
  });
});

describe("leads", () => {
  const lead = (o: Partial<Lead> = {}): Lead => ({
    id: "L0001", fullName: "Madina Karimova", phone: "+998901234567", source: "Instagram", stage: "new", nextFollowUpOn: "", note: "", createdOn: "2026-11-20", studentId: "", ...o,
  });

  it("turning a lead into a trial creates the student and a trial enrollment once", () => {
    append(GROUPS, [{ id: "G0001", name: "IELTS", teacherId: "", monthlyFee: 600_000, schedule: "Du", status: "active" }]);
    append(LEADS, [lead()]);
    admission.enrollLeadInTrial("L0001", "G0001");
    const l = read<Lead>(LEADS)[0]!;
    expect(l.stage).toBe("trial_scheduled");
    const s = read<Student>(STUDENTS).find((x) => x.id === l.studentId)!;
    expect(s.fullName).toBe("Madina Karimova");
    const e = read<Enrollment>(ENROLLMENTS);
    expect(e).toHaveLength(1);
    expect([e[0]!.status, e[0]!.studentId, e[0]!.groupId]).toEqual(["trial", s.id, "G0001"]);
    expect(() => admission.enrollLeadInTrial("L0001", "G0001")).toThrow(/allaqachon/);
    expect(read<Student>(STUDENTS)).toHaveLength(1);
  });

  it("a phone that already belongs to a student is refused", () => {
    seed();
    append(LEADS, [lead({ phone: "+998901112233" })]);
    expect(() => admission.enrollLeadInTrial("L0001", "G0001")).toThrow(/telefon/);
    expect(read<Student>(STUDENTS)).toHaveLength(1);
    expect(read<Lead>(LEADS)[0]!.stage).toBe("new");
  });

  it("the funnel sheet matches the funnel rules and fills missing lead ids", () => {
    append(LEADS, [lead(), lead({ id: "", fullName: "No Id", source: "", stage: "enrolled", createdOn: "2026-11-21" }), lead({ id: "L0003", stage: "lost", createdOn: "2025-01-01" })]);
    admission.refreshFunnel();
    expect(read<Lead>(LEADS).map((l) => l.id)).toEqual(["L0001", "L0004", "L0003"]);
    const rows = h.rows("Voronka").map((r) => r.join("|"));
    expect(rows.some((r) => r.startsWith("Yangi|1"))).toBe(true);
    expect(rows.some((r) => r.startsWith("Yozildi|1"))).toBe(true);
    expect(rows.some((r) => r.startsWith("Yo'qotildi|0"))).toBe(true); // 2025 lead is outside the last 90 days
  });
});
