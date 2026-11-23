import { daysBetween } from "./dates";
import type { StudentDebt } from "./debt";
import type { ISODate, ReminderDraft, Student } from "./types";

export const DEFAULT_TEMPLATE =
  "Assalomu alaykum, {guardian}! {student} uchun {amount} so'm to'lov muddati {days} kun oldin o'tgan. " +
  "Iltimos, to'lovni amalga oshiring. Savollar bo'lsa, markazga murojaat qiling. {center}";

export function formatSom(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? vars[key]! : m));
}

export type SkipReason = "no_consent" | "no_chat" | "cooldown" | "below_threshold" | "student_inactive";

export interface ReminderPlan {
  drafts: { studentId: string; text: string }[];
  skipped: { studentId: string; reason: SkipReason }[];
}

/**
 * Reminder DRAFTS for debtors. Nothing is sent from here: a human approves each draft (Model B of nazoratly).
 * Skipped: no consent, no linked Telegram chat, student left/paused, debt below the threshold, or a reminder was
 * already drafted/sent within `cooldownDays`.
 */
export function planReminders(args: {
  debtors: StudentDebt[];
  students: Student[];
  drafts: ReminderDraft[];
  today: ISODate;
  cooldownDays: number;
  minOverdueSom: number;
  template: string;
  centerName: string;
}): ReminderPlan {
  const students = new Map(args.students.map((s) => [s.id, s]));
  const lastDraft = new Map<string, ISODate>();
  for (const d of args.drafts) {
    if (d.status === "rejected") continue;
    const prev = lastDraft.get(d.studentId);
    if (!prev || d.createdOn > prev) lastDraft.set(d.studentId, d.createdOn);
  }
  const plan: ReminderPlan = { drafts: [], skipped: [] };
  for (const debt of args.debtors) {
    const s = students.get(debt.studentId);
    if (!s || s.status === "left" || s.status === "paused") {
      plan.skipped.push({ studentId: debt.studentId, reason: "student_inactive" });
    } else if (debt.overdue < args.minOverdueSom) {
      plan.skipped.push({ studentId: s.id, reason: "below_threshold" });
    } else if (!s.consentNotify) {
      plan.skipped.push({ studentId: s.id, reason: "no_consent" });
    } else if (!s.guardianChatId) {
      plan.skipped.push({ studentId: s.id, reason: "no_chat" });
    } else {
      const last = lastDraft.get(s.id);
      if (last && daysBetween(last, args.today) < args.cooldownDays) {
        plan.skipped.push({ studentId: s.id, reason: "cooldown" });
      } else {
        plan.drafts.push({
          studentId: s.id,
          text: renderTemplate(args.template, {
            guardian: s.guardianName || "ota-ona",
            student: s.fullName,
            amount: formatSom(debt.overdue),
            days: String(debt.maxDaysOverdue),
            center: args.centerName,
          }),
        });
      }
    }
  }
  return plan;
}
