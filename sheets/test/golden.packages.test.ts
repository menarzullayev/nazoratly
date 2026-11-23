import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consumesLesson, creditedLessons, lessonsMoney, packageBalance, packageExpiresOn, packageReminderText, paymentNeed } from "../src/domain/packages";

type Pk = { credited: number; purchased_on: string; expires_on: string };
type G = {
  credited: { name: string; in: { paid: string; price: string; lessons: number }; out: number }[];
  expires_on: { name: string; in: { purchased_on: string; expiry_days: number }; out: string }[];
  consumes: { name: string; in: { status: "present" | "absent" | "late" | "excused"; is_makeup: boolean; excused_mode: "makeup" | "credit" | "none" }; out: boolean }[];
  balance: { name: string; in: { packages: Pk[]; consumed_on: string[]; today: string }; out: { available: number; burned: number; uncovered: number; balance: number; next_expiry: string | null } }[];
  lessons_money: { name: string; in: { lessons: number; price: string; package_lessons: number }; out: string }[];
  payment_need: { name: string; in: { balance: number; low_lessons: number }; out: string }[];
  reminder_text: { name: string; in: { need: "ok" | "low" | "exhausted" | "debt"; guardian: string; student: string; balance: number; debt_amount: string; center: string }; out: string }[];
};
// The same file the Python suite reads (backend/tests/test_golden_packages.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/packages.json", import.meta.url), "utf8")) as G;

describe("golden: lesson package rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(40);
  });
  it.each(golden.credited)("creditedLessons: $name", (c) => {
    expect(creditedLessons({ paid: Number(c.in.paid), price: Number(c.in.price), lessons: c.in.lessons })).toBe(c.out);
  });
  it.each(golden.expires_on)("packageExpiresOn: $name", (c) => {
    expect(packageExpiresOn(c.in.purchased_on, c.in.expiry_days)).toBe(c.out);
  });
  it.each(golden.consumes)("consumesLesson: $name", (c) => {
    expect(consumesLesson({ status: c.in.status, isMakeup: c.in.is_makeup, excusedMode: c.in.excused_mode })).toBe(c.out);
  });
  it.each(golden.balance)("packageBalance: $name", (c) => {
    const got = packageBalance({
      packages: c.in.packages.map((p) => ({ credited: p.credited, purchasedOn: p.purchased_on, expiresOn: p.expires_on })),
      consumedOn: c.in.consumed_on,
      today: c.in.today,
    });
    expect(got).toEqual({ available: c.out.available, burned: c.out.burned, uncovered: c.out.uncovered, balance: c.out.balance, nextExpiry: c.out.next_expiry });
  });
  it.each(golden.lessons_money)("lessonsMoney: $name", (c) => {
    expect(lessonsMoney({ lessons: c.in.lessons, price: Number(c.in.price), packageLessons: c.in.package_lessons })).toBe(Number(c.out));
  });
  it.each(golden.payment_need)("paymentNeed: $name", (c) => {
    expect(paymentNeed({ balance: c.in.balance, lowLessons: c.in.low_lessons })).toBe(c.out);
  });
  it.each(golden.reminder_text)("packageReminderText: $name", (c) => {
    expect(packageReminderText({ need: c.in.need, guardian: c.in.guardian, student: c.in.student, balance: c.in.balance, debtAmount: Number(c.in.debt_amount), center: c.in.center })).toBe(c.out);
  });
});
