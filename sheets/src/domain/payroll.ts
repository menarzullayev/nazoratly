import { inMonth } from "./dates";
import type { AttendanceRow, Enrollment, Group, ISODate, Teacher } from "./types";
import type { ChargeBalance } from "./debt";

export interface PayrollLine {
  kind: "base" | "lesson";
  amount: number;
  description: string;
}

export interface PayrollResult {
  teacherId: string;
  month: ISODate;
  lines: PayrollLine[];
  total: number;
  heldLessons: number;
  collectedTuition: number;
}

/** A lesson is a distinct (date, group) that has at least one attendance mark. */
export function heldLessons(attendance: AttendanceRow[], groupIds: Set<string>, month: ISODate): number {
  const seen = new Set<string>();
  for (const a of attendance) if (groupIds.has(a.groupId) && inMonth(a.date, month)) seen.add(`${a.date}|${a.groupId}`);
  return seen.size;
}

/** Tuition actually collected in the month for the teacher's groups (paid part of the month's tuition charges). */
export function collectedTuition(
  balances: ChargeBalance[],
  enrollments: Enrollment[],
  groups: Group[],
  teacherId: string,
  month: ISODate,
): number {
  const groupIds = new Set(groups.filter((g) => g.teacherId === teacherId).map((g) => g.id));
  const enrollmentIds = new Set(enrollments.filter((e) => groupIds.has(e.groupId)).map((e) => e.id));
  return balances.filter((b) => b.month === month && enrollmentIds.has(b.enrollmentId)).reduce((s, b) => s + b.paid, 0);
}

export function computePayroll(
  teacher: Teacher,
  month: ISODate,
  ctx: { heldLessons: number; collectedTuition: number },
): PayrollResult {
  const lines: PayrollLine[] = [];
  const rate = teacher.payRate;
  if (rate > 0) {
    if (teacher.payModel === "fixed") {
      lines.push({ kind: "base", amount: rate, description: `Qat'iy oylik ${month.slice(0, 7)}` });
    } else if (teacher.payModel === "per_lesson") {
      for (let i = 1; i <= ctx.heldLessons; i++) lines.push({ kind: "lesson", amount: rate, description: `Dars #${i}` });
    } else {
      const share = Math.round((ctx.collectedTuition * rate) / 100);
      if (share > 0) {
        lines.push({
          kind: "base",
          amount: share,
          description: `${rate}% (yig'ilgan ${ctx.collectedTuition}) ${month.slice(0, 7)}`,
        });
      }
    }
  }
  return {
    teacherId: teacher.id,
    month,
    lines,
    total: lines.reduce((s, l) => s + l.amount, 0),
    heldLessons: ctx.heldLessons,
    collectedTuition: ctx.collectedTuition,
  };
}
