/**
 * Multi-branch rules: how a row gets its branch mark, who sees which rows, per-branch totals, the student move check,
 * settings/price inheritance, the daily cash close branch and the effective view scope of a staff member. Pure
 * functions, mirrored in Python (backend/src/nazoratly/rules/branches.py); both are checked against the same cases in
 * tests/golden/branches.json. Money is whole so'm. Branch ids here are the ids used in the "Filiallar" tab (F01...).
 */

export type StampMode = "context" | "parent";
export type BranchId = string;

/** The branch mark of a new row: explicit > (scope, parent) by mode > the center's default branch. */
export function stampBranch(a: { explicit: BranchId | null; scope: BranchId | null; parent: BranchId | null; default: BranchId; mode: StampMode }): BranchId {
  if (a.explicit) return a.explicit;
  const order = a.mode === "context" ? [a.scope, a.parent] : [a.parent, a.scope];
  for (const c of order) if (c) return c;
  return a.default;
}

/** Whether a session with `scope` (null = center-wide) sees a row marked `branch`; a shared row has no branch. */
export function rowVisible(a: { scope: BranchId | null; branch: BranchId | null; shared?: boolean }): boolean {
  if (a.scope === null) return true;
  if (a.branch === null || a.branch === "") return a.shared === true;
  return a.branch === a.scope;
}

export interface BranchFact {
  branch: BranchId | null;
  kind: "payment" | "charge" | "expense";
  amount: number;
  voided: boolean;
}
export interface BranchTotals {
  revenue: number;
  charges: number;
  expenses: number;
  net: number;
}
export interface BranchTotalsReport {
  rows: ({ branch: BranchId } & BranchTotals)[];
  unassigned: BranchTotals | null;
  total: BranchTotals;
}

const zero = (): BranchTotals => ({ revenue: 0, charges: 0, expenses: 0, net: 0 });
function add(t: BranchTotals, f: BranchFact): void {
  if (f.kind === "payment") t.revenue += f.amount;
  else if (f.kind === "charge") t.charges += f.amount;
  else t.expenses += f.amount;
  t.net = t.revenue - t.expenses;
}

/**
 * Revenue (payments), charges and expenses per branch plus the total. A fact of a missing/unknown branch is reported as
 * `unassigned` and still counted in the total, so the total is always the sum of all rows. Voided facts are ignored.
 */
export function branchTotals(branches: readonly { id: BranchId }[], facts: readonly BranchFact[]): BranchTotalsReport {
  const per = new Map<BranchId, BranchTotals>(branches.map((b) => [b.id, zero()]));
  const stray = zero();
  let anyStray = false;
  const total = zero();
  for (const f of facts) {
    if (f.voided) continue;
    const t = f.branch !== null && per.has(f.branch) ? per.get(f.branch)! : null;
    if (t) add(t, f);
    else {
      add(stray, f);
      anyStray = true;
    }
    add(total, f);
  }
  return { rows: branches.map((b) => ({ branch: b.id, ...per.get(b.id)! })), unassigned: anyStray ? stray : null, total };
}

export type TransferError = "same_branch" | "target_closed" | "enrollments_in_old_branch";

/** May a student move? Active/trial/frozen enrollments in other branches must be ended or the move is refused. */
export function transferCheck(a: { from: BranchId; to: BranchId; toStatus: string; enrollmentBranches: readonly BranchId[]; endEnrollments: boolean }): { ok: boolean; error: TransferError | null; endCount: number } {
  if (a.from === a.to) return { ok: false, error: "same_branch", endCount: 0 };
  if (a.toStatus !== "active") return { ok: false, error: "target_closed", endCount: 0 };
  const stale = a.enrollmentBranches.filter((b) => b !== a.to).length;
  if (stale > 0 && !a.endEnrollments) return { ok: false, error: "enrollments_in_old_branch", endCount: stale };
  return { ok: true, error: null, endCount: stale };
}

/** Settings and prices: a branch value replaces the base value; no branch value inherits; zero is a real override. */
export function effectiveValue(a: { override: string | null; base: string | null }): string | null {
  return a.override === null ? a.base : a.override;
}

/** The branch of a daily cash close: scoped staff = own; center-wide = the named one, or the single active branch. */
export function cashCloseBranch(a: { scope: BranchId | null; requested: BranchId | null; active: readonly BranchId[] }): { branch: BranchId | null; error: "forbidden_branch" | "unknown_branch" | "branch_required" | null } {
  if (a.scope !== null) {
    if (a.requested !== null && a.requested !== a.scope) return { branch: null, error: "forbidden_branch" };
    return { branch: a.scope, error: null };
  }
  if (a.requested !== null) return a.active.includes(a.requested) ? { branch: a.requested, error: null } : { branch: null, error: "unknown_branch" };
  if (a.active.length === 1) return { branch: a.active[0]!, error: null };
  return { branch: null, error: "branch_required" };
}

/** The effective scope of a request: scoped staff stay in their branch; center-wide staff see all or narrow to a known one. */
export function resolveScope(a: { memberBranch: BranchId | null; requested: BranchId | null; known: readonly BranchId[] }): { scope: BranchId | null; error: "forbidden_branch" | "unknown_branch" | null } {
  if (a.memberBranch !== null) {
    if (a.requested !== null && a.requested !== a.memberBranch) return { scope: null, error: "forbidden_branch" };
    return { scope: a.memberBranch, error: null };
  }
  if (a.requested === null) return { scope: null, error: null };
  return a.known.includes(a.requested) ? { scope: a.requested, error: null } : { scope: null, error: "unknown_branch" };
}
