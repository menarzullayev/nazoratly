import { monthStart, nextMonthStart, withDay } from "./dates";
import { earlyDiscount, earlyPayBy, familyPercent, lastingDiscounts, type DiscountInput, type DiscountLine } from "./money";
import type { Charge, Enrollment, Group, ISODate, Student, StudentDiscount } from "./types";

export function effectiveFee(group: Group, enrollment: Enrollment): number {
  return Math.round(group.monthlyFee * (1 - enrollment.discountPercent / 100));
}

/** One lasting discount taken off a planned month, with the rule behind it ("" for the family discount). */
export interface PlannedDiscount extends DiscountLine {
  sourceId: string;
  percent: number;
  reason: string;
}

export interface PlannedCharge {
  studentId: string;
  enrollmentId: string;
  month: ISODate;
  amount: number; // after the lasting discounts (credits are subtracted by the caller)
  grossAmount: number; // fee before the lasting discounts
  dueDate: ISODate;
  note: string;
  discounts: PlannedDiscount[];
  /** the best early-payment rule: the caller computes the offer on the final amount (after credits) */
  earlyPercent: number;
  earlyDay: number;
  earlyRuleId: string;
}

export interface PlannedFreeMonth {
  studentId: string;
  enrollmentId: string;
  month: ISODate;
  discounts: PlannedDiscount[];
}

export interface BillingPlan {
  month: ISODate;
  create: PlannedCharge[];
  free: PlannedFreeMonth[]; // completely free months (scholarship): no charge, the discount lines are still kept
  skippedExisting: number;
  skippedZeroFee: number;
  skippedFree: number;
  skippedPackageGroups: number; // enrollments of package-billed groups: billed when a package is sold
  discounted: number; // new charges that got a lasting discount
}

const idNumber = (id: string): number => Number(id.replace(/\D/g, "")) || 0;

/** Rank of each billable student inside his family: students with the same guardian name are one family, ranked by
 * registration order (id). 1 = first child. (The API product connects families through shared guardian records.) */
export function familyRanks(students: Student[], billable: Set<string>): Map<string, number> {
  const byGuardian = new Map<string, Student[]>();
  for (const s of students) {
    const key = s.guardianName.trim().toLowerCase();
    if (!billable.has(s.id) || key === "") continue;
    (byGuardian.get(key) ?? byGuardian.set(key, []).get(key)!).push(s);
  }
  const ranks = new Map<string, number>();
  for (const s of students) if (billable.has(s.id)) ranks.set(s.id, 1);
  for (const family of byGuardian.values()) {
    family.sort((a, b) => idNumber(a.id) - idNumber(b.id) || a.id.localeCompare(b.id));
    family.forEach((s, i) => ranks.set(s.id, i + 1));
  }
  return ranks;
}

/**
 * Monthly tuition charges, same rules as the nazoratly API (/v1/charges/generate):
 * active or finished enrollments that overlap the month; frozen ones are not billed; cancelled groups and students
 * who left are skipped; full monthly fee (no proration); idempotent per enrollment + month.
 * Lasting discounts (rules/money.py, tests/golden/money.json): scholarship, family, individual, in that order, each
 * of the fee after the enrollment's own discount; the early-payment offer is carried by the planned charge.
 */
