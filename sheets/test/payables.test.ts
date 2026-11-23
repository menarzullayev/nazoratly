import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Expense } from "../src/domain/types";
import * as ledger from "../src/gas/ledger";
import * as payables from "../src/gas/payables";
import { read } from "../src/gas/repo";
import { EXPENSES, JOURNAL } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;
const journal = () => read<ledger.JournalRow>(JOURNAL);
const entry = (n: number) => journal().filter((l) => l.entryNo === n).map((l) => [l.account, l.debit, l.credit]);
const input = (over: Partial<payables.BillInput> = {}): payables.BillInput => ({ supplierId: "V0001", number: "A-1", billDate: "2026-11-18", dueDate: "2026-12-03", category: "equipment", amount: 1000, ...over });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
  payables.addSupplier("Ofis do'koni", "+998901112233");
});
afterEach(() => vi.useRealTimers());

describe("suppliers", () => {
  it("adds, refuses duplicates and blanks, deactivates", () => {
    expect(payables.suppliers()).toMatchObject([{ id: "V0001", name: "Ofis do'koni", phone: "+998901112233", active: true }]);
    expect(payables.addSupplier("Boshqa")).toBe("V0002");
    expect(() => payables.addSupplier("OFIS DO'KONI")).toThrow("allaqachon");
    expect(() => payables.addSupplier("  ")).toThrow("1-200");
    payables.setSupplierActive("V0002", false);
    expect(payables.suppliers()[1]!.active).toBe(false);
    expect(() => payables.setSupplierActive("V9999", false)).toThrow("topilmadi");
  });
});

