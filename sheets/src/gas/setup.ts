/** One-click workbook setup: tabs, headers, validation, protection, conditional colours, sample data. */
import { effectiveFee } from "../domain/billing";
import { planCharges } from "../domain/billing";
import { prevMonthStart, monthStart } from "../domain/dates";
import { nextIds } from "../domain/ids";
import type { AttendanceRow, Charge, Enrollment, Group, Student, Teacher } from "../domain/types";
import { append, read, toDate, today } from "./repo";
import {
  ALL_TABLES,
  ATTENDANCE,
  CHARGES,
  DASHBOARD_SHEET,
  DEBTORS_SHEET,
  ENROLLMENTS,
  GROUPS,
  METHODS,
  PAYMENTS,
  SETTINGS_SHEET,
  SETTING_DEFAULTS,
  STUDENTS,
  TEACHERS,
  type ColDef,
  type TableDef,
} from "./schema";

const HEADER_BG = "#202124";
const FONT = "Google Sans";

function ensureSheet(name: string): GoogleAppsScript.Spreadsheet.Sheet {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) ?? ss.insertSheet(name);
}

function dropdown(values: string[]): GoogleAppsScript.Spreadsheet.DataValidation {
  return SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
}

function validationFor(col: ColDef): GoogleAppsScript.Spreadsheet.DataValidation | null {
  if (col.kind === "enum") return dropdown(Object.values(col.labels ?? {}));
  if (col.kind === "bool") return dropdown(["Ha", "Yo'q"]);
  if (col.options) return SpreadsheetApp.newDataValidation().requireValueInList(col.options, true).setAllowInvalid(true).build();
  if (col.kind === "date") {
    return SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).setHelpText("To'g'ri sana kiriting (yyyy-mm-dd)").build();
  }
  if (col.kind === "int") {
    return SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(col.key === "bonus" ? -1_000_000_000 : 0).setAllowInvalid(false).setHelpText("Butun son").build();
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
  });
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), n).setFontFamily(FONT).setVerticalAlignment("middle");
  // Warning-only protection: structure rows are hard to break by accident, the owner can still edit.
  const prot = sh.getRange(1, 1, 1, n).protect().setDescription("nazoratly: sarlavha qatori");
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
  const ss = SpreadsheetApp.getActive();
  const dashboard = ss.getSheetByName(DASHBOARD_SHEET) ?? ss.insertSheet(DASHBOARD_SHEET, 0);
  dashboard.setTabColor("#1a73e8");
  ensureSheet(DEBTORS_SHEET).setTabColor("#d93025");
  const blank = ss.getSheetByName("Sheet1") ?? ss.getSheetByName("Лист1") ?? ss.getSheetByName("Varaq1");
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  // payment method dropdown is a suggestion (free text allowed): already handled by PAYMENTS.cols.options
  void METHODS;
}

/** A small, realistic data set for demos. Refuses to run when the workbook already has students. */
export function loadSampleData(): string {
  if (read<Student>(STUDENTS).length > 0) throw new Error("O'quvchilar varag'i bo'sh emas: namuna ma'lumot faqat bo'sh jadvalga yuklanadi.");
  const teachers: Teacher[] = [
    { id: "T0001", fullName: "Dilnoza Karimova", payModel: "per_lesson", payRate: 90_000, status: "active" },
    { id: "T0002", fullName: "Sardor Aliyev", payModel: "percent", payRate: 40, status: "active" },
  ];
  const groups: Group[] = [
    { id: "G0001", name: "IELTS 6.5 (kechki)", teacherId: "T0001", monthlyFee: 600_000, status: "active" },
    { id: "G0002", name: "Matematika 9-sinf", teacherId: "T0002", monthlyFee: 400_000, status: "active" },
  ];
  const names = ["Aziz Rahimov", "Madina Tursunova", "Jasur Qodirov", "Nigora Ismoilova", "Bobur Saidov", "Lola Xasanova", "Otabek Mirzaev", "Zarina Yusupova"];
  const students: (Student & Record<string, unknown>)[] = names.map((fullName, i) => ({
    id: `S${String(i + 1).padStart(4, "0")}`,
    fullName,
    status: "active",
    guardianName: `${fullName.split(" ")[0]} ota-onasi`,
    guardianChatId: "",
    consentNotify: false,
    phone: `+99890123${String(4000 + i)}`,
  }));
  const cur = monthStart(today());
  const prev1 = prevMonthStart(cur);
  const prev2 = prevMonthStart(prev1);
  const enrollments: Enrollment[] = students.map((s, i) => ({
    id: `E${String(i + 1).padStart(4, "0")}`,
    studentId: s.id,
    groupId: i % 2 === 0 ? "G0001" : "G0002",
    startedOn: `${prev2.slice(0, 7)}-05`,
    endedOn: "",
    discountPercent: i === 3 ? 10 : 0,
    status: "active",
  }));
  append(TEACHERS, teachers);
  append(GROUPS, groups);
  append(STUDENTS, students);
  append(ENROLLMENTS, enrollments);

  const months = [prev2, prev1, cur];
  let charges: Charge[] = [];
  for (const m of months) {
    const plan = planCharges({ month: m, dueDay: 10, enrollments, groups, students, charges });
    const ids = nextIds("C", charges.map((c) => c.id), plan.create.length);
    charges = [...charges, ...plan.create.map((c, i) => ({ id: ids[i]!, studentId: c.studentId, enrollmentId: c.enrollmentId, month: c.month, amount: c.amount, dueDate: c.dueDate, voided: false, note: c.note }))];
  }
  append(CHARGES, charges);
  // most pay on time, two are behind
  const payments = students.flatMap((s, i) => {
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
    }));
  });
  const pids = nextIds("P", [], payments.length);
  append(PAYMENTS, payments.map((p, i) => ({ ...p, id: pids[i]! })));

  const attendance: AttendanceRow[] = [];
  for (const day of [5, 12, 19].map((d) => `${prev1.slice(0, 7)}-${String(d).padStart(2, "0")}`)) {
    for (const [i, s] of students.entries()) {
      const e = enrollments[i]!;
      const status = (i + day.length + Number(day.slice(-1))) % 7 === 0 ? "absent" : (i + Number(day.slice(-1))) % 5 === 0 ? "late" : "present";
      attendance.push({ date: day, groupId: e.groupId, studentId: s.id, status, minutesLate: status === "late" ? 10 : 0 });
    }
  }
  append(ATTENDANCE, attendance);
  void toDate;
  return `Namuna: ${students.length} o'quvchi, ${groups.length} guruh, ${charges.length} hisob, ${payments.length} to'lov, ${attendance.length} davomat yozuvi.`;
}
