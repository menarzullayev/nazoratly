import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { debtors, type InstallmentRef, type StudentDebt } from "../src/domain/debt";
import { reminderRich, stripHtml } from "../src/domain/messages";
import { DEFAULT_TEMPLATE, INSTALLMENT_TEMPLATE, planPackageReminders, planReminders, planUpcomingReminders, UPCOMING_TEMPLATE } from "../src/domain/reminders";
import type { ReminderDraft, Student } from "../src/domain/types";

type Ref = { seq: number; count: number; due_date: string; outstanding: string } | null;
type Case = {
  name: string;
  in: {
    today: string; cooldown_days: number; min_overdue: string; remind_days: number; center: string; template: string | null;
    students: { id: string; name: string; status: string; guardian: string; has_chat: boolean; consent: boolean; last_reminded_on: string | null }[];
    debts: { student_id: string; overdue: string; max_days_overdue: number; overdue_installment: Ref; next_installment: Ref }[];
  };
  out: { drafts: { student_id: string; kind: string; text: string }[]; skipped: { student_id: string; reason: string }[] };
};
// The same file the Python suite reads (backend/tests/test_golden_reminders.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/reminders.json", import.meta.url), "utf8")) as { cases: Case[] };

const ref = (r: Ref): InstallmentRef | null => (r ? { chargeId: "c", seq: r.seq, count: r.count, dueDate: r.due_date, outstanding: Number(r.outstanding) } : null);

describe("golden: debt reminder drafts", () => {
  it("has enough cases", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(8);
  });
  it.each(golden.cases)("$name", (c) => {
    const students = c.in.students.map((s) => ({ id: s.id, fullName: s.name, status: s.status, guardianName: s.guardian, guardianChatId: s.has_chat ? "1" : "", consentNotify: s.consent })) as unknown as Student[];
    const drafts = c.in.students
      .filter((s) => s.last_reminded_on)
      .map((s) => ({ id: s.id, studentId: s.id, createdOn: s.last_reminded_on!, text: "", status: "sent", error: "" })) as ReminderDraft[];
    const debts = c.in.debts.map((d) => ({
      studentId: d.student_id, overdue: Number(d.overdue), maxDaysOverdue: d.max_days_overdue, overdueInstallment: ref(d.overdue_installment), nextInstallment: ref(d.next_installment),
    })) as StudentDebt[];
    const common = { students, drafts, today: c.in.today, cooldownDays: c.in.cooldown_days, centerName: c.in.center };
    const overdue = planReminders({ ...common, debtors: debtors(debts), minOverdueSom: Number(c.in.min_overdue), template: c.in.template ?? DEFAULT_TEMPLATE, installmentTemplate: INSTALLMENT_TEMPLATE });
    const upcoming = planUpcomingReminders({ ...common, debts, remindDays: c.in.remind_days, template: UPCOMING_TEMPLATE, exclude: new Set(overdue.drafts.map((d) => d.studentId)) });
    expect([
      ...overdue.drafts.map((d) => ({ student_id: d.studentId, kind: "overdue", text: d.text })),
      ...upcoming.drafts.map((d) => ({ student_id: d.studentId, kind: "upcoming", text: d.text })),
    ]).toEqual(c.out.drafts);
    expect([...overdue.skipped, ...upcoming.skipped].map((s) => ({ student_id: s.studentId, reason: s.reason }))).toEqual(c.out.skipped);
  });
});

// the message as it is sent: the approved text + what is owed now + the buttons (the server renders the same, see
// backend/tests/test_golden_reminders.py)
type MessageCase = {
  name: string;
  in: { text: string; paid_data: string; pay_info: string; charges: { month: string; due_date: string; outstanding: string }[] };
  out: { html: string; plain: string };
};
const messages = (golden as unknown as { messages: MessageCase[] }).messages;

describe("golden: the debt reminder as it is sent", () => {
  it("has the cases", () => {
    expect(messages.length).toBeGreaterThanOrEqual(4);
  });
  it.each(messages)("$name", (c) => {
    const html = reminderRich({
      text: c.in.text,
      studentId: c.in.paid_data.slice(2),
      charges: c.in.charges.map((x) => ({ month: x.month, dueDate: x.due_date, outstanding: Number(x.outstanding) })),
      payInfo: c.in.pay_info,
    });
    expect(html).toBe(c.out.html);
    expect(stripHtml(html)).toBe(c.out.plain);
  });
});

type PackageCase = {
  name: string;
  in: {
    today: string; cooldown_days: number; center: string;
    students: Case["in"]["students"];
    balances: { student_id: string; need: "ok" | "low" | "exhausted" | "debt"; balance: number; debt_amount: string }[];
  };
  out: { drafts: { student_id: string; text: string }[]; skipped: { student_id: string; reason: string }[] };
};
const packages = (golden as unknown as { packages: PackageCase[] }).packages;

describe("golden: lesson package reminder drafts", () => {
  it.each(packages)("$name", (c) => {
    const students = c.in.students.map((s) => ({ id: s.id, fullName: s.name, status: s.status, guardianName: s.guardian, guardianChatId: s.has_chat ? "1" : "", consentNotify: s.consent })) as unknown as Student[];
    const drafts = c.in.students
      .filter((s) => s.last_reminded_on)
      .map((s) => ({ id: s.id, studentId: s.id, createdOn: s.last_reminded_on!, text: "", status: "sent", error: "" })) as ReminderDraft[];
    const balances = c.in.balances.map((b) => ({ studentId: b.student_id, need: b.need, debtAmount: Number(b.debt_amount), balance: { balance: b.balance } })) as unknown as Parameters<typeof planPackageReminders>[0]["balances"];
    const plan = planPackageReminders({ balances, students, drafts, today: c.in.today, cooldownDays: c.in.cooldown_days, centerName: c.in.center });
    expect(plan.drafts.map((d) => ({ student_id: d.studentId, text: d.text }))).toEqual(c.out.drafts);
    expect(plan.skipped.map((s) => ({ student_id: s.studentId, reason: s.reason }))).toEqual(c.out.skipped);
  });
});
