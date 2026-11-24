import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Charge, Enrollment, Group, Payment, Student } from "../../src/domain/types";
import { handlers } from "../../src/Code";
import * as actions from "../../src/gas/actions";
import * as ledger from "../../src/gas/ledger";
import { append } from "../../src/gas/repo";
import { CHARGES, DRAFTS, ENROLLMENTS, GROUPS, PAYMENTS, STUDENTS, TEACHERS } from "../../src/gas/schema";
import { installHarness, stats, type Harness } from "../harness";
import { drive } from "./support";
import { setupWorkbook } from "../../src/gas/setup";

/**
 * Quota guard. Apps Script stops a run after 6 minutes and every sheet call costs time (a getValues/setValues is
 * roughly 50-500 ms), so the number of sheet CALLS of an action must not grow with the size of the center. Each action
 * is measured on a small and on a large center (300 students, 15 groups, 6 months of charges, payments and journal; call counts are extrapolated, they are independent of the data when no per-row call exists):
 * the call count must stay under an absolute budget AND must not grow with the data (no per-row calls: the O(n) loop
 * that calls getRange/updateById for every student is exactly what this guard exists to catch).
 */
const SMALL = { students: 40, groups: 2, months: 2 };
// 300 x 6 is enough to expose any per-row call (calls would be ~8x the small center); the real 2000 x 24 centre needs >15 GB of RAM in this in-memory harness
const LARGE = { students: 300, groups: 15, months: 6 };
const TODAY = "2026-11-23";

const pad = (n: number, w = 4): string => String(n).padStart(w, "0");
const monthOf = (i: number): string => {
  const d = new Date(Date.UTC(2026, 10 - i, 1)); // i = 0 -> 2026-11, i = 1 -> 2026-10, ...
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-01`;
};

function build(size: { students: number; groups: number; months: number }): void {
  append(TEACHERS, [{ id: "T0001", fullName: "Teacher", payModel: "per_lesson", payRate: 90_000, status: "active" }]);
  append(GROUPS, Array.from({ length: size.groups }, (_, g): Group => ({ id: `G${pad(g + 1)}`, name: `Guruh ${g + 1}`, teacherId: "T0001", monthlyFee: 500_000, status: "active", schedule: "Du-Chor-Ju 18:00-19:30" })));
  append(STUDENTS, Array.from({ length: size.students }, (_, i): Student => ({ id: `S${pad(i + 1)}`, fullName: `O'quvchi ${i + 1}`, status: "active", guardianName: `Vasiy ${Math.floor(i / 2)}`, guardianChatId: i % 3 === 0 ? String(100_000 + i) : "", consentNotify: i % 3 === 0 })));
  append(ENROLLMENTS, Array.from({ length: size.students }, (_, i): Enrollment => ({ id: `E${pad(i + 1)}`, studentId: `S${pad(i + 1)}`, groupId: `G${pad((i % size.groups) + 1)}`, startedOn: "2024-09-01", endedOn: "", discountPercent: 0, status: "active" })));
  const charges: Charge[] = [];
  const payments: Payment[] = [];
  for (let m = 0; m < size.months; m++) {
    for (let i = 0; i < size.students; i++) {
      const month = monthOf(m);
      charges.push({ id: `C${pad(charges.length + 1, 6)}`, studentId: `S${pad(i + 1)}`, enrollmentId: `E${pad(i + 1)}`, month, amount: 500_000, dueDate: `${month.slice(0, 7)}-10`, voided: false, note: "" });
      // most pay on time; every seventh student of the current month is a debtor
      if (m > 0 || i % 7 !== 0) payments.push({ id: `P${pad(payments.length + 1, 6)}`, studentId: `S${pad(i + 1)}`, paidOn: `${month.slice(0, 7)}-08`, amount: 500_000, method: i % 2 ? "Naqd" : "Karta", voided: false, note: "" });
    }
  }
  append(CHARGES, charges);
  append(PAYMENTS, payments);
  // reminder drafts: a tenth of the students wait for a decision, 50 more are approved and waiting to be sent
  const waiting = Math.max(2, Math.floor(size.students / 10));
  append(DRAFTS, [
    ...Array.from({ length: waiting }, (_, i) => ({ id: `R${pad(i + 1)}`, studentId: `S${pad(i * 3 + 1)}`, createdOn: TODAY, text: "Eslatma", status: "pending", error: "" })),
    ...Array.from({ length: Math.min(50, waiting) }, (_, i) => ({ id: `R${pad(waiting + i + 1)}`, studentId: `S${pad(i * 3 + 1)}`, createdOn: TODAY, text: "Tasdiqlangan", status: "approved", error: "" })),
  ]);
}

interface Measure { calls: number; cells: number; fetches: number }
function measure(fn: () => unknown, name = ""): Measure {
  stats.reads = stats.writes = stats.cellsRead = stats.cellsWritten = stats.fetches = 0;
  const t0 = performance.now();
  if (process.env.QUOTA_TRACE) appendFileSync(`${process.env.TEMP}/quota.txt`, `start ${name}
`);
  fn();
  if (process.env.QUOTA_TRACE) appendFileSync(`${process.env.TEMP}/quota.txt`, `done ${name} ${Math.round(performance.now() - t0)} ms, ${stats.reads + stats.writes} calls
`);
  return { calls: stats.reads + stats.writes, cells: stats.cellsRead + stats.cellsWritten, fetches: stats.fetches };
}

