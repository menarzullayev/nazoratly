/** Rule-based owner reports for the Sheets edition: weekly summary, debt follow-up advice (order, tone, draft text) and the
 * churn-risk list. The API product can also have these written by an AI worker; Apps Script cannot reach that host-side
 * worker, so here the report is exactly the rule-based text (same formulas as the API, tests/golden/insights.json).
 * Nothing here sends anything or changes data: the draft texts are for a person to read, edit and send. */
import { computeDebts } from "../domain/debt";
import { daysBetween, isIsoDate } from "../domain/dates";
import { studentMovement, type EnrollmentFact } from "../domain/dashboard";
import {
  RECENT_MIN_LESSONS,
  churnRisk,
  debtFollowup,
  debtLine,
  debtMessage,
  riskLine,
  weeklySummary,
  type DebtItem,
  type RiskFact,
  type RiskItem,
  type WeekFacts,
  type WeeklySummary,
} from "../domain/insights";
import { trialStatus } from "../domain/lifecycle";
import type { AttendanceRow, Charge, Enrollment, Expense, ISODate, Installment, Payment, Student } from "../domain/types";
import { lessonsAttended } from "./admission";
import { read, readIfPresent, today } from "./repo";
import { ATTENDANCE, CHARGES, ENROLLMENTS, EXPENSES, INSTALLMENTS, PAYMENTS, STUDENTS } from "./schema";
import { readSettings } from "./settings";

export const WEEK_SHEET = "Hisobot: haftalik xulosa";
export const DEBT_SHEET = "Hisobot: qarz bo'yicha maslahat";
export const RISK_SHEET = "Hisobot: ketish xavfi";
export const RISK_WINDOW_DAYS = 28;
export const LIST_LIMIT = 30; // students per list, as in the API
export const NOTE = "Qoidalar bo'yicha hisoblangan taklif (Sheets nusxasida sun'iy intellekt yo'q). Hech narsa yuborilmaydi: matnlarni odam o'qib, tahrirlab, o'zi yuboradi.";

const addDays = (iso: ISODate, days: number): ISODate => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days)).toISOString().slice(0, 10);
const valid = (d: string): boolean => d !== "" && isIsoDate(d);
const between = (d: string, fromExclusive: ISODate, toInclusive: ISODate): boolean => d > fromExclusive && d <= toInclusive;

/** A name typed by a user must never become a formula: a leading = + - @ is neutralised with an apostrophe. */
export const safeCell = (v: string | number): string | number => (typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v);

type Windows = Map<string, [number, number, number, number]>; // student -> attended recent, marked recent, attended before, marked before

/** Two windows of `days` days ending today. Excused absences are not counted: they say nothing about drifting away. */
function attendanceWindows(att: AttendanceRow[], now: ISODate, days: number): Windows {
  const split = addDays(now, -days);
  const start = addDays(now, -2 * days);
  const out: Windows = new Map();
  for (const a of att) {
    if (!valid(a.date) || !between(a.date, start, now)) continue;
    const attended = a.status === "present" || a.status === "late";
    if (!attended && a.status !== "absent") continue;
    const w = out.get(a.studentId) ?? ([0, 0, 0, 0] as [number, number, number, number]);
    const recent = a.date > split;
    if (attended) w[recent ? 0 : 2]++;
    w[recent ? 1 : 3]++;
    out.set(a.studentId, w);
  }
  return out;
}

export interface Insights {
  today: ISODate;
  names: Map<string, string>;
  debt: DebtItem[];
  risk: RiskItem[];
  week: WeeklySummary;
}

