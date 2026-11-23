import { daysBetween } from "./dates";
import type { Charge, ISODate, Payment } from "./types";

export interface ChargeBalance extends Charge {
  paid: number;
  outstanding: number;
}

export interface StudentDebt {
  studentId: string;
  charged: number;
  paid: number;
  outstanding: number;
  overdue: number; // outstanding on charges whose due date has passed
  credit: number; // paid beyond everything charged
  oldestDue: ISODate | "";
  maxDaysOverdue: number;
  openCharges: number;
}

/**
 * Debt is derived, never stored: payments of a student are applied to that student's charges oldest-due-first
 * (the same FIFO the nazoratly API uses). Voided charges/payments are ignored.
 */
export function computeDebts(charges: Charge[], payments: Payment[], today: ISODate) {
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
    for (const c of list) {
      const applied = Math.min(remaining, c.amount);
      remaining -= applied;
      const outstanding = c.amount - applied;
      balances.push({ ...c, paid: applied, outstanding });
      charged += c.amount;
      outstandingTotal += outstanding;
      if (outstanding > 0) {
        open++;
        if (oldest === "" || c.dueDate < oldest) oldest = c.dueDate;
        if (c.dueDate < today) overdue += outstanding;
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
    });
  }
  students.sort((a, b) => b.overdue - a.overdue || a.studentId.localeCompare(b.studentId));
  return { balances, students };
}

export function debtors(students: StudentDebt[], minDaysOverdue = 1): StudentDebt[] {
  return students.filter((s) => s.overdue > 0 && s.maxDaysOverdue >= minDaysOverdue);
}
