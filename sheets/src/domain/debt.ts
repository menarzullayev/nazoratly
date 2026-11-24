import { daysBetween } from "./dates";
import { installmentBalances, nextOpenDue, planOverdue, validatePlan, type InstallmentBalance } from "./installments";
import { earlyGranted } from "./money";
import type { Charge, Installment, ISODate, Payment, Refund } from "./types";

export interface ChargeBalance extends Charge {
  paid: number;
  outstanding: number;
  overdue: number; // part of the outstanding amount that is past due (per installment when the charge has a plan)
  nextDue: ISODate | ""; // earliest due date of what is still unpaid ("" when settled)
  earlyGranted?: boolean; // the early-payment discount was earned: `amount` is already reduced
}

export interface InstallmentRef {
  chargeId: string;
  seq: number;
  count: number;
  dueDate: ISODate;
  outstanding: number;
}

export interface StudentDebt {
  studentId: string;
  charged: number;
  paid: number;
  outstanding: number;
  overdue: number; // past-due part of the outstanding amount (per installment for planned charges)
  credit: number; // paid beyond everything charged
  oldestDue: ISODate | ""; // earliest due date of anything unpaid
  maxDaysOverdue: number;
  openCharges: number;
  overdueInstallment?: InstallmentRef | null; // the earliest overdue installment, when the oldest debt is a plan's
  nextInstallment?: InstallmentRef | null; // the earliest open installment not yet due
}

/**
 * Debt is derived, never stored: payments of a student are applied to that student's charges oldest-due-first
 * (the same FIFO the nazoratly API uses). Voided charges/payments are ignored.
 * A charge with a payment plan (same rules as the API: rules/installments.py, tests/golden/installments.json) applies
 * its allocated money to its installments oldest first and is overdue only for the installments past due. A plan that
 * does not pass `validatePlan` (sum differs from the charge, bad dates) is ignored: the charge's own due date rules.
 * A charge's due date should equal its first installment (menu "To'lov rejasi" keeps it so).
 * Refunds (rules/money.py, tests/golden/money.json): money given back in cash or to the bank leaves the paid pool of the
 * student (newest payments first); a refund's `chargeReduction` shrinks its charge. A refund kept as credit changes
 * nothing but the charge.
 * Early-payment discount: a charge with `earlyDiscount` and `earlyPayBy` is reduced by the offer when the money it
 * receives that was paid on or before the pay-by date covers the reduced price (never for a charge with a plan).
 */
