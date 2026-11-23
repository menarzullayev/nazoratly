/**
 * Lesson package rules (abonement). Pure functions, mirrored in Python (backend/src/nazoratly/rules/packages.py); both
 * are checked against the same cases in tests/golden/packages.json.
 *
 * A package is bought as an ordinary charge; the lessons it gives are what has been PAID on that charge. Attendance
 * consumes lessons, a package burns at its expiry, and lessons attended without cover are negative lessons (debt).
 */
import { formatSomExact } from "./documents";
import type { ISODate } from "./types";

export type AttStatus = "present" | "absent" | "late" | "excused";
export type ExcusedMode = "makeup" | "credit" | "none";
export type Need = "ok" | "low" | "exhausted" | "debt";

/** Lessons a package has earned so far: proportional to the money paid, never above the package size. */
export function creditedLessons(a: { paid: number; price: number; lessons: number }): number {
  if (a.paid <= 0) return 0;
  return Math.min(a.lessons, Math.floor((a.paid * a.lessons) / a.price));
}

export function packageExpiresOn(purchasedOn: ISODate, expiryDays: number): ISODate {
  const t = Date.UTC(Number(purchasedOn.slice(0, 4)), Number(purchasedOn.slice(5, 7)) - 1, Number(purchasedOn.slice(8, 10)) + expiryDays);
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Does one attendance mark use up a lesson of the package? Present, late and unexcused absent do. An excused absence
 * does only when the center gives nothing for it (`none`); a make-up lesson is paid by its right.
 */
export function consumesLesson(a: { status: AttStatus; isMakeup: boolean; excusedMode: ExcusedMode }): boolean {
  if (a.isMakeup) return false;
  if (a.status === "excused") return a.excusedMode === "none";
  return true;
}

export interface PackageInput {
  credited: number;
  purchasedOn: ISODate;
  expiresOn: ISODate;
}

export interface Balance {
  available: number;
  burned: number;
  uncovered: number;
  balance: number;
  nextExpiry: ISODate | null;
}

/**
 * Lesson balance of one enrollment. Each consumed lesson (oldest first) takes a lesson from the first package that has
 * lessons left and was valid that day; a lesson nobody covered is `uncovered`. Uncovered lessons are then paid from any
 * package that has not expired today. Lessons left in a package that expired before today are `burned`.
 * `balance = available - uncovered`: negative means debt.
 */
export function packageBalance(a: { packages: PackageInput[]; consumedOn: ISODate[]; today: ISODate }): Balance {
  const pk = [...a.packages].sort((x, y) => (x.purchasedOn < y.purchasedOn ? -1 : x.purchasedOn > y.purchasedOn ? 1 : 0));
  const left = pk.map((p) => p.credited);
  let uncovered = 0;
  for (const day of [...a.consumedOn].sort()) {
    const i = pk.findIndex((p, k) => left[k]! > 0 && p.purchasedOn <= day && day <= p.expiresOn);
    if (i >= 0) left[i]!--;
    else uncovered++;
  }
  pk.forEach((p, i) => {
    if (uncovered === 0 || p.expiresOn < a.today) return;
    const take = Math.min(left[i]!, uncovered);
    left[i]! -= take;
    uncovered -= take;
  });
  let available = 0;
  let burned = 0;
  let nextExpiry: ISODate | null = null;
  pk.forEach((p, i) => {
    if (p.expiresOn < a.today) burned += left[i]!;
    else {
      available += left[i]!;
      if (left[i]! > 0 && (nextExpiry === null || p.expiresOn < nextExpiry)) nextExpiry = p.expiresOn;
    }
  });
  return { available, burned, uncovered, balance: available - uncovered, nextExpiry };
}

/** Money value of some lessons at the package's price per lesson, rounded half up to a whole so'm. */
export function lessonsMoney(a: { lessons: number; price: number; packageLessons: number }): number {
  return Math.floor((2 * a.lessons * a.price + a.packageLessons) / (2 * a.packageLessons));
}

export function paymentNeed(a: { balance: number; lowLessons: number }): Need {
  if (a.balance < 0) return "debt";
  if (a.balance === 0) return "exhausted";
  if (a.balance <= a.lowLessons) return "low";
  return "ok";
}

/** Reminder DRAFT text (a person approves it before anything is sent); empty when nothing is needed. */
export function packageReminderText(a: { need: Need; guardian: string; student: string; balance: number; debtAmount: number; center: string }): string {
  const hello = `Assalomu alaykum, ${a.guardian}!`;
  if (a.need === "low") return `${hello} ${a.student} uchun abonementda ${a.balance} ta dars qoldi. Darslar to'xtab qolmasligi uchun to'lovni oldindan amalga oshiring. ${a.center}`;
  if (a.need === "exhausted") return `${hello} ${a.student} uchun abonementdagi darslar tugadi. Davom etish uchun yangi abonement to'lovini amalga oshiring. ${a.center}`;
  if (a.need === "debt") return `${hello} ${a.student} ${-a.balance} ta darsda to'lovsiz qatnashdi (${formatSomExact(a.debtAmount)} so'm). Iltimos, abonement to'lovini amalga oshiring. ${a.center}`;
  return "";
}
