import { daysBetween } from "./dates";
import { installmentBalances, nextOpenDue, planOverdue, validatePlan, type InstallmentBalance } from "./installments";
import type { Charge, Installment, ISODate, Payment } from "./types";

export interface ChargeBalance extends Charge {
  paid: number;
  outstanding: number;
  overdue: number; // part of the outstanding amount that is past due (per installment when the charge has a plan)
  nextDue: ISODate | ""; // earliest due date of what is still unpaid ("" when settled)
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
 */
export function computeDebts(charges: Charge[], payments: Payment[], today: ISODate, installments: Installment[] = []) {
  const plans = new Map<string, Installment[]>();
  for (const i of installments) (plans.get(i.chargeId) ?? plans.set(i.chargeId, []).get(i.chargeId)!).push(i);
  for (const list of plans.values()) list.sort((a, b) => a.seq - b.seq);

  const byStudent = new Map<string, Charge[]>();
  for (const c of charges) {
    if (c.voided) continue;
    (byStudent.get(c.studentId) ?? byStudent.set(c.studentId, []).get(c.studentId)!).push(c);
  }
  const paidBy = new Map<string, number>();
  for (const p of payments) {
    if (!p.voided) paidBy.set(p.studentId, (paidBy.get(p.studentId) ?? 0) + p.amount);
  }
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
    for (const c of list) {
      const applied = Math.min(remaining, c.amount);
      remaining -= applied;
      const outstanding = c.amount - applied;
      const raw = plans.get(c.id);
      const planned = raw && validatePlan(c.amount, raw) === null ? raw : null;
      let rows: InstallmentBalance[] | null = null;
      let chargeOverdue = c.dueDate < today ? outstanding : 0;
      let nextDue: ISODate | "" = outstanding > 0 ? c.dueDate : "";
      if (planned) {
        rows = installmentBalances(planned, applied, today);
        chargeOverdue = planOverdue(rows);
        nextDue = nextOpenDue(rows) ?? "";
      }
      balances.push({ ...c, paid: applied, outstanding, overdue: chargeOverdue, nextDue });
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
