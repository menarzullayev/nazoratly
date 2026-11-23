import { describe, expect, it } from "vitest";
import { planCharges, effectiveFee } from "../src/domain/billing";
import { computeDebts, debtors } from "../src/domain/debt";
import { daysBetween, inMonth, isIsoDate, monthStart, nextMonthStart } from "../src/domain/dates";
import { nextId, nextIds } from "../src/domain/ids";
import { collectedTuition, computePayroll, heldLessons } from "../src/domain/payroll";
import { formatSom, planReminders, renderTemplate, DEFAULT_TEMPLATE } from "../src/domain/reminders";
import type { Charge, Enrollment, Group, Payment, ReminderDraft, Student, Teacher } from "../src/domain/types";

const student = (o: Partial<Student> = {}): Student => ({
  id: "S0001", fullName: "Ali Valiyev", status: "active", guardianName: "Karim", guardianChatId: "111", consentNotify: true, ...o,
});
const group = (o: Partial<Group> = {}): Group => ({ id: "G0001", name: "IELTS", teacherId: "T0001", monthlyFee: 500_000, status: "active", ...o });
const enrollment = (o: Partial<Enrollment> = {}): Enrollment => ({
  id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active", ...o,
});
const charge = (o: Partial<Charge> = {}): Charge => ({
  id: "C0001", studentId: "S0001", enrollmentId: "E0001", month: "2026-01-01", amount: 300_000, dueDate: "2026-01-05", voided: false, note: "", ...o,
});
const payment = (o: Partial<Payment> = {}): Payment => ({ id: "P0001", studentId: "S0001", paidOn: "2026-01-10", amount: 100_000, method: "naqd", voided: false, note: "", ...o });

describe("dates", () => {
  it("validates and walks months", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-1-1")).toBe(false);
    expect(monthStart("2026-03-17")).toBe("2026-03-01");
    expect(nextMonthStart("2026-12-05")).toBe("2027-01-01");
    expect(daysBetween("2026-01-31", "2026-03-01")).toBe(29);
    expect(inMonth("2026-03-31", "2026-03-01")).toBe(true);
    expect(inMonth("2026-04-01", "2026-03-01")).toBe(false);
    expect(() => monthStart("garbage")).toThrow();
  });
});

describe("billing", () => {
  it("applies the discount with rounding", () => {
    expect(effectiveFee(group({ monthlyFee: 500_000 }), enrollment({ discountPercent: 20 }))).toBe(400_000);
    expect(effectiveFee(group({ monthlyFee: 333_333 }), enrollment({ discountPercent: 10 }))).toBe(300_000);
  });

  it("bills active enrollments once per month and mirrors the API rules", () => {
    const students = [student(), student({ id: "S0002" }), student({ id: "S0003" }), student({ id: "S0004", status: "left" })];
    const enrollments = [
      enrollment({ id: "E1", studentId: "S0001", discountPercent: 20 }),
      enrollment({ id: "E2", studentId: "S0002", status: "frozen" }),
      enrollment({ id: "E3", studentId: "S0003", startedOn: "2026-03-01" }), // starts after the billed month
      enrollment({ id: "E4", studentId: "S0004" }), // student left
      enrollment({ id: "E5", studentId: "S0001", groupId: "G0002" }), // zero-fee group
      enrollment({ id: "E6", studentId: "S0002", endedOn: "2026-01-31", status: "finished" }), // ended before February
    ];
    const groups = [group(), group({ id: "G0002", monthlyFee: 0 })];
    const plan = planCharges({ month: "2026-02-20", dueDay: 10, enrollments, groups, students, charges: [] });
    expect(plan.month).toBe("2026-02-01");
    expect(plan.create.map((c) => [c.enrollmentId, c.amount, c.dueDate])).toEqual([["E1", 400_000, "2026-02-10"]]);
    expect(plan.skippedZeroFee).toBe(1);

    const again = planCharges({
      month: "2026-02-01", dueDay: 10, enrollments, groups, students,
      charges: [charge({ enrollmentId: "E1", month: "2026-02-01" })],
    });
    expect(again.create).toEqual([]);
    expect(again.skippedExisting).toBe(1);
    // a voided charge does not block re-billing
    const reissue = planCharges({
      month: "2026-02-01", dueDay: 10, enrollments, groups, students,
      charges: [charge({ enrollmentId: "E1", month: "2026-02-01", voided: true })],
    });
    expect(reissue.create).toHaveLength(1);
    expect(() => planCharges({ month: "2026-02-01", dueDay: 31, enrollments, groups, students, charges: [] })).toThrow();
  });
});

