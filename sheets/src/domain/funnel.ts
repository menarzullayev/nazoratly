/**
 * Lead funnel report. Pure function, mirrored in Python (backend/src/nazoratly/rules/funnel.py); both are checked
 * against the same cases in tests/golden/funnel.json.
 */
import type { ISODate, LeadStage } from "./types";

export const STAGES: LeadStage[] = ["new", "contacted", "trial_scheduled", "trial_attended", "enrolled", "lost"];

export interface LeadFact {
  stage: LeadStage;
  source: string | null;
  createdOn: ISODate;
}

export interface FunnelReport {
  stages: Record<LeadStage, number>;
  bySource: { source: string | null; leads: number; enrolled: number; conversion: number }[];
  trialToEnrolled: number;
}

/** percent with one decimal, half up */
const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.floor((part * 1000) / whole + 0.5) / 10);

/**
 * Counts by current stage and per source for leads created in the range (inclusive). conversion = enrolled / leads of
 * the source; trialToEnrolled = enrolled / (trial_scheduled + trial_attended + enrolled). Sources are ordered by lead
 * count (desc), then name; leads without a source come last.
 */
export function funnelReport(leads: LeadFact[], range: { from: ISODate; to: ISODate }): FunnelReport {
  const inside = leads.filter((l) => l.createdOn >= range.from && l.createdOn <= range.to);
  const stages = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<LeadStage, number>;
  const per = new Map<string | null, { leads: number; enrolled: number }>();
  for (const l of inside) {
    stages[l.stage]++;
    const c = per.get(l.source) ?? { leads: 0, enrolled: 0 };
    c.leads++;
    if (l.stage === "enrolled") c.enrolled++;
    per.set(l.source, c);
  }
  const bySource = [...per.entries()]
    .map(([source, c]) => ({ source, leads: c.leads, enrolled: c.enrolled, conversion: pct(c.enrolled, c.leads) }))
    .sort(
      (a, b) =>
        Number(a.source === null) - Number(b.source === null) || b.leads - a.leads || (a.source ?? "").localeCompare(b.source ?? ""),
    );
  const reached = stages.trial_scheduled + stages.trial_attended + stages.enrolled;
  return { stages, bySource, trialToEnrolled: pct(stages.enrolled, reached) };
}
