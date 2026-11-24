/** Accounting in the Sheets edition: the hash-chained journal, automatic postings (catch-up "sync"), manual entries and
 * reversals, closing months, verification, reports and the script-only protection of the ledger sheets.
 *
 * The rules are in ../domain (ledger.ts, accounting.ts) and shared with the API product through tests/golden/*.json.
 * IMPORTANT, said plainly in the README as well: a Google Sheet cannot be made immutable. The ledger sheets are protected
 * (only the owner/script and the emails in Sozlamalar can write), but the sheet owner can remove that protection. The hash
 * chain makes any edit detectable ("Jurnalni tekshirish" names the first broken row); it cannot prevent one. */
import {
  accountStatement, balanceSheet, CHART, incomeStatement, normalSide, pendingPostings, postedKey, postingLines, trialBalance, type ChartInfo, type PendingItem, type Source, type Totals,
} from "../domain/accounting";
import { isIsoDate, monthStart } from "../domain/dates";
import { nextId } from "../domain/ids";
import { EMPTY_HEAD, makePeriod, nextHead, parseMoney, reverseLines, sealEntry, validateEntry, verifyChain, type Head, type Line, type LineSpec, type Period, type Verdict } from "../domain/ledger";
import type { Expense, Payment, Refund, Student } from "../domain/types";
import { guard, withLock } from "./actions";
import { append, read, readIfPresent, today, updateById } from "./repo";
import { BILL_PAYMENTS, CASH_ACCOUNTS, CHART_ACCOUNTS, EXPENSES, JOURNAL, LEDGER_TABLES, PAYMENTS, PAYROLL, PERIODS, REFUNDS, STUDENTS, type TableDef } from "./schema";
import { readSettings } from "./settings";

export const REPORT_SHEET = "Buxgalteriya hisoboti";
export const PROTECT_TAG = "nazoratly:jurnal";
const SOM = 100; // the journal sheet holds whole so'm; the rules count tiyin
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();

export interface ChartRow { code: string; name: string; type: string; active: boolean }
export interface JournalRow { seq: number; entryNo: number; date: string; account: string; debit: number; credit: number; sourceType: string; sourceKey: string; memo: string; prevHash: string; hash: string }
interface PeriodRow { month: string; lastSeq: number; headHash: string; totalDebit: number; totalCredit: number; periodHash: string; closedOn: string }
interface CashRow { code: string; name: string; kind: string }
export interface EntrySpec { date: string; memo: string; sourceType: string; sourceKey: string; lines: LineSpec[] }

const ERROR_TEXT: Record<string, string> = {
  too_few_lines: "yozuvda kamida ikkita qator bo'lishi kerak",
  bad_line: "har bir qatorda faqat bitta tomon (debet yoki kredit) musbat bo'lishi kerak",
  unknown_account: "hisob rejasida bunday hisob yo'q",
  inactive_account: "hisob faol emas",
  unbalanced: "yozuv muvozanatda emas (debet kreditga teng emas)",
  closed_period: "bu oy yopilgan: unga yozuv qo'shib bo'lmaydi",
};
export const REASON_TEXT: Record<string, string> = {
  seq_gap: "qator raqami ketma-ket emas (qator o'chirilgan, qo'shilgan yoki o'rni almashgan)",
  prev_mismatch: "oldingi hash mos kelmaydi (oldingi qator o'zgartirilgan yoki o'chirilgan)",
  hash_mismatch: "qator mazmuni o'zgartirilgan (hash mos kelmaydi)",
  bad_line: "qatorda bir vaqtda debet va kredit bor yoki manfiy/nol summa",
  entry_order: "yozuv raqamlari ketma-ket emas",
  unbalanced_entry: "yozuv muvozanatda emas",
  period_hash_mismatch: "davr hashi o'zgartirilgan",
  period_head_mismatch: "yopilgan davrdan keyin shu davrgacha bo'lgan jurnal o'zgartirilgan",
  period_totals_mismatch: "yopilgan davr jami summalari jurnalga mos kelmaydi",
  period_missing: "davr jurnaldan keyingi qatorga ishora qiladi (qatorlar o'chirilgan)",
  late_entry: "yopilgan oyga yopilgandan keyin yozuv qo'shilgan",
};

export class LedgerError extends Error {
  constructor(readonly codes: string[]) {
    super(`Jurnalga yozib bo'lmaydi: ${codes.map((c) => ERROR_TEXT[c] ?? c).join("; ")}.`);
  }
}

const hasSheet = (def: TableDef): boolean => SpreadsheetApp.getActive().getSheetByName(def.sheet) !== null;
export const ledgerReady = (): boolean => hasSheet(JOURNAL);

