/**
 * Money rules of group G1: lasting discounts, early-payment discount, refunds and the daily cash close. Mirror of
 * backend/src/nazoratly/rules/money.py; both are checked against the same cases in tests/golden/money.json.
 *
 * Amounts are whole so'm (integers); every rounding is half up to a whole so'm. Percents arrive as numbers with at most
 * two decimals and are handled as integer hundredths so no floating point error can move a rounding boundary.
 * There is deliberately NO late-payment penalty: overdue money only triggers reminders.
 */
import { daysBetween, nextMonthStart, withDay } from "./dates";
import type { ISODate } from "./types";

const hundredths = (percent: number | string): number => Math.round(Number(percent) * 100);
/** round_half_up(base * percent / 100) with percent given in hundredths of a percent. */
const percentOf = (base: number, pct100: number): number => Math.floor((2 * base * pct100 + 10000) / 20000);

export type DiscountKind = "scholarship" | "family" | "individual";
export const LASTING_ORDER: readonly DiscountKind[] = ["scholarship", "family", "individual"];

export function familyPercent(a: { rank: number; second: number | string; third: number | string }): number {
  if (a.rank <= 1) return 0;
  return Number(a.rank === 2 ? a.second : a.third);
}

export interface DiscountInput {
  kind: DiscountKind;
  percent?: number | string;
  amount?: number;
}
export interface DiscountLine {
  index: number; // position of the rule in the input list
  kind: DiscountKind;
  amount: number;
}

/** Order: scholarship, family, individual (input order inside a kind). A percent is taken of the base, an amount is
 * fixed; the running total is capped so the net never goes below zero; a discount that takes nothing writes no line. */
export function lastingDiscounts(a: { base: number; discounts: DiscountInput[] }): { lines: DiscountLine[]; net: number } {
  let remaining = Math.max(a.base, 0);
  const lines: DiscountLine[] = [];
  const order = a.discounts.map((_, i) => i).sort((x, y) => LASTING_ORDER.indexOf(a.discounts[x]!.kind) - LASTING_ORDER.indexOf(a.discounts[y]!.kind) || x - y);
  for (const i of order) {
    const d = a.discounts[i]!;
    const raw = d.percent !== undefined ? percentOf(Math.max(a.base, 0), hundredths(d.percent)) : (d.amount ?? 0);
    const take = Math.min(raw, remaining);
    if (take <= 0) continue;
    remaining -= take;
    lines.push({ index: i, kind: d.kind, amount: take });
  }
  return { lines, net: remaining };
}

/** Never the whole price: at least one so'm stays to pay. */
export function earlyDiscount(a: { net: number; percent: number | string }): number {
  if (a.net <= 1 || Number(a.percent) <= 0) return 0;
  return Math.min(percentOf(a.net, hundredths(a.percent)), a.net - 1);
}

export function earlyPayBy(month: ISODate, day: number): ISODate {
  return withDay(month, day);
}

/** Is the early discount earned? Money paid on or before `payBy` must cover the reduced price (`amount - early`).
 * `excess` is what was paid beyond the reduced price (it stays as the student's credit). */
export function earlyGranted(a: { payBy: ISODate; payments: { on: ISODate; amount: number }[]; amount: number; early: number }): { granted: boolean; onTime: number; excess: number } {
  const onTime = a.payments.filter((p) => p.on <= a.payBy).reduce((n, p) => n + p.amount, 0);
  const total = a.payments.reduce((n, p) => n + p.amount, 0);
  const target = a.amount - a.early;
  const granted = a.early > 0 && onTime >= target;
  return { granted, onTime, excess: granted ? Math.max(total - target, 0) : 0 };
}

const daysInMonth = (first: ISODate): number => daysBetween(first, nextMonthStart(first));

/** A student leaves: the month is charged proportionally to the days attended (the leave day counts). `reduction` is how
 * much the charge shrinks, `refund` the money that was paid beyond the used part. */
export function leavingSplit(a: { amount: number; paid: number; leftOn: ISODate; month: ISODate }): { used: number; reduction: number; refund: number } {
  const first = `${a.month.slice(0, 8)}01`;
  const days = daysInMonth(first);
  const last = withDay(first, days);
  let used: number;
  if (a.leftOn < first) used = 0;
  else if (a.leftOn >= last) used = a.amount;
  else used = Math.floor((2 * a.amount * Number(a.leftOn.slice(8, 10)) + days) / (2 * days));
  return { used, reduction: a.amount - used, refund: Math.max(Math.min(a.paid, a.amount) - used, 0) };
}

/** Money value of the unused lessons of a package (half up), never more than was paid for it. `keepLessons` must stay
 * covered after the refund: the refund is also capped at `paid - ceil(keepLessons * price / packageLessons)`. */
export function packageRemainder(a: { price: number; packageLessons: number; remainingLessons: number; paid: number; keepLessons?: number }): number {
  const left = Math.max(Math.min(a.remainingLessons, a.packageLessons), 0);
  if (left === 0 || a.packageLessons <= 0) return 0;
  let value = Math.min(Math.floor((2 * left * a.price + a.packageLessons) / (2 * a.packageLessons)), Math.max(a.paid, 0));
  const keep = a.keepLessons ?? 0;
  if (keep > 0) value = Math.min(value, a.paid - Math.floor((keep * a.price + a.packageLessons - 1) / a.packageLessons));
  return Math.max(value, 0);
}

export type RefundKind = "wrong_payment" | "leaving" | "package_remainder" | "to_credit";
export type Payout = "cash" | "bank" | "credit";
const PAYOUTS: Record<string, readonly string[]> = {
  wrong_payment: ["cash", "bank"],
  leaving: ["cash", "bank", "credit"],
  package_remainder: ["cash", "bank", "credit"],
  to_credit: ["credit"],
};

/** Machine-readable problems of a refund request; empty when it can be made. */
export function refundErrors(a: { kind: string; payout: string; amount: number; available: number }): string[] {
  const allowed = PAYOUTS[a.kind];
  if (!allowed) return ["bad_kind"];
  const errors: string[] = [];
  if (!(a.amount > 0)) errors.push("not_positive");
  if (!allowed.includes(a.payout)) errors.push("bad_payout");
  if (a.amount > 0 && a.amount > a.available) errors.push("exceeds_available");
  return errors;
}

export function cashDifference(a: { book: number; counted: number }): { difference: number; status: "ok" | "over" | "short" } {
  const difference = a.counted - a.book;
  return { difference, status: difference === 0 ? "ok" : difference > 0 ? "over" : "short" };
}

export function cashCloseErrors(a: { counted: number; difference: number; note: string }): string[] {
  const errors: string[] = [];
  if (a.counted < 0) errors.push("negative_counted");
  if (a.difference !== 0 && a.note.trim() === "") errors.push("note_required");
  return errors;
}
