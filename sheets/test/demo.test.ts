import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoBlockers } from "../src/domain/demo";
import type { Charge, Enrollment, Expense, Group, Payment, ReminderDraft, Student, WaitlistRow } from "../src/domain/types";
import * as demo from "../src/gas/demo";
import * as ledger from "../src/gas/ledger";
import { append, read, updateById } from "../src/gas/repo";
import { ATTENDANCE, CHARGES, DRAFTS, ENROLLMENTS, EXPENSES, GROUPS, LEADS, PAYMENTS, STUDENTS, TEACHERS, WAITLIST } from "../src/gas/schema";
import { loadSampleData, resetSampleData, setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;
type S = Student & { demo?: boolean };
const real = { status: "active", phone: "", guardianName: "", guardianChatId: "", consentNotify: false };
const demoStudents = (): S[] => read<S>(STUDENTS).filter((s) => s.demo === true);
const realStudents = (): S[] => read<S>(STUDENTS).filter((s) => s.demo !== true);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("the pure rule", () => {
  it("a real row pointing at a demo row blocks; demo-to-demo and real-to-real do not", () => {
    const out = demoBlockers([
      { table: "students", rows: [{ id: "S1", demo: true, refs: [] }, { id: "S2", demo: false, refs: [] }] },
      { table: "payments", rows: [{ id: "P1", demo: true, refs: [["students", "S1"]] }, { id: "P2", demo: false, refs: [["students", "S1"]] }, { id: "P3", demo: false, refs: [["students", "S2"]] }, { id: "P4", demo: false, refs: [["students", ""]] }] },
    ]);
    expect(out).toEqual([{ table: "payments", id: "P2", refTable: "students", refId: "S1" }]);
  });
});

describe("sample data", () => {
  it("every row of every table is flagged and sits after the real ids", () => {
    append(STUDENTS, [{ id: "S0001", fullName: "Real One", ...real }]);
    append(GROUPS, [{ id: "G0001", name: "Real group", teacherId: "", monthlyFee: 1, status: "active" }]);
    const msg = loadSampleData();
    expect(msg).toContain("8 o'quvchi (+3 navbatda)");
    expect(realStudents().map((s) => s.id)).toEqual(["S0001"]);
    expect(demoStudents().map((s) => s.id)[0]).toBe("S0002");
    for (const def of [STUDENTS, TEACHERS, GROUPS, ENROLLMENTS, CHARGES, PAYMENTS, ATTENDANCE, EXPENSES, LEADS, WAITLIST]) {
      const rows = read<{ id?: string; demo?: boolean }>(def).filter((r) => r.id !== "S0001" && r.id !== "G0001");
      expect(rows.length, def.sheet).toBeGreaterThan(0);
      expect(rows.every((r) => r.demo === true), def.sheet).toBe(true);
    }
    expect(new Set(read<Group>(GROUPS).map((g) => g.id)).size).toBe(5);
  });

  it("is refused a second time, and demo money never reaches the journal", () => {
    loadSampleData();
    expect(() => loadSampleData()).toThrow(/allaqachon yuklangan/);
    expect(ledger.pendingList().filter((p) => p.sourceType === "payment" || p.sourceType === "expense")).toEqual([]);
    expect(read<Payment>(PAYMENTS).length).toBeGreaterThan(10);
    expect(read<Expense>(EXPENSES).length).toBeGreaterThan(3);
    ledger.syncLedger();
    expect(h.rows("Jurnal").length).toBe(1); // only the header: nothing was posted
  });

  it("has a full group with a queue and one seat that frees for the next in line", () => {
    loadSampleData();
    const groups = read<Group>(GROUPS);
    const ielts = groups.find((g) => g.name.startsWith("IELTS"))!;
    const math = groups.find((g) => g.name.startsWith("Matematika"))!;
    const enrollments = read<Enrollment>(ENROLLMENTS);
    expect([ielts.capacity, enrollments.filter((e) => e.groupId === ielts.id).length, math.capacity, enrollments.filter((e) => e.groupId === math.id).length]).toEqual([4, 4, 5, 4]);
    expect(read<WaitlistRow>(WAITLIST).map((w) => w.groupId)).toEqual([ielts.id, ielts.id, math.id]);
  });
});

describe("clearing demo data", () => {
  it("deletes only the flagged rows and leaves real rows, settings and ids alone", () => {
    append(STUDENTS, [{ id: "S0001", fullName: "Real One", ...real }]);
    append(GROUPS, [{ id: "G0001", name: "Real group", teacherId: "", monthlyFee: 1, status: "active" }]);
    append(ENROLLMENTS, [{ id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" }]);
    append(PAYMENTS, [{ id: "P0001", studentId: "S0001", paidOn: "2026-11-02", amount: 100, method: "Naqd", note: "", voided: false }]);
    loadSampleData();
    const settings = JSON.stringify(h.rows("Sozlamalar"));
    const out = demo.clearDemoData();
    expect(out.deleted.find((d) => d.label === "O'quvchilar")!.count).toBe(13);
    expect(realStudents().map((s) => s.id)).toEqual(["S0001"]);
    expect(demoStudents()).toHaveLength(0);
    expect(read<Group>(GROUPS).map((g) => g.id)).toEqual(["G0001"]);
    expect(read<Payment>(PAYMENTS).map((p) => p.id)).toEqual(["P0001"]);
    expect(read<Enrollment>(ENROLLMENTS).map((e) => e.id)).toEqual(["E0001"]);
    expect(demo.hasDemoRows()).toBe(false);
    expect(JSON.stringify(h.rows("Sozlamalar"))).toBe(settings);
    expect(() => loadSampleData()).not.toThrow(); // may start over
  });

  it("refuses, deleting nothing, while a real payment points at a demo student", () => {
    loadSampleData();
    const s = demoStudents()[0]!;
    append(PAYMENTS, [{ id: "P9999", studentId: s.id, paidOn: "2026-11-02", amount: 100, method: "Naqd", note: "", voided: false }]);
    const before = JSON.stringify(h.rows("O'quvchilar"));
    expect(() => demo.clearDemoData()).toThrow(/To'lovlar P9999 -> O'quvchilar S0001 \(demo\)/);
    expect(JSON.stringify(h.rows("O'quvchilar"))).toBe(before);
    expect(demo.hasDemoRows()).toBe(true);
  });

  it("refuses for a real enrollment in a demo group, a real mark, a real draft and a real lead log", () => {
    loadSampleData();
    const group = read<Group>(GROUPS)[0]!;
    append(STUDENTS, [{ id: "S0100", fullName: "Real Joiner", ...real }]);
    append(ENROLLMENTS, [{ id: "E0100", studentId: "S0100", groupId: group.id, startedOn: "2026-11-01", endedOn: "", discountPercent: 0, status: "trial" }]);
    expect(() => demo.clearDemoData()).toThrow(/Yozilishlar E0100 -> Guruhlar/);
    updateById(ENROLLMENTS, "id", "E0100", { groupId: "G9999" });
    append(ATTENDANCE, [{ date: "2026-11-23", groupId: group.id, studentId: "S0100", status: "present", minutesLate: 0 }]);
    expect(() => demo.clearDemoData()).toThrow(/Davomat/);
    h.sheet("Davomat").data.pop();
    h.sheet("Davomat").getLastRow();
    append(DRAFTS, [{ id: "R0001", studentId: demoStudents()[0]!.id, createdOn: "2026-11-23", text: "x", status: "pending", error: "" } as ReminderDraft]);
    expect(() => demo.clearDemoData()).toThrow(/Eslatmalar R0001/);
  });

  it("the menu asks first, lists what goes, and says so when there is nothing to clear", () => {
    h.answers.push("OK");
    demo.menu.clear();
    expect(h.alerts.at(-1)!.message).toBe("Demo belgili qator yo'q.");
    loadSampleData();
    h.answers.push("NO");
    demo.menu.clear();
    expect(h.alerts.at(-1)!.message).toContain("O'quvchilar: 13");
    expect(demo.hasDemoRows()).toBe(true);
    h.answers.push("YES", "OK");
    demo.menu.clear();
    expect(demo.hasDemoRows()).toBe(false);
    expect(h.alerts.at(-1)!.message).toMatch(/demo qator o'chirildi/);
  });

  it("a blocked clear is reported through the guard, not thrown at the user", () => {
    loadSampleData();
    append(PAYMENTS, [{ id: "P9999", studentId: demoStudents()[0]!.id, paidOn: "2026-11-02", amount: 100, method: "Naqd", note: "", voided: false }]);
    h.answers.push("YES");
    expect(() => demo.menu.clear()).not.toThrow();
    expect(h.alerts.at(-1)!.message).toContain("tozalab bo'lmaydi");
    expect(demo.hasDemoRows()).toBe(true);
  });
});

describe("refreshing sample data", () => {
  it("keeps real data and the Telegram link of a demo student, and drops what changed", () => {
    append(STUDENTS, [{ id: "S0001", fullName: "Real One", ...real }]);
    loadSampleData();
    const aziz = demoStudents().find((s) => s.fullName === "Aziz Rahimov")!;
    updateById(STUDENTS, "id", aziz.id, { guardianChatId: "777", consentNotify: true });
    updateById(STUDENTS, "id", demoStudents()[1]!.id, { fullName: "Stale Edited Name" });
    const msg = resetSampleData();
    expect(msg).toContain("Telegram ulanishlari saqlandi: 1");
    expect(realStudents().map((s) => s.fullName)).toEqual(["Real One"]);
    expect(demoStudents()).toHaveLength(13);
    expect(demoStudents().some((s) => s.fullName === "Stale Edited Name")).toBe(false);
    const again = demoStudents().find((s) => s.fullName === "Aziz Rahimov")!;
    expect([again.guardianChatId, again.consentNotify]).toEqual(["777", true]);
  });

  it("is refused while a real record references the demo data", () => {
    loadSampleData();
    append(PAYMENTS, [{ id: "P9999", studentId: demoStudents()[0]!.id, paidOn: "2026-11-02", amount: 100, method: "Naqd", note: "", voided: false }]);
    expect(() => resetSampleData()).toThrow(/tozalab bo'lmaydi/);
    expect(demoStudents()).toHaveLength(13);
  });

  it("charges of the sample are real-looking and flagged", () => {
    loadSampleData();
    expect(read<Charge & { demo?: boolean }>(CHARGES).every((c) => c.demo === true && c.month >= "2026-")).toBe(true);
  });
});