// ---- reading ------------------------------------------------------------------------------------------------------
export function readChart(): ChartRow[] {
  return hasSheet(CHART_ACCOUNTS) ? read<ChartRow>(CHART_ACCOUNTS) : CHART.map((a) => ({ code: a.code, name: a.name, type: a.type, active: true }));
}
export const toLine = (r: JournalRow): Line => ({ seq: r.seq, entryNo: r.entryNo, date: r.date, account: r.account, debit: r.debit * SOM, credit: r.credit * SOM, sourceType: r.sourceType, sourceKey: r.sourceKey, memo: r.memo, prevHash: r.prevHash, hash: r.hash });
const toRow = (l: Line): JournalRow => ({ seq: l.seq, entryNo: l.entryNo, date: l.date, account: l.account, debit: l.debit / SOM, credit: l.credit / SOM, sourceType: l.sourceType, sourceKey: l.sourceKey, memo: l.memo, prevHash: l.prevHash, hash: l.hash });
/** The journal in sheet order (a swapped or deleted row must show up as a broken chain, so it is never re-sorted). */
export const journalLines = (): Line[] => readIfPresent<JournalRow>(JOURNAL).map(toLine);
export function periods(): Period[] {
  return readIfPresent<PeriodRow>(PERIODS).map((p) => ({ month: p.month, lastSeq: p.lastSeq, headHash: p.headHash, totalDebit: p.totalDebit * SOM, totalCredit: p.totalCredit * SOM, periodHash: p.periodHash }));
}
export const closedMonths = (): Set<string> => new Set(readIfPresent<PeriodRow>(PERIODS).map((p) => p.month));
export const headOf = (lines: Line[]): Head => (lines.length ? { seq: lines[lines.length - 1]!.seq, entryNo: lines[lines.length - 1]!.entryNo, hash: lines[lines.length - 1]!.hash } : EMPTY_HEAD);
export const postedSet = (lines: Line[]): Set<string> => new Set(lines.filter((l) => l.sourceType !== "manual").map((l) => postedKey(l.sourceType, l.sourceKey)));

/** Seeds the chart template and the two default cash accounts the first time (idempotent). */
export function ensureChart(): void {
  if (hasSheet(CHART_ACCOUNTS)) {
    // seeds the template, and later additions to it (e.g. 4200 refunds, 5900 cash shortage) for centers that already have a chart
    const have = new Set(read<ChartRow>(CHART_ACCOUNTS).map((a) => a.code));
    const missing = CHART.filter((a) => !have.has(a.code));
    if (missing.length) append(CHART_ACCOUNTS, missing.map((a) => ({ code: a.code, name: a.name, type: a.type, active: true })));
  }
  if (hasSheet(CASH_ACCOUNTS) && read<CashRow>(CASH_ACCOUNTS).length === 0) {
    append(CASH_ACCOUNTS, [{ code: "1000", name: "Kassa", kind: "cash" }, { code: "1010", name: "Bank hisobi", kind: "bank" }]);
  }
}

// ---- posting ------------------------------------------------------------------------------------------------------
const rowsOfEntry = (lines: Line[], entryNo: number): Line[] => lines.filter((l) => l.entryNo === entryNo);
const spec = (l: Line): LineSpec => [l.account, l.debit, l.credit];

/** Validates every entry, chains them after the current head and appends them to the journal in one write. */
export function postEntries(entries: EntrySpec[]): number[] {
  if (!ledgerReady()) throw new Error(`"${JOURNAL.sheet}" varag'i yo'q. Menyudan: nazoratly > Boshlang'ich sozlash.`);
  ensureChart();
  const accounts: Record<string, boolean> = Object.fromEntries(readChart().map((a) => [a.code, a.active]));
  const closed = closedMonths();
  let head = headOf(journalLines());
  const out: Line[] = [];
  const numbers: number[] = [];
  for (const e of entries) {
    const memo = e.memo.trim().slice(0, 500);
    if (!isIsoDate(e.date)) throw new Error(`Sana noto'g'ri: "${e.date}"`);
    const errors = validateEntry(e.lines, accounts, { date: e.date, closedMonths: closed });
    if (errors.length) throw new LedgerError(errors);
    if (e.lines.some(([, d, c]) => d % SOM !== 0 || c % SOM !== 0)) throw new Error("Jurnalga faqat butun so'm yoziladi.");
    const sealed = sealEntry(head, { date: e.date, memo, sourceType: e.sourceType, sourceKey: e.sourceKey, lines: e.lines });
    head = nextHead(sealed);
    out.push(...sealed);
    numbers.push(head.entryNo);
  }
  append(JOURNAL, out.map(toRow));
  return numbers;
}