export function planCharges(args: {
  month: ISODate;
  dueDay: number;
  enrollments: Enrollment[];
  groups: Group[];
  students: Student[];
  charges: Charge[];
  discounts?: StudentDiscount[];
  family?: { second: number; third: number };
}): BillingPlan {
  if (!Number.isInteger(args.dueDay) || args.dueDay < 1 || args.dueDay > 28) throw new Error("dueDay must be 1..28");
  const first = monthStart(args.month);
  const next = nextMonthStart(first);
  const last = lastDayOf(first);
  const groups = new Map(args.groups.map((g) => [g.id, g]));
  const students = new Map(args.students.map((s) => [s.id, s]));
  const billed = new Set(args.charges.filter((c) => !c.voided && c.month === first).map((c) => c.enrollmentId));
  const plan: BillingPlan = { month: first, create: [], free: [], skippedExisting: 0, skippedZeroFee: 0, skippedFree: 0, skippedPackageGroups: 0, discounted: 0 };

  // pass 1: the enrollments that are billable this month (fee > 0); their students are the "billable children" of a family
  const eligible: { e: Enrollment; fee: number }[] = [];
  for (const e of args.enrollments) {
    const g = groups.get(e.groupId);
    const s = students.get(e.studentId);
    if (!g || !s || g.status === "cancelled" || s.status === "left") continue;
    if (e.status === "frozen" || e.status === "trial") continue;
    if (g.billingMode === "package") {
      if (e.startedOn < next && (e.endedOn === "" || e.endedOn >= first)) plan.skippedPackageGroups++;
      continue;
    }
    // a trial that was accepted is billed for its first month at acceptance; the monthly run starts after that month
    if (e.acceptedOn && first <= monthStart(e.acceptedOn)) continue;
    if (!(e.startedOn < next && (e.endedOn === "" || e.endedOn >= first))) continue;
    const fee = effectiveFee(g, e);
    if (fee <= 0) {
      plan.skippedZeroFee++;
      continue;
    }
    eligible.push({ e, fee });
  }
  const family = args.family ?? { second: 0, third: 0 };
  const ranks = familyRanks(args.students, new Set(eligible.map((x) => x.e.studentId)));
  const rules = (args.discounts ?? []).filter((d) => d.validFrom <= last && (d.validTo === "" || d.validTo >= first));

  for (const { e, fee } of eligible) {
    if (billed.has(e.id)) {
      plan.skippedExisting++;
      continue;
    }
    const inputs: DiscountInput[] = [];
    const meta: { sourceId: string; percent: number; reason: string }[] = [];
    let early: StudentDiscount | null = null;
    for (const d of rules) {
      if (d.studentId !== e.studentId || (d.enrollmentId !== "" && d.enrollmentId !== e.id)) continue;
      if (d.kind === "early_pay") {
        if (early === null || d.percent > early.percent) early = d;
        continue;
      }
      inputs.push(d.percent > 0 ? { kind: d.kind, percent: d.percent } : { kind: d.kind, amount: d.amount });
      meta.push({ sourceId: d.id, percent: d.percent, reason: d.reason });
    }
    const fam = familyPercent({ rank: ranks.get(e.studentId) ?? 1, second: family.second, third: family.third });
    if (fam > 0) {
      inputs.push({ kind: "family", percent: fam });
      meta.push({ sourceId: "", percent: fam, reason: "Oilaviy chegirma" });
    }
    const result = lastingDiscounts({ base: fee, discounts: inputs });
    const discounts: PlannedDiscount[] = result.lines.map((l) => ({ ...l, ...meta[l.index]! }));
    if (result.net <= 0) {
      plan.skippedFree++;
      plan.free.push({ studentId: e.studentId, enrollmentId: e.id, month: first, discounts });
      continue;
    }
    if (discounts.length > 0) plan.discounted++;
    plan.create.push({
      studentId: e.studentId,
      enrollmentId: e.id,
      month: first,
      amount: result.net,
      grossAmount: fee,
      dueDate: withDay(first, args.dueDay),
      note: `O'qish haqi ${first.slice(0, 7)}`,
      discounts,
      earlyPercent: early?.percent ?? 0,
      earlyDay: early?.payByDay ?? 0,
      earlyRuleId: early?.id ?? "",
    });
  }
  return plan;
}

function lastDayOf(first: ISODate): ISODate {
  const nxt = nextMonthStart(first);
  const t = Date.UTC(Number(nxt.slice(0, 4)), Number(nxt.slice(5, 7)) - 1, 0);
  return new Date(t).toISOString().slice(0, 10);
}

/** The early-payment offer of a planned charge on its final amount (after credits): so'm and the pay-by date. */
export function earlyOffer(c: Pick<PlannedCharge, "month" | "earlyPercent" | "earlyDay">, finalAmount: number): { discount: number; payBy: ISODate | "" } {
  if (c.earlyPercent <= 0 || c.earlyDay < 1) return { discount: 0, payBy: "" };
  const discount = earlyDiscount({ net: finalAmount, percent: c.earlyPercent });
  return discount > 0 ? { discount, payBy: earlyPayBy(c.month, c.earlyDay) } : { discount: 0, payBy: "" };
}
