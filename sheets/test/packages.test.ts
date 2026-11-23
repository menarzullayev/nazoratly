import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Charge, Enrollment, Entitlement, Package, ReminderDraft } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import * as admission from "../src/gas/admission";
import * as makeup from "../src/gas/makeup";
import * as packages from "../src/gas/packages";
import { append, read } from "../src/gas/repo";
import { CHARGES, DRAFTS, ENROLLMENTS, ENTITLEMENTS, GROUPS, PACKAGES, PAYMENTS, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;

function setSetting(label: string, value: string): void {
  const row = h.sheets.get("Sozlamalar")!.data.find((r) => r[0] === label);
  if (!row) throw new Error(`no setting ${label}`);
  row[1] = value;
}
function student(id: string, name: string, chat = "555", consent = true): void {
  append(STUDENTS, [{ id, fullName: name, status: "active", phone: "", guardianName: "Dilnoza", guardianChatId: chat, consentNotify: consent }]);
}
function seed(): void {
  student("S0001", "Ali Valiyev");
  append(GROUPS, [{ id: "G0001", name: "IELTS", teacherId: "T0001", monthlyFee: 0, schedule: "Du", status: "active", billingMode: "package", packageLessons: 12, packagePrice: 600_000 }]);
  append(ENROLLMENTS, [{ id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" }]);
}
const pay = (amount: number, id = "P1"): void => append(PAYMENTS, [{ id, studentId: "S0001", paidOn: "2026-11-01", amount, method: "Naqd", note: "", voided: false }]);
const mark = (date: string, status: "present" | "absent" | "late" | "excused", studentId = "S0001"): void => {
  actions.saveAttendance({ date, groupId: "G0001", marks: [{ studentId, status, minutesLate: 0 }] });
};
const balance = (enrollmentId = "E0001") => packages.loadBalances().balances.find((b) => b.enrollmentId === enrollmentId)!;
const sold = () => read<Package>(PACKAGES);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z")); // a Monday
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("selling a package", () => {
  it("creates the charge and the package row with the default expiry", () => {
    seed();
    packages.sellPackage("E0001");
    const c = read<Charge>(CHARGES);
    expect(c).toHaveLength(1);
    expect([c[0]!.id, c[0]!.studentId, c[0]!.enrollmentId, c[0]!.month, c[0]!.amount, c[0]!.dueDate, c[0]!.note]).toEqual(["C0001", "S0001", "E0001", "2026-11-01", 600_000, "2026-11-23", "Abonement 12 dars (IELTS)"]);
    expect(sold().map((p) => [p.id, p.studentId, p.enrollmentId, p.chargeId, p.lessons, p.price, p.purchasedOn, p.expiresOn])).toEqual([["P0001", "S0001", "E0001", "C0001", 12, 600_000, "2026-11-23", "2027-01-22"]]);
  });

  it("the expiry follows the center setting; declining the confirmation sells nothing", () => {
    seed();
    setSetting("Abonement muddati (kun)", "30");
    packages.sellPackage("E0001", "2026-11-01");
    expect(sold()[0]!.expiresOn).toBe("2026-12-01");
    h.answers.push("NO");
    expect(() => packages.sellPackage("E0001")).toThrow(/Bekor qilindi/);
    expect(sold()).toHaveLength(1);
    expect(read<Charge>(CHARGES)).toHaveLength(1);
  });

  it("refuses a monthly group, a trial enrollment and a group without lessons or price", () => {
    seed();
    append(GROUPS, [{ id: "G0002", name: "Math", teacherId: "", monthlyFee: 400_000, status: "active" }]);
    append(GROUPS, [{ id: "G0003", name: "Empty", teacherId: "", monthlyFee: 0, status: "active", billingMode: "package", packageLessons: 0, packagePrice: 0 }]);
    student("S0002", "Trial Student");
    append(ENROLLMENTS, [
      { id: "E0002", studentId: "S0001", groupId: "G0002", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
      { id: "E0003", studentId: "S0002", groupId: "G0001", startedOn: "2026-11-20", endedOn: "", discountPercent: 0, status: "trial" },
      { id: "E0004", studentId: "S0001", groupId: "G0003", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
    ]);
    expect(() => packages.sellPackage("E0002")).toThrow(/abonement bilan hisoblanmaydi/);
    expect(() => packages.sellPackage("E0003")).toThrow(/faol yozilishga/);
    expect(() => packages.sellPackage("E0004")).toThrow(/to'ldirilmagan/);
    expect(() => packages.sellPackage("E9999")).toThrow(/topilmadi/);
    expect(() => packages.sellPackage("E0001", "2026-13-40")).toThrow(/Sana noto'g'ri/);
    expect(sold()).toEqual([]);
  });
});

describe("lessons from payments", () => {
  it("an unpaid package gives nothing; a payment adds lessons proportionally and never above the package", () => {
    seed();
    packages.sellPackage("E0001");
    expect(balance().balance.balance).toBe(0);
    expect(balance().need).toBe("exhausted");
    pay(299_999);
    expect(balance().balance.balance).toBe(5);
    pay(1, "P2");
    expect(balance().balance.balance).toBe(6);
    pay(900_000, "P3");
    expect(balance().balance.balance).toBe(12);
  });

  it("two packages add up", () => {
    seed();
    packages.sellPackage("E0001");
    packages.sellPackage("E0001");
    pay(1_200_000);
    expect(balance().balance.balance).toBe(24);
  });
});

describe("consumption by attendance", () => {
  it("present, late and absent use a lesson; an excused absence does not in make-up mode and creates the right", () => {
    seed();
    packages.sellPackage("E0001");
    pay(600_000);
    mark("2026-11-02", "present");
    mark("2026-11-04", "late");
    mark("2026-11-06", "absent");
    mark("2026-11-09", "excused");
    expect(balance().balance.balance).toBe(9);
    expect(read<Entitlement>(ENTITLEMENTS).map((e) => e.kind)).toEqual(["makeup"]);
  });

  it("the excused mode of the center decides; credit mode makes no money credit in a package group", () => {
    seed();
    packages.sellPackage("E0001");
    pay(600_000);
    setSetting("Sababli yo'qlik", "Kredit");
    mark("2026-11-09", "excused");
    expect(balance().balance.balance).toBe(12);
    expect(read<Entitlement>(ENTITLEMENTS)).toEqual([]);
    setSetting("Sababli yo'qlik", "Yo'q");
    expect(balance().balance.balance).toBe(11);
  });

  it("changing a mark updates the balance; removing the roll call gives the lesson back", () => {
    seed();
    packages.sellPackage("E0001");
    pay(600_000);
    mark("2026-11-09", "present");
    expect(balance().balance.balance).toBe(11);
    mark("2026-11-09", "excused");
    expect(balance().balance.balance).toBe(12);
    mark("2026-11-09", "absent");
    expect(balance().balance.balance).toBe(11);
    actions.saveAttendance({ date: "2026-11-09", groupId: "G0001", marks: [] });
    expect(balance().balance.balance).toBe(12);
  });

  it("a make-up day does not consume", () => {
    seed();
    packages.sellPackage("E0001");
    pay(600_000);
    mark("2026-11-09", "excused");
    h.prompts.push("2026-11-30");
    makeup.scheduleMakeup("R0001");
    mark("2026-11-30", "present");
    expect(balance().balance.balance).toBe(12);
  });

  it("lessons without a package are negative lessons in lessons and money; a payment clears them", () => {
    seed();
    mark("2026-11-02", "present");
    mark("2026-11-04", "present");
    mark("2026-11-06", "late");
    expect([balance().balance.balance, balance().debtLessons, balance().debtAmount, balance().need]).toEqual([-3, 3, 150_000, "debt"]);
    packages.sellPackage("E0001");
    pay(600_000);
    expect([balance().balance.balance, balance().debtLessons, balance().debtAmount, balance().need]).toEqual([9, 0, 0, "ok"]);
  });
});

describe("expiry and extension", () => {
  it("unused lessons burn at the expiry and an extension revives them", () => {
    seed();
    packages.sellPackage("E0001", "2026-09-01"); // expires 2026-10-31
    pay(600_000);
    expect(sold()[0]!.expiresOn).toBe("2026-10-31");
    expect([balance().balance.available, balance().balance.burned, balance().need]).toEqual([0, 12, "exhausted"]);
    packages.extendPackage("P0001", "2026-12-31");
    expect([balance().balance.available, balance().balance.burned, balance().balance.nextExpiry]).toEqual([12, 0, "2026-12-31"]);
  });

  it("an extension must move forward and stay within two years of the purchase", () => {
    seed();
    packages.sellPackage("E0001");
    expect(() => packages.extendPackage("P0001", "2027-01-22")).toThrow(/keyin bo'lishi kerak/);
    expect(() => packages.extendPackage("P0001", "2026-12-01")).toThrow(/keyin bo'lishi kerak/);
    expect(() => packages.extendPackage("P0001", "2029-01-01")).toThrow(/730/);
    expect(() => packages.extendPackage("P0001", "soon")).toThrow(/Sana noto'g'ri/);
    expect(() => packages.extendPackage("P9999", "2027-02-01")).toThrow(/topilmadi/);
    expect(sold()[0]!.expiresOn).toBe("2027-01-22");
  });
});

describe("admission and billing", () => {
  it("the monthly run skips package groups; accepting a trial bills nothing and lessons before it are free", () => {
    seed();
    append(GROUPS, [{ id: "G0002", name: "Math", teacherId: "", monthlyFee: 400_000, status: "active" }]);
    student("S0002", "Trial Student");
    append(ENROLLMENTS, [
      { id: "E0002", studentId: "S0001", groupId: "G0002", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
      { id: "E0003", studentId: "S0002", groupId: "G0001", startedOn: "2026-11-16", endedOn: "", discountPercent: 0, status: "trial" },
    ]);
    h.prompts.push("2026-11");
    actions.generateMonthlyCharges();
    expect(read<Charge>(CHARGES).map((c) => c.enrollmentId)).toEqual(["E0002"]);
    expect(h.alerts.at(-1)!.message).toMatch(/Abonement guruhlari .*: 1/);

    mark("2026-11-16", "present", "S0002"); // the trial lesson
    expect(balance("E0003")).toBeUndefined(); // a trial has no balance yet
    admission.acceptTrial("E0003"); // no first-month prompt in a package group
    expect(read<Charge>(CHARGES)).toHaveLength(1);
    expect(read<Enrollment>(ENROLLMENTS).find((e) => e.id === "E0003")).toMatchObject({ status: "active", acceptedOn: "2026-11-23" });
    expect(balance("E0003").balance.balance).toBe(0); // the trial lesson before acceptance was free
    mark("2026-11-23", "present", "S0002");
    expect(balance("E0003").balance.balance).toBe(-1);
  });

  it("a dropped trial keeps its lessons free", () => {
    seed();
    student("S0002", "Trial Student");
    append(ENROLLMENTS, [{ id: "E0003", studentId: "S0002", groupId: "G0001", startedOn: "2026-11-16", endedOn: "", discountPercent: 0, status: "trial" }]);
    mark("2026-11-16", "present", "S0002");
    admission.dropTrial("E0003");
    expect(read<Enrollment>(ENROLLMENTS).find((e) => e.id === "E0003")).toMatchObject({ status: "finished", droppedTrial: true });
    const finished = packages.loadBalances(["finished"]).balances.find((b) => b.enrollmentId === "E0003")!;
    expect([finished.balance.uncovered, finished.balance.balance]).toEqual([0, 0]);
  });
});

describe("broken rows", () => {
  it("are ignored and listed by the check", () => {
    seed();
    packages.sellPackage("E0001");
    pay(600_000);
    append(PACKAGES, [
      { id: "P0002", studentId: "S0001", enrollmentId: "E0001", chargeId: "C0001", lessons: 0, price: 600_000, purchasedOn: "2026-11-23", expiresOn: "2027-01-22" },
      { id: "P0003", studentId: "S0001", enrollmentId: "E0001", chargeId: "C0001", lessons: 12, price: 600_000, purchasedOn: "2026-11-23", expiresOn: "2026-11-01" },
      { id: "P0004", studentId: "S0001", enrollmentId: "E0001", chargeId: "C0999", lessons: 12, price: 600_000, purchasedOn: "2026-11-23", expiresOn: "2027-01-22" },
      { id: "P0005", studentId: "S0002", enrollmentId: "E0001", chargeId: "C0001", lessons: 12, price: 600_000, purchasedOn: "2026-11-23", expiresOn: "2027-01-22" },
    ]);
    const text = packages.checkPackages();
    for (const id of ["P0002", "P0003", "P0004", "P0005"]) expect(text).toContain(id);
    expect(text).not.toContain("P0001");
    expect(balance().balance.balance).toBe(12); // only the good package counts
  });

  it("a voided charge removes its package from the balance", () => {
    seed();
    packages.sellPackage("E0001");
    pay(600_000);
    expect(balance().balance.balance).toBe(12);
    const sh = h.sheets.get("Hisoblar")!;
    const col = (sh.data[0] as string[]).indexOf("Bekor qilingan");
    sh.data[1]![col] = "Ha";
    expect(balance().balance.balance).toBe(0);
  });
});

describe("payment-needed list and reminder drafts", () => {
  function scene(): void {
    seed();
    student("S0002", "No Consent", "556", false);
    student("S0003", "Low Lessons");
    append(ENROLLMENTS, [
      { id: "E0002", studentId: "S0002", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
      { id: "E0003", studentId: "S0003", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
    ]);
    mark("2026-11-02", "present"); // S0001: debt of 1 lesson
    packages.sellPackage("E0003");
    append(PAYMENTS, [{ id: "P9", studentId: "S0003", paidOn: "2026-11-01", amount: 600_000, method: "Naqd", note: "", voided: false }]);
    for (let i = 0; i < 10; i++) mark(`2026-10-${String(i + 1).padStart(2, "0")}`, "present", "S0003"); // 2 of 12 left
  }

  it("the status sheet lists debt, exhausted and low, worst first", () => {
    scene();
    packages.openPackageStatus();
    const rows = h.rows(packages.VIEW_SHEET).slice(1);
    expect(rows.map((r) => [r[0], r[3], r[5], r[6], r[7]])).toEqual([
      ["S0001", -1, 1, 50_000, "Qarz (manfiy dars)"],
      ["S0002", 0, 0, 0, "Tugadi"],
      ["S0003", 2, 0, 0, "Oz qoldi"],
    ]);
  });

  it("drafts follow consent, chat and cooldown; they are pending and nothing is sent", () => {
    scene();
    packages.createPackageReminderDrafts();
    const drafts = read<ReminderDraft>(DRAFTS);
    expect(drafts.map((d) => [d.studentId, d.status])).toEqual([["S0001", "pending"], ["S0003", "pending"]]);
    expect(drafts[0]!.text).toContain("1 ta darsda to'lovsiz qatnashdi (50 000 so'm)");
    expect(drafts[1]!.text).toContain("2 ta dars qoldi");
    expect(h.alerts.at(-1)!.message).toContain("1 ta: roziligi yo'q");
    packages.createPackageReminderDrafts();
    expect(read<ReminderDraft>(DRAFTS)).toHaveLength(2); // cooldown
    expect(h.alerts.at(-1)!.message).toContain("yaqinda eslatma yaratilgan");
    expect(h.fetches).toEqual([]);
  });

  it("a student without a Telegram chat is listed but gets no draft", () => {
    seed();
    student("S0002", "No Chat", "");
    append(ENROLLMENTS, [{ id: "E0002", studentId: "S0002", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" }]);
    packages.createPackageReminderDrafts();
    expect(read<ReminderDraft>(DRAFTS).map((d) => d.studentId)).toEqual(["S0001"]);
    expect(h.alerts.at(-1)!.message).toContain("Telegram ulanmagan");
  });
});
