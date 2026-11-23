import { daysBetween } from "./dates";
import type { StudentDebt } from "./debt";
import { packageReminderText, type EnrollmentBalance } from "./packages";
import type { ISODate, ReminderDraft, Student } from "./types";

export const DEFAULT_TEMPLATE =
  "Assalomu alaykum, {guardian}! {student} uchun {amount} so'm to'lov muddati {days} kun oldin o'tgan. " +
  "Iltimos, to'lovni amalga oshiring. Savollar bo'lsa, markazga murojaat qiling. {center}";

export const INSTALLMENT_TEMPLATE =
  "Assalomu alaykum, {guardian}! {student} uchun {installment}-to'lov ({amount} so'm) muddati {due} edi ({days} kun o'tdi). " +
  "Jami muddati o'tgan qarz: {total} so'm. Iltimos, to'lovni amalga oshiring. Savollar bo'lsa, markazga murojaat qiling. {center}";

export const UPCOMING_TEMPLATE =
  "Assalomu alaykum, {guardian}! {student} uchun {installment}-to'lov ({amount} so'm) muddati {due} ({left}). " +
  "Iltimos, to'lovni o'z vaqtida amalga oshiring. Savollar bo'lsa, markazga murojaat qiling. {center}";

/** 2026-10-21 -> 21.10.2026 */
export const formatDmy = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export function formatSom(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? vars[key]! : m));
}

export type SkipReason = "no_consent" | "no_chat" | "cooldown" | "below_threshold" | "student_inactive" | "already_overdue";

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
  /** Used instead of `template` when the oldest debt of the student is an overdue installment of a payment plan. */
  installmentTemplate?: string;
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
        const ref = debt.overdueInstallment;
        plan.drafts.push({
          studentId: s.id,
          text: renderTemplate(ref && args.installmentTemplate ? args.installmentTemplate : args.template, {
            guardian: s.guardianName || "ota-ona",
            student: s.fullName,
            amount: formatSom(ref ? ref.outstanding : debt.overdue),
            total: formatSom(debt.overdue),
            days: String(debt.maxDaysOverdue),
            installment: ref ? `${ref.seq}/${ref.count}` : "",
            due: ref ? formatDmy(ref.dueDate) : "",
            center: args.centerName,
          }),
        });
      }
    }
  }
  return plan;
}

/**
 * Reminder DRAFTS ahead of an installment: the student's earliest open installment is due within `remindDays` days
 * (0 = off). Students who are already overdue get the overdue reminder instead; `exclude` holds the students that were
 * drafted in the same run. Same consent / chat / cooldown rules; nothing is sent from here (a human approves each draft).
 */
export function planUpcomingReminders(args: {
  debts: StudentDebt[];
  students: Student[];
  drafts: ReminderDraft[];
  today: ISODate;
  cooldownDays: number;
  remindDays: number;
  template: string;
  centerName: string;
  exclude: Set<string>;
}): ReminderPlan {
  const plan: ReminderPlan = { drafts: [], skipped: [] };
  if (args.remindDays <= 0) return plan;
  const students = new Map(args.students.map((s) => [s.id, s]));
  const lastDraft = new Map<string, ISODate>();
  for (const d of args.drafts) {
    if (d.status === "rejected") continue;
    const prev = lastDraft.get(d.studentId);
    if (!prev || d.createdOn > prev) lastDraft.set(d.studentId, d.createdOn);
  }
  for (const debt of args.debts) {
    const next = debt.nextInstallment;
    if (!next) continue;
    const left = daysBetween(args.today, next.dueDate);
    if (left < 0 || left > args.remindDays || args.exclude.has(debt.studentId)) continue;
    const s = students.get(debt.studentId);
    if (!s || s.status === "left" || s.status === "paused") plan.skipped.push({ studentId: debt.studentId, reason: "student_inactive" });
    else if (debt.overdue > 0) plan.skipped.push({ studentId: s.id, reason: "already_overdue" });
    else if (!s.consentNotify) plan.skipped.push({ studentId: s.id, reason: "no_consent" });
    else if (!s.guardianChatId) plan.skipped.push({ studentId: s.id, reason: "no_chat" });
    else {
      const last = lastDraft.get(s.id);
      if (last && daysBetween(last, args.today) < args.cooldownDays) plan.skipped.push({ studentId: s.id, reason: "cooldown" });
      else {
        plan.drafts.push({
          studentId: s.id,
          text: renderTemplate(args.template, {
            guardian: s.guardianName || "ota-ona",
            student: s.fullName,
            amount: formatSom(next.outstanding),
            installment: `${next.seq}/${next.count}`,
            due: formatDmy(next.dueDate),
            left: left === 0 ? "bugun" : `${left} kun qoldi`,
            center: args.centerName,
          }),
        });
      }
    }
  }
  return plan;
}

/**
 * Reminder DRAFTS for students whose lesson package is low, exhausted or in debt (negative lessons). Same consent / chat /
 * cooldown rules as every reminder; nothing is sent from here (a human approves each draft). One draft per student:
 * the worst of their package groups wins.
 */
export function planPackageReminders(args: {
  balances: EnrollmentBalance[];
  students: Student[];
  drafts: ReminderDraft[];
  today: ISODate;
  cooldownDays: number;
  centerName: string;
}): ReminderPlan {
  const rank = { debt: 0, exhausted: 1, low: 2, ok: 3 } as const;
  const students = new Map(args.students.map((s) => [s.id, s]));
  const lastDraft = new Map<string, ISODate>();
  for (const d of args.drafts) {
    if (d.status === "rejected") continue;
    const prev = lastDraft.get(d.studentId);
    if (!prev || d.createdOn > prev) lastDraft.set(d.studentId, d.createdOn);
  }
  const worst = new Map<string, EnrollmentBalance>();
  for (const b of args.balances) {
    if (b.need === "ok") continue;
    const cur = worst.get(b.studentId);
    if (!cur || rank[b.need] < rank[cur.need] || (b.need === cur.need && b.balance.balance < cur.balance.balance)) worst.set(b.studentId, b);
  }
  const plan: ReminderPlan = { drafts: [], skipped: [] };
  for (const [studentId, b] of worst) {
    const s = students.get(studentId);
    if (!s || s.status === "left" || s.status === "paused") plan.skipped.push({ studentId, reason: "student_inactive" });
    else if (!s.consentNotify) plan.skipped.push({ studentId, reason: "no_consent" });
    else if (!s.guardianChatId) plan.skipped.push({ studentId, reason: "no_chat" });
    else {
      const last = lastDraft.get(studentId);
      if (last && daysBetween(last, args.today) < args.cooldownDays) plan.skipped.push({ studentId, reason: "cooldown" });
      else plan.drafts.push({ studentId, text: packageReminderText({ need: b.need, guardian: s.guardianName || "ota-ona", student: s.fullName, balance: b.balance.balance, debtAmount: b.debtAmount, center: args.centerName }) });
    }
  }
  return plan;
}
