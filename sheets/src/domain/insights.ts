/**
 * Owner insights: debt follow-up order and tone with draft texts, churn-risk score, weekly summary lines. Pure
 * functions, mirrored in Python (backend/src/nazoratly/rules/insights.py); both are checked against the same cases in
 * tests/golden/insights.json. Money is whole so'm. Every result is a suggestion for a person: nothing here sends,
 * bills or changes anything. The Sheets edition has no AI (Apps Script cannot reach the host worker), so these texts
 * are the report.
 */
import { daysBetween } from "./dates";
import type { ISODate } from "./types";

export const RECENT_MIN_LESSONS = 2; // an attendance rate needs at least this many marked lessons in the window
export const HIGH_RISK = 60;
export const MEDIUM_RISK = 30;
const SOFT_MAX_DAYS = 7;
const FIRM_MAX_DAYS = 30;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 12345678 -> "12 345 678"; negatives keep the sign in front. */
export function fmtMoney(n: number): string {
  const digits = String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return n < 0 ? `-${digits}` : digits;
}

/** round(numerator / denominator) half up, for numerator >= 0 and denominator > 0, integers only. */
const halfUp = (numerator: number, denominator: number): number => Math.floor((2 * numerator + denominator) / (2 * denominator));

/** Attendance percent; null when fewer than RECENT_MIN_LESSONS lessons were marked (too little to judge). */
export function rate(attended: number, marked: number): number | null {
  return marked < RECENT_MIN_LESSONS ? null : halfUp(attended * 100, marked);
}

/** Attendance percent of a whole week; null when nothing was marked. */
export function weekRate(attended: number, marked: number): number | null {
  return marked <= 0 ? null : halfUp(attended * 100, marked);
}

// ---- debt follow-up
export type DebtTone = "reminder" | "soft" | "firm" | "final";

export interface DebtFact {
  id: string;
  outstanding: number;
  overdue: number;
  /** due date of the oldest unpaid charge or installment, "" when nothing is unpaid */
  oldestDue: ISODate | "";
}

export interface DebtItem {
  id: string;
  outstanding: number;
  overdue: number;
  ageDays: number;
  tone: DebtTone;
  score: number;
}

export function debtAgeDays(overdue: number, oldestDue: ISODate | "", today: ISODate): number {
  if (overdue <= 0 || oldestDue === "") return 0;
  return Math.max(0, daysBetween(oldestDue, today));
}

export function debtTone(overdue: number, ageDays: number): DebtTone {
  if (overdue <= 0) return "reminder";
  if (ageDays <= SOFT_MAX_DAYS) return "soft";
  if (ageDays <= FIRM_MAX_DAYS) return "firm";
  return "final";
}

/** The draft a person may send to the guardian. No penalty and no threat: only a request and an offer to talk. */
export function debtMessage(tone: DebtTone, name: string, amount: number, days: number): string {
  const money = fmtMoney(amount);
  switch (tone) {
    case "reminder":
      return `Assalomu alaykum! ${name} uchun ${money} so'm to'lov muddati yaqinlashmoqda. Qulay vaqtda to'lab qo'ysangiz, minnatdor bo'lamiz.`;
    case "soft":
      return `Assalomu alaykum! ${name} uchun ${money} so'm to'lov muddati o'tib ketdi. Iltimos, yaqin kunlarda to'lab qo'ying. Savolingiz bo'lsa, yozing.`;
    case "firm":
      return `Assalomu alaykum! ${name} uchun ${money} so'm qarz ${days} kundan beri to'lanmagan. Iltimos, shu hafta ichida to'lang yoki to'lov kunini bizga ayting.`;
    default:
      return `Assalomu alaykum! ${name} uchun ${money} so'm qarz ${days} kundan beri to'lanmagan. Iltimos, biz bilan bog'laning: to'lov rejasini birga kelishib olamiz.`;
  }
}

/** Students with an open amount, most urgent first. score = min(60, 2 * age) + min(40, outstanding div 100000). */
export function debtFollowup(students: DebtFact[], today: ISODate): DebtItem[] {
  const items: DebtItem[] = [];
  for (const s of students) {
    if (s.outstanding <= 0) continue;
    const ageDays = debtAgeDays(s.overdue, s.oldestDue, today);
    items.push({
      id: s.id,
      outstanding: s.outstanding,
      overdue: s.overdue,
      ageDays,
      tone: debtTone(s.overdue, ageDays),
      score: Math.min(60, 2 * ageDays) + Math.min(40, Math.floor(s.outstanding / 100_000)),
    });
  }
  return items.sort((a, b) => b.score - a.score || cmp(a.id, b.id));
}

// ---- churn risk
export type RiskLevel = "high" | "medium";
export type RiskReason = "attendance_drop" | "debt" | "trial_no_answer";

export interface RiskFact {
  id: string;
  attendedRecent: number;
  markedRecent: number;
  attendedPrev: number;
  markedPrev: number;
  /** 0 = nothing overdue */
  overdueAgeDays: number;
  /** null = not on an undecided trial; else days past the trial limit (>= 0) */
  trialDaysOver: number | null;
}

export interface RiskItem {
  id: string;
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
  attendanceRecent: number | null;
  attendancePrev: number | null;
}