export function computeInsights(): Insights {
  const now = today();
  const settings = readSettings();
  const students = read<Student>(STUDENTS);
  const names = new Map(students.map((s) => [s.id, s.fullName]));
  const charges = read<Charge>(CHARGES);
  const payments = read<Payment>(PAYMENTS);
  const installments = readIfPresent<Installment>(INSTALLMENTS);
  const debts = computeDebts(charges, payments, now, installments).students;
  const debtList = debtFollowup(
    debts.map((d) => ({ id: d.studentId, outstanding: Math.round(d.outstanding), overdue: Math.round(d.overdue), oldestDue: d.oldestDue })),
    now,
  );
  const ageOf = new Map(debtList.map((d) => [d.id, d.ageDays]));

  const enrollments = read<Enrollment>(ENROLLMENTS).filter((e) => names.has(e.studentId) && valid(e.startedOn));
  const att = read<AttendanceRow>(ATTENDANCE);
  const win = attendanceWindows(att, now, RISK_WINDOW_DAYS);
  const trialOver = new Map<string, number>();
  for (const e of enrollments) {
    if (e.status !== "trial") continue;
    const state = trialStatus({ startedOn: e.startedOn, today: now, lessonsAttended: lessonsAttended(att, e), freeLessons: settings.trialFreeLessons, freeDays: settings.trialFreeDays });
    if (state === "decision_needed") trialOver.set(e.studentId, Math.max(trialOver.get(e.studentId) ?? 0, Math.max(0, daysBetween(e.startedOn, now) - settings.trialFreeDays)));
  }
  const people = [...new Set(enrollments.filter((e) => e.status === "trial" || e.status === "active" || e.status === "frozen").map((e) => e.studentId))];
  const risk = churnRisk(
    people.map((id): RiskFact => {
      const w = win.get(id) ?? [0, 0, 0, 0];
      return { id, attendedRecent: w[0], markedRecent: w[1], attendedPrev: w[2], markedPrev: w[3], overdueAgeDays: ageOf.get(id) ?? 0, trialDaysOver: trialOver.has(id) ? trialOver.get(id)! : null };
    }),
  );

  const weekStart = addDays(now, -6);
  const prevStart = addDays(now, -13);
  const prevEnd = addDays(now, -7);
  const live = payments.filter((p) => !p.voided && valid(p.paidOn));
  const sum = (from: ISODate, to: ISODate): number => live.filter((p) => p.paidOn >= from && p.paidOn <= to).reduce((s, p) => s + p.amount, 0);
  const spent = readIfPresent<Expense>(EXPENSES).filter((x) => !x.voided && valid(x.date) && x.date >= weekStart && x.date <= now).reduce((s, x) => s + x.amount, 0);
  const facts: EnrollmentFact[] = enrollments.map((e) => ({
    student: e.studentId,
    status: e.status,
    startedOn: e.startedOn,
    acceptedOn: e.acceptedOn && valid(e.acceptedOn) ? e.acceptedOn : "",
    endedOn: e.endedOn && valid(e.endedOn) ? e.endedOn : "",
    droppedTrial: e.droppedTrial === true,
  }));
  const movement = studentMovement(facts, { from: weekStart, to: now });
  const weekWin = attendanceWindows(att, now, 7);
  let attended = 0, marked = 0, attendedPrev = 0, markedPrev = 0;
  for (const w of weekWin.values()) {
    attended += w[0];
    marked += w[1];
    attendedPrev += w[2];
    markedPrev += w[3];
  }
  const weekFacts: WeekFacts = {
    income: sum(weekStart, now),
    incomePrev: sum(prevStart, prevEnd),
    expenses: spent,
    newStudents: movement.new,
    leftStudents: movement.left,
    unpaid: debtList.length,
    unpaidTotal: debtList.reduce((s, d) => s + d.outstanding, 0),
    overdue: debtList.filter((d) => d.overdue > 0).length,
    attended, marked, attendedPrev, markedPrev,
    highRisk: risk.filter((r) => r.level === "high").length,
    mediumRisk: risk.filter((r) => r.level === "medium").length,
  };
  return { today: now, names, debt: debtList, risk, week: weeklySummary(weekFacts) };
}

function sheetOf(name: string): GoogleAppsScript.Spreadsheet.Sheet {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) ?? ss.insertSheet(name);
  sh.clear();
  return sh;
}

function write(name: string, title: string, rows: (string | number)[][], head: string[] | null, color: string): void {
  const width = Math.max(head?.length ?? 1, ...rows.map((r) => r.length), 1);
  const pad = (cells: (string | number)[]): (string | number)[] => [...cells.map(safeCell), ...Array<string | number>(Math.max(0, width - cells.length)).fill("")];
  const grid: (string | number)[][] = [pad([title]), pad([NOTE]), pad([])];
  if (head) grid.push(pad(head));
  for (const r of rows) grid.push(pad(r));
  const sh = sheetOf(name);
  sh.getRange(1, 1, grid.length, width).setValues(grid);
  sh.getRange(1, 1).setFontWeight("bold").setFontSize(14);
  sh.getRange(2, 1).setFontColor("#5f6368");
  if (head) sh.getRange(4, 1, 1, width).setFontWeight("bold").setBackground("#202124").setFontColor("#fff").setWrap(true);
  sh.setTabColor(color);
  sh.activate();
}

