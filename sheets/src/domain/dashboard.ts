/**
 * Dashboard rules: paid vs unpaid students, student movement and trial conversion, six-month finance and the
 * "waiting for a decision" lists. Pure functions, mirrored in Python (backend/src/nazoratly/rules/dashboard.py); both
 * are checked against the same cases in tests/golden/dashboard.json. The lead funnel, trial limits and package balances
 * are reused from their own modules, never recomputed.
 */
import { daysBetween } from "./dates";
import { trialStatus } from "./lifecycle";
import type { ISODate } from "./types";

/** percent with one decimal, half up */
const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.floor((part * 1000) / whole + 0.5) / 10);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const addDays = (iso: ISODate, days: number): ISODate => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days)).toISOString().slice(0, 10);

// ---- block 1: paid vs unpaid
export interface StudentMoney {
  id: string;
  outstanding: number;
  overdue: number;
  packageDebtLessons: number;
}

export interface PaymentStatus {
  paid: number;
  unpaid: number;
  overdue: number;
  unpaidStudents: StudentMoney[];
  paidIds: string[];
}

const isUnpaid = (s: StudentMoney): boolean => s.outstanding > 0 || s.packageDebtLessons > 0;

/** Unpaid = open money (installments included) or negative lessons in a package group; overdue is the subset with an overdue amount. */
export function paymentStatus(students: StudentMoney[]): PaymentStatus {
  const unpaid = students.filter(isUnpaid).sort((a, b) => b.outstanding - a.outstanding || cmp(a.id, b.id));
  const paidIds = students.filter((s) => !isUnpaid(s)).map((s) => s.id).sort(cmp);
  return {
    paid: paidIds.length,
    unpaid: unpaid.length,
    overdue: unpaid.filter((s) => s.overdue > 0).length,
    unpaidStudents: unpaid.map((s) => ({ id: s.id, outstanding: s.outstanding, overdue: s.overdue, packageDebtLessons: s.packageDebtLessons })),
    paidIds,
  };
}

// ---- block 2: movement and trial conversion
export interface EnrollmentFact {
  student: string;
  status: "trial" | "active" | "frozen" | "finished";
  startedOn: ISODate;
  acceptedOn: ISODate | "";
  endedOn: ISODate | "";
  droppedTrial: boolean;
}

export interface Movement {
  new: number;
  left: number;
  newIds: string[];
  leftIds: string[];
  trialsStarted: number;
  accepted: number;
  dropped: number;
  running: number;
  conversion: number;
}

/**
 * New = first real join (acceptedOn, else startedOn) in the range; left = no open enrollment now and the latest real end
 * date in the range. A dropped trial and a running trial are not real enrollments. The trial cohort is the enrollments
 * that went through a trial and started in the range; conversion = accepted / (accepted + dropped).
 */
export function studentMovement(enrollments: EnrollmentFact[], range: { from: ISODate; to: ISODate }): Movement {
  const joined = new Map<string, ISODate>();
  const leftOn = new Map<string, ISODate>();
  const open = new Set<string>();
  for (const e of enrollments) {
    if (e.status === "trial" || e.status === "active" || e.status === "frozen") open.add(e.student);
    if (e.droppedTrial || e.status === "trial") continue;
    const become = e.acceptedOn || e.startedOn;
    const j = joined.get(e.student);
    if (j === undefined || become < j) joined.set(e.student, become);
    if (e.status === "finished" && e.endedOn) {
      const l = leftOn.get(e.student);
      if (l === undefined || e.endedOn > l) leftOn.set(e.student, e.endedOn);
    }
  }
  const inRange = (d: ISODate): boolean => d >= range.from && d <= range.to;
  const newIds = [...joined].filter(([, d]) => inRange(d)).map(([s]) => s).sort(cmp);
  const leftIds = [...leftOn].filter(([s, d]) => !open.has(s) && inRange(d)).map(([s]) => s).sort(cmp);
  const cohort = enrollments.filter((e) => inRange(e.startedOn) && (e.status === "trial" || e.acceptedOn || e.droppedTrial));
  const accepted = cohort.filter((e) => e.acceptedOn).length;
  const dropped = cohort.filter((e) => e.droppedTrial).length;
  const running = cohort.filter((e) => e.status === "trial" && !e.droppedTrial).length;
  return { new: newIds.length, left: leftIds.length, newIds, leftIds, trialsStarted: cohort.length, accepted, dropped, running, conversion: pct(accepted, accepted + dropped) };
}

// ---- block 3: six-month finance
export interface MoneyOn {
  on: ISODate;
  amount: number;
}
export interface PayrollMonth {
  month: ISODate;
  amount: number;
}
export interface MonthPoint {
  month: ISODate;
  income: number;
  operating: number;
  payroll: number;
  expenses: number;
  net: number;
}
export interface Finance {
  months: MonthPoint[];
  income: number;
  expenses: number;
  net: number;
}

