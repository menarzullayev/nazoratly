/**
 * Payment-plan (installment) rules. Pure functions, mirrored in Python (backend/src/nazoratly/rules/installments.py);
 * both are checked against the same cases in tests/golden/installments.json. Money is whole so'm.
 */
import type { ISODate } from "./types";

export type PlanError = "count" | "non_positive" | "sum_mismatch" | "dates_not_increasing";
export const MIN_INSTALLMENTS = 2;
export const MAX_INSTALLMENTS = 24;

export interface PlannedInstallment {
  amount: number;
  dueDate: ISODate;
}

export interface InstallmentBalance extends PlannedInstallment {
  paid: number;
  outstanding: number;
  overdue: boolean;
}

export class PlanRuleError extends Error {
  constructor(readonly code: PlanError) {
    super(code);
  }
}

function addMonths(first: ISODate, months: number): ISODate {
  const y0 = Number(first.slice(0, 4));
  const m0 = Number(first.slice(5, 7)) - 1;
  const day = Number(first.slice(8, 10));
  const index = m0 + months;
  const year = y0 + Math.floor(index / 12);
  const month = index % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** Whole-so'm base amounts, the remainder goes to the last installment; monthly dates, day clamped to month end. */
export function equalInstallments(total: number, count: number, firstDue: ISODate): PlannedInstallment[] {
  if (!Number.isInteger(count) || count < MIN_INSTALLMENTS || count > MAX_INSTALLMENTS) throw new PlanRuleError("count");
  const base = Math.floor(total / count);
  if (base < 1) throw new PlanRuleError("non_positive");
  return Array.from({ length: count }, (_, i) => ({
    amount: i === count - 1 ? total - base * (count - 1) : base,
    dueDate: addMonths(firstDue, i),
  }));
}

export function validatePlan(total: number, installments: PlannedInstallment[]): PlanError | null {
  if (installments.length < MIN_INSTALLMENTS || installments.length > MAX_INSTALLMENTS) return "count";
  if (installments.some((i) => !(i.amount > 0))) return "non_positive";
  if (installments.reduce((s, i) => s + i.amount, 0) !== total) return "sum_mismatch";
  for (let k = 1; k < installments.length; k++) if (installments[k]!.dueDate <= installments[k - 1]!.dueDate) return "dates_not_increasing";
  return null;
}

/** The charge's allocated money is applied oldest installment first; the excess over the total is credit. */
export function installmentBalances(installments: PlannedInstallment[], paid: number, today: ISODate): InstallmentBalance[] {
  let remaining = Math.max(paid, 0);
  return installments.map((i) => {
    const applied = Math.min(remaining, i.amount);
    remaining -= applied;
    const outstanding = i.amount - applied;
    return { ...i, paid: applied, outstanding, overdue: outstanding > 0 && i.dueDate < today };
  });
}

export const planOverdue = (rows: InstallmentBalance[]): number => rows.filter((r) => r.overdue).reduce((s, r) => s + r.outstanding, 0);

export const nextOpenDue = (rows: InstallmentBalance[]): ISODate | null => rows.find((r) => r.outstanding > 0)?.dueDate ?? null;
