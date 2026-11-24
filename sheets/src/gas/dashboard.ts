/** The "Boshqaruv" sheet: KPI cards, the old charged-vs-received chart, and the four phase-5 blocks (paid vs unpaid
 * students, new vs left students with trial conversion, six-month income/expenses/net, lead funnel with "waiting for
 * a decision"). Every number comes from ../domain (dashboard.ts and the modules it reuses, shared with the API through
 * tests/golden/dashboard.json); this file only reads sheets and lays cells out. Nothing here changes data. */
import { computeDebts } from "../domain/debt";
import { inMonth, isIsoDate, monthStart } from "../domain/dates";
import { monthlyFinance, paymentStatus, studentMovement, waitingItems, type EnrollmentFact } from "../domain/dashboard";
import { funnelReport, STAGES } from "../domain/funnel";
import type { Refund, AttendanceRow, Charge, Enrollment, Entitlement, Expense, Group, Installment, Lead, Payment, Student } from "../domain/types";
import { lessonsAttended } from "./admission";
import { loadBalances } from "./packages";
import { read, readIfPresent, today } from "./repo";
import { REFUNDS, ATTENDANCE, CHARGES, DASHBOARD_SHEET, ENROLLMENTS, ENTITLEMENTS, EXPENSES, GROUPS, INSTALLMENTS, LEADS, PAYMENTS, PAYROLL, STUDENTS } from "./schema";
import { loadOffers } from "./waitlist";
import { readSettings } from "./settings";

/** Rows shown per student list; counts are always complete. */
export const LIST_LIMIT = 50;
const WIDTH = 8;
const STAGE_LABELS: Record<string, string> = { new: "Yangi", contacted: "Aloqada", trial_scheduled: "Sinovga yozilgan", trial_attended: "Sinovda bo'ldi", enrolled: "Yozildi", lost: "Yo'qotildi" };
const REASON_LABELS: Record<"lessons" | "days", string> = { lessons: "bepul darslar o'tdi", days: "bepul kunlar o'tdi" };

type Cell = string | number;
type PayrollRow = { month: string; status: string; total: number };

