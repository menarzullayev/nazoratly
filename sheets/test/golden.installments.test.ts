import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { equalInstallments, installmentBalances, nextOpenDue, planOverdue, validatePlan, PlanRuleError } from "../src/domain/installments";

type Row = { amount: string; due_date: string };
const plan = (rows: Row[]) => rows.map((r) => ({ amount: Number(r.amount), dueDate: r.due_date }));
type G = {
  equal: { name: string; in: { total: string; count: number; first_due: string }; out: Row[] | { error: string } }[];
  validate: { name: string; in: { total: string; installments: Row[] }; out: string | null }[];
  balances: {
    name: string;
    in: { installments: Row[]; paid: string; today: string };
    out: { rows: { paid: string; outstanding: string; overdue: boolean }[]; overdue: string; next_open_due: string | null };
  }[];
};
// The same file the Python suite reads (backend/tests/test_golden_installments.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/installments.json", import.meta.url), "utf8")) as G;

describe("golden: installment rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(30);
  });
  it.each(golden.equal)("equal: $name", (c) => {
    const i = c.in;
    if (!Array.isArray(c.out)) {
      const expected = c.out.error;
      expect(() => equalInstallments(Number(i.total), i.count, i.first_due)).toThrowError(new PlanRuleError(expected as never));
      return;
    }
    expect(equalInstallments(Number(i.total), i.count, i.first_due)).toEqual(plan(c.out));
  });
  it.each(golden.validate)("validate: $name", (c) => {
    expect(validatePlan(Number(c.in.total), plan(c.in.installments))).toBe(c.out);
  });
  it.each(golden.balances)("balances: $name", (c) => {
    const rows = installmentBalances(plan(c.in.installments), Number(c.in.paid), c.in.today);
    expect(rows.map((r) => ({ paid: String(r.paid), outstanding: String(r.outstanding), overdue: r.overdue }))).toEqual(c.out.rows);
    expect(planOverdue(rows)).toBe(Number(c.out.overdue));
    expect(nextOpenDue(rows)).toBe(c.out.next_open_due);
  });
});
