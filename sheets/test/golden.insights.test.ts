import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { churnRisk, debtFollowup, debtLine, debtMessage, fmtMoney, rate, riskLine, weekRate, weeklySummary, type DebtTone, type RiskLevel, type RiskReason } from "../src/domain/insights";

type G = {
  fmt_money: { n: number; out: string }[];
  rate: { attended: number; marked: number; out: number | null; week_out: number | null }[];
  debt_followup: { name: string; in: { today: string; students: { id: string; outstanding: number; overdue: number; oldest_due: string | null }[] }; out: { id: string; outstanding: number; overdue: number; age_days: number; tone: DebtTone; score: number }[] }[];
  debt_message: { name: string; in: { tone: DebtTone; student: string; amount: number; days: number }; out: string }[];
  churn_risk: {
    name: string;
    in: { students: { id: string; attended_recent: number; marked_recent: number; attended_prev: number; marked_prev: number; overdue_age_days: number; trial_days_over: number | null }[] };
    out: { id: string; score: number; level: string; reasons: string[]; attendance_recent: number | null; attendance_prev: number | null }[];
  }[];
  report_line: { name: string; kind: "debt" | "risk"; in: { rank: number; name: string; outstanding?: number; age_days?: number; tone?: DebtTone; score?: number; level?: RiskLevel; reasons?: RiskReason[] }; out: string }[];
  weekly_summary: { name: string; in: Record<string, number>; out: Record<string, unknown> }[];
};
// The same file the Python suite reads (backend/tests/test_golden_insights.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/insights.json", import.meta.url), "utf8")) as G;

describe("golden: insight rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(60);
  });
  it.each(golden.fmt_money)("fmtMoney: $n", (c) => {
    expect(fmtMoney(c.n)).toBe(c.out);
  });
  it.each(golden.rate)("rate: $attended/$marked", (c) => {
    expect(rate(c.attended, c.marked)).toBe(c.out);
    expect(weekRate(c.attended, c.marked)).toBe(c.week_out);
  });
  it.each(golden.debt_followup)("debtFollowup: $name", (c) => {
    const got = debtFollowup(c.in.students.map((s) => ({ id: s.id, outstanding: s.outstanding, overdue: s.overdue, oldestDue: s.oldest_due ?? "" })), c.in.today);
    expect(got).toEqual(c.out.map((o) => ({ id: o.id, outstanding: o.outstanding, overdue: o.overdue, ageDays: o.age_days, tone: o.tone, score: o.score })));
  });
  it.each(golden.debt_message)("debtMessage: $name", (c) => {
    expect(debtMessage(c.in.tone, c.in.student, c.in.amount, c.in.days)).toBe(c.out);
  });
  it.each(golden.churn_risk)("churnRisk: $name", (c) => {
    const got = churnRisk(
      c.in.students.map((s) => ({ id: s.id, attendedRecent: s.attended_recent, markedRecent: s.marked_recent, attendedPrev: s.attended_prev, markedPrev: s.marked_prev, overdueAgeDays: s.overdue_age_days, trialDaysOver: s.trial_days_over })),
    );
    expect(got).toEqual(c.out.map((o) => ({ id: o.id, score: o.score, level: o.level, reasons: o.reasons, attendanceRecent: o.attendance_recent, attendancePrev: o.attendance_prev })));
  });
  it.each(golden.report_line)("report line: $name", (c) => {
    const i = c.in;
    const got = c.kind === "debt" ? debtLine(i.rank, i.name, i.outstanding!, i.age_days!, i.tone!) : riskLine(i.rank, i.name, i.score!, i.level!, i.reasons!);
    expect(got).toBe(c.out);
  });
  it.each(golden.weekly_summary)("weeklySummary: $name", (c) => {
    const i = c.in;
    const got = weeklySummary({
      income: i.income!, incomePrev: i.income_prev!, expenses: i.expenses!, newStudents: i.new_students!, leftStudents: i.left_students!, unpaid: i.unpaid!, unpaidTotal: i.unpaid_total!, overdue: i.overdue!,
      attended: i.attended!, marked: i.marked!, attendedPrev: i.attended_prev!, markedPrev: i.marked_prev!, highRisk: i.high_risk!, mediumRisk: i.medium_risk!,
    });
    const o = c.out;
    expect(got).toEqual({
      income: o.income, incomePrev: o.income_prev, incomeChangePercent: o.income_change_percent, expenses: o.expenses, net: o.net, newStudents: o.new_students, leftStudents: o.left_students,
      unpaid: o.unpaid, unpaidTotal: o.unpaid_total, overdue: o.overdue, attendancePercent: o.attendance_percent, attendancePrevPercent: o.attendance_prev_percent, highRisk: o.high_risk, mediumRisk: o.medium_risk, lines: o.lines,
    });
  });
});
