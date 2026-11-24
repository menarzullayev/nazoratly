import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Expense, Payment, Student } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import * as ledger from "../src/gas/ledger";
import { append, read } from "../src/gas/repo";
import { BILL_PAYMENTS, CASH_ACCOUNTS, CHART_ACCOUNTS, EXPENSES, JOURNAL, LEDGER_TABLES, PAYMENTS, PAYROLL, PERIODS, SETTINGS_SHEET, STUDENTS, SUPPLIER_BILLS } from "../src/gas/schema";
import { loadSampleData, resetSampleData, setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;

const col = (key: string): number => JOURNAL.cols.findIndex((c) => c.key === key);
/** the data row (index into sheet data) of the journal line with this seq */
const rowOf = (seq: number): unknown[] => h.sheet("Jurnal").data.find((r, i) => i > 0 && r[col("seq")] === seq)!;
const journal = () => read<ledger.JournalRow>(JOURNAL);
const shape = (entryNo: number) => journal().filter((l) => l.entryNo === entryNo).map((l) => [l.account, l.debit, l.credit]);

const student = (): void => append(STUDENTS, [{ id: "S0001", fullName: "Ali Valiyev", status: "active", guardianName: "", guardianChatId: "", consentNotify: false } satisfies Student]);
const pay = (id: string, amount: number, paidOn: string, method = "Naqd", voided = false): void =>
  append(PAYMENTS, [{ id, studentId: "S0001", paidOn, amount, method, voided, note: "" } satisfies Payment]);
const expense = (id: string, date: string, amount: number, extra: Partial<Expense> = {}): void =>
  append(EXPENSES, [{ id, date, category: "rent", amount, note: "", voided: false, ...extra } satisfies Expense]);
const setSetting = (label: string, value: string): void => {
  const row = h.sheets.get(SETTINGS_SHEET)!.data.find((r) => r[0] === label)!;
  row[1] = value;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
  student();
});
afterEach(() => vi.useRealTimers());

describe("setup: chart, cash accounts and script-only protection", () => {
  it("creates the ledger sheets, seeds the chart and the two cash accounts", () => {
    for (const def of LEDGER_TABLES) expect(h.rows(def.sheet)[0]).toEqual(def.cols.map((c) => c.header));
    expect(read<ledger.ChartRow>(CHART_ACCOUNTS).map((a) => a.code)).toEqual(["1000", "1010", "2000", "2100", "3000", "4000", "4100", "4200", "5000", "5010", "5020", "5030", "5040", "5050", "5090", "5100", "5900"]);
    expect(read<{ code: string; kind: string }>(CASH_ACCOUNTS).map((c) => [c.code, c.kind])).toEqual([["1000", "cash"], ["1010", "bank"]]);
    expect(journal()).toEqual([]);
  });

  it("protects the four ledger sheets so that only the owner can write, and nothing else", () => {
    for (const def of LEDGER_TABLES) {
      const p = h.protections(def.sheet);
      expect(p).toHaveLength(1);
      expect(p[0]!.description).toContain("nazoratly:jurnal");
      expect(p[0]!.editors).toEqual(["owner@example.com"]); // the staff editor of the spreadsheet lost write access
    }
    expect(h.protections("Hisoblar")).toEqual([]);
  });

  it("protecting again replaces the protection (idempotent) and honours the editors listed in the settings", () => {
    setSetting("Jurnalga yozishi mumkin bo'lgan emaillar", "buxgalter@example.com, boshqa@example.com; noto'g'ri");
    expect(ledger.protectLedgerSheets()).toBe(6);
    expect(ledger.protectLedgerSheets()).toBe(6);
    for (const def of LEDGER_TABLES) {
      const p = h.protections(def.sheet);
      expect(p).toHaveLength(1);
      expect(p[0]!.editors.sort()).toEqual(["boshqa@example.com", "buxgalter@example.com", "owner@example.com"]);
    }
  });

  it("setup run again keeps the chart and the journal", () => {
    pay("P0001", 100_000, "2026-11-02");
    ledger.syncLedger();
    setupWorkbook();
    expect(read<ledger.ChartRow>(CHART_ACCOUNTS)).toHaveLength(17);
    expect(journal()).toHaveLength(2);
    expect(h.protections("Jurnal")).toHaveLength(1);
  });
});