describe("debt (FIFO)", () => {
  const charges = [
    charge({ id: "C1", month: "2026-01-01", dueDate: "2026-01-05", amount: 300_000 }),
    charge({ id: "C2", month: "2026-02-01", dueDate: "2026-02-05", amount: 300_000 }),
    charge({ id: "C3", month: "2026-03-01", dueDate: "2026-03-05", amount: 300_000 }),
  ];

  it("applies payments oldest-first (same example as the API tests)", () => {
    const { balances, students } = computeDebts(charges, [payment({ amount: 450_000 })], "2026-03-10");
    expect(balances.map((b) => [b.id, b.paid, b.outstanding])).toEqual([["C1", 300_000, 0], ["C2", 150_000, 150_000], ["C3", 0, 300_000]]);
    const s = students[0]!;
    expect(s).toMatchObject({ outstanding: 450_000, overdue: 450_000, credit: 0, oldestDue: "2026-02-05", openCharges: 2 });
    expect(s.maxDaysOverdue).toBe(33);
  });

  it("keeps overpayment as credit and ignores voided rows", () => {
    const { students } = computeDebts(charges, [payment({ amount: 1_000_000 }), payment({ id: "P2", amount: 5_000_000, voided: true })], "2026-03-10");
    expect(students[0]).toMatchObject({ outstanding: 0, credit: 100_000, overdue: 0, maxDaysOverdue: 0 });
    const voided = computeDebts([...charges, charge({ id: "C9", voided: true, amount: 9_999_999 })], [], "2026-03-10");
    expect(voided.students[0]!.charged).toBe(900_000);
  });

  it("only counts as overdue after the due date and lists debtors by size", () => {
    const { students } = computeDebts(charges, [], "2026-01-05"); // due date itself is not overdue yet
    expect(students[0]!.overdue).toBe(0);
    expect(debtors(students)).toEqual([]);
    const many = computeDebts(
      [...charges, charge({ id: "C7", studentId: "S0002", amount: 1_200_000, dueDate: "2026-01-01" })], [], "2026-03-10",
    );
    expect(debtors(many.students).map((d) => d.studentId)).toEqual(["S0002", "S0001"]);
    expect(debtors(many.students, 66).map((d) => d.studentId)).toEqual(["S0002"]); // 68 days vs 64 days
  });

  it("a payment without charges is pure credit", () => {
    const { students } = computeDebts([], [payment({ amount: 50_000 })], "2026-03-10");
    expect(students[0]).toMatchObject({ studentId: "S0001", credit: 50_000, outstanding: 0 });
  });
});

describe("payroll", () => {
  const teacher = (o: Partial<Teacher> = {}): Teacher => ({ id: "T0001", fullName: "T", payModel: "per_lesson", payRate: 100_000, status: "active", ...o });

  it("counts a lesson once per (date, group) in the month", () => {
    const rows = [
      { date: "2026-03-02", groupId: "G0001", studentId: "S1", status: "present", minutesLate: 0 },
      { date: "2026-03-02", groupId: "G0001", studentId: "S2", status: "absent", minutesLate: 0 },
      { date: "2026-03-09", groupId: "G0001", studentId: "S1", status: "late", minutesLate: 5 },
      { date: "2026-03-09", groupId: "G0002", studentId: "S1", status: "present", minutesLate: 0 }, // other teacher's group
      { date: "2026-04-01", groupId: "G0001", studentId: "S1", status: "present", minutesLate: 0 }, // other month
    ] as const;
    expect(heldLessons([...rows], new Set(["G0001"]), "2026-03-01")).toBe(2);
  });

  it("computes fixed, per-lesson and percent pay", () => {
    expect(computePayroll(teacher({ payModel: "fixed", payRate: 3_000_000 }), "2026-03-01", { heldLessons: 9, collectedTuition: 0 }).total).toBe(3_000_000);
    const per = computePayroll(teacher(), "2026-03-01", { heldLessons: 3, collectedTuition: 0 });
    expect(per.lines).toHaveLength(3);
    expect(per.total).toBe(300_000);
    const pct = computePayroll(teacher({ payModel: "percent", payRate: 40 }), "2026-03-01", { heldLessons: 0, collectedTuition: 500_000 });
    expect(pct.total).toBe(200_000);
    expect(computePayroll(teacher({ payRate: 0 }), "2026-03-01", { heldLessons: 5, collectedTuition: 0 }).total).toBe(0);
    expect(computePayroll(teacher({ payModel: "percent" }), "2026-03-01", { heldLessons: 0, collectedTuition: 0 }).lines).toEqual([]);
  });

  it("collects only the paid part of the teacher's groups for the month", () => {
    const groups = [group(), group({ id: "G0002", teacherId: "T0002" })];
    const enrollments = [enrollment({ id: "E1" }), enrollment({ id: "E2", groupId: "G0002" })];
    const { balances } = computeDebts(
      [charge({ id: "C1", enrollmentId: "E1", month: "2026-03-01", dueDate: "2026-03-05", amount: 500_000 }),
       charge({ id: "C2", studentId: "S0002", enrollmentId: "E2", month: "2026-03-01", amount: 500_000 })],
      [payment({ amount: 300_000 }), payment({ id: "P2", studentId: "S0002", amount: 500_000 })], "2026-03-31",
    );
    expect(collectedTuition(balances, enrollments, groups, "T0001", "2026-03-01")).toBe(300_000);
    expect(collectedTuition(balances, enrollments, groups, "T0002", "2026-03-01")).toBe(500_000);
  });
});

