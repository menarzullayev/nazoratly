import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Charge, Installment, Payment, ReminderDraft } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import * as plans from "../src/gas/plans";
import { append, read } from "../src/gas/repo";
import { CHARGES, DRAFTS, INSTALLMENTS, PAYMENTS, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;

function setSetting(label: string, value: string): void {
  const row = h.sheets.get("Sozlamalar")!.data.find((r) => r[0] === label);
  if (!row) throw new Error(`no setting ${label}`);
  row[1] = value;
}
function student(id: string, name: string, chat = "555", consent = true): void {
  append(STUDENTS, [{ id, fullName: name, status: "active", phone: "", guardianName: "Dilnoza", guardianChatId: chat, consentNotify: consent }]);
}
function charge(id: string, studentId: string, amount: number, dueDate: string): void {
  append(CHARGES, [{ id, studentId, enrollmentId: "E0001", month: "2026-10-01", amount, dueDate, voided: false, note: "" }]);
}
function pay(id: string, studentId: string, amount: number): void {
  append(PAYMENTS, [{ id, studentId, paidOn: "2026-11-01", amount, method: "Naqd", note: "", voided: false }]);
}
function plan(chargeId: string, rows: [number, string][]): void {
  append(INSTALLMENTS, rows.map(([amount, dueDate], i) => ({ chargeId, seq: i + 1, dueDate, amount })));
}
const installments = () => read<Installment>(INSTALLMENTS);
const debtorRow = (id: string) => h.rows("Qarzdorlar").find((r) => r[0] === id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("creating a payment plan", () => {
  it("splits the charge equally, shows the schedule, writes the rows and moves the charge due date to the first installment", () => {
    student("S0001", "Ali Valiyev");
    charge("C0001", "S0001", 1_000_000, "2026-10-10");
    plans.createPaymentPlan("C0001", 3, "2026-12-31");
    expect(installments().map((i) => [i.chargeId, i.seq, i.dueDate, i.amount])).toEqual([
      ["C0001", 1, "2026-12-31", 333_333], ["C0001", 2, "2027-01-31", 333_333], ["C0001", 3, "2027-02-28", 333_334],
    ]);
    expect(read<Charge>(CHARGES)[0]!.dueDate).toBe("2026-12-31");
    const shown = h.alerts.at(-1)!.message;
    for (const needle of ["333 333", "333 334", "31.12.2026", "28.02.2027", "Tasdiqlaysizmi"]) expect(shown).toContain(needle);
  });

  it("declining the confirmation changes nothing", () => {
    student("S0001", "Ali Valiyev");
    charge("C0001", "S0001", 600_000, "2026-10-10");
    h.answers.push("NO");
    expect(() => plans.createPaymentPlan("C0001", 2, "2026-12-10")).toThrow("Bekor qilindi");
    expect(installments()).toHaveLength(0);
    expect(read<Charge>(CHARGES)[0]!.dueDate).toBe("2026-10-10");
  });

  it("refuses 1 or 25 installments, a bad date, a voided, a fully paid and an unknown charge", () => {
    student("S0001", "Ali Valiyev");
    charge("C0001", "S0001", 600_000, "2026-10-10");
    expect(() => plans.createPaymentPlan("C0001", 1, "2026-12-10")).toThrow("2 dan 24");
    expect(() => plans.createPaymentPlan("C0001", 25, "2026-12-10")).toThrow("2 dan 24");
    expect(() => plans.createPaymentPlan("C0001", 3, "2026-13-40")).toThrow("Sana noto'g'ri");
    expect(() => plans.createPaymentPlan("C0099", 3, "2026-12-10")).toThrow("topilmadi");
    h.sheets.get(CHARGES.sheet)!.data[1]![7] = "Ha"; // voided
    expect(() => plans.createPaymentPlan("C0001", 3, "2026-12-10")).toThrow("Bekor qilingan");
    h.sheets.get(CHARGES.sheet)!.data[1]![7] = "";
    pay("P0001", "S0001", 600_000);
    expect(() => plans.createPaymentPlan("C0001", 3, "2026-12-10")).toThrow("to'liq to'langan");
    expect(installments()).toHaveLength(0);
  });

  it("replaces an existing plan and keeps the money already paid", () => {
    student("S0001", "Ali Valiyev");
    charge("C0001", "S0001", 900_000, "2026-09-21");
    plan("C0001", [[300_000, "2026-09-21"], [300_000, "2026-10-21"], [300_000, "2026-12-21"]]);
    pay("P0001", "S0001", 450_000);
    plans.createPaymentPlan("C0001", 2, "2026-12-01");
    expect(installments().map((i) => [i.seq, i.dueDate, i.amount])).toEqual([[1, "2026-12-01", 450_000], [2, "2027-01-01", 450_000]]);
    expect(h.alerts.at(-1)!.message).toContain("Eski reja almashtiriladi");
    actions.refreshDebtors();
    const row = debtorRow("S0001");
    expect([row[5], row[6]]).toEqual([450_000, 0]); // outstanding 450 000, nothing overdue any more
  });

  it("removing a plan returns the charge to its single due date", () => {
    student("S0001", "Ali Valiyev");
    charge("C0001", "S0001", 600_000, "2026-10-21");
    plan("C0001", [[300_000, "2026-10-21"], [300_000, "2026-12-21"]]);
    plans.removePlan("C0001");
    expect(installments()).toHaveLength(0);
    expect(() => plans.removePlan("C0001")).toThrow("reja yo'q");
    actions.refreshDebtors();
    expect(debtorRow("S0001")[6]).toBe(600_000);
  });
});

describe("debt and reports follow the installments", () => {
  it("the debtors sheet counts only the overdue installments", () => {
    student("S0001", "Ali Valiyev");
    charge("C0001", "S0001", 900_000, "2026-09-21");
    plan("C0001", [[300_000, "2026-09-21"], [300_000, "2026-10-21"], [300_000, "2026-12-21"]]);
    pay("P0001", "S0001", 450_000);
    actions.refreshDebtors();
    const row = debtorRow("S0001");
    expect([row[5], row[6], row[7], row[8]]).toEqual([450_000, 150_000, "2026-10-21", 33]);
  });

  it("an invalid plan is ignored by the debt and reported by the check", () => {
    student("S0001", "Ali Valiyev");
    charge("C0001", "S0001", 900_000, "2026-09-21");
    plan("C0001", [[300_000, "2026-09-21"], [299_999, "2026-12-21"]]); // one so'm short
    actions.refreshDebtors();
    expect(debtorRow("S0001")[6]).toBe(900_000); // the charge's own due date rules
    expect(plans.checkPlans()).toContain("yig'indisi hisob summasiga teng emas");
  });

  it("works before the plan sheet exists (workbook set up by an older version)", () => {
    student("S0001", "Ali Valiyev");
    charge("C0001", "S0001", 500_000, "2026-10-10");
    h.sheets.delete(INSTALLMENTS.sheet);
    actions.refreshDebtors();
    expect(debtorRow("S0001")[6]).toBe(500_000);
  });

  it("the installment view shows paid, outstanding and a status per installment", () => {
    student("S0001", "Ali Valiyev");
    charge("C0001", "S0001", 900_000, "2026-09-21");
    plan("C0001", [[300_000, "2026-09-21"], [300_000, "2026-10-21"], [300_000, "2026-12-21"]]);
    pay("P0001", "S0001", 450_000);
    plans.openInstallments();
    const rows = h.rows(plans.VIEW_SHEET).slice(1);
    expect(rows.map((r) => [r[2], r[5], r[6], r[7]])).toEqual([
      ["1/3", 300_000, 0, "To'langan"], ["2/3", 150_000, 150_000, "Muddati o'tgan"], ["3/3", 0, 300_000, "Kutilmoqda"],
    ]);
  });
});

describe("reminder drafts follow the installment", () => {
  it("drafts an overdue installment and, separately, one due soon; never sends anything", () => {
    student("S0001", "Ali Valiyev");
    student("S0002", "Vali Aliyev");
    charge("C0001", "S0001", 900_000, "2026-09-21");
    plan("C0001", [[300_000, "2026-09-21"], [300_000, "2026-10-21"], [300_000, "2026-12-21"]]);
    pay("P0001", "S0001", 450_000);
    charge("C0002", "S0002", 600_000, "2026-11-20");
    plan("C0002", [[300_000, "2026-11-20"], [300_000, "2026-11-25"]]);
    pay("P0002", "S0002", 300_000);
    actions.createReminderDrafts();
    const drafts = read<ReminderDraft>(DRAFTS);
    expect(drafts.map((d) => [d.studentId, d.status])).toEqual([["S0001", "pending"], ["S0002", "pending"]]);
    for (const needle of ["2/3", "150 000", "21.10.2026"]) expect(drafts[0]!.text).toContain(needle);
    for (const needle of ["2/2", "300 000", "25.11.2026", "2 kun"]) expect(drafts[1]!.text).toContain(needle);
    expect(h.fetches).toHaveLength(0);
  });

  it("the advance reminder can be switched off with 0 and respects consent", () => {
    student("S0002", "Vali Aliyev", "555", false);
    charge("C0002", "S0002", 600_000, "2026-11-20");
    plan("C0002", [[300_000, "2026-11-20"], [300_000, "2026-11-25"]]);
    pay("P0002", "S0002", 300_000);
    actions.createReminderDrafts();
    expect(read<ReminderDraft>(DRAFTS)).toHaveLength(0); // no consent
    setSetting("Qism haqida oldindan eslatma (kun)", "0");
    student("S0003", "Karim Aliyev");
    charge("C0003", "S0003", 600_000, "2026-11-20");
    plan("C0003", [[300_000, "2026-11-20"], [300_000, "2026-11-25"]]);
    pay("P0003", "S0003", 300_000);
    actions.createReminderDrafts();
    expect(read<ReminderDraft>(DRAFTS)).toHaveLength(0);
    setSetting("Qism haqida oldindan eslatma (kun)", "3");
    actions.createReminderDrafts();
    expect(read<ReminderDraft>(DRAFTS).map((d) => d.studentId)).toEqual(["S0003"]);
    actions.createReminderDrafts(); // cooldown: the same student is not drafted twice
    expect(read<ReminderDraft>(DRAFTS)).toHaveLength(1);
    void read<Payment>(PAYMENTS);
  });
});
