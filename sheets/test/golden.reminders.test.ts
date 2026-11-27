import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { debtors, type InstallmentRef, type StudentDebt } from "../src/domain/debt";
import { DEFAULT_TEMPLATE, INSTALLMENT_TEMPLATE, planReminders, planUpcomingReminders, UPCOMING_TEMPLATE } from "../src/domain/reminders";
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
