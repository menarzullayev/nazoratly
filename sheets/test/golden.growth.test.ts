import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { growthCreditSummary, leadReminders, promoDiscount, promoState, referralConditionMet, referralRewardAmount, sourceRoi, splitCredit } from "../src/domain/growth";

// The same file the Python suite reads (backend/tests/test_golden_growth.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/growth.json", import.meta.url), "utf8")) as Record<string, any[]>;
const num = (s: string | null): number | null => (s === null ? null : Number(s));

describe("golden: growth rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(50);
  });
  it.each(golden.referral_reward_amount!)("referralRewardAmount: $name", (c) => {
    expect(referralRewardAmount({ rewardType: c.in.reward_type, rewardValue: Number(c.in.reward_value), monthlyFee: Number(c.in.monthly_fee), lessonsInMonth: c.in.lessons_in_month })).toBe(Number(c.out));
  });
  it.each(golden.split_credit!)("splitCredit: $name", (c) => {
    expect(splitCredit({ amount: Number(c.in.amount), monthlyFee: Number(c.in.monthly_fee) })).toEqual((c.out as string[]).map(Number));
  });
  it.each(golden.referral_condition!)("referralConditionMet: $name", (c) => {
    expect(referralConditionMet({ condition: c.in.condition, minPaid: Number(c.in.min_paid), invitedEnrolled: c.in.invited_enrolled, invitedPaid: Number(c.in.invited_paid) })).toBe(c.out);
  });
  it.each(golden.promo_state!)("promoState: $name", (c) => {
    expect(promoState({ active: c.in.active, validFrom: c.in.valid_from, validTo: c.in.valid_to ?? "", maxUses: c.in.max_uses, used: c.in.used, today: c.in.today })).toBe(c.out);
  });
  it.each(golden.promo_discount!)("promoDiscount: $name", (c) => {
    expect(promoDiscount({ kind: c.in.kind, value: Number(c.in.value), fee: Number(c.in.fee) })).toBe(Number(c.out));
  });
  it.each(golden.growth_credit_summary!)("growthCreditSummary: $name", (c) => {
    const got = growthCreditSummary(c.in.credits.map((x: any) => ({ ...x, amount: Number(x.amount) })));
    const plain = (v: any) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" && !["source", "label"].includes(k) ? Number(x) : x]));
    expect(got.rows).toEqual(c.out.rows.map(plain));
    expect(got.totals).toEqual(plain(c.out.totals));
  });
  it.each(golden.source_roi!)("sourceRoi: $name", (c) => {
    const got = sourceRoi(
      c.in.leads.map((x: any) => ({ source: x.source, createdOn: x.created_on, revenue: Number(x.revenue) })),
      c.in.costs.map((x: any) => ({ source: x.source, month: x.month, amount: Number(x.amount) })),
      c.in.range,
    );
    const row = (r: any) => ({ source: r.source, leads: r.leads, paying: r.paying, revenue: Number(r.revenue), cost: Number(r.cost), roi: r.roi, costPerLead: num(r.cost_per_lead), costPerPaying: num(r.cost_per_paying) });
    expect(got.rows).toEqual(c.out.rows.map(row));
    expect(got.total).toEqual(row(c.out.total));
  });
  it.each(golden.lead_reminders!)("leadReminders: $name", (c) => {
    const got = leadReminders(
      c.in.leads.map((x: any) => ({ id: x.id, stage: x.stage, createdOn: x.created_on, lastContactOn: x.last_contact_on ?? "", nextFollowUpOn: x.next_follow_up_on ?? "" })),
      { today: c.in.today, silenceDays: c.in.silence_days },
    );
    expect(got).toEqual(c.out);
  });
});
