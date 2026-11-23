import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Expense, Payment, Student } from "../src/domain/types";
import * as ledger from "../src/gas/ledger";
import * as reconcile from "../src/gas/reconcile";
import { append, read } from "../src/gas/repo";
import { EXPENSES, PAYMENTS, STATEMENT_LINES, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;
const lines = (id = "K0001") => read<reconcile.StatementLine>(STATEMENT_LINES).filter((l) => l.statementId === id);

/** Cash: +500000 (11-10), +200000 (11-12), -50000 (11-14). */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
  append(STUDENTS, [{ id: "S0001", fullName: "Ali Valiyev", status: "active", guardianName: "", guardianChatId: "", consentNotify: false } satisfies Student]);
  append(PAYMENTS, [
    { id: "P0001", studentId: "S0001", paidOn: "2026-11-10", amount: 500_000, method: "Naqd", voided: false, note: "" },
    { id: "P0002", studentId: "S0001", paidOn: "2026-11-12", amount: 200_000, method: "Naqd", voided: false, note: "" },
  ] satisfies Payment[]);
  append(EXPENSES, [{ id: "X0001", date: "2026-11-14", category: "rent", amount: 50_000, note: "", voided: false } satisfies Expense]);
  ledger.syncLedger();
});
afterEach(() => vi.useRealTimers());

const statement = (over: Partial<Parameters<typeof reconcile.createStatement>[0]> = {}): string =>
  reconcile.createStatement({ accountCode: "1000", from: "2026-11-01", to: "2026-11-23", opening: 0, closing: 650_000, ...over });

describe("creating a statement and its lines", () => {
  it("validates the statement and the lines", () => {
    expect(() => statement({ accountCode: "4000" })).toThrow("Pul hisobi topilmadi");
    expect(() => statement({ from: "2026-11-30" })).toThrow("oldin");
    expect(() => statement({ from: "bad" })).toThrow("Sana");
    expect(() => statement({ opening: 1.5 })).toThrow("butun");
    const id = statement({ opening: -500 });
    expect(id).toBe("K0001");
    expect(() => reconcile.addStatementLines(id, [])).toThrow("Satr yo'q");
    expect(() => reconcile.addStatementLines(id, [{ date: "2026-11-10", amount: 0 }])).toThrow("noldan");
    expect(() => reconcile.addStatementLines(id, [{ date: "x", amount: 5 }])).toThrow("Sana");
    expect(() => reconcile.addStatementLines("K9999", [{ date: "2026-11-10", amount: 5 }])).toThrow("topilmadi");
    expect(reconcile.addStatementLines(id, [{ date: "2026-11-10", amount: 5 }, { date: "2026-11-11", amount: -5 }])).toBe(2);
    expect(reconcile.addStatementLines(id, [{ date: "2026-11-12", amount: 7 }])).toBe(1);
    expect(lines(id).map((l) => l.no)).toEqual([1, 2, 3]);
  });
});

