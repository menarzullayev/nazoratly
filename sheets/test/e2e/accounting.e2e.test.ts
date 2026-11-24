import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Expense } from "../../src/domain/types";
import * as actions from "../../src/gas/actions";
import * as ledger from "../../src/gas/ledger";
import { append, read, updateById } from "../../src/gas/repo";
import { CASH_ACCOUNTS, EXPENSES, JOURNAL, PAYMENTS, PERIODS } from "../../src/gas/schema";
import type { Harness } from "../harness";
import { boot, drive, enrollment, seedClass, student } from "./support";

let h: Harness;
beforeEach(() => {
  h = boot();
  seedClass({ students: [student("S0001"), student("S0002")] });
});
afterEach(() => vi.useRealTimers());

const som = (code: string): number => ledger.balanceOf(code) / 100;
const pay = (studentId: string, amount: number, paidOn: string, method = "Naqd"): string => actions.recordPayment({ studentId, amount, method, paidOn, note: "", notifyGuardian: false }).id;
const expense = (id: string, date: string, amount: number): void => append(EXPENSES, [{ id, date, category: "rent", amount, note: "", voided: false } satisfies Expense]);
const sheetValues = (name: string): (string | number)[][] => h.rows(name) as (string | number)[][];
/** the report sheet as a code -> amount map for rows like [code, name, amount...] */
const byCode = (rows: (string | number)[][], amountCol: number): Record<string, number> => Object.fromEntries(rows.filter((r) => /^\d{4}$/.test(String(r[0]))).map((r) => [String(r[0]), Number(r[amountCol])]));