/** `=HYPERLINK` to the student's row so a list entry is clickable; quotes are doubled, so a name cannot break out of the formula. */
export function studentCell(name: string, sheetId: number | null, row: number | null): string {
  if (sheetId === null || row === null) return name;
  const text = name.replace(/"/g, '""');
  return `=HYPERLINK("#gid=${sheetId}&range=A${row}","${text}")`;
}

class Grid {
  rows: Cell[][] = [];
  titles: number[] = [];
  headers: number[] = [];
  private pad(cells: Cell[]): Cell[] {
    return [...cells, ...Array<Cell>(Math.max(0, WIDTH - cells.length)).fill("")];
  }
  title(text: string): void {
    this.titles.push(this.rows.length);
    this.rows.push(this.pad([text]));
  }
  header(cells: Cell[]): void {
    this.headers.push(this.rows.length);
    this.rows.push(this.pad(cells));
  }
  line(cells: Cell[]): void {
    this.rows.push(this.pad(cells));
  }
  blank(): void {
    this.rows.push(this.pad([]));
  }
}

const valid = (d: string): boolean => d !== "" && isIsoDate(d);

function studentLinks(): (id: string, name: string) => string {
  const sh = SpreadsheetApp.getActive().getSheetByName(STUDENTS.sheet);
  const rows = new Map<string, number>();
  let sheetId: number | null = null;
  if (sh) {
    sheetId = sh.getSheetId();
    const data = sh.getDataRange().getValues();
    const idCol = (data[0] ?? []).findIndex((h) => String(h).trim() === STUDENTS.cols[0]!.header);
    if (idCol >= 0) for (let r = 1; r < data.length; r++) if (!rows.has(String(data[r]![idCol]).trim())) rows.set(String(data[r]![idCol]).trim(), r + 1);
  }
  return (id, name) => studentCell(name, sheetId, rows.get(id) ?? null);
}

export interface DashboardBlocks {
  grid: Grid;
  financeFirstRow: number; // 0-based row of the first finance table row inside the grid
  invalidEnrollments: number;
}

/** Builds the four blocks as a grid of cells (pure with respect to the sheet: reads only). */
export function buildBlocks(): DashboardBlocks {
  const now = today();
  const month = monthStart(now);
  const settings = readSettings();
  const students = read<Student>(STUDENTS);
  const names = new Map(students.map((s) => [s.id, s.fullName]));
  const link = studentLinks();
  const enrollments = read<Enrollment>(ENROLLMENTS);
  const charges = read<Charge>(CHARGES);
  const payments = read<Payment>(PAYMENTS);
  const installments = readIfPresent<Installment>(INSTALLMENTS);
  const { students: debts } = computeDebts(charges, payments, now, installments, readIfPresent<Refund>(REFUNDS));
  const debtOf = new Map(debts.map((d) => [d.studentId, d]));
  const { balances } = loadBalances(["active", "frozen"]);
  const packageDebt = new Map<string, number>();
  for (const b of balances) packageDebt.set(b.studentId, (packageDebt.get(b.studentId) ?? 0) + b.debtLessons);
  const grid = new Grid();

  // ---- block 1: paid vs unpaid
  const population = [...new Set(enrollments.filter((e) => (e.status === "active" || e.status === "frozen") && names.has(e.studentId)).map((e) => e.studentId))];
  const pay = paymentStatus(population.map((id) => ({ id, outstanding: debtOf.get(id)?.outstanding ?? 0, overdue: debtOf.get(id)?.overdue ?? 0, packageDebtLessons: packageDebt.get(id) ?? 0 })));
  grid.title("1. To'lagan va to'lamagan o'quvchilar");
  grid.header(["To'lagan", "To'lamagan", "Shundan muddati o'tgan"]);
  grid.line([pay.paid, pay.unpaid, pay.overdue]);
  grid.blank();
  grid.header(["To'lamagan o'quvchilar", "Qoldiq (so'm)", "Muddati o'tgan (so'm)", "Abonement qarzi (dars)"]);
  for (const s of pay.unpaidStudents.slice(0, LIST_LIMIT)) grid.line([link(s.id, names.get(s.id) ?? s.id), s.outstanding, s.overdue, s.packageDebtLessons]);
  if (pay.unpaid > LIST_LIMIT) grid.line([`... yana ${pay.unpaid - LIST_LIMIT} ta (to'liq ro'yxat: Qarzdorlar varag'i)`]);
  if (pay.unpaid === 0) grid.line(["Hamma to'lagan"]);
  grid.blank();
  grid.header(["To'lagan o'quvchilar"]);
  for (const id of pay.paidIds.slice(0, LIST_LIMIT)) grid.line([link(id, names.get(id) ?? id)]);
  if (pay.paid > LIST_LIMIT) grid.line([`... yana ${pay.paid - LIST_LIMIT} ta`]);
  grid.blank();

  // ---- block 2: new vs left, trial conversion (this month so far)
  const validEnrollments = enrollments.filter((e) => names.has(e.studentId) && valid(e.startedOn));
  const invalidEnrollments = enrollments.length - validEnrollments.length;
  const facts: EnrollmentFact[] = validEnrollments.map((e) => ({
    student: e.studentId,
    status: e.status,
    startedOn: e.startedOn,
    acceptedOn: e.acceptedOn && valid(e.acceptedOn) ? e.acceptedOn : "",
    endedOn: e.endedOn && valid(e.endedOn) ? e.endedOn : "",
    droppedTrial: e.droppedTrial === true,
  }));
  const mv = studentMovement(facts, { from: month, to: now });
  grid.title(`2. Yangi va ketgan o'quvchilar (${month} dan ${now} gacha)`);
  grid.header(["Yangi", "Ketgan", "Sinov boshlandi", "Qabul qilindi", "Sinov bekor", "Sinov davom etmoqda", "Sinovdan yozilishga (%)"]);
  grid.line([mv.new, mv.left, mv.trialsStarted, mv.accepted, mv.dropped, mv.running, mv.conversion]);
  grid.blank();
  grid.header(["Yangi o'quvchilar", "Ketgan o'quvchilar"]);
  const rowsNeeded = Math.min(LIST_LIMIT, Math.max(mv.newIds.length, mv.leftIds.length));
  for (let i = 0; i < rowsNeeded; i++) grid.line([mv.newIds[i] ? link(mv.newIds[i]!, names.get(mv.newIds[i]!) ?? "") : "", mv.leftIds[i] ? link(mv.leftIds[i]!, names.get(mv.leftIds[i]!) ?? "") : ""]);
  if (invalidEnrollments > 0) grid.line([`Diqqat: ${invalidEnrollments} ta yozilish qatorining sanasi yoki o'quvchisi noto'g'ri, hisobga olinmadi.`]);
  grid.blank();

  // ---- block 3: six-month income, expenses, net
  const expenses = readIfPresent<Expense>(EXPENSES).filter((x) => !x.voided && valid(x.date) && x.amount > 0);
  const payroll = read<PayrollRow>(PAYROLL).filter((r) => (r.status === "approved" || r.status === "paid") && valid(r.month));
  const fin = monthlyFinance({
    payments: payments.filter((p) => !p.voided && valid(p.paidOn)).map((p) => ({ on: p.paidOn, amount: p.amount })),
    expenses: expenses.map((x) => ({ on: x.date, amount: x.amount })),
    payroll: payroll.map((r) => ({ month: r.month, amount: r.total })),
    today: now,
  });
  grid.title("3. Tushum, xarajat va sof natija (oxirgi 6 oy)");
  grid.header(["Oy", "Tushum", "Xarajat (jami)", "Sof natija", "shundan oylik", "shundan boshqa xarajat"]);
  const financeFirstRow = grid.rows.length;
  for (const m of fin.months) grid.line([m.month.slice(0, 7), m.income, m.expenses, m.net, m.payroll, m.operating]);
  grid.line(["Jami", fin.income, fin.expenses, fin.net]);
  grid.blank();

  // ---- block 4: funnel and waiting for a decision
  const leads = read<Lead>(LEADS).filter((l) => valid(l.createdOn));
  const rep = funnelReport(leads.map((l) => ({ stage: l.stage, source: l.source || null, createdOn: l.createdOn })), { from: month, to: now });
  grid.title(`4. Voronka (${month} dan ${now} gacha) va qaror kutayotganlar`);
  grid.header(["Bosqich", "Soni"]);
  for (const s of STAGES) grid.line([STAGE_LABELS[s]!, rep.stages[s]]);
  grid.line(["Sinovdan yozilishga (%)", rep.trialToEnrolled]);
  grid.blank();
  grid.header(["Manba", "Lead soni", "Yozildi", "Konversiya (%)"]);
  for (const s of rep.bySource) grid.line([s.source ?? "(manba yo'q)", s.leads, s.enrolled, s.conversion]);
  grid.blank();
  const att = read<AttendanceRow>(ATTENDANCE);
  const groups = new Map(read<Group>(GROUPS).map((g) => [g.id, g.name]));
  const trialsEnr = validEnrollments.filter((e) => e.status === "trial");
  const wait = waitingItems({
    trials: trialsEnr.map((e) => ({ id: e.id, startedOn: e.startedOn, lessonsAttended: lessonsAttended(att, e) })),
    packages: balances.map((b) => ({ id: b.enrollmentId, available: b.balance.available, nextExpiry: b.balance.nextExpiry })),
    rights: readIfPresent<Entitlement>(ENTITLEMENTS).filter((r) => valid(r.expiresOn)).map((r) => ({ id: r.id, kind: r.kind, status: r.status, expiresOn: r.expiresOn })),
    today: now,
    windowDays: settings.dashboardWindowDays,
    freeLessons: settings.trialFreeLessons,
    freeDays: settings.trialFreeDays,
    makeupLapses: settings.makeupLapses,
  });
  const enrById = new Map(enrollments.map((e) => [e.id, e]));
  const rightById = new Map(readIfPresent<Entitlement>(ENTITLEMENTS).map((r) => [r.id, r]));
  const balById = new Map(balances.map((b) => [b.enrollmentId, b]));
  const seatOffers = loadOffers();
  grid.title(`Qaror kutayotganlar: jami ${wait.total + seatOffers.offers.length} (muddat oynasi: ${settings.dashboardWindowDays} kun)`);
  grid.header(["Sinovlar: o'quvchi", "Guruh", "Sabab", "Sinov kunlari"]);
  for (const t of wait.trials) {
    const e = enrById.get(t.id)!;
    grid.line([link(e.studentId, names.get(e.studentId) ?? e.studentId), groups.get(e.groupId) ?? e.groupId, REASON_LABELS[t.reason], t.daysElapsed]);
  }
  if (!wait.trials.length) grid.line(["Qaror kutayotgan sinov yo'q"]);
  grid.blank();
  grid.header(["Tugayotgan abonementlar: o'quvchi", "Guruh", "Qolgan dars", "Tugash sanasi", "Qolgan kun"]);
  for (const p of wait.packages) {
    const b = balById.get(p.id)!;
    grid.line([link(b.studentId, names.get(b.studentId) ?? b.studentId), groups.get(b.groupId) ?? b.groupId, p.available, p.nextExpiry, p.daysLeft]);
  }
  if (!wait.packages.length) grid.line(["Tugayotgan abonement yo'q"]);
  grid.blank();
  grid.header(["Kuyayotgan qoplash huquqlari: o'quvchi", "Guruh", "Muddat", "Qolgan kun"]);
  for (const r of wait.rights) {
    const e = rightById.get(r.id)!;
    grid.line([link(e.studentId, names.get(e.studentId) ?? e.studentId), groups.get(e.groupId) ?? e.groupId, r.expiresOn, r.daysLeft]);
  }
  if (!wait.rights.length) grid.line(["Kuyayotgan qoplash huquqi yo'q"]);
  grid.blank();
  grid.header(["Bo'shagan o'rinlar: navbatdagi o'quvchi", "Guruh", "Navbatdagi o'rni", "Bo'sh o'rin soni"]);
  for (const o of seatOffers.offers) {
    const w = seatOffers.entries.get(o.entryId)!;
    grid.line([link(w.studentId, names.get(w.studentId) ?? w.studentId), seatOffers.groups.get(o.groupId)?.name ?? o.groupId, o.position, o.freeSeats]);
  }
  if (!seatOffers.offers.length) grid.line(["Bo'shagan o'rin yo'q"]);
  return { grid, financeFirstRow, invalidEnrollments };
}

export function refreshDashboard(): void {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(DASHBOARD_SHEET) ?? ss.insertSheet(DASHBOARD_SHEET, 0);
  const now = today();
  const month = monthStart(now);
  const students = read<Student>(STUDENTS);
  const charges = read<Charge>(CHARGES);
  const payments = read<Payment>(PAYMENTS);
  const { students: debts } = computeDebts(charges, payments, now, readIfPresent<Installment>(INSTALLMENTS), readIfPresent<Refund>(REFUNDS));
  const attendance = read<AttendanceRow>(ATTENDANCE).filter((a) => inMonth(a.date, month));
  const active = students.filter((s) => s.status === "active").length;
  const monthCharged = charges.filter((c) => !c.voided && c.month === month).reduce((s, c) => s + c.amount, 0);
  const monthPaid = payments.filter((p) => !p.voided && inMonth(p.paidOn, month)).reduce((s, p) => s + p.amount, 0);
  const outstanding = debts.reduce((s, d) => s + d.outstanding, 0);
  const overdue = debts.reduce((s, d) => s + d.overdue, 0);
  const present = attendance.filter((a) => a.status === "present" || a.status === "late").length;
  const rate = attendance.length ? Math.round((present / attendance.length) * 100) : 0;

  sh.clear();
  sh.getCharts().forEach((c) => sh.removeChart(c));
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, WIDTH, 150);
  sh.setColumnWidth(1, 260);
  sh.getRange("A1").setValue(readSettings().center).setFontSize(22).setFontWeight("bold").setFontFamily("Google Sans");
  sh.getRange("A2").setValue(`Boshqaruv paneli · ${now}`).setFontColor("#5f6368");
  const cards: [string, string | number, string][] = [
    ["Faol o'quvchilar", active, "#e8f0fe"], ["Bu oy hisob", monthCharged, "#fef7e0"], ["Bu oy tushum", monthPaid, "#e6f4ea"],
    ["Umumiy qoldiq", outstanding, "#f3e8fd"], ["Muddati o'tgan", overdue, "#fce8e6"], ["Davomat (bu oy)", `${rate}%`, "#e8f0fe"],
  ];
  cards.forEach(([label, value, bg], i) => {
    const col = 1 + i;
    sh.getRange(4, col).setValue(label).setFontColor("#5f6368").setBackground(bg).setFontSize(10);
    sh.getRange(5, col).setValue(value).setFontSize(20).setFontWeight("bold").setBackground(bg).setNumberFormat("#,##0");
    sh.getRange(6, col).setBackground(bg);
  });
  // last 6 months: charged vs received (feeds the chart)
  const months: string[] = [];
  let m = month;
  for (let i = 0; i < 6; i++) { months.unshift(m); const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)); m = mo === 1 ? `${y - 1}-12-01` : `${y}-${String(mo - 1).padStart(2, "0")}-01`; }
  const table = months.map((mm) => [mm.slice(0, 7), charges.filter((c) => !c.voided && c.month === mm).reduce((s, c) => s + c.amount, 0), payments.filter((p) => !p.voided && inMonth(p.paidOn, mm)).reduce((s, p) => s + p.amount, 0)]);
  sh.getRange(8, 1, 1, 3).setValues([["Oy", "Hisoblangan", "Tushgan"]]).setFontWeight("bold").setBackground("#202124").setFontColor("#fff");
  sh.getRange(9, 1, table.length, 3).setValues(table);
  sh.getRange(9, 2, table.length, 2).setNumberFormat("#,##0");
  sh.insertChart(sh.newChart().asColumnChart().addRange(sh.getRange(8, 1, table.length + 1, 3)).setPosition(8, 5, 0, 0).setOption("title", "Hisoblangan va tushgan (oxirgi 6 oy)").setOption("colors", ["#fbbc04", "#34a853"]).setOption("width", 560).setOption("height", 300).build());
  const top = debts.filter((d) => d.overdue > 0).slice(0, 5);
  const byId = new Map(students.map((s) => [s.id, s.fullName]));
  sh.getRange(17, 1).setValue("Eng katta qarzdorlar").setFontWeight("bold");
  top.forEach((d, i) => { sh.getRange(18 + i, 1, 1, 3).setValues([[byId.get(d.studentId) ?? d.studentId, d.overdue, `${d.maxDaysOverdue} kun`]]); sh.getRange(18 + i, 2).setNumberFormat("#,##0"); });
  if (!top.length) sh.getRange(18, 1).setValue("Muddati o'tgan qarz yo'q").setFontColor("#188038");

  // phase 5 blocks start below the old content
  const START = 25;
  const { grid, financeFirstRow } = buildBlocks();
  sh.getRange(START, 1, grid.rows.length, WIDTH).setValues(grid.rows);
  for (const r of grid.titles) sh.getRange(START + r, 1, 1, WIDTH).setFontWeight("bold").setFontSize(13).setBackground("#e8f0fe");
  for (const r of grid.headers) sh.getRange(START + r, 1, 1, WIDTH).setFontWeight("bold").setBackground("#202124").setFontColor("#fff").setWrap(true);
  sh.getRange(START + financeFirstRow, 2, 7, 5).setNumberFormat("#,##0");
  const financeHeader = START + financeFirstRow - 1; // 1-based row of the finance table header
  sh.insertChart(
    sh.newChart().asColumnChart().addRange(sh.getRange(financeHeader, 1, 7, 4)).setPosition(financeHeader, 8, 0, 0)
      .setOption("title", "Tushum, xarajat va sof natija (oxirgi 6 oy)").setOption("colors", ["#34a853", "#ea4335", "#4285f4"]).setOption("width", 560).setOption("height", 300).build(),
  );
  sh.activate();
}

export const menu = { refresh: (): void => refreshDashboard() };