describe("reminders", () => {
  const base = { today: "2026-03-10", cooldownDays: 7, minOverdueSom: 50_000, template: DEFAULT_TEMPLATE, centerName: "Markaz" };
  const debt = (id: string, overdue = 300_000, days = 12) => ({ studentId: id, charged: overdue, paid: 0, outstanding: overdue, overdue, credit: 0, oldestDue: "2026-02-26", maxDaysOverdue: days, openCharges: 1 });
  const draft = (o: Partial<ReminderDraft>): ReminderDraft => ({ id: "R1", studentId: "S0001", createdOn: "2026-03-08", text: "", status: "sent", error: "", ...o });

  it("renders the message with the amount and days", () => {
    const plan = planReminders({ ...base, debtors: [debt("S0001")], students: [student()], drafts: [] });
    expect(plan.drafts).toHaveLength(1);
    expect(plan.drafts[0]!.text).toContain("Karim");
    expect(plan.drafts[0]!.text).toContain("300 000 so'm");
    expect(plan.drafts[0]!.text).toContain("12 kun");
    expect(renderTemplate("{a} {unknown}", { a: "x" })).toBe("x {unknown}");
    expect(formatSom(1234567)).toBe("1 234 567");
  });

  it("never drafts without consent, chat, activity, threshold or inside the cooldown", () => {
    const students = [
      student({ id: "S1", consentNotify: false }), student({ id: "S2", guardianChatId: "" }), student({ id: "S3", status: "left" }),
      student({ id: "S4" }), student({ id: "S5" }), student({ id: "S6" }),
    ];
    const plan = planReminders({
      ...base,
      debtors: [debt("S1"), debt("S2"), debt("S3"), debt("S4", 10_000), debt("S5"), debt("S6"), debt("S404")],
      students,
      drafts: [draft({ studentId: "S5", createdOn: "2026-03-08" }), draft({ studentId: "S6", createdOn: "2026-03-01" })],
    });
    expect(Object.fromEntries(plan.skipped.map((s) => [s.studentId, s.reason]))).toEqual({
      S1: "no_consent", S2: "no_chat", S3: "student_inactive", S4: "below_threshold", S5: "cooldown", S404: "student_inactive",
    });
    expect(plan.drafts.map((d) => d.studentId)).toEqual(["S6"]); // last reminder was 9 days ago
  });

  it("a rejected draft does not start a cooldown", () => {
    const plan = planReminders({ ...base, debtors: [debt("S0001")], students: [student()], drafts: [draft({ status: "rejected", createdOn: "2026-03-09" })] });
    expect(plan.drafts).toHaveLength(1);
  });
});

describe("ids", () => {
  it("continues the numbering and ignores other prefixes", () => {
    expect(nextId("S", [])).toBe("S0001");
    expect(nextId("S", ["S0001", "S0009", "G0100", "Sxx"])).toBe("S0010");
    expect(nextIds("C", ["C0004"], 3)).toEqual(["C0005", "C0006", "C0007"]);
  });
});
