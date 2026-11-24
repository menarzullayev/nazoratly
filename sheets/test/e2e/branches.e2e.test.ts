import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Charge, Enrollment, Group, Student } from "../../src/domain/types";
import * as actions from "../../src/gas/actions";
import { buildBranchReport } from "../../src/gas/branches";
import { append, read, readRaw } from "../../src/gas/repo";
import { resetScope } from "../../src/gas/scope";
import { BRANCH_MOVES, BRANCH_PRICES, BRANCH_SETTINGS, BRANCHES, CHARGES, ENROLLMENTS, GROUPS, STAFF, STUDENTS } from "../../src/gas/schema";
import type { Harness } from "../harness";
import { boot, drive, driveLoose, enrollment, group, seedClass, student, teacher } from "./support";

let h: Harness;
const STAFF_EMAIL = "staff@example.com";
const asStaff = (): void => { h.user = STAFF_EMAIL; resetScope(); };
const asOwner = (): void => { h.user = "owner@example.com"; resetScope(); };
const pay = (studentId: string, amount: number): void => void actions.recordPayment({ studentId, amount, method: "Naqd", paidOn: "2026-11-05", note: "", notifyGuardian: false });

beforeEach(() => {
  h = boot();
  // the Asosiy filial (F0001) has one group and two students
  seedClass({ students: [student("S0001", { guardianName: "Aliyev" }), student("S0002", { guardianName: "Botirov" })], groups: [group({ name: "IELTS 6.5" })] });
});
afterEach(() => vi.useRealTimers());

function openSecondBranch(): void {
  drive(h, "menuBranchAdd", "Chilonzor", "Chilonzor 5");
  // the owner works inside the new branch: everything created now belongs to it
  drive(h, "menuBranchChoose", "F0002");
  append(GROUPS, [group({ id: "G0002", name: "IELTS 7.0", teacherId: "T0001", monthlyFee: 700_000 })]);
  append(STUDENTS, [student("S0003", { guardianName: "Valiyev" })]);
  append(ENROLLMENTS, [enrollment("E0003", "S0003", { groupId: "G0002" })]);
  drive(h, "menuBranchChoose", ""); // back to the whole center
}