// ---- source documents ---------------------------------------------------------------------------------------------
/** Gives every row without an ID the next free one (hand-typed payments and expenses have none). */
export function fillMissingIds(def: TableDef, prefix: string): void {
  const sh = SpreadsheetApp.getActive().getSheetByName(def.sheet);
  if (!sh || sh.getLastRow() < 2) return;
  const idHeader = def.cols.find((c) => c.key === "id")!.header;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] as unknown[];
  const col = head.findIndex((h) => String(h).trim() === idHeader);
  if (col < 0) return;
  const data = sh.getDataRange().getValues();
  const used: string[] = data.slice(1).map((r) => String(r[col] ?? "").trim()).filter(Boolean);
  data.forEach((row, i) => {
    if (i === 0 || String(row[col] ?? "").trim() !== "" || row.every((c) => c === "" || c == null)) return;
    const id = nextId(prefix, used);
    used.push(id);
    sh.getRange(i + 1, col + 1).setValue(id);
  });
}

const paymentMethod = (m: string): string => (["naqd", "cash"].includes(m.trim().toLowerCase()) ? "cash" : "other");
const tiyin = (som: number): number => Math.round(som) * SOM;
const sourceId = (type: string, key: string): string => postedKey(type, key);

interface PayRowLite { month: string; teacherId: string; teacherName: string; total: number; status: string }
interface BillPayRowLite { id: string; billId: string; date: string; amount: number; paidFrom: string; voided: boolean }

export function collectSources(): { sources: Source[]; memos: Map<string, string> } {
  const sources: Source[] = [];
  const memos = new Map<string, string>();
  const names = new Map(read<Student>(STUDENTS).map((s) => [s.id, s.fullName]));
  const add = (s: Source, memo: string): void => {
    sources.push(s);
    memos.set(sourceId(s.type, s.key), memo);
  };
  for (const p of read<Payment>(PAYMENTS)) {
    if (p.demo === true) continue; // demo money never enters the books (the journal is immutable)
    if (!p.id || !isIsoDate(p.paidOn) || !(p.amount > 0)) continue; // hand-edited junk is ignored, never posted
    add({ type: "payment", key: p.id, date: p.paidOn, amount: tiyin(p.amount), voided: p.voided, method: paymentMethod(p.method) }, `To'lov ${p.id}: ${names.get(p.studentId) ?? p.studentId} (${p.method || "Naqd"})`);
  }
  for (const x of readIfPresent<Expense>(EXPENSES)) {
    if (x.demo === true) continue;
    if (!x.id || !isIsoDate(x.date) || !(x.amount > 0)) continue;
    add({ type: "expense", key: x.id, date: x.date, amount: tiyin(x.amount), voided: x.voided, category: x.category, paidFrom: x.paidFrom || "cash", bill: Boolean(x.billId) }, `Xarajat ${x.id}: ${x.category}${x.note ? ` (${x.note})` : ""}`);
  }
  for (const b of readIfPresent<BillPayRowLite>(BILL_PAYMENTS)) {
    if (!b.id || !isIsoDate(b.date) || !(b.amount > 0)) continue;
    add({ type: "bill_payment", key: b.id, date: b.date, amount: tiyin(b.amount), voided: b.voided, paidFrom: b.paidFrom || "cash" }, `Ta'minotchiga to'lov ${b.id} (hisob ${b.billId})`);
  }
  for (const r of readIfPresent<Refund & { demo?: boolean }>(REFUNDS)) {
    if (r.demo === true) continue; // demo money never enters the books
    if (!r.id || !isIsoDate(r.date) || !(r.amount > 0) || r.payout === "credit") continue; // a refund kept as credit moves no money
    add({ type: "refund", key: r.id, date: r.date, amount: tiyin(r.amount), voided: false, payout: r.payout }, `Qaytarish ${r.id}: ${names.get(r.studentId) ?? r.studentId} (${r.kind}, ${r.payout})`);
  }
  for (const r of readIfPresent<PayRowLite>(PAYROLL)) {
    if (r.status !== "approved" && r.status !== "paid") continue;
    const key = `${r.month.slice(0, 7)}:${r.teacherId}`;
    // a payroll row carries no approval date: it is dated the day the script first sees it
    add({ type: "payroll_accrual", key, date: today(), amount: tiyin(r.total), voided: false }, `O'qituvchi oyligi hisoblandi: ${r.teacherName} (${r.month.slice(0, 7)})`);
    if (r.status === "paid") add({ type: "payroll_payment", key, date: today(), amount: tiyin(r.total), voided: false }, `O'qituvchi oyligi to'landi: ${r.teacherName} (${r.month.slice(0, 7)})`);
  }
  return { sources, memos };
}

