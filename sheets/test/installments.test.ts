import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeDebts, debtors } from "../src/domain/debt";
import { planReminders, planUpcomingReminders, DEFAULT_TEMPLATE, INSTALLMENT_TEMPLATE, UPCOMING_TEMPLATE } from "../src/domain/reminders";
import type { Charge, Installment, Payment, ReminderDraft, Student } from "../src/domain/types";

type Row = { amount: string; due_date: string };
type Golden = {
  balances: { name: string; in: { installments: Row[]; paid: string; today: string }; out: { rows: { outstanding: string }[]; overdue: string; next_open_due: string | null } }[];
};
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/installments.json", import.meta.url), "utf8")) as Golden;

const charge = (over: Partial<Charge> = {}): Charge => ({ id: "C0001", studentId: "S0001", enrollmentId: "E0001", month: "2026-10-01", amount: 900_000, dueDate: "2026-09-21", voided: false, note: "", ...over });
const pay = (amount: number, over: Partial<Payment> = {}): Payment => ({ id: "P0001", studentId: "S0001", paidOn: "2026-11-01", amount, method: "Naqd", voided: false, note: "", ...over });
const plan = (chargeId: string, rows: [number, string][]): Installment[] => rows.map(([amount, dueDate], i) => ({ chargeId, seq: i + 1, dueDate, amount }));
const THREE = plan("C0001", [[300_000, "2026-09-21"], [300_000, "2026-10-21"], [300_000, "2026-12-21"]]); // today 2026-11-23: 1st and 2nd are past

describe("debt per installment", () => {
  it("replays the shared golden balances through computeDebts (same numbers as the API)", () => {
    for (const c of golden.balances) {
      const total = c.in.installments.reduce((s, r) => s + Number(r.amount), 0);
      const inst = c.in.installments.map((r, i) => ({ chargeId: "C0001", seq: i + 1, dueDate: r.due_date, amount: Number(r.amount) }));
      const { students, balances } = computeDebts([charge({ amount: total, dueDate: inst[0]!.dueDate })], [pay(Number(c.in.paid))], c.in.today, inst);
      const s = students[0]!;
      expect(s.overdue, c.name).toBe(Number(c.out.overdue));
      expect(s.outstanding, c.name).toBe(c.out.rows.reduce((n, r) => n + Number(r.outstanding), 0));
      expect(s.oldestDue, c.name).toBe(c.out.next_open_due ?? "");
      expect(balances[0]!.overdue, c.name).toBe(Number(c.out.overdue));
    }
  });

  it("only the overdue installments are overdue; days count from the earliest open installment", () => {
    const { students } = computeDebts([charge()], [pay(450_000)], "2026-11-23", THREE);
    const s = students[0]!;
    expect([s.outstanding, s.overdue, s.oldestDue, s.maxDaysOverdue]).toEqual([450_000, 150_000, "2026-10-21", 33]);
    expect(s.overdueInstallment).toEqual({ chargeId: "C0001", seq: 2, count: 3, dueDate: "2026-10-21", outstanding: 150_000 });
    expect(s.nextInstallment).toEqual({ chargeId: "C0001", seq: 3, count: 3, dueDate: "2026-12-21", outstanding: 300_000 });
  });

  it("a plan whose installments do not add up to the charge is ignored", () => {
    const bad = plan("C0001", [[300_000, "2026-09-21"], [299_999, "2026-12-21"]]);
    const { students } = computeDebts([charge()], [], "2026-11-23", bad);
    expect(students[0]!.overdue).toBe(900_000); // falls back to the charge's own due date
    expect(students[0]!.overdueInstallment).toBeNull();
  });

  it("a voided charge and a plan of another charge do not interfere; charges without a plan behave as before", () => {
    const other = charge({ id: "C0002", amount: 200_000, dueDate: "2026-11-01" });
    const { students } = computeDebts([charge({ voided: true }), other], [], "2026-11-23", [...THREE, ...plan("C0003", [[1, "2026-01-01"], [1, "2026-02-01"]])]);
    expect([students[0]!.outstanding, students[0]!.overdue, students[0]!.oldestDue]).toEqual([200_000, 200_000, "2026-11-01"]);
  });

  it("FIFO between charges is by the charge due date (= first installment) and still spills over", () => {
    const planned = charge({ id: "C0001", amount: 600_000, dueDate: "2026-10-01" });
    const plain = charge({ id: "C0002", amount: 100_000, dueDate: "2026-11-01" });
    const inst = plan("C0001", [[300_000, "2026-10-01"], [300_000, "2026-12-01"]]);
    const { balances } = computeDebts([plain, planned], [pay(650_000)], "2026-11-23", inst);
    const byId = new Map(balances.map((b) => [b.id, b]));
    expect([byId.get("C0001")!.paid, byId.get("C0002")!.paid]).toEqual([600_000, 50_000]);
  });
});