export function computeDebts(charges: Charge[], payments: Payment[], today: ISODate, installments: Installment[] = [], refunds: Refund[] = []) {
  const plans = new Map<string, Installment[]>();
  for (const i of installments) (plans.get(i.chargeId) ?? plans.set(i.chargeId, []).get(i.chargeId)!).push(i);
  for (const list of plans.values()) list.sort((a, b) => a.seq - b.seq);

  const byStudent = new Map<string, Charge[]>();
  for (const c of charges) {
    if (c.voided) continue;
    (byStudent.get(c.studentId) ?? byStudent.set(c.studentId, []).get(c.studentId)!).push(c);
  }
  const reduction = new Map<string, number>();
  const cashOut = new Map<string, number>();
  for (const r of refunds) {
    if (r.chargeId && r.chargeReduction > 0) reduction.set(r.chargeId, (reduction.get(r.chargeId) ?? 0) + r.chargeReduction);
    if (r.payout !== "credit") cashOut.set(r.studentId, (cashOut.get(r.studentId) ?? 0) + r.amount);
  }
  // the payments of a student, oldest first, after the cash given back was taken from the newest ones
  const pools = new Map<string, { on: ISODate; amount: number }[]>();
  for (const p of [...payments].sort((a, b) => (a.paidOn === b.paidOn ? a.id.localeCompare(b.id) : a.paidOn < b.paidOn ? -1 : 1))) {
    if (!p.voided) (pools.get(p.studentId) ?? pools.set(p.studentId, []).get(p.studentId)!).push({ on: p.paidOn, amount: p.amount });
  }
  for (const [studentId, list] of pools) {
    let out = cashOut.get(studentId) ?? 0;
    for (let i = list.length - 1; i >= 0 && out > 0; i--) {
      const take = Math.min(out, list[i]!.amount);
      list[i]!.amount -= take;
      out -= take;
    }
  }
  const paidBy = new Map<string, number>();
  for (const [studentId, list] of pools) paidBy.set(studentId, list.reduce((n, p) => n + p.amount, 0));
  for (const id of paidBy.keys()) if (!byStudent.has(id)) byStudent.set(id, []);

  const balances: ChargeBalance[] = [];
  const students: StudentDebt[] = [];
  for (const [studentId, list] of byStudent) {
    list.sort((a, b) => (a.dueDate === b.dueDate ? a.id.localeCompare(b.id) : a.dueDate < b.dueDate ? -1 : 1));
    const totalPaid = paidBy.get(studentId) ?? 0;
    let remaining = totalPaid;
    let charged = 0;
    let outstandingTotal = 0;
    let overdue = 0;
    let oldest: ISODate | "" = "";
    let open = 0;
    let overdueRef: InstallmentRef | null = null;
    let nextRef: InstallmentRef | null = null;
    for (const c0 of list) {
      let amount = Math.max(c0.amount - (reduction.get(c0.id) ?? 0), 0);
      const raw = plans.get(c0.id);
      let earned = false;
      if ((c0.earlyDiscount ?? 0) > 0 && c0.earlyPayBy && amount > 0 && !(raw && validatePlan(amount, raw) === null)) {
        // money that earlier charges already used is the oldest money; the rest is what this charge can count on
        let skip = totalPaid - remaining;
        const left: { on: ISODate; amount: number }[] = [];
        for (const p of pools.get(studentId) ?? []) {
          const used = Math.min(skip, p.amount);
          skip -= used;
          if (p.amount - used > 0) left.push({ on: p.on, amount: p.amount - used });
        }
        earned = earlyGranted({ payBy: c0.earlyPayBy, payments: left, amount, early: c0.earlyDiscount! }).granted;
        if (earned) amount -= c0.earlyDiscount!;
      }
      const c: Charge = { ...c0, amount };
      const applied = Math.min(remaining, c.amount);
      remaining -= applied;
      const outstanding = c.amount - applied;
      const planned = raw && validatePlan(c.amount, raw) === null ? raw : null;
      let rows: InstallmentBalance[] | null = null;
      let chargeOverdue = c.dueDate < today ? outstanding : 0;
      let nextDue: ISODate | "" = outstanding > 0 ? c.dueDate : "";
      if (planned) {
        rows = installmentBalances(planned, applied, today);
        chargeOverdue = planOverdue(rows);
        nextDue = nextOpenDue(rows) ?? "";
      }
      balances.push({ ...c, paid: applied, outstanding, overdue: chargeOverdue, nextDue, earlyGranted: earned });
      charged += c.amount;
      outstandingTotal += outstanding;
      if (outstanding > 0) {
        open++;
        overdue += chargeOverdue;
        if (oldest === "" || nextDue < oldest) oldest = nextDue;
        if (rows) {
          rows.forEach((r, k) => {
            if (r.outstanding <= 0) return;
            const ref: InstallmentRef = { chargeId: c.id, seq: k + 1, count: rows.length, dueDate: r.dueDate, outstanding: r.outstanding };
            if (r.overdue && (overdueRef === null || r.dueDate < overdueRef.dueDate)) overdueRef = ref;
            if (!r.overdue && (nextRef === null || r.dueDate < nextRef.dueDate)) nextRef = ref;
          });
        }
      }
    }
    students.push({
      studentId,
      charged,
      paid: totalPaid,
      outstanding: outstandingTotal,
      overdue,
      credit: remaining,
      oldestDue: oldest,
      maxDaysOverdue: oldest !== "" && oldest < today ? daysBetween(oldest, today) : 0,
      openCharges: open,
      overdueInstallment: overdueRef !== null && (overdueRef as InstallmentRef).dueDate === oldest ? overdueRef : null,
      nextInstallment: nextRef,
    });
  }
  students.sort((a, b) => b.overdue - a.overdue || a.studentId.localeCompare(b.studentId));
  return { balances, students };
}

export function debtors(students: StudentDebt[], minDaysOverdue = 1): StudentDebt[] {
  return students.filter((s) => s.overdue > 0 && s.maxDaysOverdue >= minDaysOverdue);
}
