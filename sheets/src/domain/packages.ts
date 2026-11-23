/**
 * Lesson package rules (abonement). Pure functions, mirrored in Python (backend/src/nazoratly/rules/packages.py); both
 * are checked against the same cases in tests/golden/packages.json.
 *
 * A package is bought as an ordinary charge; the lessons it gives are what has been PAID on that charge. Attendance
 * consumes lessons, a package burns at its expiry, and lessons attended without cover are negative lessons (debt).
 */
import { isIsoDate } from "./dates";
import { formatSomExact } from "./documents";
import type { AttendanceRow, Charge, Enrollment, Entitlement, Group, ISODate, Package } from "./types";

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

// ------------------------------------------------------------------ from sheet rows to balances

/** Why a package row cannot be used (it is ignored and listed by the menu check), or null when it is fine. */
export function packageProblem(p: Package, charges: Map<string, Charge>, enrollments: Map<string, Enrollment>): string | null {
  if (!Number.isInteger(p.lessons) || p.lessons < 1 || p.lessons > 200) return "darslar soni 1-200 orasida butun son bo'lishi kerak";
  if (!(p.price > 0)) return "narx musbat bo'lishi kerak";
  if (!isIsoDate(p.purchasedOn) || !isIsoDate(p.expiresOn)) return "sana noto'g'ri";
  if (p.expiresOn < p.purchasedOn) return "muddat sotilgan sanadan oldin";
  const c = charges.get(p.chargeId);
  if (!c) return "hisob topilmadi";
  if (c.studentId !== p.studentId) return "hisob boshqa o'quvchiniki";
  const e = enrollments.get(p.enrollmentId);
  if (!e) return "yozilish topilmadi";
  if (e.studentId !== p.studentId) return "yozilish boshqa o'quvchiniki";
  return null;
}

export interface EnrollmentBalance {
  enrollmentId: string;
  studentId: string;
  groupId: string;
  packageLessons: number;
  packagePrice: number;
  balance: Balance;
  need: Need;
  debtLessons: number;
  debtAmount: number;
}

/**
 * Lesson balance of every enrollment (of the given statuses) in a package-billed group, from sheet rows.
 * Same rules as the API (views v_lesson_packages / v_package_consumption + rules/packages.py): a package gives what was
 * paid on its charge (`paidByCharge`, FIFO money from computeDebts); present / late / unexcused absent attendance
 * consumes; a day that is an entitlement's make-up day never consumes; nothing counts from a trial, a dropped trial or
 * before the enrollment was accepted. Voided charges drop their package; broken package rows are returned as `problems`.
 */
export function enrollmentBalances(a: {
  groups: Group[];
  enrollments: Enrollment[];
  attendance: AttendanceRow[];
  entitlements: Entitlement[];
  packages: Package[];
  charges: Charge[];
  paidByCharge: Map<string, number>;
  excusedMode: ExcusedMode;
  lowLessons: number;
  today: ISODate;
  statuses?: Enrollment["status"][];
}): { balances: EnrollmentBalance[]; problems: { id: string; reason: string }[] } {
  const statuses = a.statuses ?? ["active"];
  const groups = new Map(a.groups.map((g) => [g.id, g]));
  const charges = new Map(a.charges.map((c) => [c.id, c]));
  const byId = new Map(a.enrollments.map((e) => [e.id, e]));
  const problems: { id: string; reason: string }[] = [];
  const packagesOf = new Map<string, PackageInput[]>();
  for (const p of a.packages) {
    const reason = packageProblem(p, charges, byId);
    if (reason) {
      problems.push({ id: p.id, reason });
      continue;
    }
    if (charges.get(p.chargeId)!.voided) continue;
    const credited = creditedLessons({ paid: a.paidByCharge.get(p.chargeId) ?? 0, price: p.price, lessons: p.lessons });
    (packagesOf.get(p.enrollmentId) ?? packagesOf.set(p.enrollmentId, []).get(p.enrollmentId)!).push({ credited, purchasedOn: p.purchasedOn, expiresOn: p.expiresOn });
  }
  const makeupDays = new Set(a.entitlements.filter((e) => e.lastMakeupOn).map((e) => `${e.studentId}|${e.groupId}|${e.lastMakeupOn}`));
  const balances: EnrollmentBalance[] = [];
  for (const e of a.enrollments) {
    const g = groups.get(e.groupId);
    if (!g || g.billingMode !== "package" || !statuses.includes(e.status)) continue;
    const lessons = g.packageLessons ?? 0;
    const price = g.packagePrice ?? 0;
    if (lessons < 1 || !(price > 0)) continue; // a package group without its lessons/price is a setup problem, not a balance
    const from = e.acceptedOn || e.startedOn;
    const free = e.status === "trial" || (e.status === "finished" && !e.acceptedOn && e.droppedTrial === true); // trial lessons stay free
    const consumedOn = (free ? [] : a.attendance)
      .filter(
        (r) =>
          r.studentId === e.studentId && r.groupId === e.groupId && r.date >= from && (e.endedOn === "" || r.date <= e.endedOn) &&
          consumesLesson({ status: r.status, isMakeup: makeupDays.has(`${r.studentId}|${r.groupId}|${r.date}`), excusedMode: a.excusedMode }),
      )
      .map((r) => r.date);
    const balance = packageBalance({ packages: packagesOf.get(e.id) ?? [], consumedOn, today: a.today });
    balances.push({
      enrollmentId: e.id,
      studentId: e.studentId,
      groupId: e.groupId,
      packageLessons: lessons,
      packagePrice: price,
      balance,
      need: paymentNeed({ balance: balance.balance, lowLessons: a.lowLessons }),
      debtLessons: balance.uncovered,
      debtAmount: lessonsMoney({ lessons: balance.uncovered, price, packageLessons: lessons }),
    });
  }
  return { balances, problems };
}
