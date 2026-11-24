/** One-click workbook setup: tabs, headers, validation, protection, conditional colours, sample data. */
import { effectiveFee } from "../domain/billing";
import { planCharges } from "../domain/billing";
import { prevMonthStart, monthStart } from "../domain/dates";
import { nextIds } from "../domain/ids";
import type { AttendanceRow, Charge, Enrollment, Group, Student, Teacher } from "../domain/types";
import { append, read, readIfPresent, toDate, today, updateById } from "./repo";
import { ensureDefaultBranch } from "./branches";
import { clearDemoData, hasDemoRows } from "./demo";
import { ensureChart, protectLedgerSheets } from "./ledger";
import {
  ALL_TABLES,
  ATTENDANCE,
  CHARGES,
  DASHBOARD_SHEET,
  DEBTORS_SHEET,
  ENROLLMENTS,
  EXPENSES,
  GROUPS,
  LEADS,
  METHODS,
  PAYMENTS,
  SETTINGS_SHEET,
  SETTING_DEFAULTS,
  STUDENTS,
  TEACHERS,
  WAITLIST,
  type ColDef,
  type TableDef,
} from "./schema";

const HEADER_BG = "#202124";
const FONT = "Google Sans";
const HEADER_PROTECTION = "nazoratly: sarlavha qatori";

function ensureSheet(name: string): GoogleAppsScript.Spreadsheet.Sheet {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) ?? ss.insertSheet(name);
}

function dropdown(values: string[]): GoogleAppsScript.Spreadsheet.DataValidation {
  return SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
}

function validationFor(col: ColDef): GoogleAppsScript.Spreadsheet.DataValidation | null {
  if (col.kind === "enum") return dropdown(Object.values(col.labels ?? {}).filter((l) => l !== ""));
  if (col.kind === "bool") return dropdown(["Ha", "Yo'q"]);
  if (col.options) return SpreadsheetApp.newDataValidation().requireValueInList(col.options, true).setAllowInvalid(true).build();
  if (col.kind === "date") {
    return SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).setHelpText("To'g'ri sana kiriting (yyyy-mm-dd)").build();
  }
  if (col.kind === "num") {
    return SpreadsheetApp.newDataValidation().requireNumberBetween(0, 100).setAllowInvalid(false).setHelpText("0-100 (kasr bo'lishi mumkin)").build();
  }
  if (col.kind === "int") {
    return SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(col.key === "bonus" || col.signed ? -1_000_000_000 : 0).setAllowInvalid(false).setHelpText("Butun son").build();
  }
  return null;
}

