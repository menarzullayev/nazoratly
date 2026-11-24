/**
 * Growth rules: referral rewards, promo codes, the marketing-credit summary, lead source ROI and internal lead reminders.
 * Pure functions, mirrored in Python (backend/src/nazoratly/rules/growth.py); both are checked against the same cases in
 * tests/golden/growth.json. Money is whole so'm.
 *
 * Rewards and promo discounts are booked as open credits (the existing credit mechanism); nothing here changes how
 * tuition is billed and nothing here is sent to anybody: reminders are an internal list.
 */
import { daysBetween } from "./dates";
import { lessonCreditAmount } from "./entitlements";
import type { ISODate } from "./types";

export type RewardType = "amount" | "percent" | "free_lesson";
export type Condition = "enrolled" | "paid";
export type PromoKind = "percent" | "amount";
export type PromoState = "ok" | "inactive" | "not_started" | "expired" | "exhausted";

const roundHalfUp = (x: number): number => Math.floor(x + 0.5);
/** a / b rounded half away from zero (the Python side uses ROUND_HALF_UP on a Decimal) */
const divRound = (a: number, b: number): number => {
  const q = Math.floor((2 * Math.abs(a) + b) / (2 * b));
  return (a < 0 ? -q : q) + 0; // + 0 turns -0 into 0
};
/** value percent of fee, half up; exact for the whole and halved percentages used in practice */
const percentOf = (fee: number, pct: number): number => Math.floor((2 * fee * pct + 100) / 200);

// ---- referral ---------------------------------------------------------------------------------------------------
/** Money value of a referral reward: amount = itself; percent = % of the referrer's monthly fee; free_lesson = N lessons. */
export function referralRewardAmount(a: { rewardType: RewardType; rewardValue: number; monthlyFee: number; lessonsInMonth: number }): number {
  if (a.rewardValue <= 0) return 0;
  if (a.rewardType === "amount") return roundHalfUp(a.rewardValue);
  if (a.rewardType === "percent") return percentOf(Math.max(a.monthlyFee, 0), a.rewardValue);
  return roundHalfUp(lessonCreditAmount({ monthlyFee: a.monthlyFee, lessonsInMonth: a.lessonsInMonth }) * a.rewardValue);
}

/** A credit is consumed whole by billing, so a reward is split into credits of at most one monthly fee. */
export function splitCredit(a: { amount: number; monthlyFee: number }): number[] {
  if (a.amount <= 0) return [];
  if (a.monthlyFee <= 0) return [a.amount];
  const out: number[] = [];
  let left = a.amount;
  while (left > 0) {
    const part = Math.min(left, a.monthlyFee);
    out.push(part);
    left -= part;
  }
  return out;
}

/** enrolled: the invited student has an accepted (active) enrollment. paid: paid at least minPaid in total (and > 0). */
export function referralConditionMet(a: { condition: Condition; minPaid: number; invitedEnrolled: boolean; invitedPaid: number }): boolean {
  return a.condition === "enrolled" ? a.invitedEnrolled : a.invitedPaid > 0 && a.invitedPaid >= a.minPaid;
}

// ---- promo ------------------------------------------------------------------------------------------------------
/** Can a promo code be redeemed today? Checked in this order: inactive, not started, expired, exhausted. */
export function promoState(a: { active: boolean; validFrom: ISODate; validTo: ISODate | ""; maxUses: number | null; used: number; today: ISODate }): PromoState {
  if (!a.active) return "inactive";
  if (a.today < a.validFrom) return "not_started";
  if (a.validTo && a.today > a.validTo) return "expired";
  if (a.maxUses !== null && a.used >= a.maxUses) return "exhausted";
  return "ok";
}

/** The credit a promo gives against the first month: percent of the fee (half up) or a fixed amount, capped at the fee. */
export function promoDiscount(a: { kind: PromoKind; value: number; fee: number }): number {
  const fee = Math.max(a.fee, 0);
  if (a.value <= 0 || fee === 0) return 0;
  const raw = a.kind === "percent" ? percentOf(fee, a.value) : roundHalfUp(a.value);
  return Math.min(raw, fee);
}

// ---- marketing credits in accounting -----------------------------------------------------------------------------
export interface CreditFact {
  source: string;
  label: string;
  amount: number;
  status: string;
}
export interface CreditRow {
  count: number;
  granted: number;
  applied: number;
  outstanding: number;
  cancelled: number;
}
const zeroRow = (): CreditRow => ({ count: 0, granted: 0, applied: 0, outstanding: 0, cancelled: 0 });

/** Per (source, label): credits granted, money applied against charges, still waiting, cancelled (not counted as granted). */
export function growthCreditSummary(credits: CreditFact[]): { rows: (CreditRow & { source: string; label: string })[]; totals: CreditRow } {
  const groups = new Map<string, CreditRow & { source: string; label: string }>();
  for (const c of credits) {
    const key = `${c.source}\u0000${c.label}`;
    const g = groups.get(key) ?? { source: c.source, label: c.label, ...zeroRow() };
    groups.set(key, g);
    if (c.status === "cancelled") {
      g.cancelled += c.amount;
      continue;
    }
    g.count++;
    g.granted += c.amount;
    if (c.status === "used") g.applied += c.amount;
    else g.outstanding += c.amount;
  }
  const rows = [...groups.values()].sort((a, b) => (a.source === b.source ? (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) : a.source < b.source ? -1 : 1));
  const totals = zeroRow();
  for (const r of rows) for (const k of Object.keys(totals) as (keyof CreditRow)[]) totals[k] += r[k];
  return { rows, totals };
}

