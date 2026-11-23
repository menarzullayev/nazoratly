/** Reconciliation of a cash/bank account with its statement in the Sheets edition (rules: ../domain/accounting.ts
 * matchStatement, statementFoots, reconciliationSummary, shared with the API product through tests/golden/accounting.json).
 * A statement is finalized only when it foots, every line is matched and the closing balance equals the ledger balance. */
import { matchStatement, reconciliationSummary, statementFoots } from "../domain/accounting";
import { isIsoDate } from "../domain/dates";
import { nextId } from "../domain/ids";
import { guard, withLock } from "./actions";
import { askText, balanceOf, journalLines, writeReport } from "./ledger";
import { append, readIfPresent, replaceWhere, today, updateById } from "./repo";
import { CASH_ACCOUNTS, STATEMENT_LINES, STATEMENTS } from "./schema";

const SOM = 100;
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const addDays = (iso: string, n: number): string => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + n)).toISOString().slice(0, 10);

export interface Statement { id: string; accountCode: string; from: string; to: string; opening: number; closing: number; status: "open" | "finalized" }
export interface StatementLine { statementId: string; no: number; date: string; description: string; amount: number; matchedSeq: number }

export const statements = (): Statement[] => readIfPresent<Statement>(STATEMENTS);
const linesOf = (id: string): StatementLine[] => readIfPresent<StatementLine>(STATEMENT_LINES).filter((l) => l.statementId === id).sort((a, b) => a.no - b.no);

function openStatement(id: string): Statement {
  const s = statements().find((x) => x.id === id);
  if (!s) throw new Error(`Ko'chirma topilmadi: ${id}`);
  if (s.status === "finalized") throw new Error("Ko'chirma yopilgan: o'zgartirib bo'lmaydi.");
  return s;
}