export function pendingList(): PendingItem[] {
  const { sources } = collectSources();
  return pendingPostings(sources, postedSet(journalLines()), today());
}

export interface SyncResult { posted: number; reversed: number; blocked: { sourceType: string; sourceKey: string; date: string }[] }

/** Posts what is missing and reverses voided documents; entries that would land in a closed month are only reported. */
export function syncLedger(only?: (item: PendingItem) => boolean): SyncResult {
  return withLock(() => {
    if (!ledgerReady()) throw new Error(`"${JOURNAL.sheet}" varag'i yo'q. Menyudan: nazoratly > Boshlang'ich sozlash.`);
    ensureChart();
    fillMissingIds(PAYMENTS, "P");
    if (hasSheet(EXPENSES)) fillMissingIds(EXPENSES, "X");
    const { sources, memos } = collectSources();
    const lines = journalLines();
    const closed = closedMonths();
    const specs: EntrySpec[] = [];
    const blocked: SyncResult["blocked"] = [];
    let posted = 0;
    let reversed = 0;
    for (const item of pendingPostings(sources, postedSet(lines), today())) {
      if (only && !only(item)) continue;
      if (closed.has(item.date.slice(0, 7))) {
        blocked.push({ sourceType: item.sourceType, sourceKey: item.sourceKey, date: item.date });
        continue;
      }
      if (item.kind === "post") {
        specs.push({ date: item.date, memo: memos.get(sourceId(item.sourceType, item.sourceKey)) ?? `${item.sourceType} ${item.sourceKey}`, sourceType: item.sourceType, sourceKey: item.sourceKey, lines: item.lines });
        posted++;
      } else {
        const base = item.sourceType.replace(/_void$/, "");
        const orig = lines.filter((l) => l.sourceType === base && l.sourceKey === item.sourceKey);
        if (orig.length === 0) continue;
        specs.push({ date: item.date, memo: `Bekor qilish: ${orig[0]!.memo}`, sourceType: item.sourceType, sourceKey: item.sourceKey, lines: reverseLines(orig.map(spec)) });
        reversed++;
      }
    }
    if (specs.length) postEntries(specs);
    return { posted, reversed, blocked };
  });
}

/** Called right after a payment is recorded: posts the payments that are still missing. A person who is not a protection
 * editor cannot write the journal; then the payment stays recorded and the entry is posted by the next sync. */
export function tryPostPayments(): string {
  if (!ledgerReady()) return "";
  try {
    syncLedger((i) => i.sourceType.startsWith("payment"));
    return "";
  } catch (e) {
    return `Jurnalga o'tkazilmadi (${e instanceof Error ? e.message : String(e)}). Menyu: Buxgalteriya > Kutayotganlarni o'tkazish.`;
  }
}

/** Called right after a refund is recorded: posts the refunds that are still missing (same fallback as payments). */
export function tryPostRefunds(): string {
  if (!ledgerReady()) return "";
  try {
    syncLedger((i) => i.sourceType.startsWith("refund"));
    return "";
  } catch (e) {
    return `Jurnalga o'tkazilmadi (${e instanceof Error ? e.message : String(e)}). Menyu: Buxgalteriya > Kutayotganlarni o'tkazish.`;
  }
}

/** What the books say the cash desk holds through `through` (all cash-kind accounts), in so'm, the last journal line, and
 * the cash that came in and went out on that very day. */
export function cashBookBalance(through: string): { balance: number; seq: number; cashIn: number; cashOut: number } {
  const kinds = readIfPresent<CashRow>(CASH_ACCOUNTS).filter((c) => c.kind === "cash").map((c) => c.code);
  const codes = new Set(kinds.length ? kinds : ["1000"]);
  const lines = journalLines();
  const mine = lines.filter((l) => codes.has(l.account));
  const upTo = mine.filter((l) => l.date <= through);
  const day = mine.filter((l) => l.date === through);
  return {
    balance: upTo.reduce((n, l) => n + l.debit - l.credit, 0) / SOM,
    seq: lines.length ? lines[lines.length - 1]!.seq : 0,
    cashIn: day.reduce((n, l) => n + l.debit, 0) / SOM,
    cashOut: day.reduce((n, l) => n + l.credit, 0) / SOM,
  };
}

