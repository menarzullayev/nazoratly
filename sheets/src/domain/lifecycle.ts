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

const DAY_TOKENS: [string, number][] = [["du", 1], ["se", 2], ["chor", 3], ["pay", 4], ["ju", 5], ["sha", 6], ["yak", 7]];

/** ISO weekday numbers (1 = Monday) found in a schedule text like "Du-Chor-Ju 18:00" or "1, 3, 5". Times are ignored. */
export function parseWeekdays(spec: string): number[] {
  const out = new Set<number>();
  for (const raw of spec.toLowerCase().split(/[\s,;\-/]+/)) {
    if (!raw) continue;
    if (/^[1-7]$/.test(raw)) out.add(Number(raw));
    else for (const [prefix, n] of DAY_TOKENS) if (raw.startsWith(prefix) && raw.length <= prefix.length + 8 && !/\d/.test(raw)) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Lesson dates of a month implied by the weekly schedule text; empty when the text names no weekday. */
export function monthLessonDates(month: ISODate, spec: string): ISODate[] {
  const days = new Set(parseWeekdays(spec));
  if (days.size === 0) return [];
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: ISODate[] = [];
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (days.has(dow === 0 ? 7 : dow)) out.push(`${month.slice(0, 7)}-${String(d).padStart(2, "0")}`);
  }
  return out;
}
