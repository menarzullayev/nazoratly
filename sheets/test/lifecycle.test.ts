import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planCharges } from "../src/domain/billing";
import { funnelReport } from "../src/domain/funnel";
import type { Enrollment, Group, Student } from "../src/domain/types";
import { read } from "../src/gas/repo";
import { ALL_TABLES, ENROLLMENTS, LEADS, LEAD_LOG, SETTING_DEFAULTS } from "../src/gas/schema";
import { readSettings } from "../src/gas/settings";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

const student: Student = { id: "S0001", fullName: "Ali", status: "active", guardianName: "", guardianChatId: "", consentNotify: false };
const group: Group = { id: "G0001", name: "IELTS", teacherId: "T0001", monthlyFee: 500_000, status: "active" };
const enr = (o: Partial<Enrollment> = {}): Enrollment => ({
  id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-10-28", endedOn: "", discountPercent: 0, status: "active", ...o,
});
const plan = (month: string, enrollments: Enrollment[]) => planCharges({ month, dueDay: 10, enrollments, groups: [group], students: [student], charges: [] });

describe("planCharges and the admission lifecycle", () => {
  it("never bills a trial enrollment", () => {
    expect(plan("2026-11-01", [enr({ status: "trial" })]).create).toHaveLength(0);
  });

  it("bills only the months after the acceptance month; the acceptance month is handled at acceptance", () => {
    const accepted = enr({ acceptedOn: "2026-11-16", firstMonthMode: "prorated" });
    expect(plan("2026-10-01", [accepted]).create).toHaveLength(0); // before acceptance
    expect(plan("2026-11-01", [accepted]).create).toHaveLength(0); // billed at acceptance (or free)
    expect(plan("2026-12-01", [accepted]).create).toHaveLength(1);
  });

  it("legacy active enrollments without acceptedOn are billed as before", () => {
    expect(plan("2026-11-01", [enr()]).create).toHaveLength(1);
  });
});

interface FunnelCase {
  name: string;
  in: { range: { from: string; to: string }; leads: { stage: string; source: string | null; created_on: string }[] };
  out: { stages: Record<string, number>; by_source: { source: string | null; leads: number; enrolled: number; conversion: number }[]; trial_to_enrolled: number };
}
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/funnel.json", import.meta.url), "utf8")) as { funnel_report: FunnelCase[] };

describe("golden: funnelReport", () => {
  it.each(golden.funnel_report)("$name", (c) => {
    const got = funnelReport(
      c.in.leads.map((l) => ({ stage: l.stage as never, source: l.source, createdOn: l.created_on })),
      { from: c.in.range.from, to: c.in.range.to },
    );
    expect(got).toEqual({ stages: c.out.stages, bySource: c.out.by_source, trialToEnrolled: c.out.trial_to_enrolled });
  });
});

describe("sheet model", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
    h = installHarness();
    setupWorkbook();
  });
  afterEach(() => vi.useRealTimers());

  it("creates the Leads and lead-log sheets with their headers", () => {
    for (const t of [LEADS, LEAD_LOG]) {
      expect(ALL_TABLES).toContain(t);
      expect(h.rows(t.sheet)[0]).toEqual(t.cols.map((c) => c.header));
    }
  });

  it("enrollments carry the acceptance columns and a blank mode decodes as blank", () => {
    expect(h.rows(ENROLLMENTS.sheet)[0]).toContain("Qabul sanasi");
    const sh = h.sheets.get(ENROLLMENTS.sheet)!;
    sh.data[1] = ["E0001", "S0001", "G0001", "2026-10-28", "", 0, "Sinov", "", ""];
    const e = read<Enrollment>(ENROLLMENTS)[0]!;
    expect(e.status).toBe("trial");
    expect(e.firstMonthMode ?? "").toBe("");
  });

  it("settings expose the trial limits with defaults 1 lesson / 7 days", () => {
    expect(SETTING_DEFAULTS.find((d) => d.key === "trialFreeLessons")?.value).toBe("1");
    expect(SETTING_DEFAULTS.find((d) => d.key === "trialFreeDays")?.value).toBe("7");
    const s = readSettings();
    expect([s.trialFreeLessons, s.trialFreeDays]).toEqual([1, 7]);
  });
});
