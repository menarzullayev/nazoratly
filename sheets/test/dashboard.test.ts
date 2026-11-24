import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceRow, Charge, Enrollment, Entitlement, Expense, Group, Lead, Package, Payment, Student } from "../src/domain/types";
import { buildBlocks, refreshDashboard, studentCell } from "../src/gas/dashboard";
import { append } from "../src/gas/repo";
import { ATTENDANCE, CHARGES, DASHBOARD_SHEET, ENROLLMENTS, ENTITLEMENTS, EXPENSES, GROUPS, LEADS, PACKAGES, PAYMENTS, PAYROLL, STUDENTS } from "../src/gas/schema";
import { loadSampleData, resetSampleData, setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;

const stu = (id: string, fullName: string): Student => ({ id, fullName, status: "active", guardianName: "", guardianChatId: "", consentNotify: false });
const enr = (id: string, studentId: string, groupId: string, startedOn: string, extra: Partial<Enrollment> = {}): Enrollment => ({ id, studentId, groupId, startedOn, endedOn: "", discountPercent: 0, status: "active", ...extra });
const pay = (id: string, studentId: string, paidOn: string, amount: number, voided = false): Payment => ({ id, studentId, paidOn, amount, method: "Naqd", note: "", voided });
const lead = (id: string, source: string, stage: Lead["stage"], createdOn: string): Lead => ({ id, fullName: `Lead ${id}`, phone: "", source, stage, nextFollowUpOn: "", note: "", createdOn, studentId: "" });

/** Today is Monday 2026-11-23. */
function seed(): void {
  const students = [stu("S0001", "Ali Valiyev"), stu("S0002", "Bobur Karimov"), stu("S0003", "Dilnoza Aliyeva"), stu("S0004", "Eldor Tursunov"), stu("S0005", "Farida Rahimova"), stu("S0006", "Gulnora Saidova"), stu("S0007", "Hamid Nazarov"), stu("S0008", "Ilhom Yusupov"), stu("S0009", "Jamila Ergasheva")];
  append(STUDENTS, students);
  const groups: Group[] = [
    { id: "G0001", name: "IELTS", teacherId: "T0001", monthlyFee: 200_000, schedule: "Du", status: "active" },
    { id: "G0002", name: "Abonement guruh", teacherId: "T0001", monthlyFee: 0, schedule: "Du", status: "active", billingMode: "package", packageLessons: 12, packagePrice: 600_000 },
  ];
  append(GROUPS, groups);
  append(ENROLLMENTS, [
    enr("E0001", "S0001", "G0001", "2026-01-01"),
    enr("E0002", "S0002", "G0001", "2026-01-01"),
    enr("E0003", "S0003", "G0001", "2026-11-02", { acceptedOn: "2026-11-05", firstMonthMode: "free_until_next" }),
    enr("E0004", "S0004", "G0001", "2026-01-01", { status: "finished", endedOn: "2026-11-12" }),
    enr("E0005", "S0005", "G0002", "2026-01-01"),
    enr("E0006", "S0006", "G0001", "2026-11-20", { status: "trial" }),
    enr("E0007", "S0007", "G0001", "2026-11-10", { status: "trial" }),
    enr("E0008", "S0008", "G0001", "2026-11-04", { status: "finished", endedOn: "2026-11-06", droppedTrial: true }),
    enr("E0009", "S0009", "G0002", "2026-01-01"),
  ]);
  const charge = (id: string, studentId: string, enrollmentId: string, amount: number, due: string): Charge => ({ id, studentId, enrollmentId, month: "2026-11-01", amount, dueDate: due, voided: false, note: "" });
  append(CHARGES, [charge("C0001", "S0001", "E0001", 200_000, "2026-11-10"), charge("C0002", "S0002", "E0002", 200_000, "2026-11-10"), charge("C0003", "S0009", "E0009", 600_000, "2026-11-20")]);
  append(PAYMENTS, [pay("P0001", "S0001", "2026-11-11", 200_000), pay("P0002", "S0002", "2026-11-12", 50_000), pay("P0003", "S0001", "2026-10-05", 300_000), pay("P0004", "S0009", "2026-11-20", 600_000), pay("P0005", "S0002", "2026-11-13", 77_777, true)]);
  append(PACKAGES, [{ id: "P0001", studentId: "S0009", enrollmentId: "E0009", chargeId: "C0003", lessons: 12, price: 600_000, purchasedOn: "2026-11-20", expiresOn: "2026-11-27" } satisfies Package]);
  const att = (date: string): AttendanceRow => ({ date, groupId: "G0002", studentId: "S0005", status: "present", minutesLate: 0 });
  append(ATTENDANCE, [att("2026-11-02"), att("2026-11-09")]);
  const ex = (id: string, date: string, amount: number, voided = false): Expense => ({ id, date, category: "rent", amount, note: "", voided });
  append(EXPENSES, [ex("X0001", "2026-11-03", 500_000), ex("X0002", "2026-10-03", 500_000), ex("X0003", "2026-11-04", 999_999, true)]);
  append(PAYROLL, [
    { month: "2026-11-01", teacherId: "T0001", teacherName: "Dilnoza", heldLessons: 0, collected: 0, bonus: 0, total: 400_000, status: "approved" },
    { month: "2026-10-01", teacherId: "T0001", teacherName: "Dilnoza", heldLessons: 0, collected: 0, bonus: 0, total: 111, status: "draft" },
  ]);
  const right = (id: string, expiresOn: string, extra: Partial<Entitlement> = {}): Entitlement => ({ id, studentId: "S0001", groupId: "G0001", missedOn: "2026-11-16", kind: "makeup", amount: 0, expiresOn, status: "open", makeupOn: "", usedOn: "", appliedChargeId: "", lastMakeupOn: "", ...extra });
  append(ENTITLEMENTS, [right("R0001", "2026-11-27"), right("R0002", "2026-12-10"), right("R0003", "2026-11-25", { status: "used" }), right("R0004", "2026-11-25", { kind: "credit", amount: 10_000 })]);
  append(LEADS, [lead("L0001", "Instagram", "new", "2026-11-02"), lead("L0002", "Instagram", "enrolled", "2026-11-05"), lead("L0003", "", "contacted", "2026-11-10"), lead("L0004", "Instagram", "new", "2026-10-01")]);
}

const cells = (): (string | number)[][] => h.rows(DASHBOARD_SHEET) as (string | number)[][];
/** Rows of the dashboard from the one whose first cell starts with `from`, up to (not including) the next blank row. */
function section(from: string, second?: string): (string | number)[][] {
  const all = cells();
  const start = all.findIndex((r) => String(r[0]).startsWith(from) && (second === undefined || r[1] === second));
  if (start < 0) throw new Error(`no row starting with ${from}`);
  const out: (string | number)[][] = [];
  for (let i = start; i < all.length && all[i]!.some((c) => c !== "" && c != null); i++) out.push(all[i]!);
  return out;
}
const nameOf = (cell: string | number): string => (/^=HYPERLINK\(".*","(.*)"\)$/.exec(String(cell)) ?? [])[1]?.replace(/""/g, '"') ?? String(cell);
const short = (r: (string | number)[], n: number): (string | number)[] => r.slice(0, n);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("expenses sheet", () => {
  it("setup creates Xarajatlar with its header", () => {
    expect(h.rows(EXPENSES.sheet)[0]).toEqual(["ID", "Sana", "Turi", "Summa", "Izoh", "Bekor qilingan", "Qayerdan to'langan", "Ta'minotchi hisobi", "Demo", "Filial"]);
  });
});

describe("dashboard block 1: paid vs unpaid", () => {
  beforeEach(() => {
    seed();
    refreshDashboard();
  });

  it("counts paid, unpaid and overdue among students with an active or frozen enrollment", () => {
    const s = section("1. ");
    expect(short(s[2]!, 3)).toEqual([3, 2, 1]); // paid: Ali, Dilnoza, Jamila; unpaid: Bobur, Farida; overdue: Bobur
  });

  it("lists unpaid students by amount, as links to their student row, with package debt", () => {
    const s = section("To'lamagan o'quvchilar");
    expect(s.slice(1).map((r) => [nameOf(r[0]!), r[1], r[2], r[3]])).toEqual([
      ["Bobur Karimov", 150_000, 150_000, 0],
      ["Farida Rahimova", 0, 0, 2], // two lessons attended with no package
    ]);
    expect(String(s[1]![0])).toMatch(/^=HYPERLINK\("#gid=\d+&range=A3","Bobur Karimov"\)$/);
    expect(String(s[2]![0])).toMatch(/range=A6"/);
  });

  it("lists paid students; a trial, a dropped trial and a finished enrollment are not in the population", () => {
    const s = section("To'lagan o'quvchilar");
    expect(s.slice(1).map((r) => nameOf(r[0]!))).toEqual(["Ali Valiyev", "Dilnoza Aliyeva", "Jamila Ergasheva"]);
  });
});

describe("dashboard block 2: new, left, trial conversion", () => {
  it("counts this month's movement and conversion", () => {
    seed();
    refreshDashboard();
    const s = section("2. ");
    expect(short(s[2]!, 7)).toEqual([1, 1, 4, 1, 1, 2, 50]); // new, left, trials started, accepted, dropped, running, conversion %
    const lists = section("Yangi o'quvchilar");
    expect(nameOf(lists[1]![0]!)).toBe("Dilnoza Aliyeva");
    expect(nameOf(lists[1]![1]!)).toBe("Eldor Tursunov");
  });

  it("a student who left and re-enrolled is not counted as left; bad enrollment rows are reported, not counted", () => {
    seed();
    append(ENROLLMENTS, [enr("E0010", "S0004", "G0002", "2026-11-20"), enr("E0011", "S0001", "G0001", "")]);
    refreshDashboard();
    const s = section("2. ");
    expect(s[2]![1]).toBe(0); // Eldor came back
    const warning = cells().find((r) => String(r[0]).startsWith("Diqqat:"));
    expect(String(warning![0])).toContain("1 ta yozilish");
  });
});

describe("dashboard block 3: six-month finance", () => {
  it("income, expenses (rent plus approved payroll, no drafts, no voided rows) and net per month, with totals", () => {
    seed();
    refreshDashboard();
    const s = section("Oy", "Tushum");
    const rows = s.filter((r) => /^\d{4}-\d{2}$/.test(String(r[0])) || r[0] === "Jami");
    expect(rows.map((r) => short(r, 6))).toEqual([
      ["2026-06", 0, 0, 0, 0, 0],
      ["2026-07", 0, 0, 0, 0, 0],
      ["2026-08", 0, 0, 0, 0, 0],
      ["2026-09", 0, 0, 0, 0, 0],
      ["2026-10", 300_000, 500_000, -200_000, 0, 500_000],
      ["2026-11", 850_000, 900_000, -50_000, 400_000, 500_000],
      ["Jami", 1_150_000, 1_400_000, -250_000, "", ""],
    ]);
  });

  it("works when the workbook has no expenses sheet yet (older workbook before setup)", () => {
    seed();
    h.sheets.delete(EXPENSES.sheet);
    refreshDashboard();
    const nov = section("Oy", "Tushum").find((r) => r[0] === "2026-11")!;
    expect(short(nov, 6)).toEqual(["2026-11", 850_000, 400_000, 450_000, 400_000, 0]);
  });

  it("ignores hand-edited rows with bad dates", () => {
    seed();
    append(PAYMENTS, [pay("P0009", "S0001", "", 5_000_000)]);
    append(EXPENSES, [{ id: "X0009", date: "", category: "rent", amount: 9_000_000, note: "", voided: false }]);
    refreshDashboard();
    expect(section("Oy", "Tushum").find((r) => r[0] === "Jami")![1]).toBe(1_150_000);
  });
});

describe("dashboard block 4: funnel and waiting for a decision", () => {
  it("shows the funnel of this month's leads", () => {
    seed();
    refreshDashboard();
    const s = section("4. ");
    const byLabel = Object.fromEntries(s.slice(2, 9).map((r) => [String(r[0]), r[1]]));
    expect(byLabel).toMatchObject({ Yangi: 1, Aloqada: 1, Yozildi: 1, "Yo'qotildi": 0, "Sinovdan yozilishga (%)": 100 });
    const sources = section("Manba");
    expect(sources.slice(1).map((r) => short(r, 4))).toEqual([
      ["Instagram", 2, 1, 50], // the October lead is outside this month
      ["(manba yo'q)", 1, 0, 0],
    ]);
  });

  it("lists trials needing a decision, expiring packages and lapsing make-up rights", () => {
    seed();
    refreshDashboard();
    const waiting = cells().find((r) => String(r[0]).startsWith("Qaror kutayotganlar"))!;
    expect(String(waiting[0])).toContain("jami 3");
    const trials = section("Sinovlar");
    expect(trials.slice(1).map((r) => [nameOf(r[0]!), r[1], r[2], r[3]])).toEqual([["Hamid Nazarov", "IELTS", "bepul kunlar o'tdi", 13]]); // Gulnora's trial is only 3 days old
    const pkgs = section("Tugayotgan abonementlar");
    expect(pkgs.slice(1).map((r) => [nameOf(r[0]!), r[1], r[2], r[3], r[4]])).toEqual([["Jamila Ergasheva", "Abonement guruh", 12, "2026-11-27", 4]]);
    const rights = section("Kuyayotgan qoplash huquqlari");
    expect(rights.slice(1).map((r) => [nameOf(r[0]!), r[1], r[2], r[3]])).toEqual([["Ali Valiyev", "IELTS", "2026-11-27", 4]]); // credit, used and far-away rights are not listed
  });

  it("the look-ahead window is a setting", () => {
    seed();
    const row = h.sheets.get("Sozlamalar")!.data.find((r) => r[0] === "Panelda yaqinlashayotgan muddat oynasi (kun)")!;
    row[1] = "3";
    refreshDashboard();
    const waiting = cells().find((r) => String(r[0]).startsWith("Qaror kutayotganlar"))!;
    expect(String(waiting[0])).toContain("jami 1"); // only the trial: both others are 4 days away
    expect(String(waiting[0])).toContain("3 kun");
  });
});

describe("sample data and older workbooks", () => {
  it("sample data carries rent and utilities that reach the finance block", () => {
    loadSampleData();
    refreshDashboard();
    const nov = section("Oy", "Tushum").find((r) => r[0] === "2026-11")!;
    expect(nov[5]).toBe(3_450_000); // operating expenses of the month
  });

  it("sample data and reset still work in a workbook that has no expenses sheet yet", () => {
    h.sheets.delete(EXPENSES.sheet);
    expect(() => loadSampleData()).not.toThrow();
    expect(() => resetSampleData()).not.toThrow();
    expect(() => refreshDashboard()).not.toThrow();
  });
});

describe("dashboard sheet", () => {
  it("keeps the old KPI cards and is idempotent", () => {
    seed();
    refreshDashboard();
    const sh = h.sheet(DASHBOARD_SHEET);
    expect(sh.getRange(5, 1).getValue()).toBe(9); // students with status active (all 9 seeded as active)
    const first = JSON.stringify(cells());
    refreshDashboard();
    expect(JSON.stringify(cells())).toBe(first);
  });

  it("an empty workbook produces a dashboard with zeros and no errors", () => {
    refreshDashboard();
    expect(short(section("1. ")[2]!, 3)).toEqual([0, 0, 0]);
    expect(cells().some((r) => r[0] === "Hamma to'lagan")).toBe(true);
    expect(buildBlocks().invalidEnrollments).toBe(0);
  });

  it("a student name cannot break out of the hyperlink formula", () => {
    expect(studentCell('Ali "Pro" Valiyev', 5, 7)).toBe('=HYPERLINK("#gid=5&range=A7","Ali ""Pro"" Valiyev")');
    expect(studentCell("Ali", null, null)).toBe("Ali");
  });
});
