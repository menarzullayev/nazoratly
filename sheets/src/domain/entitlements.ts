/**
 * Excused-absence entitlement rules. Pure functions, mirrored in Python (backend/src/nazoratly/rules/entitlements.py);
 * both are checked against the same cases in tests/golden/entitlements.json.
 */
import type { ISODate } from "./types";

export type EntitlementStatus = "open" | "scheduled" | "used" | "cancelled";
export type EffectiveStatus = EntitlementStatus | "lapsed";

export function entitlementExpiresOn(missedOn: ISODate, expiryDays: number): ISODate {
  const t = Date.UTC(Number(missedOn.slice(0, 4)), Number(missedOn.slice(5, 7)) - 1, Number(missedOn.slice(8, 10)) + expiryDays);
  return new Date(t).toISOString().slice(0, 10);
}

/** Only an `open` right can lapse: the day after its expiry, and only when the center lets rights lapse. */
export function entitlementState(a: { status: EntitlementStatus; expiresOn: ISODate; today: ISODate; lapses: boolean }): EffectiveStatus {
  return a.status === "open" && a.lapses && a.today > a.expiresOn ? "lapsed" : a.status;
}

/** Money value of one lesson: the monthly fee split over the month's lessons, rounded half up to a whole so'm. */
export function lessonCreditAmount(a: { monthlyFee: number; lessonsInMonth: number }): number {
  if (a.lessonsInMonth <= 0) return 0;
  return Math.floor((2 * a.monthlyFee + a.lessonsInMonth) / (2 * a.lessonsInMonth));
}

/**
 * Subtract credits (oldest first) from a tuition fee. A credit is always consumed fully, even when it is larger than
 * what is left of the fee (the excess is lost); consumption stops as soon as the amount reaches zero.
 */
export function applyCredits(a: { fee: number; credits: number[] }): { amount: number; used: number } {
  let amount = Math.max(a.fee, 0);
  let used = 0;
  for (const c of a.credits) {
    if (amount <= 0) break;
    amount = Math.max(amount - c, 0);
    used++;
  }
  return { amount, used };
}
