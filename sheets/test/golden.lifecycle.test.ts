import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firstMonthCharge, trialStatus } from "../src/domain/lifecycle";

interface TrialCase {
  name: string;
  in: { started_on: string; today: string; lessons_attended: number; free_lessons: number; free_days: number };
  out: "running" | "decision_needed";
}
interface FirstMonthCase {
  name: string;
  in: { mode: "full" | "prorated" | "free_until_next"; monthly_fee: number; accepted_on: string; lesson_dates: string[] };
  out: { amount: number; fallback_to_full: boolean };
}

// The same file the Python suite reads (backend/tests/test_golden_lifecycle.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/lifecycle.json", import.meta.url), "utf8")) as {
  trial_status: TrialCase[];
  first_month_charge: FirstMonthCase[];
};

describe("golden: lifecycle rules", () => {
  it("has enough cases", () => {
    expect(golden.trial_status.length).toBeGreaterThanOrEqual(8);
    expect(golden.first_month_charge.length).toBeGreaterThanOrEqual(9);
  });

  it.each(golden.trial_status)("trialStatus: $name", (c) => {
    expect(
      trialStatus({
        startedOn: c.in.started_on,
        today: c.in.today,
        lessonsAttended: c.in.lessons_attended,
        freeLessons: c.in.free_lessons,
        freeDays: c.in.free_days,
      }),
    ).toBe(c.out);
  });

  it.each(golden.first_month_charge)("firstMonthCharge: $name", (c) => {
    const got = firstMonthCharge({ mode: c.in.mode, monthlyFee: c.in.monthly_fee, acceptedOn: c.in.accepted_on, lessonDates: c.in.lesson_dates });
    expect(got).toEqual({ amount: c.out.amount, fallbackToFull: c.out.fallback_to_full });
  });
});