export function weeklyReport(): void {
  const i = computeInsights();
  const rows: (string | number)[][] = i.week.lines.map((l) => [l]);
  rows.push([]);
  rows.push(["Eng katta qarzlar"]);
  for (const [k, d] of i.debt.slice(0, 5).entries()) rows.push([debtLine(k + 1, i.names.get(d.id) ?? d.id, d.outstanding, d.ageDays, d.tone)]);
  if (!i.debt.length) rows.push(["Qarzdor yo'q."]);
  rows.push([]);
  rows.push(["Ketish xavfi eng yuqorilar"]);
  for (const [k, r] of i.risk.slice(0, 5).entries()) rows.push([riskLine(k + 1, i.names.get(r.id) ?? r.id, r.score, r.level, r.reasons)]);
  if (!i.risk.length) rows.push(["Ketish xavfi ostidagi o'quvchi yo'q."]);
  write(WEEK_SHEET, `Haftalik xulosa (oxirgi 7 kun, ${i.today} gacha)`, rows, null, "#1a73e8");
  SpreadsheetApp.getActive().toast("Haftalik xulosa tayyor.", "nazoratly", 5);
}

export function debtAdvice(): void {
  const i = computeInsights();
  const shown = i.debt.slice(0, LIST_LIMIT);
  const rows = shown.map((d, k): (string | number)[] => {
    const name = i.names.get(d.id) ?? d.id;
    return [k + 1, name, d.outstanding, d.overdue, d.ageDays, d.tone, d.score, debtMessage(d.tone, name, d.outstanding, d.ageDays)];
  });
  if (!rows.length) rows.push(["Qarzdor o'quvchi yo'q."]);
  if (i.debt.length > LIST_LIMIT) rows.push([`... yana ${i.debt.length - LIST_LIMIT} ta (to'liq ro'yxat: Qarzdorlar varag'i)`]);
  write(DEBT_SHEET, `Qarz bo'yicha maslahat (${i.today}): avval bog'lanish kerak bo'lganlar tepada`, rows, ["№", "O'quvchi", "Qoldiq (so'm)", "Muddati o'tgan (so'm)", "Kechikish (kun)", "Ohang", "Ball", "Qoralama matn"], "#e37400");
  SpreadsheetApp.getActive().toast(`${i.debt.length} ta qarzdor. Matnlar qoralama: yuborishni odam hal qiladi.`, "nazoratly", 6);
}

export function riskList(): void {
  const i = computeInsights();
  const shown = i.risk.slice(0, LIST_LIMIT);
  const rows = shown.map((r, k): (string | number)[] => [k + 1, i.names.get(r.id) ?? r.id, r.score, r.level === "high" ? "yuqori" : "o'rta", riskLine(k + 1, i.names.get(r.id) ?? r.id, r.score, r.level, r.reasons), r.attendanceRecent ?? "", r.attendancePrev ?? ""]);
  if (!rows.length) rows.push(["Ketish xavfi ostidagi o'quvchi yo'q."]);
  write(RISK_SHEET, `Ketish xavfi (${i.today}): ball qancha yuqori bo'lsa, xavf shuncha katta`, rows, ["№", "O'quvchi", "Ball", "Daraja", "Sabab", `Davomat, oxirgi ${RISK_WINDOW_DAYS} kun (%)`, `Davomat, undan oldingi ${RISK_WINDOW_DAYS} kun (%)`], "#c5221f");
  SpreadsheetApp.getActive().toast(`${i.risk.length} ta o'quvchi xavf ostida (davomat uchun kamida ${RECENT_MIN_LESSONS} ta belgilangan dars kerak).`, "nazoratly", 6);
}

export const menu = { weekly: weeklyReport, debt: debtAdvice, risk: riskList };