/** Books the difference found at a cash close (more cash than booked = other income, less = shortage); returns the entry number. */
export function postCashDifference(date: string, closeId: string, difference: number): number {
  const lines = postingLines({ event: "cash_close", direction: difference > 0 ? "over" : "short", amount: tiyin(Math.abs(difference)) });
  const [no] = postEntries([{ date, memo: `Kassa farqi (${difference > 0 ? "ortiqcha" : "kamomad"}): smena ${closeId}`, sourceType: "cash_close", sourceKey: closeId, lines }]);
  return no!;
}

// ---- manual entries and reversals ---------------------------------------------------------------------------------
export const askText = (title: string, label: string): string => {
  const r = ui().prompt(title, label, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  return r.getResponseText().trim();
};

/** "1000 D 500000; 3000 K 500000" (one line per row or separated by ;). D = debet, K = kredit. */
export function parseManualLines(text: string): LineSpec[] {
  const rows = text.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  return rows.map((row) => {
    const m = /^(\d{3,8})\s+(d|dt|debet|k|kt|kredit)\s+(\d+)$/i.exec(row);
    if (!m) throw new Error(`Qator tushunarsiz: "${row}". Format: 1000 D 500000 yoki 3000 K 500000`);
    const amount = Number(m[3]) * SOM;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Summa noto'g'ri: "${row}"`);
    return m[2]!.toLowerCase().startsWith("d") ? [m[1]!, amount, 0] : [m[1]!, 0, amount];
  });
}

export function manualEntry(input?: { date: string; memo: string; linesText: string }): number {
  const date = input?.date ?? askText("Qo'lda yozuv", `Sana (yyyy-mm-dd). Bugun: ${today()}`);
  const memo = input?.memo ?? askText("Qo'lda yozuv", "Izoh");
  const linesText = input?.linesText ?? askText("Qo'lda yozuv", "Qatorlar: hisob kodi, D (debet) yoki K (kredit), summa. Masalan:\n1000 D 500000; 3000 K 500000");
  if (!memo) throw new Error("Izoh kiritilmadi.");
  if (date > today()) throw new Error("Yozuv kelajak sanasi bilan yozilmaydi.");
  const [no] = withLock(() => postEntries([{ date, memo, sourceType: "manual", sourceKey: "", lines: parseManualLines(linesText) }]));
  return no!;
}

/** Corrects a manual entry by posting its exact reversal (nothing is ever edited or deleted). */
export function reverseManual(entryNo?: number, date?: string): number {
  const n = entryNo ?? Number(askText("Teskari yozuv", "Bekor qilinadigan yozuv raqami (Jurnal, 'Yozuv №')"));
  const on = date ?? today();
  const [no] = withLock(() => {
    const lines = journalLines();
    const orig = rowsOfEntry(lines, n);
    if (orig.length === 0) throw new Error(`Yozuv topilmadi: ${n}`);
    if (orig[0]!.sourceType !== "manual") throw new Error("To'lov, xarajat, ta'minotchi yoki oylik yozuvlari shu hujjatni bekor qilish orqali tuzatiladi.");
    if (lines.some((l) => l.sourceType === "reversal" && l.sourceKey === String(n))) throw new Error("Bu yozuv allaqachon bekor qilingan.");
    if (on > today()) throw new Error("Teskari yozuv kelajak sanasi bilan yozilmaydi.");
    return postEntries([{ date: on, memo: `Bekor qilish: #${n} ${orig[0]!.memo}`, sourceType: "reversal", sourceKey: String(n), lines: reverseLines(orig.map(spec)) }]);
  });
  return no!;
}

// ---- chart ----------------------------------------------------------------------------------------------------------
export function addAccount(code: string, name: string, type: string): void {
  withLock(() => {
    ensureChart();
    if (!/^\d{3,8}$/.test(code)) throw new Error("Hisob kodi 3-8 raqamdan iborat bo'lishi kerak.");
    if (!["asset", "liability", "equity", "income", "expense"].includes(type)) throw new Error(`Hisob turi noto'g'ri: ${type}`);
    if (!name.trim()) throw new Error("Hisob nomi kiritilmadi.");
    if (readChart().some((a) => a.code === code)) throw new Error(`Hisob ${code} allaqachon bor.`);
    append(CHART_ACCOUNTS, [{ code, name: name.trim(), type, active: true }]);
  });
}

export function balanceOf(code: string, lines = journalLines()): number {
  return lines.filter((l) => l.account === code).reduce((n, l) => n + l.debit - l.credit, 0);
}

export function setAccountActive(code: string, active: boolean): void {
  withLock(() => {
    if (!readChart().some((a) => a.code === code)) throw new Error(`Hisob topilmadi: ${code}`);
    if (!active && balanceOf(code) !== 0) throw new Error("Qoldig'i bor hisobni faolsizlantirib bo'lmaydi.");
    updateById(CHART_ACCOUNTS, "code", code, { active });
  });
}

export function addCashAccount(code: string, name: string, kind: "cash" | "bank"): void {
  withLock(() => {
    ensureChart();
    const acc = readChart().find((a) => a.code === code);
    if (acc && acc.type !== "asset") throw new Error("Pul hisobi aktiv hisob bo'lishi kerak.");
    if (readIfPresent<CashRow>(CASH_ACCOUNTS).some((c) => c.code === code)) throw new Error("Bu hisob allaqachon pul hisobi.");
    if (!acc) append(CHART_ACCOUNTS, [{ code, name, type: "asset", active: true }]);
    append(CASH_ACCOUNTS, [{ code, name, kind }]);
  });
}

// ---- verification, closing --------------------------------------------------------------------------------------------
export function verifyJournal(): { verdict: Verdict; lines: number; message: string } {
  const lines = journalLines();
  const verdict = verifyChain(lines, periods());
  let message: string;
  if (verdict.ok) message = `Jurnal to'g'ri: ${lines.length} qator, hash zanjiri va ${periods().length} ta yopilgan davr tekshirildi.`;
  else {
    const parts: string[] = [];
    if (verdict.brokenSeq !== null) parts.push(`XATO: jurnalning birinchi buzilgan qatori №${verdict.brokenSeq}: ${REASON_TEXT[verdict.reason ?? ""] ?? verdict.reason}.`);
    for (const p of verdict.periodIssues) parts.push(`Davr ${p.month}: ${REASON_TEXT[p.reason] ?? p.reason}${p.seq ? ` (qator №${p.seq})` : ""}.`);
    message = parts.join("\n");
  }
  return { verdict, lines: lines.length, message };
}

export function closePeriod(month?: string): string {
  const m = (month ?? askText("Davrni yopish", "Yopiladigan oy (yyyy-mm). Faqat tugagan oy yopiladi, qayta ochib bo'lmaydi.")).slice(0, 7);
  return withLock(() => {
    if (!isIsoDate(`${m}-01`)) throw new Error(`Noto'g'ri oy: "${m}". Format: 2026-10`);
    if (!hasSheet(PERIODS)) throw new Error(`"${PERIODS.sheet}" varag'i yo'q. Menyudan: nazoratly > Boshlang'ich sozlash.`);
    if (`${m}-01` >= monthStart(today())) throw new Error("Faqat tugagan oyni yopish mumkin.");
    if (closedMonths().has(m)) throw new Error(`${m} allaqachon yopilgan.`);
    const unposted = pendingList().filter((i) => i.kind === "post" && i.date.slice(0, 7) <= m);
    if (unposted.length) throw new Error(`${unposted.length} ta hujjat hali jurnalga o'tkazilmagan: avval Buxgalteriya > Kutayotganlarni o'tkazish.`);
    const verdict = verifyJournal();
    if (!verdict.verdict.ok) throw new Error(`Jurnal tekshiruvdan o'tmadi, yopib bo'lmaydi.\n${verdict.message}`);
    const p = makePeriod(m, journalLines());
    append(PERIODS, [{ month: p.month, lastSeq: p.lastSeq, headHash: p.headHash, totalDebit: p.totalDebit / SOM, totalCredit: p.totalCredit / SOM, periodHash: p.periodHash, closedOn: today() }]);
    return `${m} yopildi: ${p.lastSeq} qator, davr hashi ${p.periodHash.slice(0, 12)}...`;
  });
}

// ---- reports ---------------------------------------------------------------------------------------------------------
export function totalsOf(lines: Line[], opts: { from?: string; to: string }): Totals {
  const t: Totals = {};
  for (const l of lines) {
    if (l.date > opts.to || (opts.from && l.date < opts.from)) continue;
    const cur = t[l.account] ?? [0, 0];
    t[l.account] = [cur[0] + l.debit, cur[1] + l.credit];
  }
  return t;
}
const chartInfo = (): ChartInfo[] => readChart().map((a) => ({ code: a.code, name: a.name, type: a.type }));
const som = (s: string): number => parseMoney(s) / SOM;

export function writeReport(title: string, rows: (string | number)[][]): void {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(REPORT_SHEET) ?? ss.insertSheet(REPORT_SHEET);
  sh.clear();
  const width = Math.max(1, ...rows.map((r) => r.length));
  const all = [[title], ...rows].map((r) => [...r, ...Array.from({ length: width - r.length }, () => "")]);
  sh.getRange(1, 1, all.length, width).setValues(all);
  sh.getRange(1, 1, 1, width).setFontWeight("bold").setFontSize(14);
  sh.setTabColor("#202124");
  sh.activate();
}

export type ReportKind = "trial" | "income" | "balance" | "ledger";

export function buildReport(kind: ReportKind, o: { asOf?: string; from?: string; to?: string; account?: string } = {}): { title: string; rows: (string | number)[][] } {
  const lines = journalLines();
  const chart = chartInfo();
  const asOf = o.asOf ?? today();
  if (kind === "trial") {
    const r = trialBalance(totalsOf(lines, { to: asOf }), chart);
    return { title: `Sinov balansi, ${asOf} holatiga`, rows: [["Kod", "Hisob", "Turi", "Debet", "Kredit", "Qoldiq (debet)", "Qoldiq (kredit)"], ...r.rows.map((x) => [x.code!, x.name!, x.type!, som(x.debit!), som(x.credit!), som(x.balance_debit!), som(x.balance_credit!)]), ["", "JAMI", "", som(r.total_debit), som(r.total_credit), som(r.total_balance_debit), som(r.total_balance_credit)], ["", r.balanced ? "Debet kreditga teng" : "DIQQAT: debet kreditga teng emas", "", "", "", "", ""]] };
  }
  if (kind === "income") {
    const from = o.from ?? monthStart(today());
    const to = o.to ?? today();
    const r = incomeStatement(totalsOf(lines, { from, to }), chart);
    return { title: `Foyda va zarar hisoboti, ${from} - ${to}`, rows: [["Kod", "Daromad", "Summa"], ...r.income.map((x) => [x.code, x.name, som(x.amount)]), ["", "Jami daromad", som(r.total_income)], ["", "", ""], ["Kod", "Xarajat", "Summa"], ...r.expenses.map((x) => [x.code, x.name, som(x.amount)]), ["", "Jami xarajat", som(r.total_expenses)], ["", "", ""], ["", "SOF NATIJA", som(r.net)]] };
  }
  if (kind === "balance") {
    const r = balanceSheet(totalsOf(lines, { to: asOf }), chart);
    const part = (name: string, rows: { code: string; name: string; amount: string }[], total: number): (string | number)[][] => [[name, "", ""], ...rows.map((x) => [x.code, x.name, som(x.amount)]), ["", `Jami ${name.toLowerCase()}`, total], ["", "", ""]];
    return { title: `Balans, ${asOf} holatiga`, rows: [...part("Aktivlar", r.assets, som(r.total_assets)), ...part("Majburiyatlar", r.liabilities, som(r.total_liabilities)), ["Kapital", "", ""], ...r.equity.map((x) => [x.code, x.name, som(x.amount)]), ["", "Joriy natija (daromad - xarajat)", som(r.current_result)], ["", "Jami kapital", som(r.total_equity)], ["", "", ""], ["", r.balanced ? "Aktiv = majburiyat + kapital" : "DIQQAT: balans tenglashmadi", ""]] };
  }
  const code = o.account;
  if (!code) throw new Error("Hisob kodi kiritilmadi.");
  const acc = chart.find((a) => a.code === code);
  if (!acc) throw new Error(`Hisob topilmadi: ${code}`);
  const side = normalSide(acc.type);
  const from = o.from ?? "";
  const to = o.to ?? today();
  const opening = lines.filter((l) => l.account === code && from && l.date < from).reduce((n, l) => n + (side === "debit" ? l.debit - l.credit : l.credit - l.debit), 0);
  const mine = lines.filter((l) => l.account === code && l.date <= to && (!from || l.date >= from));
  const st = accountStatement(opening, side, mine.map((l) => ({ seq: l.seq, date: l.date, debit: l.debit, credit: l.credit })));
  const memo = new Map(mine.map((l) => [l.seq, l.memo]));
  return { title: `Hisob kartochkasi ${code} ${acc.name}`, rows: [["№", "Sana", "Izoh", "Debet", "Kredit", "Qoldiq"], ["", "", "Boshlang'ich qoldiq", "", "", som(st.opening)], ...st.rows.map((r) => [r.seq, r.date, memo.get(r.seq) ?? "", som(r.debit), som(r.credit), som(r.balance)]), ["", "", "Oxirgi qoldiq", "", "", som(st.closing)]] };
}

export function showReport(kind: ReportKind, o: Parameters<typeof buildReport>[1] = {}): void {
  const r = buildReport(kind, o);
  writeReport(r.title, r.rows);
}

// ---- protection --------------------------------------------------------------------------------------------------------
/** Protects the ledger sheets so that only the script's owner (and the emails in Sozlamalar) can write. Idempotent. */
export function protectLedgerSheets(): number {
  const ss = SpreadsheetApp.getActive();
  const emails = readSettings().ledgerEditors.split(/[,;\s]+/).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e));
  const me = Session.getEffectiveUser();
  let n = 0;
  for (const def of LEDGER_TABLES) {
    const sh = ss.getSheetByName(def.sheet);
    if (!sh) continue;
    for (const old of sh.getProtections(SpreadsheetApp.ProtectionType.SHEET)) if (old.getDescription().startsWith(PROTECT_TAG)) old.remove();
    const p = sh.protect().setDescription(`${PROTECT_TAG}: ${def.sheet}. Faqat skript yozadi.`);
    p.removeEditors(p.getEditors()); // the owner stays: an owner cannot be removed
    p.addEditor(me);
    if (emails.length) p.addEditors(emails);
    if (p.canDomainEdit()) p.setDomainEdit(false);
    n++;
  }
  return n;
}