describe("sync: automatic postings", () => {
  it("posts cash payments to 1000 and other methods to 1010, chained from the genesis hash", () => {
    pay("P0001", 300_000, "2026-11-02", "Naqd");
    pay("P0002", 250_000, "2026-11-03", "Karta");
    pay("P0003", 100_000, "2026-11-04", "Payme");
    expect(ledger.syncLedger()).toEqual({ posted: 3, reversed: 0, blocked: [] });
    expect([shape(1), shape(2), shape(3)]).toEqual([
      [["1000", 300_000, 0], ["4000", 0, 300_000]],
      [["1010", 250_000, 0], ["4000", 0, 250_000]],
      [["1010", 100_000, 0], ["4000", 0, 100_000]],
    ]);
    const rows = journal();
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[0]!.prevHash).toBe("0".repeat(64));
    expect(rows.slice(1).every((r, i) => r.prevHash === rows[i]!.hash)).toBe(true);
    expect(rows[0]!.memo).toBe("To'lov P0001: Ali Valiyev (Naqd)");
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("a second sync posts nothing", () => {
    pay("P0001", 300_000, "2026-11-02");
    ledger.syncLedger();
    const before = h.rows("Jurnal");
    expect(ledger.syncLedger()).toEqual({ posted: 0, reversed: 0, blocked: [] });
    expect(h.rows("Jurnal")).toEqual(before);
  });

  it("posts expenses from cash or bank, supplier-bill expenses against payables, and ignores voided ones that were never posted", () => {
    expense("X0001", "2026-11-03", 1_000_000);
    expense("X0002", "2026-11-04", 85_000, { category: "utilities", paidFrom: "bank" });
    expense("X0003", "2026-11-05", 200_000, { category: "equipment", billId: "H0001" });
    expense("X0004", "2026-11-06", 999, { voided: true });
    ledger.syncLedger();
    expect([shape(1), shape(2), shape(3)]).toEqual([
      [["5000", 1_000_000, 0], ["1000", 0, 1_000_000]],
      [["5010", 85_000, 0], ["1010", 0, 85_000]],
      [["5040", 200_000, 0], ["2000", 0, 200_000]],
    ]);
    expect(journal().some((l) => l.sourceKey === "X0004")).toBe(false);
  });

  it("voiding a posted payment or expense posts the exact reversal once", () => {
    pay("P0001", 300_000, "2026-11-02");
    expense("X0001", "2026-11-03", 50_000);
    ledger.syncLedger();
    h.sheet("To'lovlar").data[1]![6] = "Ha"; // voided column of the payments sheet
    h.sheet("Xarajatlar").data[1]![5] = "Ha";
    expect(ledger.syncLedger()).toEqual({ posted: 0, reversed: 2, blocked: [] });
    expect(journal().filter((l) => l.sourceType.endsWith("_void")).map((l) => [l.sourceType, l.date, l.account, l.debit, l.credit])).toEqual([
      ["payment_void", "2026-11-23", "1000", 0, 300_000],
      ["payment_void", "2026-11-23", "4000", 300_000, 0],
      ["expense_void", "2026-11-23", "5000", 0, 50_000],
      ["expense_void", "2026-11-23", "1000", 50_000, 0],
    ]);
    expect(ledger.syncLedger()).toEqual({ posted: 0, reversed: 0, blocked: [] });
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    expect(ledger.balanceOf("1000")).toBe(0);
  });

  it("a payment voided before it was ever posted leaves no entry at all", () => {
    pay("P0001", 300_000, "2026-11-02", "Naqd", true);
    expect(ledger.syncLedger()).toEqual({ posted: 0, reversed: 0, blocked: [] });
    expect(journal()).toEqual([]);
  });

  it("hand-edited junk is ignored and rows without an ID get one", () => {
    pay("P0001", 100_000, "2026-11-02");
    pay("P0002", 0, "2026-11-02");
    pay("P0003", 50_000, "not a date");
    pay("", 70_000, "2026-11-05");
    expense("", "2026-11-06", 30_000);
    expense("X0009", "2026-11-06", -5);
    const res = ledger.syncLedger();
    expect(res.posted).toBe(3);
    expect(read<Payment>(PAYMENTS).map((p) => p.id)).toEqual(["P0001", "P0002", "P0003", "P0004"]);
    expect(read<Expense>(EXPENSES).map((x) => x.id)).toEqual(["X0010", "X0009"]);
    expect(journal().map((l) => l.sourceKey)).toEqual(["P0001", "P0001", "P0004", "P0004", "X0010", "X0010"]);
  });

  it("teacher pay: a draft posts nothing, approved accrues, paid settles, each once", () => {
    const row = (status: string, total: number, month = "2026-10-01") => ({ month, teacherId: "T0001", teacherName: "Dilnoza", heldLessons: 0, collected: 0, bonus: 0, total, status });
    append(PAYROLL, [row("draft", 111, "2026-09-01"), row("approved", 500_000)]);
    ledger.syncLedger();
    expect(journal().map((l) => [l.sourceType, l.sourceKey, l.account, l.debit, l.credit, l.date])).toEqual([
      ["payroll_accrual", "2026-10:T0001", "5100", 500_000, 0, "2026-11-23"],
      ["payroll_accrual", "2026-10:T0001", "2100", 0, 500_000, "2026-11-23"],
    ]);
    h.sheet("Oylik").data[2]![7] = "To'langan";
    expect(ledger.syncLedger().posted).toBe(1);
    expect(shape(2)).toEqual([["2100", 500_000, 0], ["1000", 0, 500_000]]);
    expect(ledger.syncLedger().posted).toBe(0);
    expect(ledger.buildReport("balance").rows.flat()).toContain("Jami majburiyatlar");
  });

  it("without the ledger sheets (a workbook that was not set up again) payments still work and sync explains what to do", () => {
    h.sheets.delete("Jurnal");
    pay("P0001", 100_000, "2026-11-02");
    expect(() => ledger.syncLedger()).toThrow("Boshlang'ich sozlash");
    expect(ledger.tryPostPayments()).toBe("");
    const r = actions.recordPayment({ studentId: "S0001", amount: 1000, method: "Naqd", paidOn: "2026-11-23", note: "", notifyGuardian: false });
    expect(r.ledger).toBe("");
  });
});

describe("recording a payment through the sidebar", () => {
  it("posts it right away", () => {
    const r = actions.recordPayment({ studentId: "S0001", amount: 600_000, method: "Karta", paidOn: "2026-11-23", note: "", notifyGuardian: false });
    expect(r.ledger).toBe("");
    expect(journal().map((l) => [l.account, l.debit, l.credit, l.sourceKey])).toEqual([["1010", 600_000, 0, r.id], ["4000", 0, 600_000, r.id]]);
  });

  it("a person who cannot write the protected journal still records the payment; the next sync posts it", () => {
    const sheet = h.sheet("Jurnal") as unknown as { getRange: () => never };
    sheet.getRange = () => {
      throw new Error("You are trying to edit a protected cell or object. Please contact the spreadsheet owner.");
    };
    const r = actions.recordPayment({ studentId: "S0001", amount: 1000, method: "Naqd", paidOn: "2026-11-23", note: "", notifyGuardian: false });
    expect(r.ledger).toContain("Jurnalga o'tkazilmadi");
    expect(r.ledger).toContain("protected");
    expect(read<Payment>(PAYMENTS)).toHaveLength(1);
    delete (sheet as unknown as Record<string, unknown>).getRange;
    expect(ledger.syncLedger().posted).toBe(1);
  });
});

describe("verification detects tampering and names the first broken row", () => {
  beforeEach(() => {
    pay("P0001", 100_000, "2026-11-02");
    pay("P0002", 200_000, "2026-11-03");
    pay("P0003", 300_000, "2026-11-04");
    ledger.syncLedger();
  });

  it("reports a clean journal", () => {
    const v = ledger.verifyJournal();
    expect(v.verdict).toEqual({ ok: true, brokenSeq: null, reason: null, periodIssues: [] });
    expect(v.message).toContain("Jurnal to'g'ri: 6 qator");
  });

  it("an edited amount (even keeping the entry balanced) is found at that row", () => {
    rowOf(3)![col("debit")] = 250_000;
    rowOf(4)![col("credit")] = 250_000;
    const v = ledger.verifyJournal();
    expect(v.verdict.brokenSeq).toBe(3);
    expect(v.verdict.reason).toBe("hash_mismatch");
    expect(v.message).toContain("№3");
    expect(v.message).toContain("o'zgartirilgan");
  });

  it("an edited date, account or memo is found", () => {
    rowOf(2)![col("memo")] = "forged";
    expect(ledger.verifyJournal().verdict.brokenSeq).toBe(2);
    rowOf(2)![col("memo")] = "To'lov P0001: Ali Valiyev (Naqd)";
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    rowOf(6)![col("account")] = "1000";
    expect(ledger.verifyJournal().verdict.brokenSeq).toBe(6);
  });

  it("a deleted row leaves a gap, a swapped pair is out of order", () => {
    const sheet = h.sheet("Jurnal");
    const removed = sheet.data.splice(3, 1); // the row of seq 3
    expect(ledger.verifyJournal().verdict).toMatchObject({ brokenSeq: 4, reason: "seq_gap" });
    sheet.data.splice(3, 0, ...removed);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    [sheet.data[2], sheet.data[3]] = [sheet.data[3]!, sheet.data[2]!];
    expect(ledger.verifyJournal().verdict).toMatchObject({ brokenSeq: 3, reason: "seq_gap" });
  });

  it("an inserted forged row breaks the chain", () => {
    const sheet = h.sheet("Jurnal");
    const forged = [...sheet.data[3]!];
    forged[col("seq")] = 7;
    sheet.data.push(forged);
    expect(ledger.verifyJournal().verdict).toMatchObject({ brokenSeq: 7, reason: "prev_mismatch" });
  });

  it("an emptied row is a gap as well (an empty row is skipped when reading)", () => {
    h.sheet("Jurnal").data[2] = h.sheet("Jurnal").data[2]!.map(() => "");
    expect(ledger.verifyJournal().verdict).toMatchObject({ brokenSeq: 3, reason: "seq_gap" });
  });

  it("the verify menu action shows the message", () => {
    rowOf(1)![col("debit")] = 5;
    ledger.menu.verify();
    expect(h.alerts.at(-1)!.message).toContain("birinchi buzilgan qatori №1");
  });
});

describe("manual entries, reversals and the chart", () => {
  it("posts a balanced manual entry, keeping pipes, backslashes and spaces in the memo exact", () => {
    const no = ledger.manualEntry({ date: "2026-11-20", memo: "  boshlang'ich | qoldiq \\ test  ", linesText: "1000 D 1 000 000".replace("1 000 000", "1000000") + "; 3000 K 1000000" });
    expect(no).toBe(1);
    expect(shape(1)).toEqual([["1000", 1_000_000, 0], ["3000", 0, 1_000_000]]);
    expect(journal()[0]!.memo).toBe("boshlang'ich | qoldiq \\ test");
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("refuses unbalanced, one-sided, unknown, inactive, future and unreadable entries without writing anything", () => {
    const post = (linesText: string, date = "2026-11-20") => () => ledger.manualEntry({ date, memo: "x", linesText });
    expect(post("1000 D 10; 3000 K 9")).toThrow("muvozanatda emas");
    expect(post("1000 D 10")).toThrow("kamida ikkita");
    expect(post("7777 D 10; 3000 K 10")).toThrow("bunday hisob yo'q");
    expect(post("1000 D 10; 3000 K 10", "2026-11-30")).toThrow("kelajak");
    expect(post("hello")).toThrow("tushunarsiz");
    expect(post("1000 D 0; 3000 K 0")).toThrow("Summa");
    expect(post("1000 D 10.5; 3000 K 10.5")).toThrow("tushunarsiz");
    expect(() => ledger.manualEntry({ date: "2026-11-20", memo: "", linesText: "1000 D 1; 3000 K 1" })).toThrow("Izoh");
    ledger.addAccount("5200", "Transport", "expense");
    ledger.setAccountActive("5200", false);
    expect(post("5200 D 10; 1000 K 10")).toThrow("faol emas");
    expect(journal()).toHaveLength(0);
  });

  it("reverses a manual entry exactly once and never a document entry or a reversal", () => {
    ledger.manualEntry({ date: "2026-11-20", memo: "xato", linesText: "1000 D 50; 3000 K 50" });
    const rev = ledger.reverseManual(1);
    expect(rev).toBe(2);
    expect(shape(2)).toEqual([["1000", 0, 50], ["3000", 50, 0]]);
    expect(journal()[2]!.memo).toBe("Bekor qilish: #1 xato");
    expect(() => ledger.reverseManual(1)).toThrow("allaqachon bekor");
    expect(() => ledger.reverseManual(2)).toThrow("To'lov, xarajat");
    pay("P0001", 100, "2026-11-02");
    ledger.syncLedger();
    expect(() => ledger.reverseManual(3)).toThrow("To'lov, xarajat");
    expect(() => ledger.reverseManual(99)).toThrow("topilmadi");
    expect(() => ledger.reverseManual(1, "2026-12-01")).toThrow();
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    expect(ledger.balanceOf("1000") / 100).toBe(100);
  });

  it("manages accounts: add, refuse duplicates and bad codes, deactivate only at zero balance", () => {
    ledger.addAccount("5200", "Transport", "expense");
    expect(() => ledger.addAccount("5200", "Again", "expense")).toThrow("allaqachon");
    expect(() => ledger.addAccount("52", "Short", "expense")).toThrow("3-8");
    expect(() => ledger.addAccount("5201", "x", "revenue")).toThrow("turi");
    expect(() => ledger.addAccount("5202", " ", "expense")).toThrow("nomi");
    ledger.manualEntry({ date: "2026-11-20", memo: "x", linesText: "1000 D 5; 3000 K 5" });
    expect(() => ledger.setAccountActive("1000", false)).toThrow("Qoldig'i bor");
    expect(() => ledger.setAccountActive("9999", false)).toThrow("topilmadi");
    ledger.setAccountActive("5200", false);
    ledger.setAccountActive("5200", true);
    ledger.addCashAccount("1020", "Ikkinchi bank", "bank");
    expect(() => ledger.addCashAccount("1020", "x", "bank")).toThrow("allaqachon");
    expect(() => ledger.addCashAccount("4000", "x", "bank")).toThrow("aktiv");
    expect(read<ledger.ChartRow>(CHART_ACCOUNTS).find((a) => a.code === "1020")).toMatchObject({ type: "asset", active: true });
  });
});

describe("closing a month", () => {
  beforeEach(() => {
    pay("P0001", 500_000, "2026-10-05");
    expense("X0001", "2026-10-12", 120_000);
    pay("P0002", 300_000, "2026-11-03", "Karta");
    ledger.syncLedger();
  });

  it("closes a finished month: stores the last row, totals and the period hash, and verification still passes", () => {
    expect(ledger.closePeriod("2026-10")).toContain("2026-10 yopildi");
    const rows = read<{ month: string; lastSeq: number; totalDebit: number; totalCredit: number; periodHash: string; closedOn: string }>(PERIODS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ month: "2026-10", lastSeq: 6, totalDebit: 920_000, totalCredit: 920_000, closedOn: "2026-11-23" });
    expect(rows[0]!.periodHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("refuses the current month, a closed month, a bad month, and a month with unposted documents", () => {
    expect(() => ledger.closePeriod("2026-11")).toThrow("tugagan");
    expect(() => ledger.closePeriod("2027-01")).toThrow("tugagan");
    expect(() => ledger.closePeriod("2026-13")).toThrow("Noto'g'ri oy");
    pay("P0003", 1000, "2026-10-20");
    expect(() => ledger.closePeriod("2026-10")).toThrow("1 ta hujjat");
    ledger.syncLedger();
    ledger.closePeriod("2026-10");
    expect(() => ledger.closePeriod("2026-10")).toThrow("allaqachon yopilgan");
  });

  it("a closed month takes no entries; sync reports instead of posting; later months keep working", () => {
    ledger.closePeriod("2026-10");
    expect(() => ledger.manualEntry({ date: "2026-10-31", memo: "late", linesText: "1000 D 1; 3000 K 1" })).toThrow("bu oy yopilgan");
    pay("P0003", 7000, "2026-10-20");
    expect(ledger.syncLedger()).toEqual({ posted: 0, reversed: 0, blocked: [{ sourceType: "payment", sourceKey: "P0003", date: "2026-10-20" }] });
    pay("P0004", 8000, "2026-11-20");
    expect(ledger.syncLedger().posted).toBe(1);
    // voiding an October payment reverses it in the open month
    h.sheet("To'lovlar").data[1]![6] = "Ha";
    expect(ledger.syncLedger().reversed).toBe(1);
    expect(journal().filter((l) => l.sourceType === "payment_void")[0]!.date).toBe("2026-11-23");
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("detects a tampered period record and a rewritten history that was re-hashed", () => {
    ledger.closePeriod("2026-10");
    const periodCol = PERIODS.cols.findIndex((c) => c.key === "totalDebit");
    h.sheet("Davrlar").data[1]![periodCol] = 1;
    expect(ledger.verifyJournal().verdict.periodIssues[0]).toMatchObject({ month: "2026-10", reason: "period_hash_mismatch" });
    h.sheet("Davrlar").data[1]![periodCol] = 920_000;
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    rowOf(6)![col("debit")] = 1; // a closed-period line
    const v = ledger.verifyJournal();
    expect(v.verdict.ok).toBe(false);
    expect(v.message).toContain("№");
  });

  it("refuses to close a journal that does not verify", () => {
    rowOf(1)![col("debit")] = 1;
    expect(() => ledger.closePeriod("2026-10")).toThrow("tekshiruvdan o'tmadi");
    expect(read(PERIODS)).toHaveLength(0);
  });
});

describe("reports", () => {
  beforeEach(() => {
    ledger.manualEntry({ date: "2026-11-01", memo: "kapital", linesText: "1000 D 1000000; 3000 K 1000000" });
    pay("P0001", 600_000, "2026-11-10");
    expense("X0001", "2026-11-12", 250_000);
    ledger.syncLedger();
  });

  it("trial balance, income statement, balance sheet and an account card agree with the journal", () => {
    const tb = ledger.buildReport("trial");
    expect(tb.rows.filter((r) => r[0] === "1000")[0]).toEqual(["1000", "Kassa", "asset", 1_600_000, 250_000, 1_350_000, 0]);
    expect(tb.rows.find((r) => r[1] === "JAMI")).toEqual(["", "JAMI", "", 1_850_000, 1_850_000, 1_600_000, 1_600_000]);
    const inc = ledger.buildReport("income", { from: "2026-11-01", to: "2026-11-30" });
    expect(inc.rows.find((r) => r[1] === "SOF NATIJA")![2]).toBe(350_000);
    const bs = ledger.buildReport("balance");
    expect(bs.rows.find((r) => r[1] === "Jami kapital")![2]).toBe(1_350_000);
    expect(bs.rows.find((r) => r[1] === "Joriy natija (daromad - xarajat)")![2]).toBe(350_000);
    expect(String(bs.rows.at(-1)![1])).toContain("Aktiv = majburiyat");
    const card = ledger.buildReport("ledger", { account: "1000" });
    expect(card.rows.slice(1).map((r) => r[5])).toEqual([0, 1_000_000, 1_600_000, 1_350_000, 1_350_000]);
    expect(() => ledger.buildReport("ledger", { account: "9999" })).toThrow("topilmadi");
    expect(() => ledger.buildReport("ledger", {})).toThrow("kiritilmadi");
  });

  it("showReport writes the sheet and reports are idempotent", () => {
    ledger.showReport("trial");
    const first = h.rows(ledger.REPORT_SHEET);
    ledger.showReport("trial");
    expect(h.rows(ledger.REPORT_SHEET)).toEqual(first);
    expect(first[0]![0]).toContain("Sinov balansi");
  });
});

describe("demo data never touches the immutable journal", () => {
  it("a reset with a journal full of real entries leaves the journal alone", () => {
    pay("P0001", 100, "2026-11-02");
    ledger.syncLedger();
    expect(journal()).toHaveLength(2);
    loadSampleData();
    ledger.syncLedger(); // demo payments and expenses are not posted
    expect(journal()).toHaveLength(2);
    expect(() => resetSampleData()).not.toThrow();
    expect(journal()).toHaveLength(2);
    expect(ledger.pendingList().filter((p) => p.sourceKey.startsWith("P0"))).toEqual([]);
  });

  it("works on an empty journal and keeps the chart", () => {
    h = installHarness();
    setupWorkbook();
    loadSampleData();
    resetSampleData();
    expect(read<ledger.ChartRow>(CHART_ACCOUNTS)).toHaveLength(17);
    expect(journal()).toHaveLength(0);
  });
});

describe("misc", () => {
  it("the bills and settlement sheets exist and are not protected (documents, not the ledger)", () => {
    expect(h.protections(SUPPLIER_BILLS.sheet)).toEqual([]);
    expect(h.protections(BILL_PAYMENTS.sheet)).toEqual([]);
  });
});