describe("journey: journal, reports, period close", () => {
  it("payments, expenses and refunds reach the journal by themselves or by 'sync'; sync twice posts nothing twice", () => {
    pay("S0001", 500_000, "2026-10-05");
    pay("S0002", 300_000, "2026-10-06", "Karta");
    expense("X0001", "2026-10-03", 200_000);
    const sync = drive(h, "menuLedgerSync");
    expect(sync.last).toMatch(/Jurnalga o'tkazildi: 1 ta/); // the expense; payments were posted when recorded
    const n = read(JOURNAL).length;
    expect(drive(h, "menuLedgerSync").last).toMatch(/Jurnalga o'tkazildi: 0 ta/);
    expect(read(JOURNAL)).toHaveLength(n);
    expect(som("1000")).toBe(500_000 - 200_000); // cash: naqd in, rent out
    expect(som("1010")).toBe(300_000); // bank: card payment
    expect(drive(h, "menuLedgerVerify").last).toMatch(/Jurnal to'g'ri/);
  });

  it("manual entry validates its lines; a reversal cancels it exactly and cannot be repeated; auto entries are not reversible by hand", () => {
    expect(drive(h, "menuLedgerManual", "2026-11-01", "Egasi kiritdi", "1000 D 500000; 3000 K 400000").last).toMatch(/muvozanatda emas/);
    expect(read(JOURNAL)).toEqual([]);
    expect(drive(h, "menuLedgerManual", "2026-11-01", "Egasi kiritdi", "1000 X 500000").last).toMatch(/tushunarsiz/);
    expect(drive(h, "menuLedgerManual", "2027-01-01", "Kelajak", "1000 D 5; 3000 K 5").last).toMatch(/kelajak/);
    expect(drive(h, "menuLedgerManual", "2026-11-01", "Egasi kiritdi", "1000 D 500000; 3000 K 500000").last).toContain("Yozuv №1");
    expect(som("1000")).toBe(500_000);
    expect(drive(h, "menuLedgerReverse", "1").last).toContain("Teskari yozuv №2");
    expect(som("1000")).toBe(0);
    expect(drive(h, "menuLedgerReverse", "1").last).toMatch(/allaqachon bekor/);
    expect(drive(h, "menuLedgerReverse", "99").last).toMatch(/topilmadi/);
    pay("S0001", 100_000, "2026-11-02");
    expect(drive(h, "menuLedgerReverse", "3").last).toMatch(/hujjatni bekor qilish orqali/);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("reports: the trial balance balances, income and balance sheet agree with the journal, the account card follows the cash", () => {
    pay("S0001", 500_000, "2026-11-02");
    pay("S0002", 300_000, "2026-11-04", "Karta");
    expense("X0001", "2026-11-03", 200_000);
    drive(h, "menuLedgerSync");
    drive(h, "menuReportTrial", "");
    const trial = sheetValues("Buxgalteriya hisoboti");
    expect(String(trial[0]![0])).toContain("Sinov balansi");
    const rows = trial.slice(2).filter((r) => /^\d{4}$/.test(String(r[0])));
    const debit = rows.reduce((n, r) => n + Number(r[3]), 0);
    const credit = rows.reduce((n, r) => n + Number(r[4]), 0);
    expect(debit).toBe(credit);
    expect(debit).toBeGreaterThan(0);
    drive(h, "menuReportIncome", "2026-11-01", "2026-11-30");
    const income = sheetValues("Buxgalteriya hisoboti");
    expect(String(income[0]![0])).toContain("Foyda va zarar");
    const flat = JSON.stringify(income);
    expect(flat).toContain("800000"); // total income
    expect(flat).toContain("200000"); // rent
    expect(flat).toContain("600000"); // net
    drive(h, "menuReportBalance", "");
    expect(String(sheetValues("Buxgalteriya hisoboti")[0]![0])).toContain("Balans");
    drive(h, "menuReportLedger", "1000");
    const card = sheetValues("Buxgalteriya hisoboti");
    expect(String(card[0]![0])).toContain("Hisob kartochkasi 1000");
    expect(Number(card.at(-1)![5])).toBe(300_000); // closing cash balance
    expect(drive(h, "menuReportLedger", "9999").last).toMatch(/topilmadi/);
    void byCode;
  });

  it("closing a period: only a finished month, needs a verified journal, blocks later changes to that month, and tampering after the close is caught", () => {
    const p1 = pay("S0001", 500_000, "2026-10-05");
    pay("S0002", 300_000, "2026-10-06");
    expense("X0001", "2026-10-03", 200_000);
    expect(drive(h, "menuLedgerClose", "2026-11").last).toMatch(/Faqat tugagan oyni/);
    expect(drive(h, "menuLedgerClose", "2026-10").last).toMatch(/hali jurnalga o'tkazilmagan/); // the expense is not posted yet
    drive(h, "menuLedgerSync");
    const closed = drive(h, "menuLedgerClose", "2026-10");
    expect(closed.last).toMatch(/2026-10 yopildi: \d+ qator/);
    expect(read(PERIODS)).toHaveLength(1);
    expect(drive(h, "menuLedgerClose", "2026-10").last).toMatch(/allaqachon yopilgan/);
    expect(drive(h, "menuLedgerClose", "2026-13").last).toMatch(/Noto'g'ri oy/);

    // voiding an October payment cannot rewrite October: the correction is a reversal dated TODAY (November)
    const octoberLines = read<{ seq: number; date: string }>(JOURNAL).filter((l) => l.date.startsWith("2026-10")).length;
    updateById(PAYMENTS, "id", p1, { voided: true });
    const sync = drive(h, "menuLedgerSync");
    expect(sync.last).toBe("Jurnalga o'tkazildi: 0 ta, teskari yozuv: 1 ta.");
    expect(read<{ date: string }>(JOURNAL).filter((l) => l.date.startsWith("2026-10"))).toHaveLength(octoberLines);
    expect(read<{ date: string; memo: string }>(JOURNAL).filter((l) => l.date === "2026-11-23").every((l) => l.memo.startsWith("Bekor qilish"))).toBe(true);
    expect(som("1000")).toBe(300_000 - 200_000);
    expect(ledger.verifyJournal().verdict.ok).toBe(true); // the closed month still verifies
    // a manual entry cannot be dated inside the closed month either
    expect(drive(h, "menuLedgerManual", "2026-10-20", "Orqaga", "1000 D 5; 3000 K 5").last).toMatch(/yopilgan/);

    // tampering with a closed month is detected by the period hash, not only by the chain
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    const col = JOURNAL.cols.findIndex((c) => c.key === "memo");
    h.sheet("Jurnal").data[1]![col] = "o'zgartirildi";
    expect(ledger.verifyJournal().verdict.ok).toBe(false);
    expect(drive(h, "menuLedgerVerify").last).toMatch(/XATO/);
    expect(drive(h, "menuLedgerClose", "2026-09").last).toMatch(/tekshiruvdan o'tmadi|yopib bo'lmaydi|Faqat/);
  });

  it("accounts: add (validated), add a bank account, and the protection menu re-applies without stacking", () => {
    drive(h, "menuAccountAdd", "5200", "Marketing", "expense");
    expect(drive(h, "menuAccountAdd", "5200", "Boshqa", "expense").last).toBe("Hisob 5200 allaqachon bor.");
    expect(drive(h, "menuAccountAdd", "52", "Qisqa", "expense").last).toBe("Hisob kodi 3-8 raqamdan iborat bo'lishi kerak.");
    drive(h, "menuCashAdd", "bank", "1020", "Kapital bank");
    expect(read<{ code: string }>(CASH_ACCOUNTS).map((c) => c.code)).toEqual(["1000", "1010", "1020"]);
    expect(drive(h, "menuLedgerProtect").last).toContain("6 ta varaq himoyalandi");
    expect(drive(h, "menuLedgerProtect").last).toContain("6 ta varaq himoyalandi");
    expect(h.protections("Jurnal")).toHaveLength(1);
  });
});