export function setupTable(def: TableDef): void {
  const sh = ensureSheet(def.sheet);
  const n = def.cols.length;
  const head = sh.getRange(1, 1, 1, n);
  head.setValues([def.cols.map((c) => c.header)]);
  head.setBackground(HEADER_BG).setFontColor("#ffffff").setFontWeight("bold").setFontFamily(FONT).setVerticalAlignment("middle").setWrap(true);
  sh.setRowHeight(1, 36);
  sh.setFrozenRows(1);
  sh.setTabColor(def.color);
  def.cols.forEach((c, i) => {
    sh.setColumnWidth(i + 1, c.width);
    if (c.help) sh.getRange(1, i + 1).setNote(c.help);
    const body = sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1);
    const rule = validationFor(c);
    if (rule) body.setDataValidation(rule);
    if (c.kind === "date") body.setNumberFormat("yyyy-mm-dd");
    if (c.kind === "int") body.setNumberFormat("#,##0");
    if (c.kind === "num") body.setNumberFormat("0.##");
    if (c.plain) body.setNumberFormat("@");
  });
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), n).setFontFamily(FONT).setVerticalAlignment("middle");
  // Warning-only protection: structure rows are hard to break by accident, the owner can still edit.
  // range.protect() adds a NEW protection on every call, so the previous one is removed first (setup is re-runnable).
  for (const old of sh.getProtections(SpreadsheetApp.ProtectionType.RANGE)) if (old.getDescription() === HEADER_PROTECTION) old.remove();
  const prot = sh.getRange(1, 1, 1, n).protect().setDescription(HEADER_PROTECTION);
  prot.setWarningOnly(true);
  // Colour the status column so problems are visible at a glance.
  const statusIdx = def.cols.findIndex((c) => c.key === "status");
  if (statusIdx >= 0) {
    const r = sh.getRange(2, statusIdx + 1, Math.max(sh.getMaxRows() - 1, 1), 1);
    const labels = def.cols[statusIdx]!.labels ?? {};
    const colour = (label: string, bg: string, fg: string) =>
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(label).setBackground(bg).setFontColor(fg).setRanges([r]).build();
    const rules = [
      ...(labels.active ? [colour(labels.active, "#e6f4ea", "#137333")] : []),
      ...(labels.left ? [colour(labels.left, "#fce8e6", "#c5221f")] : []),
      ...(labels.absent ? [colour(labels.absent, "#fce8e6", "#c5221f")] : []),
      ...(labels.present ? [colour(labels.present, "#e6f4ea", "#137333")] : []),
      ...(labels.late ? [colour(labels.late, "#fef7e0", "#b06000")] : []),
      ...(labels.pending ? [colour(labels.pending, "#fef7e0", "#b06000")] : []),
      ...(labels.failed ? [colour(labels.failed, "#fce8e6", "#c5221f")] : []),
      ...(labels.sent ? [colour(labels.sent, "#e8f0fe", "#1967d2")] : []),
    ];
    sh.setConditionalFormatRules([...sh.getConditionalFormatRules(), ...rules]);
  }
  const voidedIdx = def.cols.findIndex((c) => c.key === "voided");
  if (voidedIdx >= 0) {
    const full = sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), n);
    const letter = String.fromCharCode(65 + voidedIdx);
    const rule = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=$${letter}2="Ha"`).setFontColor("#9aa0a6").setStrikethrough(true).setRanges([full]).build();
    sh.setConditionalFormatRules([...sh.getConditionalFormatRules(), rule]);
  }
}

export function setupSettings(): void {
  const sh = ensureSheet(SETTINGS_SHEET);
  sh.clear();
  sh.getRange(1, 1, 1, 3).setValues([["Sozlama", "Qiymat", "Izoh"]]).setBackground(HEADER_BG).setFontColor("#fff").setFontWeight("bold");
  sh.getRange(2, 1, SETTING_DEFAULTS.length, 3).setValues(SETTING_DEFAULTS.map((d) => [d.label, d.value, d.help]));
  sh.setColumnWidths(1, 1, 300);
  sh.setColumnWidths(2, 1, 360);
  sh.setColumnWidths(3, 1, 460);
  sh.getRange(2, 2, SETTING_DEFAULTS.length, 1).setBackground("#fff8e1").setWrap(true);
  sh.getRange(2, 3, SETTING_DEFAULTS.length, 1).setFontColor("#5f6368");
  sh.setTabColor("#5f6368");
  sh.setFrozenRows(1);
}

export function setupWorkbook(): void {
  for (const def of ALL_TABLES) setupTable(def);
  setupSettings();
  ensureDefaultBranch(); // every center has a default branch ("Asosiy filial"); rows without a branch mark belong to it
  ensureChart(); // chart of accounts and the two default cash accounts (first time only)
  protectLedgerSheets(); // the ledger sheets are written by the script only
  const ss = SpreadsheetApp.getActive();
  const dashboard = ss.getSheetByName(DASHBOARD_SHEET) ?? ss.insertSheet(DASHBOARD_SHEET, 0);
  dashboard.setTabColor("#1a73e8");
  ensureSheet(DEBTORS_SHEET).setTabColor("#d93025");
  const blank = ss.getSheetByName("Sheet1") ?? ss.getSheetByName("Лист1") ?? ss.getSheetByName("Varaq1");
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  // payment method dropdown is a suggestion (free text allowed): already handled by PAYMENTS.cols.options
  void METHODS;
}

/**
 * A small, realistic data set for demos. Every row carries the Demo flag ("Demo" column), so "Demo ma'lumotni tozalash"
 * can remove it again without touching real rows, and demo money is left out of the journal. Ids are taken after the
 * existing ones, so the sample can sit next to real data. Refuses to run when demo rows already exist.
 */
export function loadSampleData(): string {
  if (hasDemoRows()) throw new Error("Demo ma'lumot allaqachon yuklangan. Yangilash uchun 'Namuna ma'lumotni yangilash', olib tashlash uchun 'Demo ma'lumotni tozalash'.");
  const D = { demo: true } as const;
  const ids = (prefix: string, def: TableDef, n: number): string[] => nextIds(prefix, readIfPresent<{ id: string }>(def).map((r) => r.id), n);
  const tIds = ids("T", TEACHERS, 2);
  const gIds = ids("G", GROUPS, 2);
  const teachers: Teacher[] = [
    { id: tIds[0]!, fullName: "Dilnoza Karimova", payModel: "per_lesson", payRate: 90_000, status: "active", ...D },
    { id: tIds[1]!, fullName: "Sardor Aliyev", payModel: "percent", payRate: 40, status: "active", ...D },
  ];
  const groups: Group[] = [
    { id: gIds[0]!, name: "IELTS 6.5 (kechki)", teacherId: tIds[0]!, monthlyFee: 600_000, status: "active", capacity: 4, ...D },
    { id: gIds[1]!, name: "Matematika 9-sinf", teacherId: tIds[1]!, monthlyFee: 400_000, status: "active", capacity: 5, ...D },
  ];
  const names = ["Aziz Rahimov", "Madina Tursunova", "Jasur Qodirov", "Nigora Ismoilova", "Bobur Saidov", "Lola Xasanova", "Otabek Mirzaev", "Zarina Yusupova"];
  const waiting = ["Kamola Nurmatova", "Davron Sodiqov", "Feruza Olimova"];
  const sIds = ids("S", STUDENTS, names.length + waiting.length);
  const students: (Student & Record<string, unknown>)[] = [...names, ...waiting].map((fullName, i) => ({
    id: sIds[i]!,
    fullName,
    status: i < names.length ? "active" : "lead",
    guardianName: `${fullName.split(" ")[0]} ota-onasi`,
    guardianChatId: "",
    consentNotify: false,
    phone: i < names.length ? `+99890123${String(4000 + i)}` : "",
    ...D,
  }));
  const cur = monthStart(today());
  const prev1 = prevMonthStart(cur);
  const prev2 = prevMonthStart(prev1);
  const eIds = ids("E", ENROLLMENTS, names.length);
  const enrollments: Enrollment[] = names.map((_, i) => ({
    id: eIds[i]!,
    studentId: sIds[i]!,
    groupId: i % 2 === 0 ? gIds[0]! : gIds[1]!,
    startedOn: `${prev2.slice(0, 7)}-05`,
    endedOn: "",
    discountPercent: i === 3 ? 10 : 0,
    status: "active",
    ...D,
  }));
  append(TEACHERS, teachers);
  append(GROUPS, groups);
  append(STUDENTS, students);
  append(ENROLLMENTS, enrollments);

  const months = [prev2, prev1, cur];
  let charges: Charge[] = readIfPresent<Charge>(CHARGES);
  const before = charges.length;
  const demoStudents = students.slice(0, names.length);
  for (const m of months) {
    const plan = planCharges({ month: m, dueDay: 10, enrollments, groups, students: demoStudents, charges });
    const cids = nextIds("C", charges.map((c) => c.id), plan.create.length);
    charges = [...charges, ...plan.create.map((c, i) => ({ id: cids[i]!, studentId: c.studentId, enrollmentId: c.enrollmentId, month: c.month, amount: c.amount, dueDate: c.dueDate, voided: false, note: c.note, ...D }))];
  }
  const newCharges = charges.slice(before);
  append(CHARGES, newCharges);
  // most pay on time, two are behind
  const payments = demoStudents.flatMap((s, i) => {
    const e = enrollments[i]!;
    const fee = effectiveFee(groups.find((g) => g.id === e.groupId)!, e);
    const paidMonths = i === 1 ? 1 : i === 4 ? 0 : i === 5 ? 2 : 3;
    return Array.from({ length: paidMonths }, (_, k) => ({
      id: "",
      studentId: s.id,
      paidOn: ((d) => (d > today() ? today() : d))(`${months[k]!.slice(0, 7)}-${String(8 + i).padStart(2, "0")}`),
      amount: fee,
      method: ["Naqd", "Karta", "Payme", "Click"][(i + k) % 4]!,
      voided: false,
      note: "",
      ...D,
    }));
  });
  const pids = nextIds("P", readIfPresent<{ id: string }>(PAYMENTS).map((p) => p.id), payments.length);
  append(PAYMENTS, payments.map((p, i) => ({ ...p, id: pids[i]! })));

  const attendance: AttendanceRow[] = [];
  for (const day of [5, 12, 19].map((d) => `${prev1.slice(0, 7)}-${String(d).padStart(2, "0")}`)) {
    for (const [i, s] of demoStudents.entries()) {
      const e = enrollments[i]!;
      const status = (i + day.length + Number(day.slice(-1))) % 7 === 0 ? "absent" : (i + Number(day.slice(-1))) % 5 === 0 ? "late" : "present";
      attendance.push({ date: day, groupId: e.groupId, studentId: s.id, status, minutesLate: status === "late" ? 10 : 0, ...D });
    }
  }
  append(ATTENDANCE, attendance);
  // sample expenses (only when the workbook already has the expenses sheet, i.e. after "Boshlang'ich sozlash")
  const xIds = nextIds("X", readIfPresent<{ id: string }>(EXPENSES).map((x) => x.id), months.length * 2);
  const expenseRows = SpreadsheetApp.getActive().getSheetByName(EXPENSES.sheet)
    ? months.flatMap((m, i) => [
        { id: xIds[i * 2]!, date: `${m.slice(0, 7)}-03`, category: "rent", amount: 3_000_000, note: "Ijara (namuna)", voided: false, ...D },
        { id: xIds[i * 2 + 1]!, date: `${m.slice(0, 7)}-05`, category: "utilities", amount: 450_000, note: "Kommunal (namuna)", voided: false, ...D },
      ]).filter((x) => x.date <= today())
    : [];
  append(EXPENSES, expenseRows);
  // leads and the waiting list (these sheets exist after "Boshlang'ich sozlash"; an older workbook simply skips them)
  let extra = "";
  if (SpreadsheetApp.getActive().getSheetByName(LEADS.sheet)) {
    const lIds = ids("L", LEADS, 4);
    const leads = [["Sherzod Abdullayev", "new", "Instagram"], ["Mohira Ergasheva", "contacted", "Tanish"], ["Anvar Toshpulatov", "trial_scheduled", "Instagram"], ["Dildora Karimova", "lost", "Telegram"]] as const;
    append(LEADS, leads.map(([fullName, stage, source], i) => ({ id: lIds[i]!, fullName, phone: `+99893555${1000 + i}`, source, stage, nextFollowUpOn: "", note: "", createdOn: today(), studentId: "", ...D })));
  }
  if (SpreadsheetApp.getActive().getSheetByName(WAITLIST.sheet)) {
    const wIds = ids("W", WAITLIST, waiting.length);
    append(WAITLIST, waiting.map((_, i) => ({ id: wIds[i]!, groupId: i < 2 ? gIds[0]! : gIds[1]!, studentId: sIds[names.length + i]!, joinedOn: today(), status: "waiting", note: "demo", ...D })));
    extra = ` (+${waiting.length} navbatda)`;
  }
  void toDate;
  return `Namuna: ${names.length} o'quvchi${extra}, ${groups.length} guruh, ${newCharges.length} hisob, ${payments.length} to'lov, ${attendance.length} davomat yozuvi. Barcha qatorlar "Demo" belgili: pul yozuvlari jurnalga tushmaydi.`;
}

const TELEGRAM_FIELDS = ["guardianChatId", "consentNotify", "consentDate", "consentPolicy", "linkCode", "linkUrl"] as const;

/**
 * "Namuna ma'lumotni yangilash": removes the demo rows (only those: real data and Sozlamalar stay; refused with the
 * reason when a real record references one), then loads fresh sample data relative to today. Guardian Telegram links of
 * demo students (matched by name) are carried over, so a live demo bot keeps working.
 */
export function resetSampleData(): string {
  const keep = new Map<string, Record<string, unknown>>();
  for (const s of read<Student & Record<string, unknown>>(STUDENTS)) {
    if (s.demo !== true || !s.guardianChatId) continue;
    keep.set(s.fullName, Object.fromEntries(TELEGRAM_FIELDS.map((f) => [f, s[f] ?? ""])));
  }
  clearDemoData();
  const msg = loadSampleData();
  let restored = 0;
  for (const s of read<Student>(STUDENTS)) {
    const patch = s.demo === true ? keep.get(s.fullName) : undefined;
    if (patch && updateById(STUDENTS, "id", s.id, patch)) restored++;
  }
  return `${msg}${restored ? ` Telegram ulanishlari saqlandi: ${restored} ta o'quvchi.` : ""}`;
}
