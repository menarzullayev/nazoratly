import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyCredits, entitlementExpiresOn, entitlementState, lessonCreditAmount } from "../src/domain/entitlements";

type G = {
  expires_on: { name: string; in: { missed_on: string; expiry_days: number }; out: string }[];
  state: { name: string; in: { status: "open" | "scheduled" | "used" | "cancelled"; expires_on: string; today: string; lapses: boolean }; out: string }[];
  lesson_credit_amount: { name: string; in: { monthly_fee: number; lessons_in_month: number }; out: number }[];
  apply_credits: { name: string; in: { fee: number; credits: number[] }; out: { amount: number; used: number } }[];
};
// The same file the Python suite reads (backend/tests/test_golden_entitlements.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/entitlements.json", import.meta.url), "utf8")) as G;

describe("golden: entitlement rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(23);
  });
  it.each(golden.expires_on)("expiresOn: $name", (c) => {
    expect(entitlementExpiresOn(c.in.missed_on, c.in.expiry_days)).toBe(c.out);
  });
  it.each(golden.state)("state: $name", (c) => {
    expect(entitlementState({ status: c.in.status, expiresOn: c.in.expires_on, today: c.in.today, lapses: c.in.lapses })).toBe(c.out);
  });
  it.each(golden.lesson_credit_amount)("lessonCreditAmount: $name", (c) => {
    expect(lessonCreditAmount({ monthlyFee: c.in.monthly_fee, lessonsInMonth: c.in.lessons_in_month })).toBe(c.out);
  });
  it.each(golden.apply_credits)("applyCredits: $name", (c) => {
    expect(applyCredits({ fee: c.in.fee, credits: c.in.credits })).toEqual(c.out);
  });
});
