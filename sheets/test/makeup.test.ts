import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldLessons } from "../src/domain/payroll";
import type { AttendanceRow, Charge, Entitlement } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import * as admission from "../src/gas/admission";
import * as makeup from "../src/gas/makeup";
import { append, read } from "../src/gas/repo";
import { CHARGES, ENROLLMENTS, ENTITLEMENTS, GROUPS, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;

function setSetting(label: string, value: string): void {
  const sh = h.sheets.get("Sozlamalar")!;
  const row = sh.data.find((r) => r[0] === label);
  if (!row) throw new Error(`no setting ${label}`);
  row[1] = value;
}

function seed(fee = 600_000): void {
  append(STUDENTS, [{ id: "S0001", fullName: "Ali Valiyev", status: "active", phone: "", guardianName: "", guardianChatId: "", consentNotify: false }]);
  append(GROUPS, [{ id: "G0001", name: "IELTS", teacherId: "T0001", monthlyFee: fee, schedule: "Du", status: "active" }]);
  append(ENROLLMENTS, [{ id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" }]);
}
const mark = (date: string, status: AttendanceRow["status"]) =>
  actions.saveAttendance({ date, groupId: "G0001", marks: [{ studentId: "S0001", status, minutesLate: 0 }] });
const rights = () => read<Entitlement>(ENTITLEMENTS);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z")); // a Monday
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("make-up rights from excused absences", () => {
  it("an excused mark creates one right with the expiry; saving again changes nothing", () => {
    seed();
    mark("2026-11-16", "excused");
    mark("2026-11-16", "excused");
    expect(rights()).toHaveLength(1);
    const r = rights()[0]!;
    expect([r.id, r.studentId, r.groupId, r.missedOn, r.kind, r.status, r.expiresOn]).toEqual(["R0001", "S0001", "G0001", "2026-11-16", "makeup", "open", "2026-12-16"]);
  });

  it("another mark cancels an open right and excused again reopens it; removing the mark cancels it", () => {
    seed();
    mark("2026-11-16", "excused");
    mark("2026-11-16", "present");
    expect(rights().map((r) => r.status)).toEqual(["cancelled"]);
    mark("2026-11-16", "excused");
    expect(rights().map((r) => r.status)).toEqual(["open"]);
    actions.saveAttendance({ date: "2026-11-16", groupId: "G0001", marks: [] });
    expect(rights().map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("mode 'yo'q' creates nothing; a trial student earns nothing", () => {
    seed();
    setSetting("Sababli yo'qlik", "Yo'q");
    mark("2026-11-16", "excused");
    expect(rights()).toHaveLength(0);
    setSetting("Sababli yo'qlik", "Qoplash");
    const sh = h.sheets.get(ENROLLMENTS.sheet)!;
    sh.data[1]![6] = "Sinov";
    mark("2026-11-09", "excused");
    expect(rights()).toHaveLength(0);
  });
});

describe("scheduling a make-up lesson", () => {
  it("schedule, attend closes, absent reopens; validation", () => {
    seed();
    mark("2026-11-16", "excused");
    h.prompts.push("2026-11-22");
    expect(() => makeup.scheduleMakeup("R0001")).toThrow(/o'tgan sana/);
    h.prompts.push("2026-11-30");
    makeup.scheduleMakeup("R0001");
    expect([rights()[0]!.status, rights()[0]!.makeupOn]).toEqual(["scheduled", "2026-11-30"]);
    expect(() => makeup.scheduleMakeup("R0001")).toThrow(/ochiq emas/); // refused before any prompt

    mark("2026-11-30", "absent");
    expect([rights()[0]!.status, rights()[0]!.makeupOn]).toEqual(["open", ""]);
    h.prompts.push("2026-11-30");
    makeup.scheduleMakeup("R0001");
    mark("2026-11-30", "present");
    expect([rights()[0]!.status, rights()[0]!.usedOn]).toEqual(["used", "2026-11-30"]);
  });

  it("cancel works on open and scheduled rights only", () => {
    seed();
    mark("2026-11-16", "excused");
    makeup.cancelEntitlement("R0001");
    expect(rights()[0]!.status).toBe("cancelled");
    expect(() => makeup.cancelEntitlement("R0001")).toThrow(/ochiq emas/);
  });

  it("a right past its expiry shows as lapsed and cannot be scheduled; lapsing can be turned off", () => {
    seed();
    setSetting("Qoplash muddati (kun)", "0");
    mark("2026-11-16", "excused");
    makeup.openEntitlements();
    expect(h.rows("Qoplash holati").map((r) => r.join("|")).some((r) => /Muddati o'tgan/.test(r))).toBe(true);
    expect(() => makeup.scheduleMakeup("R0001")).toThrow(/ochiq emas/);
    setSetting("Muddati o'tgan huquq kuyadi", "Yo'q");
    makeup.openEntitlements();
    expect(h.rows("Qoplash holati").map((r) => r.join("|")).some((r) => /Muddati o'tgan/.test(r))).toBe(false);
  });
});

describe("credit mode", () => {
  it("an excused absence earns the lesson price and the next monthly charge is reduced once", () => {
    seed(600_000);
    setSetting("Sababli yo'qlik", "Kredit");
    mark("2026-11-16", "excused");
    mark("2026-11-09", "excused");
    expect(rights().map((r) => [r.kind, r.amount])).toEqual([["credit", 120_000], ["credit", 120_000]]); // 5 Mondays in November
    h.prompts.push("2026-12");
    actions.generateMonthlyCharges();
    const c = read<Charge>(CHARGES);
    expect(c.map((x) => x.amount)).toEqual([360_000]);
    expect(rights().every((r) => r.status === "used" && r.appliedChargeId === c[0]!.id)).toBe(true);
    h.prompts.push("2026-12");
    actions.generateMonthlyCharges();
    expect(read<Charge>(CHARGES)).toHaveLength(1); // nothing generated or consumed twice
  });

  it("credits that cover the whole fee leave a zero charge", () => {
    seed(100_000);
    setSetting("Sababli yo'qlik", "Kredit");
    for (const d of ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]) mark(d, "excused");
    h.prompts.push("2026-12");
    actions.generateMonthlyCharges();
    expect(read<Charge>(CHARGES).map((x) => x.amount)).toEqual([0]);
  });

  it("a credit cannot be scheduled", () => {
    seed();
    setSetting("Sababli yo'qlik", "Kredit");
    mark("2026-11-16", "excused");
    expect(() => makeup.scheduleMakeup("R0001")).toThrow(/kredit/i);
  });
});

describe("payroll and Telegram", () => {
  it("a make-up day with only absent marks is not a held lesson", () => {
    const att = (date: string, status: AttendanceRow["status"]): AttendanceRow => ({ date, groupId: "G0001", studentId: "S0001", status, minutesLate: 0 });
    const gids = new Set(["G0001"]);
    const makeupDays = new Set(["2026-11-30|G0001"]);
    expect(heldLessons([att("2026-11-16", "present"), att("2026-11-30", "absent")], gids, "2026-11-01", makeupDays)).toBe(1);
    expect(heldLessons([att("2026-11-16", "present"), att("2026-11-30", "present")], gids, "2026-11-01", makeupDays)).toBe(2);
    expect(heldLessons([att("2026-11-16", "present"), att("2026-11-30", "absent")], gids, "2026-11-01")).toBe(2); // old behaviour without the set
  });

  it("nothing is sent to Telegram", () => {
    seed();
    mark("2026-11-16", "excused");
    h.prompts.push("2026-11-30");
    makeup.scheduleMakeup("R0001");
    expect(h.fetches).toHaveLength(0);
    expect(typeof admission.pendingTrials).toBe("function");
  });
});
