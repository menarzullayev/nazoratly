import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { monthlyFinance, paymentStatus, studentMovement, waitingItems } from "../src/domain/dashboard";

type G = {
  payment_status: { name: string; in: { students: { id: string; outstanding: string; overdue: string; package_debt_lessons: number }[] }; out: unknown }[];
  student_movement: {
    name: string;
    in: { range: { from: string; to: string }; enrollments: { student: string; status: "trial" | "active" | "frozen" | "finished"; started_on: string; accepted_on: string | null; ended_on: string | null; dropped_trial: boolean }[] };
    out: unknown;
  }[];
  monthly_finance: {
    name: string;
    in: { today: string; payments: { on: string; amount: string }[]; expenses: { on: string; amount: string }[]; payroll: { month: string; amount: string }[] };
    out: unknown;
  }[];
  waiting: {
    name: string;
    in: {
      today: string;
      window_days: number;
      free_lessons: number;
      free_days: number;
      makeup_lapses: boolean;
      trials: { id: string; started_on: string; lessons_attended: number }[];
      packages: { id: string; available: number; next_expiry: string | null }[];
      rights: { id: string; kind: "makeup" | "credit"; status: "open" | "scheduled" | "used" | "cancelled"; expires_on: string }[];
    };
    out: unknown;
  }[];
};
// The same file the Python suite reads (backend/tests/test_golden_dashboard.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/dashboard.json", import.meta.url), "utf8")) as G;

describe("golden: dashboard rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(45);
  });
  it.each(golden.payment_status)("paymentStatus: $name", (c) => {
    const got = paymentStatus(c.in.students.map((s) => ({ id: s.id, outstanding: Number(s.outstanding), overdue: Number(s.overdue), packageDebtLessons: s.package_debt_lessons })));
    const out = c.out as { paid: number; unpaid: number; overdue: number; unpaid_students: { id: string; outstanding: number; overdue: number; package_debt_lessons: number }[]; paid_ids: string[] };
    expect(got).toEqual({
      paid: out.paid,
      unpaid: out.unpaid,
      overdue: out.overdue,
      unpaidStudents: out.unpaid_students.map((s) => ({ id: s.id, outstanding: s.outstanding, overdue: s.overdue, packageDebtLessons: s.package_debt_lessons })),
      paidIds: out.paid_ids,
    });
  });
  it.each(golden.student_movement)("studentMovement: $name", (c) => {
    const got = studentMovement(
      c.in.enrollments.map((e) => ({ student: e.student, status: e.status, startedOn: e.started_on, acceptedOn: e.accepted_on ?? "", endedOn: e.ended_on ?? "", droppedTrial: e.dropped_trial })),
      { from: c.in.range.from, to: c.in.range.to },
    );
    const o = c.out as Record<string, unknown>;
    expect(got).toEqual({ new: o.new, left: o.left, newIds: o.new_ids, leftIds: o.left_ids, trialsStarted: o.trials_started, accepted: o.accepted, dropped: o.dropped, running: o.running, conversion: o.conversion });
  });
  it.each(golden.monthly_finance)("monthlyFinance: $name", (c) => {
    const got = monthlyFinance({
      payments: c.in.payments.map((p) => ({ on: p.on, amount: Number(p.amount) })),
      expenses: c.in.expenses.map((p) => ({ on: p.on, amount: Number(p.amount) })),
      payroll: c.in.payroll.map((p) => ({ month: p.month, amount: Number(p.amount) })),
      today: c.in.today,
    });
    expect(got).toEqual(c.out);
  });
  it.each(golden.waiting)("waitingItems: $name", (c) => {
    const got = waitingItems({
      trials: c.in.trials.map((t) => ({ id: t.id, startedOn: t.started_on, lessonsAttended: t.lessons_attended })),
      packages: c.in.packages.map((p) => ({ id: p.id, available: p.available, nextExpiry: p.next_expiry })),
      rights: c.in.rights.map((r) => ({ id: r.id, kind: r.kind, status: r.status, expiresOn: r.expires_on })),
      today: c.in.today,
      windowDays: c.in.window_days,
      freeLessons: c.in.free_lessons,
      freeDays: c.in.free_days,
      makeupLapses: c.in.makeup_lapses,
    });
    const o = c.out as { trials: Record<string, unknown>[]; packages: Record<string, unknown>[]; rights: Record<string, unknown>[]; total: number };
    expect(got).toEqual({
      trials: o.trials.map((t) => ({ id: t.id, startedOn: t.started_on, lessonsAttended: t.lessons_attended, daysElapsed: t.days_elapsed, reason: t.reason })),
      packages: o.packages.map((p) => ({ id: p.id, available: p.available, nextExpiry: p.next_expiry, daysLeft: p.days_left })),
      rights: o.rights.map((r) => ({ id: r.id, expiresOn: r.expires_on, daysLeft: r.days_left })),
      total: o.total,
    });
  });
});
