import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { branchTotals, cashCloseBranch, effectiveValue, resolveScope, rowVisible, stampBranch, transferCheck } from "../src/domain/branches";

// The same file the Python suite reads (backend/tests/test_golden_branches.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/branches.json", import.meta.url), "utf8")) as Record<string, any[]>;
const id = (x: number | null): string | null => (x === null ? null : String(x));
const ids = (xs: number[]): string[] => xs.map(String);
const tot = (t: any) => ({ revenue: Number(t.revenue), charges: Number(t.charges), expenses: Number(t.expenses), net: Number(t.net) });

describe("golden: branch rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(40);
  });
  it.each(golden.stamp_branch!)("stampBranch: $name", (c) => {
    const i = c.in;
    expect(stampBranch({ explicit: id(i.explicit), scope: id(i.scope), parent: id(i.parent), default: String(i.default), mode: i.mode })).toBe(String(c.out));
  });
  it.each(golden.row_visible!)("rowVisible: $name", (c) => {
    expect(rowVisible({ scope: id(c.in.scope), branch: id(c.in.branch), shared: c.in.shared })).toBe(c.out);
  });
  it.each(golden.branch_totals!)("branchTotals: $name", (c) => {
    const got = branchTotals(
      c.in.branches.map((b: any) => ({ id: String(b.id) })),
      c.in.facts.map((f: any) => ({ branch: id(f.branch), kind: f.kind, amount: Number(f.amount), voided: f.voided })),
    );
    expect(got.rows).toEqual(c.out.rows.map((r: any) => ({ branch: String(r.branch), ...tot(r) })));
    expect(got.unassigned).toEqual(c.out.unassigned === null ? null : tot(c.out.unassigned));
    expect(got.total).toEqual(tot(c.out.total));
  });
  it.each(golden.transfer_check!)("transferCheck: $name", (c) => {
    const i = c.in;
    expect(transferCheck({ from: String(i.from), to: String(i.to), toStatus: i.to_status, enrollmentBranches: ids(i.enrollment_branches), endEnrollments: i.end_enrollments })).toEqual({ ok: c.out.ok, error: c.out.error, endCount: c.out.end_count });
  });
  it.each(golden.effective_value!)("effectiveValue: $name", (c) => {
    expect(effectiveValue(c.in)).toBe(c.out);
  });
  it.each(golden.cash_close_branch!)("cashCloseBranch: $name", (c) => {
    expect(cashCloseBranch({ scope: id(c.in.scope), requested: id(c.in.requested), active: ids(c.in.active) })).toEqual({ branch: id(c.out.branch), error: c.out.error });
  });
  it.each(golden.resolve_scope!)("resolveScope: $name", (c) => {
    expect(resolveScope({ memberBranch: id(c.in.member_branch), requested: id(c.in.requested), known: ids(c.in.known) })).toEqual({ scope: id(c.out.scope), error: c.out.error });
  });
});