// ---- menus ---------------------------------------------------------------------------------------------------------------
export const menu = {
  sync: (): void =>
    guard("Buxgalteriya", () => {
      const r = syncLedger();
      const blocked = r.blocked.length ? `\nYopilgan oyga tushgani uchun o'tkazilmadi: ${r.blocked.length} ta (${r.blocked.slice(0, 5).map((b) => `${b.sourceType} ${b.sourceKey}`).join(", ")})` : "";
      ui().alert("Kutayotganlarni o'tkazish", `Jurnalga o'tkazildi: ${r.posted} ta, teskari yozuv: ${r.reversed} ta.${blocked}`, ui().ButtonSet.OK);
    }),
  verify: (): void => guard("Jurnalni tekshirish", () => ui().alert("Jurnalni tekshirish", verifyJournal().message, ui().ButtonSet.OK)),
  manual: (): void => guard("Qo'lda yozuv", () => ui().alert("Qo'lda yozuv", `Yozuv №${manualEntry()} jurnalga yozildi.`, ui().ButtonSet.OK)),
  reverse: (): void => guard("Teskari yozuv", () => ui().alert("Teskari yozuv", `Teskari yozuv №${reverseManual()} yozildi.`, ui().ButtonSet.OK)),
  close: (): void => guard("Davrni yopish", () => ui().alert("Davrni yopish", closePeriod(), ui().ButtonSet.OK)),
  addAccount: (): void =>
    guard("Hisob qo'shish", () => {
      addAccount(askText("Hisob qo'shish", "Kod (3-8 raqam)"), askText("Hisob qo'shish", "Nomi"), askText("Hisob qo'shish", "Turi: asset, liability, equity, income yoki expense"));
      toast("Hisob qo'shildi.");
    }),
  addCash: (): void =>
    guard("Pul hisobi", () => {
      const kind = askText("Pul hisobi", "Turi: cash (kassa) yoki bank").toLowerCase();
      if (kind !== "cash" && kind !== "bank") throw new Error("Tur cash yoki bank bo'lishi kerak.");
      addCashAccount(askText("Pul hisobi", "Hisob kodi (masalan 1020)"), askText("Pul hisobi", "Nomi"), kind);
      toast("Pul hisobi qo'shildi.");
    }),
  trial: (): void => guard("Sinov balansi", () => showReport("trial", { asOf: askText("Sinov balansi", `Sana (yyyy-mm-dd), bo'sh = bugun`) || undefined })),
  income: (): void => guard("Foyda va zarar", () => showReport("income", { from: askText("Foyda va zarar", "Boshlanish sanasi (bo'sh = shu oy boshi)") || undefined, to: askText("Foyda va zarar", "Tugash sanasi (bo'sh = bugun)") || undefined })),
  balance: (): void => guard("Balans", () => showReport("balance", { asOf: askText("Balans", "Sana (yyyy-mm-dd), bo'sh = bugun") || undefined })),
  ledger: (): void => guard("Hisob kartochkasi", () => showReport("ledger", { account: askText("Hisob kartochkasi", "Hisob kodi (masalan 1000)") })),
  protect: (): void => guard("Himoya", () => ui().alert("Himoya", `${protectLedgerSheets()} ta varaq himoyalandi: faqat ega va Sozlamalardagi emaillar yoza oladi.`, ui().ButtonSet.OK)),
};

const toast = (msg: string): void => SpreadsheetApp.getActive().toast(msg, "nazoratly", 6);