const student: Student = { id: "S0001", fullName: "Ali Valiyev", status: "active", guardianName: "Dilnoza", guardianChatId: "555", consentNotify: true };
const base = { students: [student], drafts: [] as ReminderDraft[], today: "2026-11-23", cooldownDays: 7, minOverdueSom: 50_000, centerName: "Bilim" };

describe("reminders follow the installment", () => {
  it("an overdue installment is named in the draft with its number, due date and amount", () => {
    const { students: debts } = computeDebts([charge()], [pay(450_000)], "2026-11-23", THREE);
    const r = planReminders({ ...base, debtors: debtors(debts), template: DEFAULT_TEMPLATE, installmentTemplate: INSTALLMENT_TEMPLATE });
    expect(r.drafts).toHaveLength(1);
    const text = r.drafts[0]!.text;
    for (const needle of ["2/3", "150 000", "21.10.2026", "33", "Ali Valiyev", "Bilim"]) expect(text).toContain(needle);
  });

  it("a plain overdue charge still uses the ordinary template", () => {
    const { students: debts } = computeDebts([charge()], [], "2026-11-23");
    const r = planReminders({ ...base, debtors: debtors(debts), template: DEFAULT_TEMPLATE, installmentTemplate: INSTALLMENT_TEMPLATE });
    expect(r.drafts[0]!.text).toContain("900 000");
    expect(r.drafts[0]!.text).not.toContain("1/");
  });

  it("an installment due within the window is announced; one further away or already overdue is not", () => {
    const soon = plan("C0001", [[300_000, "2026-11-20"], [300_000, "2026-11-25"], [300_000, "2026-12-25"]]); // 1st paid, 2nd in 2 days
    const { students: debts } = computeDebts([charge({ dueDate: "2026-11-20" })], [pay(300_000)], "2026-11-23", soon);
    const r = planUpcomingReminders({ ...base, debts, remindDays: 3, template: UPCOMING_TEMPLATE, exclude: new Set() });
    expect(r.drafts).toHaveLength(1);
    for (const needle of ["2/3", "300 000", "25.11.2026", "2 kun"]) expect(r.drafts[0]!.text).toContain(needle);
    expect(planUpcomingReminders({ ...base, debts, remindDays: 1, template: UPCOMING_TEMPLATE, exclude: new Set() }).drafts).toHaveLength(0);
    expect(planUpcomingReminders({ ...base, debts, remindDays: 0, template: UPCOMING_TEMPLATE, exclude: new Set() }).drafts).toHaveLength(0); // 0 = off
    const late = computeDebts([charge({ dueDate: "2026-11-20" })], [], "2026-11-23", soon).students; // 1st installment overdue
    expect(planUpcomingReminders({ ...base, debts: late, remindDays: 3, template: UPCOMING_TEMPLATE, exclude: new Set() }).skipped).toEqual([{ studentId: "S0001", reason: "already_overdue" }]);
  });

  it("consent, chat and cooldown rules apply to upcoming reminders too; nothing is sent from here", () => {
    const soon = plan("C0001", [[300_000, "2026-11-20"], [300_000, "2026-11-25"], [300_000, "2026-12-25"]]);
    const { students: debts } = computeDebts([charge({ dueDate: "2026-11-20" })], [pay(300_000)], "2026-11-23", soon);
    const run = (s: Partial<Student>, drafts: ReminderDraft[] = []) => planUpcomingReminders({ ...base, students: [{ ...student, ...s }], drafts, debts, remindDays: 3, template: UPCOMING_TEMPLATE, exclude: new Set() });
    expect(run({ consentNotify: false }).skipped[0]!.reason).toBe("no_consent");
    expect(run({ guardianChatId: "" }).skipped[0]!.reason).toBe("no_chat");
    expect(run({ status: "left" }).skipped[0]!.reason).toBe("student_inactive");
    expect(run({}, [{ id: "R0001", studentId: "S0001", createdOn: "2026-11-20", text: "x", status: "sent", error: "" }]).skipped[0]!.reason).toBe("cooldown");
    expect(planUpcomingReminders({ ...base, debts, remindDays: 3, template: UPCOMING_TEMPLATE, exclude: new Set(["S0001"]) }).drafts).toHaveLength(0);
  });
});