describe("matching and finalizing", () => {
  it("auto-matches by amount within the tolerance, then finalizes when everything agrees; afterwards it is frozen", () => {
    const id = statement();
    reconcile.addStatementLines(id, [{ date: "2026-11-10", amount: 500_000 }, { date: "2026-11-13", amount: 200_000 }, { date: "2026-11-14", amount: -50_000 }]);
    let r = reconcile.reconciliation(id);
    expect(r).toMatchObject({ ledgerBalance: 650_000, difference: 0, foots: true, unmatchedStatement: 3, reconciled: false });
    expect(r.unmatchedLedger).toHaveLength(3);
    expect(reconcile.autoMatch(id, 0)).toBe(2); // the bank booked the second one a day later
    expect(lines(id).map((l) => l.matchedSeq > 0)).toEqual([true, false, true]);
    expect(() => reconcile.finalizeStatement(id)).toThrow("moslanmagan satr: 1");
    expect(reconcile.autoMatch(id, 1)).toBe(1);
    r = reconcile.reconciliation(id);
    expect(r.reconciled).toBe(true);
    reconcile.finalizeStatement(id);
    expect(reconcile.statements()[0]!.status).toBe("finalized");
    expect(() => reconcile.addStatementLines(id, [{ date: "2026-11-15", amount: 1 }])).toThrow("yopilgan");
    expect(() => reconcile.autoMatch(id)).toThrow("yopilgan");
    expect(() => reconcile.unmatchLine(id, 1)).toThrow("yopilgan");
    expect(() => reconcile.matchLine(id, 1, 1)).toThrow("yopilgan");
    expect(() => reconcile.finalizeStatement(id)).toThrow("yopilgan");
  });

  it("matches by hand: only the statement's own account, each ledger line once, unmatch frees it", () => {
    const id = statement({ closing: 500_000 });
    reconcile.addStatementLines(id, [{ date: "2026-11-10", amount: 500_000 }, { date: "2026-11-11", amount: 1 }]);
    expect(() => reconcile.matchLine(id, 1, 2)).toThrow("ko'chirma hisobiga tegishli emas"); // seq 2 is the revenue line
    expect(() => reconcile.matchLine(id, 1, 99)).toThrow("tegishli emas");
    expect(() => reconcile.matchLine(id, 9, 1)).toThrow("Satr topilmadi");
    reconcile.matchLine(id, 1, 1);
    expect(() => reconcile.matchLine(id, 1, 1)).toThrow("allaqachon moslangan");
    expect(() => reconcile.matchLine(id, 2, 1)).toThrow("boshqa ko'chirma satriga");
    reconcile.unmatchLine(id, 1);
    expect(lines(id)[0]!.matchedSeq).toBe(0);
    expect(() => reconcile.unmatchLine(id, 9)).toThrow("Satr topilmadi");
    reconcile.matchLine(id, 2, 1);
    expect(lines(id)[1]!.matchedSeq).toBe(1);
  });

  it("a ledger line matched in one statement is not offered to another", () => {
    const a = statement();
    reconcile.addStatementLines(a, [{ date: "2026-11-10", amount: 500_000 }]);
    reconcile.autoMatch(a, 0);
    const b = statement();
    reconcile.addStatementLines(b, [{ date: "2026-11-10", amount: 500_000 }]);
    expect(reconcile.autoMatch(b, 0)).toBe(0);
    expect(() => reconcile.matchLine(b, 1, lines(a)[0]!.matchedSeq)).toThrow("boshqa ko'chirma");
  });

  it("does not finalize a statement that does not foot, differs from the ledger, or leaves a ledger line unmatched", () => {
    const id = statement({ closing: 651_000 });
    reconcile.addStatementLines(id, [{ date: "2026-11-10", amount: 500_000 }, { date: "2026-11-12", amount: 200_000 }, { date: "2026-11-14", amount: -50_000 }]);
    reconcile.autoMatch(id, 0);
    const r = reconcile.reconciliation(id);
    expect(r).toMatchObject({ foots: false, difference: 1000, unmatchedStatement: 0, reconciled: false });
    expect(() => reconcile.finalizeStatement(id)).toThrow("yig'indisi mos kelmaydi");
    const id2 = statement();
    reconcile.addStatementLines(id2, [{ date: "2026-11-10", amount: 500_000 }, { date: "2026-11-12", amount: 200_000 }, { date: "2026-11-14", amount: -50_000 }]);
    ledger.manualEntry({ date: "2026-11-15", memo: "chek", linesText: "1000 D 10; 3000 K 10" });
    reconcile.autoMatch(id2, 0);
    expect(reconcile.reconciliation(id2)).toMatchObject({ difference: -10, reconciled: false });
    expect(reconcile.reconciliation(id2).unmatchedLedger.map((l) => [l.amount, l.memo])).toEqual([[10, "chek"]]);
    expect(() => reconcile.finalizeStatement(id2)).toThrow("jurnalda moslanmagan: 1");
  });

  it("validates the tolerance and shows the reconciliation on the report sheet", () => {
    const id = statement();
    expect(() => reconcile.autoMatch(id, 31)).toThrow("0-30");
    expect(() => reconcile.autoMatch(id, 1.5)).toThrow("0-30");
    reconcile.showReconciliation(id);
    const rows = h.rows(ledger.REPORT_SHEET);
    expect(rows[0]![0]).toContain("Ko'chirma K0001");
    expect(rows.find((r) => r[0] === "NATIJA")![1]).toBe("Mos emas");
    expect(() => reconcile.showReconciliation("K9999")).toThrow("topilmadi");
  });

  it("an empty statement on an empty account reconciles at once", () => {
    ledger.addCashAccount("1020", "Ikkinchi bank", "bank");
    const id = reconcile.createStatement({ accountCode: "1020", from: "2026-11-01", to: "2026-11-23", opening: 0, closing: 0 });
    expect(reconcile.reconciliation(id).reconciled).toBe(true);
    reconcile.finalizeStatement(id);
  });
});
