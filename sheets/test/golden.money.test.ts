import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cashCloseErrors, cashDifference, earlyDiscount, earlyGranted, earlyPayBy, familyPercent, lastingDiscounts, leavingSplit, packageRemainder, refundErrors, type DiscountInput } from "../src/domain/money";

type Case<I, O> = { name: string; in: I; out: O };
type G = {
  family_percent: Case<{ rank: number; second: string; third: string }, string>[];
  lasting_discounts: Case<{ base: number; discounts: { kind: DiscountInput["kind"]; percent?: string; amount?: number }[] }, { lines: { index: number; kind: string; amount: number }[]; net: number }>[];
  early_discount: Case<{ net: number; percent: string }, number>[];
  early_pay_by: Case<{ month: string; day: number }, string>[];
  early_granted: Case<{ pay_by: string; payments: { on: string; amount: number }[]; amount: number; early: number }, { granted: boolean; on_time: number; excess: number }>[];
  leaving: Case<{ amount: number; paid: number; left_on: string; month: string }, { used: number; reduction: number; refund: number }>[];
  package_remainder: Case<{ price: number; package_lessons: number; remaining_lessons: number; paid: number; keep_lessons?: number }, number>[];
  refund_errors: Case<{ kind: string; payout: string; amount: number; available: number }, string[]>[];
  cash_difference: Case<{ book: number; counted: number }, { difference: number; status: string }>[];
  cash_close_errors: Case<{ counted: number; difference: number; note: string }, string[]>[];
};
// The same file the Python suite reads (backend/tests/test_golden_money.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/money.json", import.meta.url), "utf8")) as G;

describe("golden: money rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(70);
  });
  it.each(golden.family_percent)("familyPercent: $name", (c) => {
    expect(familyPercent(c.in)).toBe(Number(c.out));
  });
  it.each(golden.lasting_discounts)("lastingDiscounts: $name", (c) => {
    expect(lastingDiscounts({ base: c.in.base, discounts: c.in.discounts })).toEqual(c.out);
  });
  it.each(golden.early_discount)("earlyDiscount: $name", (c) => {
    expect(earlyDiscount(c.in)).toBe(c.out);
  });
  it.each(golden.early_pay_by)("earlyPayBy: $name", (c) => {
    expect(earlyPayBy(c.in.month, c.in.day)).toBe(c.out);
  });
  it.each(golden.early_granted)("earlyGranted: $name", (c) => {
    expect(earlyGranted({ payBy: c.in.pay_by, payments: c.in.payments, amount: c.in.amount, early: c.in.early })).toEqual({ granted: c.out.granted, onTime: c.out.on_time, excess: c.out.excess });
  });
  it.each(golden.leaving)("leavingSplit: $name", (c) => {
    expect(leavingSplit({ amount: c.in.amount, paid: c.in.paid, leftOn: c.in.left_on, month: c.in.month })).toEqual(c.out);
  });
  it.each(golden.package_remainder)("packageRemainder: $name", (c) => {
    expect(packageRemainder({ price: c.in.price, packageLessons: c.in.package_lessons, remainingLessons: c.in.remaining_lessons, paid: c.in.paid, keepLessons: c.in.keep_lessons })).toBe(c.out);
  });
  it.each(golden.refund_errors)("refundErrors: $name", (c) => {
    expect(refundErrors(c.in)).toEqual(c.out);
  });
  it.each(golden.cash_difference)("cashDifference: $name", (c) => {
    expect(cashDifference(c.in)).toEqual(c.out);
  });
  it.each(golden.cash_close_errors)("cashCloseErrors: $name", (c) => {
    expect(cashCloseErrors(c.in)).toEqual(c.out);
  });
});
