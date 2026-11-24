import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Charge, Payment, Student } from "../src/domain/types";
import * as demo from "../src/gas/demo";
import { computeInsights } from "../src/gas/insights";
import * as ledger from "../src/gas/ledger";
import { append, read, updateById } from "../src/gas/repo";
import { checkSchedule } from "../src/gas/schedule";
import {
  BRANCHES, CASH_CLOSES, CERTIFICATES, CHARGES, DEMO_TABLES, DISCOUNT_LINES, DISCOUNTS, ENTITLEMENTS, EXAM_RESULTS, EXAMS, GROUPS, GUARDIAN_LINKS, GUARDIAN_REQUESTS,
  MARKS, PAYMENTS, PROMO_USES, PROMOS, REFERRALS, REFUNDS, REPORTS, ROOMS, SCHEDULE_CHANGES, SOURCE_COSTS, STUDENTS, TEACHER_INVITES, TEACHERS,
} from "../src/gas/schema";
import { loadSampleData, resetSampleData, setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;
type Row = Record<string, unknown>;
const real = { status: "active", phone: "", guardianName: "", guardianChatId: "", consentNotify: false };
const rowsOf = (def: { sheet: string }): Row[] => read<Row>(def as never);
const demoStudents = (): (Student & { demo?: boolean })[] => read<Student & { demo?: boolean }>(STUDENTS).filter((s) => s.demo === true);
const byName = (name: string): Student => demoStudents().find((s) => s.fullName === name)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("the sample data shows every capability of the expansion", () => {
  it("fills every new table and flags each row as demo", () => {
    loadSampleData();
    const expected: [string, { sheet: string }, number][] = [
      ["discounts", DISCOUNTS, 2], ["discount lines", DISCOUNT_LINES, 4], ["refunds", REFUNDS, 2], ["cash close", CASH_CLOSES, 1],
      ["rooms", ROOMS, 3], ["schedule change", SCHEDULE_CHANGES, 1], ["referrals", REFERRALS, 2], ["credits", ENTITLEMENTS, 2],
      ["promos", PROMOS, 2], ["promo use", PROMO_USES, 1], ["source costs", SOURCE_COSTS, 3], ["marks", MARKS, 16],
      ["exam", EXAMS, 1], ["exam results", EXAM_RESULTS, 4], ["reports", REPORTS, 4], ["certificate", CERTIFICATES, 1],
      ["guardian requests", GUARDIAN_REQUESTS, 2], ["guardian link", GUARDIAN_LINKS, 1], ["teacher invitation", TEACHER_INVITES, 1],
    ];
    for (const [what, def, n] of expected) {
      const rows = rowsOf(def);
      expect(rows.length, what).toBeGreaterThanOrEqual(n);
      expect(rows.every((r) => r.demo === true), what).toBe(true);
    }
    for (const def of DEMO_TABLES) expect(rowsOf(def).filter((r) => r.demo === true).length, def.sheet).toBeGreaterThan(0);
    expect(read<{ id: string; name: string; demo?: boolean }>(BRANCHES).map((b) => [b.id, b.name, b.demo === true])).toEqual([["F0001", "Asosiy filial", false], ["F0002", "Chilonzor filiali", true]]);
    expect(rowsOf(GROUPS).filter((g) => g.branchId === "F0002")).toHaveLength(1);
  });

  it("discounts are applied: the scholarship takes 20% off, the individual one 50 000 for one month, and the lines say so", () => {
    loadSampleData();
    const mine = (name: string): Charge[] => read<Charge>(CHARGES).filter((c) => c.studentId === byName(name).id).sort((a, b) => a.month.localeCompare(b.month));
    expect(mine("Sevinch Omonova").map((c) => [c.month, c.amount])).toEqual([["2026-09-01", 360_000], ["2026-10-01", 360_000], ["2026-11-01", 360_000]]);
    expect(mine("Rustam Hamidov").map((c) => [c.month, c.amount])).toEqual([["2026-09-01", 450_000], ["2026-10-01", 400_000], ["2026-11-01", 450_000]]);
    expect(rowsOf(DISCOUNT_LINES).map((l) => [l.kind, l.amount])).toEqual(expect.arrayContaining([["scholarship", 90_000], ["individual", 50_000]]));
  });

  it("the refund returns the double payment, the cash close keeps its difference and its note, and nothing reaches the journal", () => {
    loadSampleData();
    const dup = read<Payment>(PAYMENTS).find((p) => p.studentId === byName("Sevinch Omonova").id && p.note.includes("Ikki marta"))!;
    const refund = rowsOf(REFUNDS).find((r) => r.kind === "wrong_payment")!;
    expect([refund.paymentId, refund.amount, refund.payout]).toEqual([dup.id, dup.amount, "bank"]);
    const close = rowsOf(CASH_CLOSES)[0]!;
    expect(close.difference).toBe((close.counted as number) - (close.bookBalance as number));
    expect(String(close.note).length).toBeGreaterThan(10);
    ledger.syncLedger();
    expect(h.rows("Jurnal").length).toBe(1); // only the header
  });

  it("the schedule check reports the room conflict, and the substitute is a recorded change in the future", () => {
    loadSampleData();
    const report = checkSchedule();
    expect(report).toMatch(/xona band \(A xona\)/);
    expect(report).toContain("IELTS 6.5 (kechki)");
    expect(report).toContain("Matematika 9-sinf");
    const change = rowsOf(SCHEDULE_CHANGES)[0]!;
    const malika = read<{ id: string; fullName: string }>(TEACHERS).find((t) => t.fullName === "Malika Yusupova")!;
    expect([change.kind, change.substituteId]).toEqual(["substitute", malika.id]);
    expect(report).not.toMatch(/2026-11-25 18:00: .*o'qituvchi band/); // the substitute is free at that hour
    expect(String(change.date) > "2026-11-23").toBe(true);
  });

  it("reports use the sample's own attendance and marks: two approved, two waiting, plus a certificate in the right format", () => {
    loadSampleData();
    const reports = rowsOf(REPORTS);
    expect(reports.filter((r) => r.status === "approved")).toHaveLength(2);
    expect(reports.filter((r) => r.status === "draft")).toHaveLength(2);
    for (const r of reports) expect(String(r.average)).toMatch(/^\d\.\d$/);
    expect(String(rowsOf(CERTIFICATES)[0]!.code)).toMatch(/^NZC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("guardian requests and the QR link wait for approval; the teacher invitation can never be redeemed by accident", () => {
    loadSampleData();
    expect(rowsOf(GUARDIAN_REQUESTS).map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(rowsOf(GUARDIAN_LINKS).map((r) => [r.method, r.status])).toEqual([["qr", "pending"]]);
    const inv = rowsOf(TEACHER_INVITES)[0]!;
    expect(inv.status).toBe("pending");
    expect(String(inv.codeHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the rule-based report has something to say: debts, weekly lines and an unpaid total", () => {
    loadSampleData();
    const i = computeInsights();
    expect(i.debt.length).toBeGreaterThan(0);
    expect(i.week.lines.length).toBeGreaterThan(0);
    expect(i.week.unpaidTotal).toBeGreaterThan(0);
    expect(i.week.income).toBeGreaterThan(0); // the branch students paid in the last days
  });
});

describe("clearing and refreshing the expanded sample", () => {
  it("clearing removes the second branch and every flagged row of the new tables, and leaves real rows", () => {
    append(STUDENTS, [{ id: "S0001", fullName: "Real One", ...real }]);
    loadSampleData();
    demo.clearDemoData();
    for (const def of DEMO_TABLES) expect(rowsOf(def).filter((r) => r.demo === true), def.sheet).toEqual([]);
    expect(read<{ id: string }>(BRANCHES).map((b) => b.id)).toEqual(["F0001"]);
    expect(rowsOf(STUDENTS).map((s) => s.id)).toEqual(["S0001"]);
    expect(rowsOf(ROOMS)).toEqual([]);
    expect(() => loadSampleData()).not.toThrow(); // may start over
  });

  it("refuses to clear while a real student sits in the demo branch or a real group uses a demo room", () => {
    loadSampleData();
    append(STUDENTS, [{ id: "S0100", fullName: "Real Branch Student", branchId: "F0002", ...real }]);
    expect(() => demo.clearDemoData()).toThrow(/O'quvchilar S0100 -> Filiallar F0002 \(demo\)/);
    updateById(STUDENTS, "id", "S0100", { branchId: "F0001" });
    append(GROUPS, [{ id: "G0100", name: "Real group in a demo room", teacherId: "", monthlyFee: 1, status: "active", roomId: String(rowsOf(ROOMS)[0]!.id) }]);
    expect(() => demo.clearDemoData()).toThrow(/Guruhlar G0100 -> Xonalar X0001 \(demo\)/);
  });

  it("refreshing keeps the Telegram link and brings the whole expansion back", () => {
    loadSampleData();
    updateById(STUDENTS, "id", byName("Aziz Rahimov").id, { guardianChatId: "777", consentNotify: true });
    resetSampleData();
    expect(rowsOf(DISCOUNTS)).toHaveLength(2);
    expect(rowsOf(GUARDIAN_REQUESTS)).toHaveLength(2);
    expect(byName("Aziz Rahimov").guardianChatId).toBe("777");
  });

  it("an older workbook without the newer tabs still loads the basic sample", () => {
    const ss = SpreadsheetApp.getActive();
    for (const def of DEMO_TABLES) ss.deleteSheet(ss.getSheetByName(def.sheet)!);
    expect(ss.getSheetByName(ROOMS.sheet)).toBeNull();
    expect(() => loadSampleData()).not.toThrow();
    expect(demoStudents()).toHaveLength(13);
  });
});
