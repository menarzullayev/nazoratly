/** One-click workbook setup: tabs, headers, validation, protection, conditional colours, sample data. */
import type { Student } from "../domain/types";
import { read, today, updateById } from "./repo";
import { ensureDefaultBranch } from "./branches";
import { clearDemoData } from "./demo";
import { loadSampleData } from "./sampleData";
import { ensureChart, protectLedgerSheets } from "./ledger";
import {
  ALL_TABLES,
  DASHBOARD_SHEET,
  DEBTORS_SHEET,
  METHODS,
  PAYMENTS,
  SETTINGS_SHEET,
  SETTING_DEFAULTS,
  STUDENTS,
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

export { loadSampleData };

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
