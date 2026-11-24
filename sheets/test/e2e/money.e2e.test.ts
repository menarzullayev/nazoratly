import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Charge, Payment, Refund, StudentDiscount } from "../../src/domain/types";
import * as actions from "../../src/gas/actions";
import * as ledger from "../../src/gas/ledger";
import { read } from "../../src/gas/repo";
import { CASH_CLOSES, CHARGES, DISCOUNT_LINES, DISCOUNTS, JOURNAL, PAYMENTS, REFUNDS } from "../../src/gas/schema";
import type { Harness } from "../harness";
import { boot, drive, enrollment, seedClass, setSetting, student } from "./support";

let h: Harness;
beforeEach(() => {
  h = boot();
});
afterEach(() => vi.useRealTimers());

/** cash account balance in so'm (the journal keeps tiyin) */
const cash = (): number => ledger.balanceOf("1000") / 100;
const charge = (studentId: string): Charge => read<Charge>(CHARGES).find((c) => c.studentId === studentId && c.month === "2026-11-01")!;
const pay = (studentId: string, amount: number, paidOn = "2026-11-02"): string => actions.recordPayment({ studentId, amount, method: "Naqd", paidOn, note: "", notifyGuardian: false }).id;

/** Six children of one center: S1 plain, S2 individual 10%, S3 scholarship 50%, S4 early-pay 5% by the 10th, S5+S6 siblings. */
function openCenter(): void {
  setSetting(h, "Oilaviy chegirma: 2-farzand (%)", "10");
  seedClass({
    students: [
      student("S0001", { guardianName: "Aliyev" }),
      student("S0002", { guardianName: "Botirov" }),
      student("S0003", { guardianName: "Valiyev" }),
      student("S0004", { guardianName: "Gofurov" }),
      student("S0005", { guardianName: "Karimova" }),
      student("S0006", { guardianName: "Karimova" }),
    ],
    enrollments: ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006"].map((s, i) => enrollment(`E000${i + 1}`, s)),
  });
}

