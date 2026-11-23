import { effectiveFee, planCharges } from "@domain/billing";
import { nextIds } from "@domain/ids";
import type { AttendanceRow, Charge, Enrollment, Group, Payment, Student, Teacher } from "@domain/types";

/** Fixed "today" of the simulation, so every visitor and every test sees the same numbers. */
export const DEMO_TODAY = "2026-11-23";
export const DEMO_MONTH = "2026-11-01";
const MONTHS = ["2026-09-01", "2026-10-01", "2026-11-01"] as const;

export interface DemoData {
  students: Student[];
  groups: Group[];
  teachers: Teacher[];
  enrollments: Enrollment[];
  charges: Charge[];
  payments: Payment[];
  attendance: AttendanceRow[];
}

const NAMES = [
  "Aziz Rahimov",
  "Madina Tursunova",
  "Jasur Qodirov",
  "Nigora Ismoilova",
  "Bobur Saidov",
  "Lola Xasanova",
  "Otabek Mirzaev",
  "Zarina Yusupova",
];
/** Guardians who already linked the bot and agreed to notifications (index into NAMES). */
const CONSENTING = new Set([1, 4]);

export function seedData(): DemoData {
  const teachers: Teacher[] = [
    { id: "T0001", fullName: "Dilnoza Karimova", payModel: "per_lesson", payRate: 90_000, status: "active" },
    { id: "T0002", fullName: "Sardor Aliyev", payModel: "percent", payRate: 40, status: "active" },
  ];
  const groups: Group[] = [
    { id: "G0001", name: "IELTS 6.5 (kechki)", teacherId: "T0001", monthlyFee: 600_000, status: "active" },
    { id: "G0002", name: "Matematika 9-sinf", teacherId: "T0002", monthlyFee: 400_000, status: "active" },
  ];
  const students: Student[] = NAMES.map((fullName, i) => ({
    id: `S${String(i + 1).padStart(4, "0")}`,
    fullName,
    status: "active",
    guardianName: `${fullName.split(" ")[0]} ota-onasi`,
    guardianChatId: CONSENTING.has(i) ? String(7_000_000 + i) : "",
    consentNotify: CONSENTING.has(i),
  }));
  const enrollments: Enrollment[] = students.map((s, i) => ({
    id: `E${String(i + 1).padStart(4, "0")}`,
    studentId: s.id,
    groupId: i % 2 === 0 ? "G0001" : "G0002",
    startedOn: "2026-09-05",
    endedOn: "",
    discountPercent: i === 3 ? 10 : 0,
    status: "active",
  }));

  let charges: Charge[] = [];
  for (const month of MONTHS) {
    const plan = planCharges({ month, dueDay: 10, enrollments, groups, students, charges });
    const ids = nextIds(
      "C",
      charges.map((c) => c.id),
      plan.create.length,
    );
    charges = [
      ...charges,
      ...plan.create.map((c, i) => ({
        id: ids[i]!,
        studentId: c.studentId,
        enrollmentId: c.enrollmentId,
        month: c.month,
        amount: c.amount,
        dueDate: c.dueDate,
        voided: false,
        note: c.note,
      })),
    ];
  }

  // most families pay on time; Madina paid one month, Bobur none, Lola two
  const payments: Payment[] = [];
  students.forEach((s, i) => {
    const e = enrollments[i]!;
    const fee = effectiveFee(groups.find((g) => g.id === e.groupId)!, e);
    const paidMonths = i === 1 ? 1 : i === 4 ? 0 : i === 5 ? 2 : 3;
    for (let k = 0; k < paidMonths; k++) {
      payments.push({
        id: `P${String(payments.length + 1).padStart(4, "0")}`,
        studentId: s.id,
        paidOn: `${MONTHS[k]!.slice(0, 7)}-${String(8 + i).padStart(2, "0")}`,
        amount: fee,
        method: ["cash", "card", "transfer"][(i + k) % 3]!,
        voided: false,
        note: "",
      });
    }
  });

  // three lessons per group already held this month
  const attendance: AttendanceRow[] = [];
  for (const day of ["2026-11-05", "2026-11-12", "2026-11-19"]) {
    enrollments.forEach((e, i) => {
      const k = Number(day.slice(-2));
      const status = (i + k) % 7 === 0 ? "absent" : (i + k) % 5 === 0 ? "late" : "present";
      attendance.push({ date: day, groupId: e.groupId, studentId: e.studentId, status, minutesLate: status === "late" ? 10 : 0 });
    });
  }
  return { students, groups, teachers, enrollments, charges, payments, attendance };
}
