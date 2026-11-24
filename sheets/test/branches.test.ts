import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextId } from "../src/domain/ids";
import type { Charge, Enrollment, Expense, Group, Payment, Student } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import * as branches from "../src/gas/branches";
import * as growth from "../src/gas/growth";
import * as ledger from "../src/gas/ledger";
import * as money from "../src/gas/money";
import { append, read, readRaw, updateById } from "../src/gas/repo";
import { BRANCH_COL, BRANCH_MARKED, BRANCH_MOVES, BRANCHES, CASH_CLOSES, CHARGES, ENROLLMENTS, EXPENSES, GROUPS, JOURNAL, PAYMENTS, SOURCE_COSTS, STAFF, STUDENTS } from "../src/gas/schema";
import { resetScope } from "../src/gas/scope";
import { readSettings } from "../src/gas/settings";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;
const A = "F0001"; // the default branch
const B = "F0002";
const BOSS = "owner@example.com";
const CASHIER_B = "kassir.b@example.com";
const MANAGER_A = "menejer.a@example.com";

const student = (id: string, extra: Partial<Student> = {}): Student => ({ id, fullName: `Student ${id}`, status: "active", guardianName: "", guardianChatId: "", consentNotify: false, ...extra }) as Student;
const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, name: `Guruh ${id}`, teacherId: "", monthlyFee: 300_000, status: "active", ...extra }) as Group;
const enrollment = (id: string, studentId: string, groupId: string, extra: Partial<Enrollment> = {}): Enrollment => ({ id, studentId, groupId, startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active", ...extra }) as Enrollment;
const payment = (id: string, studentId: string, amount: number, extra: Partial<Payment> = {}): Payment => ({ id, studentId, paidOn: "2026-11-23", amount, method: "Naqd", voided: false, note: "", ...extra }) as Payment;

/** Acts as another person: the script reads the active user afresh on every run. */
function as(email: string): void {
  h.user = email;
  resetScope();
}
const sid = (rows: { id: string }[]): string[] => rows.map((r) => r.id).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

/** Two branches, a student and a group in each, a cashier of branch B and a manager of branch A. */
function twoBranches(): void {
  expect(branches.addBranch("Chilonzor", "Chilonzor 5")).toBe(B);
  append(STUDENTS, [student("S0001"), student("S0002", { branchId: B })]);
  append(GROUPS, [group("G0001"), group("G0002", { branchId: B, monthlyFee: 200_000 })]);
  append(ENROLLMENTS, [enrollment("E0001", "S0001", "G0001"), enrollment("E0002", "S0002", "G0002")]);
  branches.setStaff(CASHIER_B, "accountant", B);
  branches.setStaff(MANAGER_A, "manager", A);
}

describe("workbook setup", () => {
  it("creates the branch tabs, the default branch and a Filial column on every business tab", () => {
    for (const def of [BRANCHES, STAFF]) expect(h.rows(def.sheet)[0]).toEqual(def.cols.map((c) => c.header));
    expect(h.rows(BRANCHES.sheet)[1]).toEqual([A, "Asosiy filial", "", "Faol", "Ha"]);
    for (const def of BRANCH_MARKED) expect(h.rows(def.sheet)[0]!.at(-1), def.sheet).toBe(BRANCH_COL.header);
    setupWorkbook(); // again: still one default branch
    expect(h.rows(BRANCHES.sheet)).toHaveLength(2);
  });

  it("a workbook set up before branches (no Filial column) keeps working as one branch", () => {
    append(STUDENTS, [student("S0001")]);
    const sh = h.sheet(STUDENTS.sheet);
    sh.data = sh.data.map((r) => r.slice(0, -1)); // drop the Filial column
    expect(read<Student>(STUDENTS)).toMatchObject([{ id: "S0001", branchId: A }]);
    append(STUDENTS, [student("S0002")]); // no column to write the mark into: the row still lands
    expect(read<Student>(STUDENTS).map((s) => s.id)).toEqual(["S0001", "S0002"]);
    expect(updateById(STUDENTS, "id", "S0001", { branchId: B })).toBe(true); // a missing optional column is skipped, not an error
  });
});

describe("branches", () => {
  it("adds branches with ids and rejects duplicates and blanks", () => {
    expect(branches.addBranch("Chilonzor", "")).toBe(B);
    expect(() => branches.addBranch("chilonzor", "")).toThrow(/allaqachon bor/);
    expect(() => branches.addBranch("  ", "")).toThrow(/kiritilmadi/);
    expect(branches.listBranches().map((b) => [b.id, b.name, b.isDefault, b.status])).toEqual([[A, "Asosiy filial", true, "active"], [B, "Chilonzor", false, "active"]]);
  });

  it("the default branch cannot be closed; the default can be swapped; a closed branch cannot become the default", () => {
    branches.addBranch("Chilonzor", "");
    expect(() => branches.setBranchStatus(A, "closed")).toThrow(/Asosiy filialni yopib bo'lmaydi/);
    branches.makeDefault(B);
    expect(branches.listBranches().map((b) => b.isDefault)).toEqual([false, true]);
    branches.setBranchStatus(A, "closed");
    expect(() => branches.makeDefault(A)).toThrow(/Yopilgan filial/);
    expect(() => branches.setBranchStatus("F9999", "closed")).toThrow(/topilmadi/);
  });
});

describe("branch scope (the Sheets analogue of row-level security)", () => {
  beforeEach(twoBranches);

  it("center-wide staff see the total and may narrow the view; new rows follow the view", () => {
    expect(sid(read<Student>(STUDENTS))).toEqual(["S0001", "S0002"]);
    expect(branches.chooseView(B)).toMatch(/F0002/);
    resetScope();
    expect(sid(read<Student>(STUDENTS))).toEqual(["S0002"]);
    expect(sid(read<Group>(GROUPS))).toEqual(["G0002"]);
    append(STUDENTS, [student("S0003")]);
    expect(readRaw<Student>(STUDENTS).find((s) => s.id === "S0003")!.branchId).toBe(B); // stamped with the branch you look at
    expect(() => branches.chooseView("F9999")).toThrow(/topilmadi/);
    branches.chooseView("");
    resetScope();
    expect(sid(read<Student>(STUDENTS))).toEqual(["S0001", "S0002", "S0003"]);
  });

  it("staff of a branch see and write only their branch, and cannot look elsewhere", () => {
    as(CASHIER_B);
    expect(sid(read<Student>(STUDENTS))).toEqual(["S0002"]);
    expect(sid(read<Enrollment>(ENROLLMENTS))).toEqual(["E0002"]);
    append(STUDENTS, [student("S0010")]);
    expect(readRaw<Student>(STUDENTS).find((s) => s.id === "S0010")!.branchId).toBe(B);
    expect(() => branches.chooseView(A)).toThrow(/bitta filialga biriktirilgansiz/);
    as(MANAGER_A);
    expect(sid(read<Student>(STUDENTS))).toEqual(["S0001"]);
  });

  it("an id is never handed out twice, even though the other branch's rows are hidden", () => {
    as(CASHIER_B);
    const visible = read<Student>(STUDENTS);
    expect(visible.map((s) => s.id)).toEqual(["S0002"]);
    expect(nextId("S", visible.map((s) => s.id))).toBe("S0003"); // S0001 belongs to the other branch: reserved, and S0002 is ours
    as(MANAGER_A);
    const own = read<Student>(STUDENTS); // sees S0001 only; S0002 is hidden but reserved
    expect(nextId("S", own.map((s) => s.id))).toBe("S0003");
  });

  it("rewrites of a tab keep the rows of other branches", () => {
    as(CASHIER_B);
    append(STUDENTS, [student("S0003")]);
    const removed = (rows: Student[]): boolean => rows.length > 0;
    expect(removed(read<Student>(STUDENTS))).toBe(true);
    expect(sid(readRaw<Student>(STUDENTS))).toEqual(["S0001", "S0002", "S0003"]);
  });

  it("only center-wide staff manage branches and staff", () => {
    as(CASHIER_B);
    for (const f of [() => branches.addBranch("X", ""), () => branches.setBranchStatus(B, "closed"), () => branches.makeDefault(B), () => branches.setStaff("a@b.uz", "viewer", B), () => branches.setBranchPrice(B, "Ingliz", 1), () => branches.transferStudent("S0002", A, true)]) {
      expect(f).toThrow(/faqat butun markaz xodimlari/);
    }
  });

  it("a listed person with no branch is center-wide", () => {
    branches.setStaff("bosh@example.com", "admin", "");
    as("bosh@example.com");
    expect(sid(read<Student>(STUDENTS))).toEqual(["S0001", "S0002"]);
    expect(() => branches.setStaff("not-an-email", "admin", "")).toThrow(/Email noto'g'ri/);
    expect(() => branches.setStaff("x@y.uz", "admin", "F9999")).toThrow(/topilmadi/);
  });
});

describe("a student and a group of different branches", () => {
  beforeEach(twoBranches);

  it("cannot be joined by an enrollment", () => {
    append(STUDENTS, [student("S0003")]);
    expect(() => append(ENROLLMENTS, [enrollment("E0003", "S0003", "G0002")])).toThrow(/turli filiallarda/);
    append(ENROLLMENTS, [enrollment("E0004", "S0003", "G0002", { status: "finished" })]); // history is not blocked
    append(ENROLLMENTS, [enrollment("E0005", "S0003", "G0001")]);
    expect(readRaw<Enrollment>(ENROLLMENTS).find((e) => e.id === "E0005")!.branchId).toBe(A);
  });
});

describe("money rows follow their branch", () => {
  beforeEach(twoBranches);

  it("charges follow the enrollment, payments the student, and the desk wins for money", () => {
    h.prompts.push("2026-11");
    actions.generateMonthlyCharges();
    expect(Object.fromEntries(read<Charge>(CHARGES).map((c) => [c.studentId, [c.branchId, c.amount]]))).toEqual({ S0001: [A, 300_000], S0002: [B, 200_000] });
    append(PAYMENTS, [payment("P0001", "S0002", 50_000)]);
    expect(read<Payment>(PAYMENTS)[0]!.branchId).toBe(B); // no scope: follows the student
    as(MANAGER_A);
    append(PAYMENTS, [payment("P0002", "S0001", 10_000)]);
    as(CASHIER_B);
    expect(read<Payment>(PAYMENTS).map((p) => p.id)).toEqual(["P0001"]);
    expect(read<Charge>(CHARGES).map((c) => c.studentId)).toEqual(["S0002"]);
  });

  it("the monthly charges follow the settings of the branch of each enrollment (family discount)", () => {
    append(STUDENTS, [student("S0003", { guardianName: "Ona" }), student("S0004", { guardianName: "Ona" }), student("S0005", { guardianName: "Dada", branchId: B }), student("S0006", { guardianName: "Dada", branchId: B })]);
    append(ENROLLMENTS, [enrollment("E0003", "S0003", "G0001"), enrollment("E0004", "S0004", "G0001"), enrollment("E0005", "S0005", "G0002"), enrollment("E0006", "S0006", "G0002")]);
    const sheet = h.sheet("Sozlamalar");
    const row = sheet.data.findIndex((r) => r[0] === "Oilaviy chegirma: 2-farzand (%)");
    sheet.data[row]![1] = "10"; // the center: 10 %
    branches.setBranchSetting(B, "Oilaviy chegirma: 2-farzand (%)", "50"); // branch B: 50 %
    h.prompts.push("2026-11");
    actions.generateMonthlyCharges();
    const by = Object.fromEntries(read<Charge>(CHARGES).map((c) => [c.studentId, c.amount]));
    expect([by.S0003, by.S0004]).toEqual([300_000, 270_000]); // branch A: the center's 10 %
    expect([by.S0005, by.S0006]).toEqual([200_000, 100_000]); // branch B: its own 50 %
  });
});

describe("the ledger is one chain for the center", () => {
  beforeEach(() => {
    twoBranches();
    append(PAYMENTS, [payment("P0001", "S0001", 100_000), payment("P0002", "S0002", 40_000)]);
  });

  it("a center-wide sync posts every branch's payments into one chain, each entry in its own branch", () => {
    ledger.syncLedger();
    const lines = readRaw<ledger.JournalRow>(JOURNAL);
    expect(lines.map((l) => [l.entryNo, l.account, l.branchId])).toEqual([[1, "1000", A], [1, "4000", A], [2, "1000", B], [2, "4000", B]]);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
  });

  it("a branch writes into the same chain and sees only its own lines; it cannot verify or close", () => {
    ledger.syncLedger();
    as(CASHIER_B);
    append(PAYMENTS, [payment("P0003", "S0002", 5_000)]);
    ledger.syncLedger();
    expect(readRaw<ledger.JournalRow>(JOURNAL).map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ledger.journalLines().map((l) => l.entryNo)).toEqual([2, 2, 3, 3]); // its own entries only
    expect(() => ledger.verifyJournal()).toThrow(/faqat butun markaz xodimlari/);
    expect(() => ledger.closePeriod("2026-10")).toThrow(/faqat butun markaz xodimlari/);
    as(BOSS);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    expect(ledger.verifyJournal().lines).toBe(6);
  });

  it("the cash desk of a branch holds that branch's cash only", () => {
    ledger.syncLedger();
    expect(ledger.cashBookBalance("2026-11-23").balance).toBe(140_000);
    expect(ledger.cashBookBalance("2026-11-23", A).balance).toBe(100_000);
    expect(ledger.cashBookBalance("2026-11-23", B).balance).toBe(40_000);
    expect(ledger.cashBookBalance("2026-11-23", B).seq).toBe(4); // the chain head is the center's
    as(CASHIER_B);
    expect(ledger.cashBookBalance("2026-11-23").balance).toBe(40_000);
  });
});

describe("daily cash close per branch", () => {
  beforeEach(() => {
    twoBranches();
    append(PAYMENTS, [payment("P0001", "S0001", 100_000), payment("P0002", "S0002", 40_000)]);
    ledger.syncLedger();
  });

  it("center-wide staff must name the branch when there are several; shifts count per branch", () => {
    expect(() => money.closeCash({ counted: 100_000 })).toThrow(/bir nechta filial/);
    expect(() => money.closeCash({ counted: 1, branchId: "F9999" })).toThrow(/topilmadi/);
    const a = money.closeCash({ counted: 100_000, branchId: A });
    const b = money.closeCash({ counted: 35_000, note: "5000 kam", branchId: B });
    expect([a.shiftNo, b.shiftNo, a.difference, b.difference]).toEqual([1, 1, 0, -5_000]);
    expect(read(CASH_CLOSES).map((c) => (c as { branchId: string }).branchId)).toEqual([A, B]);
    expect(money.closeCash({ counted: 100_000, branchId: A }).shiftNo).toBe(2);
  });

  it("staff of a branch close their own cash desk and cannot name another", () => {
    as(CASHIER_B);
    expect(money.cashClosePreview()).toMatchObject({ branchId: B, bookBalance: 40_000, nextShift: 1 });
    expect(money.closeCash({ counted: 40_000 })).toMatchObject({ shiftNo: 1, difference: 0 });
    expect(() => money.closeCash({ counted: 1, branchId: A })).toThrow(/sizga ochiq emas/);
    expect(money.closeCash({ counted: 40_000 }).shiftNo).toBe(2);
  });

  it("a center with one active branch needs no choice", () => {
    branches.setBranchStatus(B, "closed");
    resetScope();
    expect(money.closeCash({ counted: 100_000 })).toMatchObject({ shiftNo: 1, difference: 0 }); // branch A is the only active one
  });
});

describe("moving a student between branches", () => {
  beforeEach(() => {
    twoBranches();
    h.prompts.push("2026-11");
    actions.generateMonthlyCharges();
    append(PAYMENTS, [payment("P0001", "S0001", 100_000)]);
  });

  it("is refused while he is enrolled in groups of the old branch, and needs a real target", () => {
    expect(() => branches.transferStudent("S0001", B, false)).toThrow(/boshqa filial guruhlarida o'qiydi/);
    expect(() => branches.transferStudent("S0001", A, true)).toThrow(/allaqachon shu filialda/);
    expect(() => branches.transferStudent("S0001", "F9999", true)).toThrow(/topilmadi/);
    expect(() => branches.transferStudent("S9999", B, true)).toThrow(/topilmadi/);
    branches.setBranchStatus(B, "closed");
    resetScope();
    expect(() => branches.transferStudent("S0001", B, true)).toThrow(/yopilgan/);
  });

  it("ends the old enrollments, moves the student, keeps money and history in the old branch and writes the move", () => {
    const r = branches.transferStudent("S0001", B, true, "ko'chib o'tdi", "2026-11-23");
    expect(r).toEqual({ studentId: "S0001", from: A, to: B, ended: 1 });
    expect(readRaw<Student>(STUDENTS).find((s) => s.id === "S0001")!.branchId).toBe(B);
    expect(readRaw<Enrollment>(ENROLLMENTS).find((e) => e.id === "E0001")).toMatchObject({ status: "finished", endedOn: "2026-11-23" });
    expect(readRaw<Charge>(CHARGES).find((c) => c.studentId === "S0001")!.branchId).toBe(A); // the money stays where it arose
    expect(readRaw<Payment>(PAYMENTS)[0]!.branchId).toBe(A);
    expect(read<{ id: string; studentId: string; fromBranchId: string; toBranchId: string; endedEnrollments: number; reason: string }>(BRANCH_MOVES)).toMatchObject([{ id: "B0001", studentId: "S0001", fromBranchId: A, toBranchId: B, endedEnrollments: 1, reason: "ko'chib o'tdi" }]);
    // now he can join a group of the new branch, not the old one
    append(ENROLLMENTS, [enrollment("E0003", "S0001", "G0002")]);
    expect(() => append(ENROLLMENTS, [enrollment("E0004", "S0001", "G0001")])).toThrow(/turli filiallarda/);
  });

  it("enrollments already in the target branch stay", () => {
    append(GROUPS, [group("G0003")]);
    updateById(ENROLLMENTS, "id", "E0001", { status: "finished" });
    const r = branches.transferStudent("S0001", B, false);
    expect(r.ended).toBe(0);
  });
});

describe("report per branch and total", () => {
  beforeEach(() => {
    twoBranches();
    h.prompts.push("2026-11");
    actions.generateMonthlyCharges();
    append(PAYMENTS, [payment("P0001", "S0001", 300_000), payment("P0002", "S0002", 150_000)]);
    append(EXPENSES, [{ id: "X0001", date: "2026-11-05", category: "rent", amount: 50_000, note: "", voided: false, paidFrom: "cash", billId: "", branchId: B } as Expense]);
    ledger.syncLedger();
  });

  it("the total is the sum of the rows (revenue, charges, expenses, net, debt, cash)", () => {
    const r = branches.buildBranchReport("2026-11");
    const [a, b] = r.rows;
    expect([a!.branchId, a!.revenue, a!.charges, a!.expenses, a!.net]).toEqual([A, 300_000, 300_000, 0, 300_000]);
    expect([b!.branchId, b!.revenue, b!.charges, b!.expenses, b!.net]).toEqual([B, 150_000, 200_000, 50_000, 100_000]);
    expect([a!.debt, b!.debt]).toEqual([0, 50_000]);
    expect([a!.studentsActive, b!.studentsActive, a!.groupsActive, b!.groupsActive]).toEqual([1, 1, 1, 1]);
    for (const key of ["revenue", "charges", "expenses", "net", "debt", "cashBalance", "studentsActive"] as const) expect(r.rows.reduce((n, x) => n + x[key], 0), key).toBe(r.total[key]);
    expect(r.total).toMatchObject({ branchId: null, revenue: 450_000, net: 400_000 });
    expect(a!.cashBalance).toBe(300_000);
    expect(b!.cashBalance).toBe(100_000); // 150 000 in, 50 000 rent out
  });

  it("staff of a branch get only their own row", () => {
    as(CASHIER_B);
    const r = branches.buildBranchReport("2026-11");
    expect(r.rows.map((x) => x.branchId)).toEqual([B]);
    expect(r.total.revenue).toBe(150_000);
    branches.showBranchReport("2026-11");
    expect(h.rows(branches.BRANCH_REPORT_SHEET)[0]![0]).toMatch(/faqat sizning filialingiz/);
  });

  it("a bad month is refused", () => {
    expect(() => branches.buildBranchReport("nope")).toThrow(/Oy noto'g'ri/);
  });
});

describe("prices and settings per branch", () => {
  beforeEach(twoBranches);

  it("a branch price replaces the group fee when applied; a zero price is a real price", () => {
    branches.setBranchPrice(B, "Guruh", 250_000);
    expect(branches.branchPrice(B, "Guruh G0002", 999)).toBe(250_000);
    expect(branches.branchPrice(A, "Guruh G0001", 300_000)).toBe(300_000); // no price in A: the fee stays
    expect(branches.applyBranchPrice("G0002")).toBe(250_000);
    expect(readRaw<Group>(GROUPS).find((g) => g.id === "G0002")!.monthlyFee).toBe(250_000);
    branches.setBranchPrice(B, "Guruh", 0);
    expect(branches.branchPrice(B, "Guruh G0002", 999)).toBe(0);
    expect(branches.applyBranchPrice("G0001")).toBe(300_000);
    expect(() => branches.setBranchPrice(B, "", 1)).toThrow(/Kurs nomi/);
    expect(() => branches.setBranchPrice(B, "X", -5)).toThrow(/butun son/);
    expect(() => branches.setBranchPrice("F9999", "X", 5)).toThrow(/topilmadi/);
  });

  it("settings: a branch inherits the center's value until it has its own", () => {
    const base = readSettings();
    branches.setBranchSetting(B, "Bepul sinov kunlari", "14");
    expect(readSettings(B).trialFreeDays).toBe(14);
    expect(readSettings(A).trialFreeDays).toBe(base.trialFreeDays);
    expect(readSettings().trialFreeDays).toBe(base.trialFreeDays); // center-wide view: the center's own
    as(CASHIER_B);
    expect(readSettings().trialFreeDays).toBe(14); // staff of the branch see the branch's value
    as(BOSS);
    branches.setBranchSetting(B, "Bepul sinov kunlari", ""); // empty = inherit again
    expect(readSettings(B).trialFreeDays).toBe(base.trialFreeDays);
    expect(() => branches.setBranchSetting(B, "Markaz nomi", "X")).toThrow(/alohida o'rnatiladigan sozlama emas/);
    expect(() => branches.setBranchSetting("F9999", "Bepul sinov kunlari", "3")).toThrow(/topilmadi/);
  });
});

describe("lead source costs per branch", () => {
  beforeEach(twoBranches);

  it("one figure per source, month and branch", () => {
    growth.setSourceCost("Instagram", "2026-11", "100000"); // center-wide: the default branch
    as(CASHIER_B);
    growth.setSourceCost("Instagram", "2026-11", "40000");
    growth.setSourceCost("Instagram", "2026-11", "45000"); // corrects its own, not the other branch's
    as(BOSS);
    expect(read<{ branchId: string; amount: number }>(SOURCE_COSTS).map((c) => [c.branchId, c.amount])).toEqual([[A, 100_000], [B, 45_000]]);
  });
});
