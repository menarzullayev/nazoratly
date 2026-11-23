import { monthStart, nextMonthStart, withDay } from "./dates";
import type { Charge, Enrollment, Group, ISODate, Student } from "./types";

export function effectiveFee(group: Group, enrollment: Enrollment): number {
  return Math.round(group.monthlyFee * (1 - enrollment.discountPercent / 100));
}

export interface PlannedCharge {
  studentId: string;
  enrollmentId: string;
  month: ISODate;
  amount: number;
  dueDate: ISODate;
  note: string;
}

export interface BillingPlan {
  month: ISODate;
  create: PlannedCharge[];
  skippedExisting: number;
  skippedZeroFee: number;
}

/**
 * Monthly tuition charges, same rules as the nazoratly API (/v1/charges/generate):
 * active or finished enrollments that overlap the month; frozen ones are not billed; cancelled groups and students
 * who left are skipped; full monthly fee (no proration); idempotent per enrollment + month.
 */
export function planCharges(args: {
  month: ISODate;
  dueDay: number;
  enrollments: Enrollment[];
  groups: Group[];
  students: Student[];
  charges: Charge[];
}): BillingPlan {
  if (!Number.isInteger(args.dueDay) || args.dueDay < 1 || args.dueDay > 28) throw new Error("dueDay must be 1..28");
  const first = monthStart(args.month);
  const next = nextMonthStart(first);
  const groups = new Map(args.groups.map((g) => [g.id, g]));
  const students = new Map(args.students.map((s) => [s.id, s]));
  const billed = new Set(args.charges.filter((c) => !c.voided && c.month === first).map((c) => c.enrollmentId));
  const plan: BillingPlan = { month: first, create: [], skippedExisting: 0, skippedZeroFee: 0 };
  for (const e of args.enrollments) {
    const g = groups.get(e.groupId);
    const s = students.get(e.studentId);
    if (!g || !s || g.status === "cancelled" || s.status === "left") continue;
    if (e.status === "frozen" || e.status === "trial") continue;
    // a trial that was accepted is billed for its first month at acceptance; the monthly run starts after that month
    if (e.acceptedOn && first <= monthStart(e.acceptedOn)) continue;
    if (!(e.startedOn < next && (e.endedOn === "" || e.endedOn >= first))) continue;
    const fee = effectiveFee(g, e);
    if (fee <= 0) {
      plan.skippedZeroFee++;
      continue;
    }
    if (billed.has(e.id)) {
      plan.skippedExisting++;
      continue;
    }
    plan.create.push({
      studentId: e.studentId,
      enrollmentId: e.id,
      month: first,
      amount: fee,
      dueDate: withDay(first, args.dueDay),
      note: `O'qish haqi ${first.slice(0, 7)}`,
    });
  }
  return plan;
}
