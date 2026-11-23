/**
 * Admission lifecycle rules. Pure functions, mirrored in Python (backend/src/nazoratly/rules/lifecycle.py); both are
 * checked against the same cases in tests/golden/lifecycle.json.
 */
import { daysBetween } from "./dates";
import type { ISODate } from "./types";

export type TrialState = "running" | "decision_needed";
export type FirstMonthMode = "full" | "prorated" | "free_until_next";

/** A trial needs a decision once the free lessons are used up OR the free days have passed, whichever is first. */
export function trialStatus(a: { startedOn: ISODate; today: ISODate; lessonsAttended: number; freeLessons: number; freeDays: number }): TrialState {
  const days = daysBetween(a.startedOn, a.today);
  return a.lessonsAttended >= a.freeLessons || days >= a.freeDays ? "decision_needed" : "running";
}

/**
 * Amount of the first tuition charge for the month in which a trial is accepted. `lessonDates` are all lessons of that
 * month. `prorated` charges the share of lessons on or after `acceptedOn`, rounded half up to a whole so'm; a month with
 * no lessons at all falls back to the full fee and says so.
 */
export function firstMonthCharge(a: { mode: FirstMonthMode; monthlyFee: number; acceptedOn: ISODate; lessonDates: ISODate[] }): {
  amount: number;
  fallbackToFull: boolean;
} {
  if (a.mode === "free_until_next") return { amount: 0, fallbackToFull: false };
  const full = Math.round(a.monthlyFee);
  if (a.mode === "full") return { amount: full, fallbackToFull: false };
  const total = a.lessonDates.length;
  if (total === 0) return { amount: full, fallbackToFull: true };
  const remaining = a.lessonDates.filter((d) => d >= a.acceptedOn).length;
  // integer arithmetic: floor((2*fee*remaining + total) / (2*total)) is round-half-up of fee*remaining/total
  const amount = Math.floor((2 * a.monthlyFee * remaining + total) / (2 * total));
  return { amount, fallbackToFull: false };
}