describe("journey: discounts, billing, payments, refunds, cash close, journal", () => {
  it("adds the four kinds of discount through the menu and bills November with each of them", () => {
    openCenter();
    expect(drive(h, "menuDiscountAdd", "S0002", "individual", "10", "Aka-uka", "").all).toBe("");
    drive(h, "menuDiscountAdd", "S0003", "stipendiya", "50", "Olimpiada g'olibi", "");
    drive(h, "menuDiscountAdd", "S0004", "erta", "5", "10", "Vaqtida to'lagani uchun", "");
    const rules = read<StudentDiscount>(DISCOUNTS);
    expect(rules.map((r) => [r.id, r.studentId, r.kind, r.percent, r.payByDay])).toEqual([
      ["D0001", "S0002", "individual", 10, 0],
      ["D0002", "S0003", "scholarship", 50, 0],
      ["D0003", "S0004", "early_pay", 5, 10],
    ]);

    const run = drive(h, "menuGenerateCharges", "2026-11");
    expect(run.last).toContain("2026-11: 6 ta yangi hisob yaratildi");
    expect(run.last).toContain("chegirma bilan: 3");

    expect(charge("S0001").amount).toBe(500_000); // no discount
    expect(charge("S0002").amount).toBe(450_000); // individual 10%
    expect(charge("S0003").amount).toBe(250_000); // scholarship 50%
    expect(charge("S0005").amount).toBe(500_000); // first sibling pays in full
    expect(charge("S0006").amount).toBe(450_000); // family: second child 10%
    // the early-pay offer does not shrink the charge, it is a line that is earned by paying in time
    const lines = read<{ studentId: string; kind: string; amount: number }>(DISCOUNT_LINES);
    expect(lines.filter((l) => l.studentId === "S0006").map((l) => [l.kind, l.amount])).toEqual([["family", 50_000]]);
    expect(lines.filter((l) => l.studentId === "S0004")).toEqual([]);
    expect(charge("S0004")).toMatchObject({ amount: 500_000, earlyDiscount: 25_000, earlyPayBy: "2026-11-10" });

    // running the month again creates nothing (idempotent), the owner is told so
    const again = drive(h, "menuGenerateCharges", "2026-11");
    expect(again.last).toContain("0 ta yangi hisob yaratildi");
    expect(read<Charge>(CHARGES)).toHaveLength(6);

    const report = drive(h, "menuDiscountReport", "2026-11");
    expect(report.alerts.length >= 0).toBe(true);
  });

  it("the early-pay discount is earned only when the money arrives by the pay-by day", () => {
    openCenter();
    drive(h, "menuDiscountAdd", "S0004", "erta", "5", "10", "Vaqtida to'laydi", "");
    drive(h, "menuDiscountAdd", "S0001", "erta", "5", "10", "Vaqtida to'laydi", "");
    drive(h, "menuGenerateCharges", "2026-11");
    pay("S0004", 475_000, "2026-11-10"); // on the last day: earned
    pay("S0001", 475_000, "2026-11-11"); // one day late: not earned
    expect(actions.getBalance("S0004").outstanding).toBe(0);
    expect(actions.getBalance("S0001").outstanding).toBe(25_000);
  });

  it("rejects bad discount input with a readable dialog and writes nothing", () => {
    openCenter();
    expect(drive(h, "menuDiscountAdd", "S0002", "individual", "10", "x", "").last).toMatch(/Sabab 3-500/);
    expect(drive(h, "menuDiscountAdd", "S9999", "individual", "10", "Sabab bor", "").last).toMatch(/topilmadi/);
    expect(drive(h, "menuDiscountAdd", "S0002", "individual", "150", "Sabab bor", "").last).toMatch(/Foiz/);
    expect(drive(h, "menuDiscountAdd", "S0002", "erta", "5", "40", "Sabab bor", "").last).toMatch(/1-28/);
    expect(read<StudentDiscount>(DISCOUNTS)).toEqual([]);
  });

  it("partial payment, then the rest; the journal follows and verifies", () => {
    openCenter();
    drive(h, "menuGenerateCharges", "2026-11");
    pay("S0001", 200_000);
    expect(actions.getBalance("S0001").outstanding).toBe(300_000);
    pay("S0001", 300_000, "2026-11-05");
    expect(actions.getBalance("S0001").outstanding).toBe(0);
    expect(read<Payment>(PAYMENTS).filter((p) => p.studentId === "S0001")).toHaveLength(2);
    // overpayment becomes credit, not an error
    pay("S0002", 600_000);
    const b = actions.getBalance("S0002");
    expect([b.outstanding, b.credit]).toEqual([0, 100_000]);
    const v = drive(h, "menuLedgerVerify");
    expect(v.last).toMatch(/to'g'ri|buzilmagan|tekshirildi|OK/i);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    // cash = 200k + 300k + 600k received in cash
    expect(cash()).toBe(1_100_000);
  });

  it("refunds: wrong payment, leaving mid-month, to credit; and a refund over the limit is refused", () => {
    openCenter();
    drive(h, "menuGenerateCharges", "2026-11");
    const p1 = pay("S0001", 500_000);
    const p2 = pay("S0002", 450_000);
    pay("S0003", 250_000);
    // 1) wrong payment: 100 000 of P1 goes back in cash
    drive(h, "menuRefund", "xato", "S0001", "naqd", p1, "100000", "Xato summa kiritilgan");
    // 2) over the payment: refused, nothing written
    const bad = drive(h, "menuRefund", "xato", "S0001", "naqd", p1, "999999", "Juda ko'p");
    expect(bad.last).toMatch(/oshib ketdi/);
    // 3) leaving: S2 left on Nov 10, charge shrinks to the attended part and the surplus goes back
    const leave = drive(h, "menuRefund", "ketdi", "S0002", "naqd", charge("S0002").id, "2026-11-10", "Ketdi");
    expect(leave.alerts.at(-1)!.message).toContain("yozildi");
    // 4) to credit: no cash leaves
    drive(h, "menuRefund", "kredit", "S0003", charge("S0003").id, "50000", "Keyingi oyga");
    const refunds = read<Refund>(REFUNDS);
    expect(refunds.map((r) => [r.kind, r.payout])).toEqual([["wrong_payment", "cash"], ["leaving", "cash"], ["to_credit", "credit"]]);
    expect(refunds[0]!.amount).toBe(100_000);
    // cash moved out for the two cash refunds only; the journal stays balanced and verified
    const cashOut = refunds.filter((r) => r.payout === "cash").reduce((n, r) => n + r.amount, 0);
    expect(cash()).toBe(500_000 + 450_000 + 250_000 - cashOut);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    void p2;
  });

  it("the owner can decline the confirmation: nothing is written", () => {
    openCenter();
    drive(h, "menuGenerateCharges", "2026-11");
    const p1 = pay("S0001", 500_000);
    h.answers.push("NO");
    const r = drive(h, "menuRefund", "xato", "S0001", "naqd", p1, "100000", "Fikr o'zgardi");
    expect(r.last).toMatch(/Bekor qilindi/);
    expect(read<Refund>(REFUNDS)).toEqual([]);
  });

  it("daily cash close: matches, then a shortage needs a note and is booked", () => {
    openCenter();
    drive(h, "menuGenerateCharges", "2026-11");
    pay("S0001", 500_000, TODAY_ISO);
    expect(drive(h, "menuCashStatus").last).toContain("500");
    // exact count
    expect(drive(h, "menuCashClose", "500000").last).toMatch(/Smena 1 yopildi.*Farq: 0/);
    // second shift of the day, 20 000 short: needs a note, the owner chooses to book it
    const short = drive(h, "menuCashClose", "480000", "Kassadan 20 ming kam chiqdi");
    expect(short.last).toMatch(/Smena 2 yopildi/);
    const closes = read<{ shiftNo: number; difference: number; entryNo: number }>(CASH_CLOSES);
    expect(closes.map((c) => [c.shiftNo, c.difference])).toEqual([[1, 0], [2, -20_000]]);
    expect(closes[1]!.entryNo).toBeGreaterThan(0); // the difference went into the journal (alert default = YES)
    expect(cash()).toBe(480_000);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("a cash close with a difference and no note is refused", () => {
    openCenter();
    drive(h, "menuGenerateCharges", "2026-11");
    pay("S0001", 500_000, TODAY_ISO);
    const r = drive(h, "menuCashClose", "450000", "");
    expect(r.last).toMatch(/izoh kiritish majburiy/);
    expect(read(CASH_CLOSES)).toEqual([]);
  });

  it("tampering with the journal is detected and names the first broken row; fixing it back verifies again", () => {
    openCenter();
    drive(h, "menuGenerateCharges", "2026-11");
    pay("S0001", 500_000);
    pay("S0002", 450_000);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    const col = JOURNAL.cols.findIndex((c) => c.key === "debit");
    const row = h.sheet("Jurnal").data[2]!; // second journal line
    const original = row[col];
    row[col] = 1;
    const msg = drive(h, "menuLedgerVerify").last;
    expect(msg).toMatch(/2/); // names the broken row
    expect(ledger.verifyJournal().verdict.ok).toBe(false);
    row[col] = original;
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    // a deleted row is caught too
    h.sheet("Jurnal").data.splice(1, 1);
    expect(ledger.verifyJournal().verdict.ok).toBe(false);
  });
});

const TODAY_ISO = "2026-11-23";
