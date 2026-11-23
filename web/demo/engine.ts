import { computeDebts, debtors, type StudentDebt } from "@domain/debt";
import { nextIds } from "@domain/ids";
import { reminderRich, type OpenCharge } from "@domain/messages";
import { collectedTuition, computePayroll, heldLessons, type PayrollResult } from "@domain/payroll";
import { DEFAULT_TEMPLATE, planReminders, type SkipReason } from "@domain/reminders";
import type { ReminderDraft } from "@domain/types";
import { DEMO_MONTH, DEMO_TODAY, seedData, type DemoData } from "./seed";

export { DEMO_TODAY } from "./seed";

export type AttendanceStatus = "present" | "late" | "absent";

export interface DemoState extends DemoData {
  drafts: ReminderDraft[];
  skipped: { studentId: string; reason: SkipReason }[];
}

const MAX_PAYMENT = 1_000_000_000;
const CENTER = "Namuna markaz";

export function seedState(): DemoState {
  return { ...seedData(), drafts: [], skipped: [] };
}

function debts(s: DemoState) {
  return computeDebts(s.charges, s.payments, DEMO_TODAY);
}

export function debtOf(s: DemoState, studentId: string): StudentDebt {
  return (
    debts(s).students.find((d) => d.studentId === studentId) ?? {
      studentId,
      charged: 0,
      paid: 0,
      outstanding: 0,
      overdue: 0,
      credit: 0,
      oldestDue: "",
      maxDaysOverdue: 0,
      openCharges: 0,
    }
  );
}

export function openCharges(s: DemoState, studentId: string): OpenCharge[] {
  return debts(s)
    .balances.filter((b) => b.studentId === studentId && b.outstanding > 0)
    .map((b) => ({ month: b.month, dueDate: b.dueDate, outstanding: b.outstanding }))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
}

export function markAttendance(
  s: DemoState,
  date: string,
  groupId: string,
  studentId: string,
  status: AttendanceStatus,
): DemoState {
  const row = { date, groupId, studentId, status, minutesLate: status === "late" ? 10 : 0 };
  const i = s.attendance.findIndex((a) => a.date === date && a.groupId === groupId && a.studentId === studentId);
  const attendance = i >= 0 ? s.attendance.map((a, k) => (k === i ? row : a)) : [...s.attendance, row];
  return { ...s, attendance };
}

export function addPayment(
  s: DemoState,
  studentId: string,
  amount: number,
  method: string,
): { state: DemoState; error?: "invalid_amount" } {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PAYMENT || !s.students.some((x) => x.id === studentId)) {
    return { state: s, error: "invalid_amount" };
  }
  const [id] = nextIds(
    "P",
    s.payments.map((p) => p.id),
    1,
  );
  const payment = { id: id!, studentId, paidOn: DEMO_TODAY, amount: Math.round(amount), method, voided: false, note: "" };
  return { state: { ...s, payments: [...s.payments, payment] } };
}

export function prepareReminders(s: DemoState): DemoState {
  const d = debts(s);
  const plan = planReminders({
    debtors: debtors(d.students),
    students: s.students,
    drafts: s.drafts,
    today: DEMO_TODAY,
    cooldownDays: 7,
    minOverdueSom: 1,
    template: DEFAULT_TEMPLATE,
    centerName: CENTER,
  });
  const ids = nextIds(
    "D",
    s.drafts.map((x) => x.id),
    plan.drafts.length,
  );
  const added: ReminderDraft[] = plan.drafts.map((x, i) => ({
    id: ids[i]!,
    studentId: x.studentId,
    createdOn: DEMO_TODAY,
    text: x.text,
    status: "pending",
    error: "",
  }));
  return { ...s, drafts: [...s.drafts, ...added], skipped: plan.skipped };
}

export function approve(s: DemoState, draftId: string): DemoState {
  if (!s.drafts.some((d) => d.id === draftId && d.status === "pending")) return s;
  return { ...s, drafts: s.drafts.map((d) => (d.id === draftId ? { ...d, status: "sent" as const } : d)) };
}

/** The rich Telegram message a guardian would get; null until the owner approved the draft. */
export function messageFor(s: DemoState, draftId: string): string | null {
  const d = s.drafts.find((x) => x.id === draftId);
  if (!d || d.status !== "sent") return null;
  return reminderRich({ text: d.text, studentId: d.studentId, charges: openCharges(s, d.studentId), payInfo: "" });
}

export function payrollOf(s: DemoState, teacherId: string): PayrollResult {
  const teacher = s.teachers.find((t) => t.id === teacherId)!;
  const groupIds = new Set(s.groups.filter((g) => g.teacherId === teacherId).map((g) => g.id));
  return computePayroll(teacher, DEMO_MONTH, {
    heldLessons: heldLessons(s.attendance, groupIds, DEMO_MONTH),
    collectedTuition: collectedTuition(debts(s).balances, s.enrollments, s.groups, teacherId, DEMO_MONTH),
  });
}