describe("bills accrue an expense and a payable", () => {
  it("records the bill, an expense row linked to it, and posts both to the journal", () => {
    const r = payables.addBill(input());
    expect(r).toEqual({ id: "H0001", warning: "" });
    expect(read<Expense>(EXPENSES)).toMatchObject([{ id: "X0001", date: "2026-11-18", category: "equipment", amount: 1000, billId: "H0001", voided: false, note: "Ofis do'koni #A-1" }]);
    expect(entry(1)).toEqual([["5040", 1000, 0], ["2000", 0, 1000]]);
    const bs = ledger.buildReport("balance");
    expect(bs.rows.find((x) => x[1] === "Jami majburiyatlar")![2]).toBe(1000);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("validates everything and writes nothing for a refused bill", () => {
    payables.addBill(input());
    const bad = (over: Partial<payables.BillInput>, text: string) => expect(() => payables.addBill(input({ number: "B", ...over }))).toThrow(text);
    bad({ number: "A-1" }, "allaqachon");
    bad({ supplierId: "V9999" }, "topilmadi");
    bad({ dueDate: "2026-11-01" }, "oldin");
    bad({ billDate: "oops" }, "Sana");
    bad({ category: "fun" }, "turi");
    bad({ amount: 0 }, "Summa");
    bad({ amount: 10.5 }, "Summa");
    bad({ number: " " }, "raqami");
    payables.setSupplierActive("V0001", false);
    bad({}, "faol emas");
    expect(payables.bills()).toHaveLength(1);
    expect(read<Expense>(EXPENSES)).toHaveLength(1);
    expect(journal()).toHaveLength(2);
  });

  it("when the journal cannot be written the bill is still recorded and the warning says how to post it", () => {
    (h.sheet("Jurnal") as unknown as { getRange: () => never }).getRange = () => {
      throw new Error("protected");
    };
    const r = payables.addBill(input());
    expect(r.warning).toContain("Jurnalga o'tkazilmadi");
    expect(payables.bills()).toHaveLength(1);
    delete (h.sheet("Jurnal") as unknown as Record<string, unknown>).getRange;
    expect(ledger.syncLedger().posted).toBe(1);
  });
});

describe("settlement", () => {
  beforeEach(() => {
    payables.addBill(input());
  });

  it("settles partly from the bank, then the rest from cash; status follows", () => {
    expect(payables.billStatus(payables.bills()[0]!)).toBe("open");
    payables.payBill({ billId: "H0001", amount: 400, paidOn: "2026-11-20", paidFrom: "bank" });
    expect(entry(2)).toEqual([["2000", 400, 0], ["1010", 0, 400]]);
    expect(payables.billStatus(payables.bills()[0]!)).toBe("partial");
    payables.payBill({ billId: "H0001", amount: 600, paidOn: "2026-11-21" });
    expect(entry(3)).toEqual([["2000", 600, 0], ["1000", 0, 600]]);
    expect(payables.billStatus(payables.bills()[0]!)).toBe("paid");
    expect(payables.paidOf("H0001")).toBe(1000);
    expect(ledger.balanceOf("2000")).toBe(0);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("refuses overpayment, a future date, a date before the bill, a bad amount, a voided or unknown bill", () => {
    const pay = (over: Partial<payables.BillPaymentInput>) => () => payables.payBill({ billId: "H0001", amount: 100, paidOn: "2026-11-20", ...over });
    expect(pay({ amount: 1001 })).toThrow("oshib");
    expect(pay({ paidOn: "2026-11-30" })).toThrow("kelajak");
    expect(pay({ paidOn: "2026-11-01" })).toThrow("oldin");
    expect(pay({ amount: 0 })).toThrow("Summa");
    expect(pay({ amount: 1.5 })).toThrow("Summa");
    expect(pay({ paidOn: "xx" })).toThrow("Sana");
    expect(pay({ billId: "H0099" })).toThrow("topilmadi");
    expect(payables.billPayments()).toHaveLength(0);
    payables.payBill({ billId: "H0001", amount: 1000, paidOn: "2026-11-20" });
    expect(pay({ amount: 1 })).toThrow("oshib");
  });

  it("voids a settlement (reversal posted, the amount is free again) and a bill without settlements (its expense too)", () => {
    payables.payBill({ billId: "H0001", amount: 300, paidOn: "2026-11-20" });
    expect(() => payables.voidBill("H0001")).toThrow("to'lovlarini");
    payables.voidBillPayment("Q0001");
    expect(() => payables.voidBillPayment("Q0001")).toThrow("allaqachon");
    expect(() => payables.voidBillPayment("Q9999")).toThrow("topilmadi");
    expect(entry(3)).toEqual([["2000", 0, 300], ["1000", 300, 0]]);
    expect(payables.paidOf("H0001")).toBe(0);
    payables.voidBill("H0001");
    expect(() => payables.voidBill("H0001")).toThrow("allaqachon");
    expect(() => payables.voidBill("H9999")).toThrow("topilmadi");
    expect(payables.billStatus(payables.bills()[0]!)).toBe("voided");
    expect(read<Expense>(EXPENSES)[0]!.voided).toBe(true);
    expect(entry(4)).toEqual([["5040", 0, 1000], ["2000", 1000, 0]]);
    expect(() => payables.payBill({ billId: "H0001", amount: 1, paidOn: "2026-11-20" })).toThrow("bekor qilingan");
    expect(ledger.balanceOf("2000")).toBe(0);
    expect(ledger.balanceOf("5040")).toBe(0);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("the overdue status follows the due date", () => {
    payables.addBill(input({ number: "OLD", dueDate: "2026-11-19" }));
    expect(payables.billStatus(payables.bills()[1]!)).toBe("overdue");
    expect(payables.billStatus(payables.bills()[1]!, [], "2026-11-19")).toBe("open");
  });
});

describe("aging", () => {
  it("puts every bill in its bucket (edges included) and leaves paid bills out", () => {
    const due: Record<string, number> = { B01: 5, B02: 0, B03: -1, B04: -30, B05: -31, B06: -60, B07: -61, B08: -90, B09: -91 };
    const day = (off: number): string => new Date(Date.UTC(2026, 10, 23 + off)).toISOString().slice(0, 10);
    for (const [n, off] of Object.entries(due)) payables.addBill(input({ number: n, billDate: day(-120), dueDate: day(off), amount: 10 }));
    payables.addBill(input({ number: "PART", billDate: day(-120), dueDate: day(-5), amount: 100 }));
    payables.payBill({ billId: "H0010", amount: 40, paidOn: day(-100) });
    payables.addBill(input({ number: "DONE", billDate: day(-120), dueDate: day(-50), amount: 50 }));
    payables.payBill({ billId: "H0011", amount: 50, paidOn: day(-100) });
    const r = payables.agingReport();
    expect(r.buckets).toEqual({ not_due: "20.00", d1_30: "80.00", d31_60: "20.00", d61_90: "20.00", d90_plus: "10.00" });
    expect(r.total).toBe("150.00");
    expect(r.rows.map((x) => [x.id, x.days_overdue, x.bucket])).toEqual([
      ["H0009", 91, "d90_plus"], ["H0008", 90, "d61_90"], ["H0007", 61, "d61_90"], ["H0006", 60, "d31_60"], ["H0005", 31, "d31_60"],
      ["H0004", 30, "d1_30"], ["H0010", 5, "d1_30"], ["H0003", 1, "d1_30"], ["H0002", 0, "not_due"], ["H0001", 0, "not_due"],
    ]);
    expect(payables.agingReport(day(-130)).rows).toEqual([]); // none of them existed yet
    payables.showAging();
    const sheet = h.rows(ledger.REPORT_SHEET);
    expect(sheet[0]![0]).toContain("Ta'minotchilarga qarz");
    expect(sheet.some((r) => r[1] === "JAMI" && r[3] === 150)).toBe(true);
  });
});