export function createStatement(input: { accountCode: string; from: string; to: string; opening: number; closing: number }): string {
  return withLock(() => {
    if (!readIfPresent<{ code: string }>(CASH_ACCOUNTS).some((c) => c.code === input.accountCode)) throw new Error(`Pul hisobi topilmadi: ${input.accountCode}`);
    if (!isIsoDate(input.from) || !isIsoDate(input.to)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
    if (input.to < input.from) throw new Error("Davr oxiri boshidan oldin bo'lishi mumkin emas.");
    if (!Number.isInteger(input.opening) || !Number.isInteger(input.closing)) throw new Error("Qoldiqlar butun so'm bo'lishi kerak.");
    const id = nextId("K", statements().map((s) => s.id));
    append(STATEMENTS, [{ id, accountCode: input.accountCode, from: input.from, to: input.to, opening: input.opening, closing: input.closing, status: "open" }]);
    return id;
  });
}

export function addStatementLines(id: string, lines: { date: string; description?: string; amount: number }[]): number {
  return withLock(() => {
    openStatement(id);
    if (lines.length === 0) throw new Error("Satr yo'q.");
    let no = linesOf(id).reduce((n, l) => Math.max(n, l.no), 0);
    const rows = lines.map((l) => {
      if (!isIsoDate(l.date)) throw new Error(`Sana noto'g'ri: "${l.date}"`);
      if (!Number.isInteger(l.amount) || l.amount === 0) throw new Error("Summa noldan farqli butun son bo'lishi kerak (kirim musbat, chiqim manfiy).");
      return { statementId: id, no: ++no, date: l.date, description: l.description ?? "", amount: l.amount, matchedSeq: 0 };
    });
    append(STATEMENT_LINES, rows);
    return rows.length;
  });
}

/** Ledger lines of the statement's account that no statement line has taken yet. */
function freeLedgerLines(s: Statement, from: string, to: string): { seq: number; date: string; amount: number; memo: string }[] {
  const taken = new Set(readIfPresent<StatementLine>(STATEMENT_LINES).filter((l) => l.matchedSeq > 0).map((l) => l.matchedSeq));
  return journalLines().filter((l) => l.account === s.accountCode && l.date >= from && l.date <= to && !taken.has(l.seq)).map((l) => ({ seq: l.seq, date: l.date, amount: l.debit - l.credit, memo: l.memo }));
}

export interface ReconState { ledgerBalance: number; difference: number; foots: boolean; unmatchedStatement: number; unmatchedLedger: { seq: number; date: string; amount: number; memo: string }[]; reconciled: boolean }

export function reconciliation(id: string): ReconState {
  const s = statements().find((x) => x.id === id);
  if (!s) throw new Error(`Ko'chirma topilmadi: ${id}`);
  const lines = linesOf(id);
  const free = freeLedgerLines(s, s.from, s.to);
  const foots = statementFoots(s.opening * SOM, s.closing * SOM, lines.map((l) => ({ amount: l.amount * SOM })));
  const ledger = balanceOf(s.accountCode, journalLines().filter((l) => l.date <= s.to));
  const unmatched = lines.filter((l) => l.matchedSeq === 0).length;
  const sum = reconciliationSummary(s.closing * SOM, ledger, unmatched, free.length, foots);
  return { ledgerBalance: ledger / SOM, difference: (s.closing * SOM - ledger) / SOM, foots, unmatchedStatement: unmatched, unmatchedLedger: free.map((l) => ({ ...l, amount: l.amount / SOM })), reconciled: sum.reconciled };
}

export function autoMatch(id: string, toleranceDays = 3): number {
  return withLock(() => {
    const s = openStatement(id);
    if (!Number.isInteger(toleranceDays) || toleranceDays < 0 || toleranceDays > 30) throw new Error("Tolerantlik 0-30 kun.");
    const lines = linesOf(id);
    const pending = lines.filter((l) => l.matchedSeq === 0);
    const res = matchStatement(pending.map((l) => ({ id: String(l.no), date: l.date, amount: l.amount * SOM })), freeLedgerLines(s, addDays(s.from, -toleranceDays), addDays(s.to, toleranceDays)).map((l) => ({ seq: l.seq, date: l.date, amount: l.amount })), toleranceDays);
    const by = new Map(res.matches.map((m) => [Number(m.statement_line), m.seq]));
    replaceWhere<StatementLine>(STATEMENT_LINES, (r) => r.statementId === id, lines.map((l) => ({ ...l, matchedSeq: by.get(l.no) ?? l.matchedSeq })));
    return res.matches.length;
  });
}

export function matchLine(id: string, no: number, seq: number): void {
  withLock(() => {
    const s = openStatement(id);
    const lines = linesOf(id);
    const line = lines.find((l) => l.no === no);
    if (!line) throw new Error(`Satr topilmadi: ${no}`);
    if (line.matchedSeq > 0) throw new Error("Satr allaqachon moslangan: avval moslashni bekor qiling.");
    const target = journalLines().find((l) => l.seq === seq);
    if (!target || target.account !== s.accountCode) throw new Error("Bu jurnal qatori ko'chirma hisobiga tegishli emas.");
    if (readIfPresent<StatementLine>(STATEMENT_LINES).some((l) => l.matchedSeq === seq)) throw new Error("Bu jurnal qatori boshqa ko'chirma satriga moslangan.");
    replaceWhere<StatementLine>(STATEMENT_LINES, (r) => r.statementId === id, lines.map((l) => (l.no === no ? { ...l, matchedSeq: seq } : l)));
  });
}

export function unmatchLine(id: string, no: number): void {
  withLock(() => {
    openStatement(id);
    const lines = linesOf(id);
    if (!lines.some((l) => l.no === no)) throw new Error(`Satr topilmadi: ${no}`);
    replaceWhere<StatementLine>(STATEMENT_LINES, (r) => r.statementId === id, lines.map((l) => (l.no === no ? { ...l, matchedSeq: 0 } : l)));
  });
}

export function finalizeStatement(id: string): void {
  withLock(() => {
    openStatement(id);
    const r = reconciliation(id);
    if (!r.reconciled) {
      throw new Error(`Ko'chirma hali mos emas: ${r.foots ? "" : "qoldiqlar yig'indisi mos kelmaydi; "}moslanmagan satr: ${r.unmatchedStatement}, jurnalda moslanmagan: ${r.unmatchedLedger.length}, farq: ${r.difference}.`);
    }
    updateById(STATEMENTS, "id", id, { status: "finalized" });
  });
}

export function showReconciliation(id: string): void {
  const s = statements().find((x) => x.id === id);
  if (!s) throw new Error(`Ko'chirma topilmadi: ${id}`);
  const r = reconciliation(id);
  writeReport(`Ko'chirma ${id} (${s.accountCode}, ${s.from} - ${s.to}) solishtirish`, [
    ["Boshlang'ich qoldiq", s.opening], ["Oxirgi qoldiq", s.closing], ["Jurnal qoldig'i", r.ledgerBalance], ["Farq", r.difference],
    ["Qoldiqlar yig'indisi mos", r.foots ? "Ha" : "Yo'q"], ["Moslanmagan ko'chirma satrlari", r.unmatchedStatement], ["Moslanmagan jurnal qatorlari", r.unmatchedLedger.length], ["NATIJA", r.reconciled ? "Mos" : "Mos emas"],
    ["", ""], ["Moslanmagan jurnal qatorlari: №", "Sana", "Izoh", "Summa"],
    ...r.unmatchedLedger.map((l) => [l.seq, l.date, l.memo, l.amount]),
  ]);
}

const askNumber = (title: string, label: string): number => {
  const n = Number(askText(title, label).replace(/[\s,]/g, ""));
  if (!Number.isFinite(n)) throw new Error("Son kiriting.");
  return n;
};

export const menu = {
  create: (): void =>
    guard("Ko'chirma", () => {
      const id = createStatement({ accountCode: askText("Ko'chirma", "Pul hisobi kodi (1000, 1010 ...)"), from: askText("Ko'chirma", "Davr boshi (yyyy-mm-dd)"), to: askText("Ko'chirma", `Davr oxiri (yyyy-mm-dd). Bugun: ${today()}`), opening: askNumber("Ko'chirma", "Boshlang'ich qoldiq"), closing: askNumber("Ko'chirma", "Oxirgi qoldiq") });
      ui().alert("Ko'chirma", `Ko'chirma ${id} ochildi. Satrlarni "Ko'chirma satrlari" varag'iga kiriting (Ko'chirma ID, №, Sana, Summa), so'ng "Avtomatik moslash" ni bosing.`, ui().ButtonSet.OK);
    }),
  auto: (): void => guard("Ko'chirma", () => ui().alert("Ko'chirma", `${autoMatch(askText("Ko'chirma", "Ko'chirma ID (K0001)"))} ta satr moslandi.`, ui().ButtonSet.OK)),
  status: (): void => guard("Ko'chirma", () => showReconciliation(askText("Ko'chirma", "Ko'chirma ID (K0001)"))),
  match: (): void => guard("Ko'chirma", () => matchLine(askText("Ko'chirma", "Ko'chirma ID"), askNumber("Ko'chirma", "Satr №"), askNumber("Ko'chirma", "Jurnal qatori №"))),
  unmatch: (): void => guard("Ko'chirma", () => unmatchLine(askText("Ko'chirma", "Ko'chirma ID"), askNumber("Ko'chirma", "Satr №"))),
  finalize: (): void => guard("Ko'chirma", () => { finalizeStatement(askText("Ko'chirma", "Ko'chirma ID (K0001)")); ui().alert("Ko'chirma", "Ko'chirma yopildi.", ui().ButtonSet.OK); }),
};