// ---- lead source ROI -----------------------------------------------------------------------------------------------
export interface SourceLead {
  source: string | null;
  createdOn: ISODate;
  revenue: number; // live payments of the student the lead became, up to the end of the range
}
export interface SourceCost {
  source: string;
  month: ISODate; // first day of the month
  amount: number;
}
export interface RoiRow {
  source: string | null;
  leads: number;
  paying: number;
  revenue: number;
  cost: number;
  roi: number | null;
  costPerLead: number | null;
  costPerPaying: number | null;
}

const first = (d: ISODate): ISODate => `${d.slice(0, 7)}-01`;

/**
 * Per source: leads created in the range, the ones that pay (revenue > 0), their revenue, the cost entered for the months
 * the range touches and the ratios (roi in percent with one decimal, half away from zero; null without cost). Ordered by
 * revenue (desc), then name; leads without a source come last.
 */
export function sourceRoi(leads: SourceLead[], costs: SourceCost[], range: { from: ISODate; to: ISODate }): { rows: RoiRow[]; total: RoiRow } {
  const per = new Map<string | null, { leads: number; paying: number; revenue: number; cost: number }>();
  const row = (s: string | null) => {
    let r = per.get(s);
    if (!r) per.set(s, (r = { leads: 0, paying: 0, revenue: 0, cost: 0 }));
    return r;
  };
  for (const l of leads) {
    if (l.createdOn < range.from || l.createdOn > range.to) continue;
    const r = row(l.source);
    r.leads++;
    if (l.revenue > 0) {
      r.paying++;
      r.revenue += l.revenue;
    }
  }
  const lo = first(range.from);
  const hi = first(range.to);
  for (const c of costs) if (c.month >= lo && c.month <= hi) row(c.source).cost += c.amount;
  const build = (source: string | null, r: { leads: number; paying: number; revenue: number; cost: number }): RoiRow => ({
    source,
    leads: r.leads,
    paying: r.paying,
    revenue: r.revenue,
    cost: r.cost,
    roi: r.cost > 0 ? divRound((r.revenue - r.cost) * 1000, r.cost) / 10 : null,
    costPerLead: r.leads > 0 && r.cost > 0 ? divRound(r.cost, r.leads) : null,
    costPerPaying: r.paying > 0 && r.cost > 0 ? divRound(r.cost, r.paying) : null,
  });
  const entries = [...per.entries()].sort(
    (a, b) => Number(a[0] === null) - Number(b[0] === null) || b[1].revenue - a[1].revenue || (a[0] ?? "").localeCompare(b[0] ?? ""),
  );
  const total = { leads: 0, paying: 0, revenue: 0, cost: 0 };
  for (const [, r] of entries) {
    total.leads += r.leads;
    total.paying += r.paying;
    total.revenue += r.revenue;
    total.cost += r.cost;
  }
  return { rows: entries.map(([s, r]) => build(s, r)), total: build("TOTAL", total) };
}

// ---- internal lead reminders ----------------------------------------------------------------------------------------
export interface LeadReminderFact {
  id: string;
  stage: string;
  createdOn: ISODate;
  lastContactOn: ISODate | ""; // newest logged interaction
  nextFollowUpOn: ISODate | "";
}
export type ReminderReason = "follow_up_due" | "after_trial" | "silent";
const REASON_ORDER: Record<ReminderReason, number> = { follow_up_due: 0, after_trial: 1, silent: 2 };

/**
 * Which open leads need a person's attention (internal only, nothing is sent to the lead). follow_up_due: the planned date
 * has come; after_trial: attended a trial and a day of silence; silent: new / contacted / trial-scheduled and quiet for
 * `silenceDays`. A follow-up planned for a later day silences the last two. Order: reason, days (desc), id.
 */
export function leadReminders(leads: LeadReminderFact[], a: { today: ISODate; silenceDays: number }): { id: string; reason: ReminderReason; days: number }[] {
  const out: { id: string; reason: ReminderReason; days: number }[] = [];
  for (const x of leads) {
    if (x.stage === "enrolled" || x.stage === "lost") continue;
    if (x.nextFollowUpOn) {
      if (x.nextFollowUpOn <= a.today) out.push({ id: x.id, reason: "follow_up_due", days: daysBetween(x.nextFollowUpOn, a.today) });
      continue;
    }
    const last = x.lastContactOn && x.lastContactOn > x.createdOn ? x.lastContactOn : x.createdOn;
    const quiet = daysBetween(last, a.today);
    if (x.stage === "trial_attended" && quiet >= 1) out.push({ id: x.id, reason: "after_trial", days: quiet });
    else if ((x.stage === "new" || x.stage === "contacted" || x.stage === "trial_scheduled") && quiet >= a.silenceDays) out.push({ id: x.id, reason: "silent", days: quiet });
  }
  return out.sort((p, q) => REASON_ORDER[p.reason] - REASON_ORDER[q.reason] || q.days - p.days || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}