/** Medium and high risk students, highest score first. Points: attendance fall (up to 40), debt age (up to 30), undecided trial (10 + 5 per day over, up to 30). */
export function churnRisk(students: RiskFact[]): RiskItem[] {
  const items: RiskItem[] = [];
  for (const s of students) {
    const recent = rate(s.attendedRecent, s.markedRecent);
    const prev = rate(s.attendedPrev, s.markedPrev);
    const attPoints = recent !== null && prev !== null && prev > recent ? Math.min(40, prev - recent) : 0;
    const debtPoints = Math.min(30, Math.max(0, s.overdueAgeDays));
    const trialPoints = s.trialDaysOver === null ? 0 : 10 + Math.min(20, 5 * Math.max(0, s.trialDaysOver));
    const score = Math.min(100, attPoints + debtPoints + trialPoints);
    const level: RiskLevel | null = score >= HIGH_RISK ? "high" : score >= MEDIUM_RISK ? "medium" : null;
    if (level === null) continue;
    const reasons: RiskReason[] = [];
    if (attPoints >= 10) reasons.push("attendance_drop");
    if (debtPoints > 0) reasons.push("debt");
    if (s.trialDaysOver !== null) reasons.push("trial_no_answer");
    items.push({ id: s.id, score, level, reasons, attendanceRecent: recent, attendancePrev: prev });
  }
  return items.sort((a, b) => b.score - a.score || cmp(a.id, b.id));
}

// ---- report lines (the rule-based text of the debt and risk reports)
const TONE_LABEL: Record<DebtTone, string> = { reminder: "eslatma", soft: "yumshoq", firm: "qat'iy", final: "so'nggi" };
const LEVEL_LABEL: Record<RiskLevel, string> = { high: "yuqori", medium: "o'rta" };
const REASON_TEXT: Record<RiskReason, string> = { attendance_drop: "davomat pasaygan", debt: "qarzi muddati o'tgan", trial_no_answer: "sinovdan keyin javob yo'q" };

export const debtLine = (rank: number, name: string, outstanding: number, ageDays: number, tone: DebtTone): string => `${rank}. ${name}: ${fmtMoney(outstanding)} so'm, ${ageDays} kun, ohang: ${TONE_LABEL[tone]}.`;

export const riskLine = (rank: number, name: string, score: number, level: RiskLevel, reasons: RiskReason[]): string =>
  `${rank}. ${name}: xavf balli ${score} (${LEVEL_LABEL[level]}); sabab: ${reasons.map((r) => REASON_TEXT[r]).join(", ")}.`;

// ---- weekly summary
export interface WeekFacts {
  income: number;
  incomePrev: number;
  expenses: number;
  newStudents: number;
  leftStudents: number;
  unpaid: number;
  unpaidTotal: number;
  overdue: number;
  attended: number;
  marked: number;
  attendedPrev: number;
  markedPrev: number;
  highRisk: number;
  mediumRisk: number;
}

export interface WeeklySummary {
  income: number;
  incomePrev: number;
  incomeChangePercent: number | null;
  expenses: number;
  net: number;
  newStudents: number;
  leftStudents: number;
  unpaid: number;
  unpaidTotal: number;
  overdue: number;
  attendancePercent: number | null;
  attendancePrevPercent: number | null;
  highRisk: number;
  mediumRisk: number;
  lines: string[];
}

/** Signed percent change, null when there is no earlier value to compare with. */
export function changePercent(now: number, before: number): number | null {
  if (before <= 0) return null;
  const magnitude = halfUp(Math.abs(now - before) * 100, before);
  return now >= before ? magnitude : -magnitude;
}

export function weeklySummary(f: WeekFacts): WeeklySummary {
  const change = changePercent(f.income, f.incomePrev);
  const att = weekRate(f.attended, f.marked);
  const attPrev = weekRate(f.attendedPrev, f.markedPrev);
  const net = f.income - f.expenses;
  const compare = change === null || change === 0 ? "" : `, ${change > 0 ? "+" : "-"}${Math.abs(change)}%`;
  const lines = [
    `Tushum: ${fmtMoney(f.income)} so'm (o'tgan hafta: ${fmtMoney(f.incomePrev)} so'm${compare}).`,
    `Xarajat: ${fmtMoney(f.expenses)} so'm; sof natija: ${fmtMoney(net)} so'm.`,
    `Yangi o'quvchilar: ${f.newStudents}, ketganlar: ${f.leftStudents}.`,
    `Qarzdorlar: ${f.unpaid} ta, jami ${fmtMoney(f.unpaidTotal)} so'm, shundan muddati o'tgan: ${f.overdue} ta.`,
  ];
  if (att === null) lines.push("Davomat: bu hafta belgilangan dars yo'q.");
  else if (attPrev === null) lines.push(`Davomat: ${att}%.`);
  else lines.push(`Davomat: ${att}% (o'tgan hafta: ${attPrev}%).`);
  lines.push(`Ketish xavfi ostidagi o'quvchilar: yuqori ${f.highRisk}, o'rta ${f.mediumRisk}.`);
  return {
    income: f.income,
    incomePrev: f.incomePrev,
    incomeChangePercent: change,
    expenses: f.expenses,
    net,
    newStudents: f.newStudents,
    leftStudents: f.leftStudents,
    unpaid: f.unpaid,
    unpaidTotal: f.unpaidTotal,
    overdue: f.overdue,
    attendancePercent: att,
    attendancePrevPercent: attPrev,
    highRisk: f.highRisk,
    mediumRisk: f.mediumRisk,
    lines,
  };
}