export const FINANCE_MONTHS = 6;

/** The six calendar months ending with the month of `today`; expenses = operating + payroll, net = income - expenses. Voided rows and payroll drafts are filtered by the caller. */
export function monthlyFinance(input: { payments: MoneyOn[]; expenses: MoneyOn[]; payroll: PayrollMonth[]; today: ISODate }): Finance {
  const keys: string[] = [];
  let y = Number(input.today.slice(0, 4));
  let m = Number(input.today.slice(5, 7));
  for (let i = 0; i < FINANCE_MONTHS; i++) {
    keys.unshift(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
    if (m === 1) {
      y -= 1;
      m = 12;
    } else m -= 1;
  }
  const sum = (rows: { key: string; amount: number }[], k: string): number => rows.filter((r) => r.key === k).reduce((s, r) => s + r.amount, 0);
  const pay = input.payments.map((p) => ({ key: p.on.slice(0, 7), amount: p.amount }));
  const exp = input.expenses.map((p) => ({ key: p.on.slice(0, 7), amount: p.amount }));
  const prl = input.payroll.map((p) => ({ key: p.month.slice(0, 7), amount: p.amount }));
  const months = keys.map((k) => {
    const income = sum(pay, k);
    const operating = sum(exp, k);
    const payroll = sum(prl, k);
    return { month: `${k}-01`, income, operating, payroll, expenses: operating + payroll, net: income - operating - payroll };
  });
  const income = months.reduce((s, p) => s + p.income, 0);
  const expenses = months.reduce((s, p) => s + p.expenses, 0);
  return { months, income, expenses, net: income - expenses };
}

// ---- block 4: waiting for a decision
export interface TrialWait {
  id: string;
  startedOn: ISODate;
  lessonsAttended: number;
}
export interface PackageWait {
  id: string;
  available: number;
  nextExpiry: ISODate | null;
}
export interface RightWait {
  id: string;
  kind: "makeup" | "credit";
  status: "open" | "scheduled" | "used" | "cancelled";
  expiresOn: ISODate;
}
export interface Waiting {
  trials: { id: string; startedOn: ISODate; lessonsAttended: number; daysElapsed: number; reason: "lessons" | "days" }[];
  packages: { id: string; available: number; nextExpiry: ISODate; daysLeft: number }[];
  rights: { id: string; expiresOn: ISODate; daysLeft: number }[];
  total: number;
}

/** Trials whose limit is reached, packages with lessons left that expire within the window, open make-up rights that lapse within the window (today through today + window inclusive). Each list is ordered by urgency, then id. */
export function waitingItems(input: { trials: TrialWait[]; packages: PackageWait[]; rights: RightWait[]; today: ISODate; windowDays: number; freeLessons: number; freeDays: number; makeupLapses: boolean }): Waiting {
  const last = addDays(input.today, input.windowDays);
  const trials = [...input.trials]
    .sort((a, b) => cmp(a.startedOn, b.startedOn) || cmp(a.id, b.id))
    .filter((t) => trialStatus({ startedOn: t.startedOn, today: input.today, lessonsAttended: t.lessonsAttended, freeLessons: input.freeLessons, freeDays: input.freeDays }) === "decision_needed")
    .map((t) => ({ id: t.id, startedOn: t.startedOn, lessonsAttended: t.lessonsAttended, daysElapsed: daysBetween(t.startedOn, input.today), reason: (t.lessonsAttended >= input.freeLessons ? "lessons" : "days") as "lessons" | "days" }));
  const packages = input.packages
    .filter((p): p is PackageWait & { nextExpiry: ISODate } => p.nextExpiry !== null && p.available > 0 && p.nextExpiry >= input.today && p.nextExpiry <= last)
    .sort((a, b) => cmp(a.nextExpiry, b.nextExpiry) || cmp(a.id, b.id))
    .map((p) => ({ id: p.id, available: p.available, nextExpiry: p.nextExpiry, daysLeft: daysBetween(input.today, p.nextExpiry) }));
  const rights = input.rights
    .filter((r) => input.makeupLapses && r.kind === "makeup" && r.status === "open" && r.expiresOn >= input.today && r.expiresOn <= last)
    .sort((a, b) => cmp(a.expiresOn, b.expiresOn) || cmp(a.id, b.id))
    .map((r) => ({ id: r.id, expiresOn: r.expiresOn, daysLeft: daysBetween(input.today, r.expiresOn) }));
  return { trials, packages, rights, total: trials.length + packages.length + rights.length };
}