/** [name, action, absolute call budget on the LARGE center] */
type Action = [string, (h: Harness) => unknown, number, boolean?]; // [name, run, call budget, fetches scale with the work]
const ACTIONS: Action[] = [
  ["recordPayment (sidebar)", () => actions.recordPayment({ studentId: "S0002", amount: 100_000, method: "Naqd", paidOn: TODAY, note: "", notifyGuardian: false }), 40],
  ["getBalance + searchStudents (payment dialog)", () => { actions.searchStudents("o'quvchi 1"); actions.getBalance("S0002"); }, 25],
  ["getRoster + saveAttendance (one group)", () => {
    const roster = actions.getRoster("G0001", TODAY);
    actions.saveAttendance({ date: TODAY, groupId: "G0001", marks: roster.map((r) => ({ studentId: r.studentId, status: "present", minutesLate: 0 })) });
  }, 40],
  ["menuGenerateCharges (next month)", (h) => drive(h, "menuGenerateCharges", "2026-12"), 60],
  ["menuDebtors", (h) => drive(h, "menuDebtors"), 40],
  ["menuDashboard", (h) => drive(h, "menuDashboard"), 60],
  ["menuInsightWeekly", (h) => drive(h, "menuInsightWeekly"), 60],
  ["menuInsightDebt", (h) => drive(h, "menuInsightDebt"), 60],
  ["menuCreateDrafts", (h) => drive(h, "menuCreateDrafts"), 60],
  ["menuLedgerSync (nothing new)", (h) => drive(h, "menuLedgerSync"), 60],
  ["menuLedgerVerify", (h) => drive(h, "menuLedgerVerify"), 30],
  ["menuReportTrial", (h) => drive(h, "menuReportTrial", ""), 40],
  ["menuReportIncome", (h) => drive(h, "menuReportIncome", "", ""), 40],
  ["menuCashStatus", (h) => drive(h, "menuCashStatus"), 40],
  ["menuCashClose", (h) => drive(h, "menuCashClose", "0", "Hisob", ), 60],
  ["menuQrIssue (a code for every student)", (h) => drive(h, "menuQrIssue"), 40],
  ["menuLinkCodes (a link for every student)", (h) => drive(h, "menuLinkCodes"), 40],
  ["decideDrafts (approve every pending draft)", () => {
    const pending = actions.getPendingDrafts();
    return actions.decideDrafts({ approve: pending.map((d) => d.id), reject: [], edits: {} });
  }, 40],
  ["menuSendApproved (up to 50 drafts)", (h) => drive(h, "menuSendApproved"), 40, true],
  ["menuPayroll", (h) => drive(h, "menuPayroll", ""), 60],
  ["menuBranchReport", (h) => drive(h, "menuBranchReport", "2026-11"), 60],
];

let small: Harness;
const smallMeasures = new Map<string, Measure>();
const largeMeasures = new Map<string, Measure>();

function fresh(size: typeof SMALL): Harness {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00Z`));
  const h = installHarness();
  setupWorkbook();
  h.props.set("BOT_USERNAME", "demo_bot");
  h.props.set("TELEGRAM_BOT_TOKEN", "123:abc");
  build(size);
  return h;
}

/** posts every payment of the data set into the journal (24 months of entries) before measuring */
function bookEverything(h: Harness): void {
  ledger.syncLedger();
  void h;
}

describe("quota guard: sheet calls per action must not grow with the size of the center", () => {
  beforeAll(() => {
    small = fresh(SMALL);
    bookEverything(small);
    for (const [name, run] of ACTIONS) {
      try {
        smallMeasures.set(name, measure(() => run(small), `small ${name}`));
      } catch (e) {
        throw new Error(`${name} failed on the small center: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const big = fresh(LARGE);
    bookEverything(big);
    for (const [name, run] of ACTIONS) {
      try {
        largeMeasures.set(name, measure(() => run(big), name));
      } catch (e) {
        throw new Error(`${name} failed on the large center: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }, 600_000);
  afterAll(() => vi.useRealTimers());

  it("the large center is many times the small one", () => {
    expect(LARGE.students / SMALL.students).toBeGreaterThanOrEqual(7);
  });

  for (const [name, , budget, fetchesScale] of ACTIONS) {
    it(`${name}: within ${budget} sheet calls and no per-row calls`, () => {
      const s = smallMeasures.get(name)!;
      const l = largeMeasures.get(name)!;
      // eslint-disable-next-line no-console
      if (process.env.QUOTA_REPORT) console.log(`${name}: small ${s.calls} calls / ${s.cells} cells, large ${l.calls} calls / ${l.cells} cells`);
      expect(l.calls, `${name}: ${l.calls} sheet calls on the large center (budget ${budget})`).toBeLessThanOrEqual(budget);
      // work-proportional actions (one network call and one write batch per 25 drafts) only keep the absolute budget
      if (!fetchesScale) expect(l.calls, `${name}: ${l.calls} calls on the large center vs ${s.calls} on the small one (calls must not grow with the data)`).toBeLessThanOrEqual(s.calls * 1.25 + 4);
      if (!fetchesScale) expect(l.fetches, `${name}: network calls must not grow with the data`).toBeLessThanOrEqual(s.fetches + 2);
    });
  }
  void handlers;
});