describe("journey: branches", () => {
  it("adds a branch, lists it, refuses duplicates, and stamps new rows with the chosen view branch", () => {
    expect(drive(h, "menuBranchAdd", "Chilonzor", "Chilonzor 5").alerts).toEqual([]);
    expect(drive(h, "menuBranchAdd", "chilonzor", "").last).toMatch(/allaqachon bor/);
    expect(read<{ id: string; name: string; isDefault: boolean }>(BRANCHES).map((b) => [b.id, b.name, b.isDefault])).toEqual([["F0001", "Asosiy filial", true], ["F0002", "Chilonzor", false]]);
    const list = drive(h, "menuBranchList").last;
    expect(list).toContain("F0002  Chilonzor");
    expect(list).toContain("butun markaz");
    expect(drive(h, "menuBranchChoose", "F0099").last).toMatch(/topilmadi/);
    openSecondBranch();
    const raw = readRaw<Student>(STUDENTS);
    expect(raw.map((s) => [s.id, s.branchId ?? ""])).toEqual([["S0001", "F0001"], ["S0002", "F0001"], ["S0003", "F0002"]]);
  });

  it("branch staff see only their branch; center-only actions are refused for them; the owner sees everything again", () => {
    openSecondBranch();
    drive(h, "menuBranchStaff", STAFF_EMAIL, "admin", "F0002");
    expect(read(STAFF)).toHaveLength(1);
    asStaff();
    expect(read<Student>(STUDENTS).map((s) => s.id)).toEqual(["S0003"]);
    expect(read<Group>(GROUPS).map((g) => g.id)).toEqual(["G0002"]);
    expect(driveLoose(h, "menuBranchAdd", "Yunusobod", "").last).toMatch(/markaz|butun/i);
    expect(driveLoose(h, "menuBranchChoose", "F0001").last).toMatch(/biriktirilgansiz/);
    // the staff member registers a student: it lands in F0002 and gets a fresh id that does not clash with the hidden ones
    append(STUDENTS, [student("S0004")]);
    expect(readRaw<Student>(STUDENTS).find((s) => s.id === "S0004")!.branchId).toBe("F0002");
    asOwner();
    expect(read<Student>(STUDENTS).map((s) => s.id)).toEqual(["S0001", "S0002", "S0003", "S0004"]);
  });

  it("branch report: money and counts are separated per branch and the total is the sum", () => {
    openSecondBranch();
    drive(h, "menuGenerateCharges", "2026-11");
    pay("S0001", 500_000);
    pay("S0003", 300_000);
    const rep = buildBranchReport("2026-11");
    const byId = Object.fromEntries(rep.rows.map((r) => [r.branchId, r]));
    expect([byId.F0001!.studentsActive, byId.F0001!.charges, byId.F0001!.revenue, byId.F0001!.debt]).toEqual([2, 1_000_000, 500_000, 500_000]);
    expect([byId.F0002!.studentsActive, byId.F0002!.charges, byId.F0002!.revenue, byId.F0002!.debt]).toEqual([1, 700_000, 300_000, 400_000]);
    expect([rep.total.charges, rep.total.revenue, rep.total.debt]).toEqual([1_700_000, 800_000, 900_000]);
    drive(h, "menuBranchReport", "2026-11");
    const sheet = JSON.stringify(h.rows("Filial hisoboti"));
    expect(sheet).toContain("Chilonzor");
    expect(sheet).toContain("Jami");
    expect(drive(h, "menuBranchReport", "2026-13").last).toMatch(/noto'g'ri/);
  });

  it("transfers a student: refused while enrolled in the old branch, then with 'end' the enrollment finishes and history stays", () => {
    openSecondBranch();
    drive(h, "menuGenerateCharges", "2026-11");
    pay("S0001", 500_000);
    const refused = drive(h, "menuBranchTransfer", "S0001", "F0002", "Yo'q", "Ko'chib o'tdi");
    expect(refused.last).toMatch(/boshqa filial guruhlarida/);
    expect(readRaw<Student>(STUDENTS).find((s) => s.id === "S0001")!.branchId ?? "").toBe("F0001");
    const ok = drive(h, "menuBranchTransfer", "S0001", "F0002", "Ha", "Ko'chib o'tdi");
    expect(ok.last).toContain("F0001 → F0002");
    expect(ok.last).toContain("Tugatilgan yozilishlar: 1");
    expect(readRaw<Student>(STUDENTS).find((s) => s.id === "S0001")!.branchId).toBe("F0002");
    expect(readRaw<Enrollment>(ENROLLMENTS).find((e) => e.studentId === "S0001")!.status).toBe("finished");
    // the money stays where it arose: the November charge and payment are still F0001's
    const charge = readRaw<Charge>(CHARGES).find((c) => c.studentId === "S0001")!;
    expect(charge.branchId).toBe("F0001");
    expect(read(BRANCH_MOVES)).toHaveLength(1);
    expect(drive(h, "menuBranchTransfer", "S0001", "F0002", "Ha", "").last).toMatch(/allaqachon shu filialda/);
    expect(drive(h, "menuBranchTransfer", "S0099", "F0002", "Ha", "").last).toMatch(/topilmadi/);
  });

  it("closing and reopening: the default branch cannot be closed, a closed branch takes no transfers, default can be switched", () => {
    drive(h, "menuBranchAdd", "Chilonzor", "");
    expect(drive(h, "menuBranchClose", "F0001").last).toMatch(/Asosiy filialni yopib bo'lmaydi/);
    drive(h, "menuBranchClose", "F0002");
    expect(drive(h, "menuBranchTransfer", "S0002", "F0002", "Ha", "").last).toMatch(/yopilgan/);
    expect(drive(h, "menuBranchDefault", "F0002").last).toMatch(/Yopilgan filial asosiy/);
    drive(h, "menuBranchReopen", "F0002");
    drive(h, "menuBranchDefault", "F0002");
    expect(read<{ id: string; isDefault: boolean }>(BRANCHES).map((b) => [b.id, b.isDefault])).toEqual([["F0001", false], ["F0002", true]]);
    drive(h, "menuBranchClose", "F0001");
    expect(read<{ id: string; status: string }>(BRANCHES).map((b) => b.status)).toEqual(["closed", "active"]);
    expect(drive(h, "menuBranchStaff", "not-an-email", "admin", "").last).toMatch(/Email noto'g'ri/);
  });

  it("price per branch and course applies to a group; a branch setting overrides the center value and clears again", () => {
    openSecondBranch();
    drive(h, "menuBranchPrice", "F0002", "IELTS", "650000");
    drive(h, "menuBranchPrice", "F0002", "ielts", "620000"); // same course: corrected, not doubled
    expect(read<{ course: string; monthlyFee: number }>(BRANCH_PRICES).map((p) => [p.course, p.monthlyFee])).toEqual([["IELTS", 620_000]]);
    expect(drive(h, "menuBranchPrice", "F0002", "IELTS", "-1").last).toMatch(/Narx/);
    drive(h, "menuBranchApplyPrice", "G0002");
    expect(read<Group>(GROUPS).find((g) => g.id === "G0002")!.monthlyFee).toBe(620_000);
    // the first branch has no price: its group keeps its own fee
    drive(h, "menuBranchApplyPrice", "G0001");
    expect(read<Group>(GROUPS).find((g) => g.id === "G0001")!.monthlyFee).toBe(500_000);

    drive(h, "menuBranchSetting", "F0002", "Oilaviy chegirma: 2-farzand (%)", "20");
    expect(read<{ branchId: string; value: string }>(BRANCH_SETTINGS).map((s) => [s.branchId, s.value])).toEqual([["F0002", "20"]]);
    expect(drive(h, "menuBranchSetting", "F0002", "Markaz nomi", "X").last).toMatch(/alohida o'rnatiladigan/);
    drive(h, "menuBranchSetting", "F0002", "Oilaviy chegirma: 2-farzand (%)", "");
    void teacher;
  });
});
