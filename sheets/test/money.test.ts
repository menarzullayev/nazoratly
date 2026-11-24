import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { earlyOffer, familyRanks, planCharges } from "../src/domain/billing";
import { computeDebts } from "../src/domain/debt";
import type { Charge, Enrollment, Group, Payment, Refund, Student, StudentDiscount } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import * as ledger from "../src/gas/ledger";
import * as money from "../src/gas/money";
import { append, read, updateById } from "../src/gas/repo";
import { CASH_CLOSES, CHARGES, CHART_ACCOUNTS, DISCOUNT_LINES, DISCOUNTS, ENROLLMENTS, GROUPS, INSTALLMENTS, JOURNAL, PACKAGES, PAYMENTS, REFUNDS, SETTINGS_SHEET, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

// ---- domain: planning with discounts ---------------------------------------------------------------------------------
const stu = (id: string, guardian = "", extra: Partial<Student> = {}): Student => ({ id, fullName: `Student ${id}`, status: "active", guardianName: guardian, guardianChatId: "", consentNotify: false, ...extra });
const grp = (fee = 500_000, extra: Partial<Group> = {}): Group => ({ id: "G1", name: "G", teacherId: "", monthlyFee: fee, status: "active", ...extra });
const enr = (id: string, studentId: string, extra: Partial<Enrollment> = {}): Enrollment => ({ id, studentId, groupId: "G1", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active", ...extra });
const rule = (id: string, studentId: string, extra: Partial<StudentDiscount>): StudentDiscount => ({ id, studentId, enrollmentId: "", kind: "individual", percent: 0, amount: 0, payByDay: 0, reason: "test", validFrom: "2026-01-01", validTo: "", ...extra });
const plan = (a: { students: Student[]; enrollments: Enrollment[]; discounts?: StudentDiscount[]; family?: { second: number; third: number }; groups?: Group[]; charges?: Charge[]; month?: string }) =>
  planCharges({ month: a.month ?? "2026-11-01", dueDay: 10, enrollments: a.enrollments, groups: a.groups ?? [grp()], students: a.students, charges: a.charges ?? [], discounts: a.discounts, family: a.family });

describe("planCharges with lasting discounts", () => {
  it("applies scholarship, family and individual in the shared order (the golden example)", () => {
    const p = plan({
      students: [stu("S1", "Mother"), stu("S2", "Mother")],
      enrollments: [enr("E1", "S1"), enr("E2", "S2")],
      discounts: [rule("D1", "S2", { kind: "individual", percent: 5 }), rule("D2", "S2", { kind: "scholarship", percent: 50 })],
      family: { second: 10, third: 20 },
    });
    expect(p.create.map((c) => [c.studentId, c.amount, c.grossAmount])).toEqual([["S1", 500_000, 500_000], ["S2", 175_000, 500_000]]);
    expect(p.create[1]!.discounts.map((d) => [d.kind, d.amount, d.sourceId])).toEqual([["scholarship", 250_000, "D2"], ["family", 50_000, ""], ["individual", 25_000, "D1"]]);
    expect(p.discounted).toBe(1);
  });

  it("a fully free month creates no charge but keeps its lines; the enrollment discount comes first", () => {
    const p = plan({ students: [stu("S1"), stu("S2")], enrollments: [enr("E1", "S1"), enr("E2", "S2", { discountPercent: 20 })], discounts: [rule("D1", "S1", { kind: "scholarship", percent: 100 }), rule("D2", "S2", { kind: "individual", percent: 10 })] });
    expect(p.create.map((c) => [c.studentId, c.amount, c.grossAmount])).toEqual([["S2", 360_000, 400_000]]);
    expect(p.free).toEqual([{ studentId: "S1", enrollmentId: "E1", month: "2026-11-01", discounts: [expect.objectContaining({ kind: "scholarship", amount: 500_000, sourceId: "D1" })] }]);
    expect(p.skippedFree).toBe(1);
  });

  it("family ranks follow registration order inside the same guardian, strangers pay in full", () => {
    const students = [stu("S0010", "Mother"), stu("S0002", "mother "), stu("S0003", "Mother"), stu("S0004", "Other"), stu("S0005", "")];
    const ranks = familyRanks(students, new Set(students.map((s) => s.id)));
    expect([...ranks.entries()].sort()).toEqual([["S0002", 1], ["S0003", 2], ["S0004", 1], ["S0005", 1], ["S0010", 3]]);
    const p = plan({ students, enrollments: students.map((s, i) => enr(`E${i}`, s.id)), family: { second: 10, third: 20 }, groups: [grp(100_000)] });
    expect(Object.fromEntries(p.create.map((c) => [c.studentId, c.amount]))).toEqual({ S0010: 80_000, S0002: 100_000, S0003: 90_000, S0004: 100_000, S0005: 100_000 });
  });

  it("only billable children count for the family rank (frozen and zero-fee ones do not)", () => {
    const p = plan({
      students: [stu("S1", "M"), stu("S2", "M"), stu("S3", "M")],
      enrollments: [enr("E1", "S1", { status: "frozen" }), enr("E2", "S2"), enr("E3", "S3")],
      family: { second: 10, third: 20 },
    });
    expect(p.create.map((c) => [c.studentId, c.amount])).toEqual([["S2", 500_000], ["S3", 450_000]]);
  });

  it("rules count only inside their validity and enrollment scope", () => {
    const p = plan({
      students: [stu("S1")],
      enrollments: [enr("E1", "S1")],
      discounts: [
        rule("D1", "S1", { percent: 10, validFrom: "2026-12-01" }), // not yet
        rule("D2", "S1", { percent: 10, validFrom: "2026-01-01", validTo: "2026-10-31" }), // over
        rule("D3", "S1", { percent: 10, enrollmentId: "E9" }), // another enrollment
        rule("D4", "S1", { percent: 10, validFrom: "2026-11-30" }), // starts on the last day of the month: counts
        rule("D5", "S1", { percent: 10, validTo: "2026-11-01" }), // ends on the first day: counts
      ],
    });
    expect(p.create[0]!.discounts.map((d) => d.sourceId)).toEqual(["D4", "D5"]);
    expect(p.create[0]!.amount).toBe(400_000);
  });

  it("a discount never exceeds the fee, an existing charge is skipped, the best early offer is kept", () => {
    const existing: Charge = { id: "C1", studentId: "S2", enrollmentId: "E2", month: "2026-11-01", amount: 1, dueDate: "2026-11-10", voided: false, note: "" };
    const p = plan({
      students: [stu("S1"), stu("S2")],
      enrollments: [enr("E1", "S1"), enr("E2", "S2")],
      charges: [existing],
      discounts: [rule("D1", "S1", { amount: 900_000 }), rule("D2", "S2", { kind: "early_pay", percent: 3, payByDay: 10 }), rule("D3", "S2", { kind: "early_pay", percent: 6, payByDay: 4 })],
    });
    expect(p.skippedFree).toBe(1);
    expect(p.skippedExisting).toBe(1);
    const q = plan({ students: [stu("S2")], enrollments: [enr("E2", "S2")], discounts: [rule("D2", "S2", { kind: "early_pay", percent: 3, payByDay: 10 }), rule("D3", "S2", { kind: "early_pay", percent: 6, payByDay: 4 })] });
    expect(q.create[0]).toMatchObject({ earlyPercent: 6, earlyDay: 4, earlyRuleId: "D3", amount: 500_000 });
    expect(earlyOffer(q.create[0]!, 500_000)).toEqual({ discount: 30_000, payBy: "2026-11-04" });
    expect(earlyOffer(q.create[0]!, 1)).toEqual({ discount: 0, payBy: "" });
    expect(earlyOffer({ month: "2026-11-01", earlyPercent: 0, earlyDay: 0 }, 500_000)).toEqual({ discount: 0, payBy: "" });
  });
});

// ---- domain: refunds and early payment in the debt computation ---------------------------------------------------------
const charge = (id: string, amount: number, dueDate: string, extra: Partial<Charge> = {}): Charge => ({ id, studentId: "S1", enrollmentId: "E1", month: `${dueDate.slice(0, 8)}01`, amount, dueDate, voided: false, note: "", ...extra });
const paid = (id: string, amount: number, paidOn: string): Payment => ({ id, studentId: "S1", paidOn, amount, method: "Naqd", voided: false, note: "" });
const refund = (extra: Partial<Refund>): Refund => ({ id: "R1", studentId: "S1", date: "2026-11-20", kind: "wrong_payment", payout: "cash", amount: 0, chargeReduction: 0, chargeId: "", paymentId: "", packageId: "", leftOn: "", reason: "test", note: "", ...extra });

describe("computeDebts with refunds and early discounts", () => {
  it("cash given back reopens the debt; credit payouts keep the money; the charge reduction shrinks the debt", () => {
    const c = [charge("C1", 300_000, "2026-11-10")];
    const p = [paid("P1", 300_000, "2026-11-02")];
    const base = computeDebts(c, p, "2026-11-20").students[0]!;
    expect([base.outstanding, base.credit]).toEqual([0, 0]);
    const cash = computeDebts(c, p, "2026-11-20", [], [refund({ amount: 100_000 })]).students[0]!;
    expect([cash.outstanding, cash.credit, cash.paid]).toEqual([100_000, 0, 200_000]);
    const leaving = computeDebts(c, p, "2026-11-20", [], [refund({ kind: "leaving", payout: "cash", amount: 200_000, chargeReduction: 200_000, chargeId: "C1" })]).students[0]!;
    expect([leaving.charged, leaving.outstanding, leaving.credit]).toEqual([100_000, 0, 0]);
    const kept = computeDebts(c, p, "2026-11-20", [], [refund({ kind: "leaving", payout: "credit", amount: 200_000, chargeReduction: 200_000, chargeId: "C1" })]).students[0]!;
    expect([kept.charged, kept.outstanding, kept.credit]).toEqual([100_000, 0, 200_000]);
  });

  it("early discount: earned on time, lost when late, shown as a granted flag", () => {
    const c = [charge("C1", 500_000, "2026-11-10", { earlyDiscount: 25_000, earlyPayBy: "2026-11-05" })];
    const onTime = computeDebts(c, [paid("P1", 475_000, "2026-11-05")], "2026-11-20");
    expect([onTime.balances[0]!.amount, onTime.balances[0]!.outstanding, onTime.balances[0]!.earlyGranted]).toEqual([475_000, 0, true]);
    const late = computeDebts(c, [paid("P1", 475_000, "2026-11-06")], "2026-11-20");
    expect([late.balances[0]!.amount, late.balances[0]!.outstanding, late.balances[0]!.earlyGranted]).toEqual([500_000, 25_000, false]);
    const split = computeDebts(c, [paid("P1", 200_000, "2026-11-02"), paid("P2", 275_000, "2026-11-09")], "2026-11-20");
    expect(split.balances[0]!.earlyGranted).toBe(false);
    const twoOnTime = computeDebts(c, [paid("P1", 400_000, "2026-11-01"), paid("P2", 75_000, "2026-11-05")], "2026-11-20");
    expect([twoOnTime.balances[0]!.earlyGranted, twoOnTime.balances[0]!.outstanding]).toEqual([true, 0]);
    const surplus = computeDebts(c, [paid("P1", 500_000, "2026-11-03")], "2026-11-20");
    expect([surplus.balances[0]!.amount, surplus.students[0]!.credit]).toEqual([475_000, 25_000]);
  });

  it("an earlier charge uses the oldest money first, so a later offer counts on what is left", () => {
    const c = [charge("C0", 100_000, "2026-10-10"), charge("C1", 500_000, "2026-11-10", { earlyDiscount: 25_000, earlyPayBy: "2026-11-05" })];
    // October took 100000 of the 575000 paid on 2026-11-01 and 2026-11-04: the rest (475000) still covers the November offer
    const ok = computeDebts(c, [paid("P1", 300_000, "2026-11-01"), paid("P2", 275_000, "2026-11-04")], "2026-11-20");
    expect(ok.balances.find((b) => b.id === "C1")!.earlyGranted).toBe(true);
    const short = computeDebts(c, [paid("P1", 300_000, "2026-11-01"), paid("P2", 175_000, "2026-11-04")], "2026-11-20");
    expect(short.balances.find((b) => b.id === "C1")!.earlyGranted).toBe(false);
  });

  it("a cash refund takes the newest money, which can lose the early discount", () => {
    const c = [charge("C1", 500_000, "2026-11-10", { earlyDiscount: 25_000, earlyPayBy: "2026-11-05" })];
    const p = [paid("P1", 400_000, "2026-11-02"), paid("P2", 75_000, "2026-11-04")];
    expect(computeDebts(c, p, "2026-11-20").balances[0]!.earlyGranted).toBe(true);
    const r = computeDebts(c, p, "2026-11-20", [], [refund({ amount: 50_000 })]);
    expect([r.balances[0]!.earlyGranted, r.balances[0]!.outstanding]).toEqual([false, 75_000]);
  });

  it("a charge with a payment plan never gets the early discount; no penalty ever grows an overdue charge", () => {
    const c = [charge("C1", 500_000, "2026-11-10", { earlyDiscount: 25_000, earlyPayBy: "2026-11-05" })];
    const plan = [{ chargeId: "C1", seq: 1, dueDate: "2026-11-10", amount: 250_000 }, { chargeId: "C1", seq: 2, dueDate: "2026-12-10", amount: 250_000 }];
    const r = computeDebts(c, [paid("P1", 475_000, "2026-11-04")], "2026-11-20", plan);
    expect([r.balances[0]!.earlyGranted, r.balances[0]!.amount, r.balances[0]!.outstanding]).toEqual([false, 500_000, 25_000]);
    const overdue = computeDebts([charge("C1", 300_000, "2026-01-10")], [], "2026-11-20");
    expect([overdue.balances[0]!.amount, overdue.balances[0]!.overdue, overdue.students[0]!.outstanding]).toEqual([300_000, 300_000, 300_000]);
  });
});

// ---- the Apps Script adapter -------------------------------------------------------------------------------------------------
let h: Harness;
const journal = () => read<ledger.JournalRow>(JOURNAL);
const entriesOf = (type: string) => journal().filter((l) => l.sourceType === type);
const shapeOf = (type: string) => entriesOf(type).map((l) => [l.account, l.debit, l.credit]);
const setSetting = (label: string, value: string): void => {
  h.sheets.get(SETTINGS_SHEET)!.data.find((r) => r[0] === label)![1] = value;
};

function seed(fee = 300_000): void {
  append(STUDENTS, [{ id: "S0001", fullName: "Ali Valiyev", status: "active", guardianName: "Dilnoza", guardianChatId: "", consentNotify: false } satisfies Student]);
  append(GROUPS, [{ id: "G0001", name: "Ingliz", teacherId: "", monthlyFee: fee, status: "active" } satisfies Group]);
  append(ENROLLMENTS, [{ id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" } satisfies Enrollment]);
}
const generate = (month = "2026-11"): string => {
  h.prompts.push(month);
  actions.generateMonthlyCharges();
  return h.alerts[h.alerts.length - 1]!.message;
};
const charges = () => read<Charge>(CHARGES);
const pay = (id: string, amount: number, paidOn: string, method = "Naqd"): void => append(PAYMENTS, [{ id, studentId: "S0001", paidOn, amount, method, voided: false, note: "" } satisfies Payment]);
const debt = () => computeDebts(charges(), read<Payment>(PAYMENTS), "2026-11-23", [], read<Refund>(REFUNDS)).students[0]!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("workbook setup", () => {
  it("creates the new sheets, columns, chart accounts and settings", () => {
    for (const def of [DISCOUNTS, DISCOUNT_LINES, REFUNDS, CASH_CLOSES]) expect(h.rows(def.sheet)[0]).toEqual(def.cols.map((c) => c.header));
    expect(h.rows("Hisoblar")[0]).toEqual(expect.arrayContaining(["Chegirmasiz summa", "Erta to'lov chegirmasi", "Erta to'lov muddati"]));
    expect(read<ledger.ChartRow>(CHART_ACCOUNTS).map((a) => a.code)).toEqual(expect.arrayContaining(["4200", "5900"]));
    expect(h.protections("Qaytarishlar")).toHaveLength(1); // refunds and cash closes are script-only like the journal
    expect(h.protections("Kassa smenalari")).toHaveLength(1);
  });

  it("adds the new chart accounts to a chart that already exists, without touching the journal", () => {
    const sh = h.sheet("Hisob rejasi");
    sh.data = sh.data.filter((r, i) => i === 0 || (r[0] !== "4200" && r[0] !== "5900"));
    ledger.ensureChart();
    const codes = h.rows("Hisob rejasi").slice(1).map((r) => r[0]);
    expect(codes.filter((c) => c === "4200" || c === "5900")).toHaveLength(2);
    ledger.ensureChart(); // idempotent
    expect(h.rows("Hisob rejasi").slice(1).map((r) => r[0]).filter((c) => c === "4200")).toHaveLength(1);
  });
});

describe("discount rules", () => {
  beforeEach(() => seed());

  it("validates every rule like the API does", () => {
    const ok = { studentId: "S0001", kind: "individual", percent: 10, reason: "valid reason" } as const;
    const bad: [Partial<money.DiscountInput>, RegExp][] = [
      [{ percent: 10, amount: 5000 }, /Faqat bittasini/],
      [{ percent: undefined }, /Faqat bittasini/],
      [{ percent: 0 }, /Faqat bittasini/],
      [{ kind: "scholarship", percent: undefined, amount: 5000 }, /Stipendiya foizda/],
      [{ kind: "early_pay", payByDay: undefined }, /Muddat kuni 1-28/],
      [{ kind: "early_pay", percent: 100, payByDay: 5 }, /100 dan kam/],
      [{ kind: "early_pay", payByDay: 29 }, /1-28/],
      [{ payByDay: 5 }, /faqat erta to'lov/],
      [{ percent: 100.01 }, /100 dan oshmaydigan/],
      [{ percent: 12.345 }, /2 xonali/],
      [{ percent: undefined, amount: 1.5 }, /butun so'm/],
      [{ reason: "x" }, /Sabab/],
      [{ validFrom: "2026-11-01", validTo: "2026-10-01" }, /Tugash sanasi/],
      [{ validFrom: "2026-13-01" }, /Sana noto'g'ri/],
      [{ studentId: "S9999" }, /topilmadi/],
      [{ enrollmentId: "E9999" }, /Yozilish topilmadi/],
      [{ kind: "gift" as never }, /turi noto'g'ri/],
    ];
    for (const [patch, re] of bad) expect(() => money.createDiscount({ ...ok, ...patch } as money.DiscountInput), JSON.stringify(patch)).toThrow(re);
    expect(read<StudentDiscount>(DISCOUNTS)).toHaveLength(0);
  });

  it("adds, ends and never extends a rule", () => {
    const id = money.createDiscount({ studentId: "S0001", kind: "scholarship", percent: 50, reason: "olympiad winner" });
    expect(id).toBe("D0001");
    expect(read<StudentDiscount>(DISCOUNTS)[0]).toMatchObject({ kind: "scholarship", percent: 50, amount: 0, validFrom: "2026-11-23", validTo: "" });
    money.endDiscount(id, "2026-12-31");
    expect(read<StudentDiscount>(DISCOUNTS)[0]!.validTo).toBe("2026-12-31");
    expect(() => money.endDiscount(id, "2027-06-30")).toThrow(/uzaytirib bo'lmaydi/);
    expect(() => money.endDiscount(id, "2026-01-01")).toThrow(/boshlanishdan oldin/);
    expect(() => money.endDiscount("D9999", "2026-12-31")).toThrow(/topilmadi/);
    money.endDiscount(id, "2026-12-01");
    expect(read<StudentDiscount>(DISCOUNTS)[0]!.validTo).toBe("2026-12-01");
  });

  it("generation writes the reduced charge, the lines, the early offer, and is idempotent", () => {
    setSetting("Oilaviy chegirma: 2-farzand (%)", "10");
    append(STUDENTS, [{ id: "S0002", fullName: "Vali Valiyev", status: "active", guardianName: "dilnoza", guardianChatId: "", consentNotify: false } satisfies Student]);
    append(ENROLLMENTS, [{ id: "E0002", studentId: "S0002", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" } satisfies Enrollment]);
    money.createDiscount({ studentId: "S0002", kind: "early_pay", percent: 5, payByDay: 5, reason: "pays early" });
    money.createDiscount({ studentId: "S0001", kind: "individual", amount: 50_000, reason: "staff relative" });
    const msg = generate();
    expect(msg).toContain("2 ta yangi hisob");
    expect(msg).toContain("chegirma bilan: 2");
    expect(charges().map((c) => [c.studentId, c.amount, c.grossAmount, c.earlyDiscount, c.earlyPayBy])).toEqual([
      ["S0001", 250_000, 300_000, 0, ""],
      ["S0002", 270_000, 300_000, 13_500, "2026-11-05"],
    ]);
    expect(read<{ studentId: string; kind: string; amount: number; chargeId: string; sourceId: string }>(DISCOUNT_LINES).map((l) => [l.studentId, l.kind, l.amount, l.chargeId, l.sourceId])).toEqual([
      ["S0001", "individual", 50_000, "C0001", "D0002"],
      ["S0002", "family", 30_000, "C0002", ""],
    ]);
    expect(generate()).toContain("Avval yaratilgan: 2");
    expect(charges()).toHaveLength(2);
    expect(read(DISCOUNT_LINES)).toHaveLength(2);
    // the early discount is earned by paying on time and shows in the report with the others
    append(PAYMENTS, [{ id: "P1", studentId: "S0002", paidOn: "2026-11-04", amount: 256_500, method: "Naqd", voided: false, note: "" } satisfies Payment]);
    const rep = money.discountReport("2026-11-15");
    expect(rep.rows.map((r) => [r.kind, r.lines, r.students, r.amount])).toEqual([["early_pay", 1, 1, 13_500], ["family", 1, 1, 30_000], ["individual", 1, 1, 50_000]]);
    expect([rep.total, rep.scholarshipTotal, rep.otherTotal]).toEqual([93_500, 0, 93_500]);
  });

  it("a fully free month appears in the report as a scholarship and creates no charge", () => {
    money.createDiscount({ studentId: "S0001", kind: "scholarship", percent: 100, reason: "need-based, full" });
    expect(generate()).toContain("To'liq bepul (stipendiya, hisob yaratilmadi): 1");
    expect(charges()).toHaveLength(0);
    generate();
    expect(read(DISCOUNT_LINES)).toHaveLength(1);
    const rep = money.discountReport("2026-11-01");
    expect([rep.scholarshipTotal, rep.otherTotal, rep.total]).toEqual([300_000, 0, 300_000]);
    expect(() => money.discountReport("nonsense")).toThrow();
  });

  it("there is no late-payment penalty: overdue charges keep their amount and nothing is added", () => {
    generate("2026-01");
    generate("2026-02");
    generate("2026-03");
    expect(charges().map((c) => c.amount)).toEqual([300_000, 300_000, 300_000]);
    const d = debt();
    expect([d.outstanding, d.overdue, d.charged]).toEqual([900_000, 900_000, 900_000]);
    expect(read<Charge>(CHARGES).every((c) => c.note.startsWith("O'qish haqi"))).toBe(true);
  });
});

describe("refunds", () => {
  beforeEach(() => {
    seed();
    generate();
    pay("P0001", 300_000, "2026-11-02");
    ledger.syncLedger();
  });
  const base = { studentId: "S0001", reason: "owner decision" } as const;

  it("wrong payment: cash goes back, the debt reopens and the journal gets the entry", () => {
    expect(money.planRefund({ ...base, kind: "wrong_payment", payout: "cash", paymentId: "P0001", amount: 100_000 })).toMatchObject({ money: 100_000, available: 300_000, errors: [] });
    const r = money.makeRefund({ ...base, kind: "wrong_payment", payout: "cash", paymentId: "P0001", amount: 100_000 });
    expect(r.id).toBe("R0001");
    expect(r.ledger).toBe("");
    expect(shapeOf("refund")).toEqual([["4200", 100_000, 0], ["1000", 0, 100_000]]);
    expect([debt().outstanding, debt().paid]).toEqual([100_000, 200_000]);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    expect(ledger.pendingList()).toEqual([]);
    // the rest, to the bank, and nothing more
    const bank = money.makeRefund({ ...base, kind: "wrong_payment", payout: "bank", paymentId: "P0001" });
    expect(bank.plan.money).toBe(200_000);
    expect(shapeOf("refund").slice(2)).toEqual([["4200", 200_000, 0], ["1010", 0, 200_000]]);
    expect(() => money.makeRefund({ ...base, kind: "wrong_payment", payout: "cash", paymentId: "P0001" })).toThrow(/summa musbat/);
  });

  it("wrong payment: every negative case is refused and nothing is written", () => {
    append(STUDENTS, [{ id: "S0002", fullName: "Other", status: "active", guardianName: "", guardianChatId: "", consentNotify: false } satisfies Student]);
    const refusals: [Partial<money.RefundInput>, RegExp][] = [
      [{ amount: 300_001 }, /oshib ketdi/],
      [{ amount: 0 }, /summa musbat/],
      [{ amount: -5 }, /summa musbat/],
      [{ payout: "credit" }, /to'lov usuli/],
      [{ paymentId: "P9999" }, /To'lov topilmadi/],
      [{ studentId: "S0002" }, /boshqa o'quvchiniki/],
      [{ studentId: "S9999" }, /O'quvchi topilmadi/],
      [{ reason: "x" }, /Sabab/],
      [{ date: "2999-01-01" }, /kelajak/],
      [{ date: "nope" }, /Sana noto'g'ri/],
    ];
    for (const [patch, re] of refusals) expect(() => money.makeRefund({ ...base, kind: "wrong_payment", payout: "cash", paymentId: "P0001", amount: 1000, ...patch }), JSON.stringify(patch)).toThrow(re);
    expect(read(REFUNDS)).toHaveLength(0);
    expect(entriesOf("refund")).toHaveLength(0);
  });

  it("leaving: the month is charged for the days attended, the rest goes back", () => {
    const pre = money.planRefund({ ...base, kind: "leaving", payout: "cash", chargeId: "C0001", leftOn: "2026-11-10" });
    expect(pre).toMatchObject({ money: 200_000, reduction: 200_000, errors: [] });
    money.makeRefund({ ...base, kind: "leaving", payout: "cash", chargeId: "C0001", leftOn: "2026-11-10" });
    expect(read<Refund>(REFUNDS)[0]).toMatchObject({ kind: "leaving", amount: 200_000, chargeReduction: 200_000, chargeId: "C0001", leftOn: "2026-11-10" });
    const d = debt();
    expect([d.charged, d.outstanding, d.credit]).toEqual([100_000, 0, 0]);
    expect(shapeOf("refund")).toEqual([["4200", 200_000, 0], ["1000", 0, 200_000]]);
    expect(() => money.makeRefund({ ...base, kind: "leaving", payout: "cash", chargeId: "C0001", leftOn: "2026-11-20" })).toThrow(/allaqachon/);
  });

  it("leaving with the money kept as credit moves no cash and posts nothing", () => {
    money.makeRefund({ ...base, kind: "leaving", payout: "credit", chargeId: "C0001", leftOn: "2026-11-10" });
    expect(entriesOf("refund")).toEqual([]);
    const d = debt();
    expect([d.charged, d.outstanding, d.credit]).toEqual([100_000, 0, 200_000]);
    expect(ledger.cashBookBalance("2026-11-23").balance).toBe(300_000);
  });

  it("leaving edge cases: the whole month attended, and a month nobody paid", () => {
    expect(() => money.makeRefund({ ...base, kind: "leaving", payout: "cash", chargeId: "C0001", leftOn: "2026-11-30" })).toThrow(/to'liq o'qigan/);
    append(STUDENTS, [{ id: "S0002", fullName: "Vali Valiyev", status: "active", guardianName: "", guardianChatId: "", consentNotify: false } satisfies Student]);
    append(ENROLLMENTS, [{ id: "E0002", studentId: "S0002", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" } satisfies Enrollment]);
    generate();
    const unpaid = charges().find((c) => c.studentId === "S0002")!;
    expect(() => money.makeRefund({ studentId: "S0002", reason: "owner decision", kind: "leaving", payout: "cash", chargeId: unpaid.id, leftOn: "2026-11-10" })).toThrow(/qaytariladigan pul yo'q/);
    expect(read(REFUNDS)).toHaveLength(0);
  });

  it("leaving before the month began refunds everything paid and empties the charge", () => {
    money.makeRefund({ ...base, kind: "leaving", payout: "cash", chargeId: "C0001", leftOn: "2026-10-20" });
    const d = debt();
    expect([d.charged, d.outstanding, d.credit, d.paid]).toEqual([0, 0, 0, 0]);
  });

  it("to credit: the paid money becomes credit and the charge shrinks", () => {
    expect(() => money.makeRefund({ ...base, kind: "to_credit", payout: "cash", chargeId: "C0001", amount: 1000 })).toThrow(/to'lov usuli/);
    expect(() => money.makeRefund({ ...base, kind: "to_credit", payout: "credit", chargeId: "C0001", amount: 300_001 })).toThrow(/oshib ketdi/);
    expect(() => money.makeRefund({ ...base, kind: "to_credit", payout: "credit", chargeId: "C0001" })).toThrow(/summa musbat/);
    money.makeRefund({ ...base, kind: "to_credit", payout: "credit", chargeId: "C0001", amount: 100_000 });
    const d = debt();
    expect([d.charged, d.outstanding, d.credit]).toEqual([200_000, 0, 100_000]);
    expect(entriesOf("refund")).toEqual([]);
  });

  it("another student's charge, a charge with a payment plan and a voided charge are refused", () => {
    append(STUDENTS, [{ id: "S0002", fullName: "Other", status: "active", guardianName: "", guardianChatId: "", consentNotify: false } satisfies Student]);
    expect(() => money.makeRefund({ studentId: "S0002", reason: "owner decision", kind: "to_credit", payout: "credit", chargeId: "C0001", amount: 1 })).toThrow(/boshqa o'quvchiniki/);
    expect(() => money.makeRefund({ ...base, kind: "to_credit", payout: "credit", chargeId: "C9999", amount: 1 })).toThrow(/Hisob topilmadi/);
    append(INSTALLMENTS, [{ chargeId: "C0001", seq: 1, dueDate: "2026-11-10", amount: 150_000 }, { chargeId: "C0001", seq: 2, dueDate: "2026-12-10", amount: 150_000 }]);
    expect(() => money.makeRefund({ ...base, kind: "to_credit", payout: "credit", chargeId: "C0001", amount: 1 })).toThrow(/to'lov rejasi/);
    updateById(CHARGES, "id", "C0001", { voided: true });
    expect(() => money.makeRefund({ ...base, kind: "to_credit", payout: "credit", chargeId: "C0001", amount: 1 })).toThrow(/bekor qilingan/);
    expect(read(REFUNDS)).toHaveLength(0);
  });

  it("package remainder: unused lessons are refunded and the used ones stay covered", () => {
    append(GROUPS, [{ id: "G0002", name: "Abon", teacherId: "", monthlyFee: 0, status: "active", billingMode: "package", packageLessons: 8, packagePrice: 400_000 } satisfies Group]);
    append(ENROLLMENTS, [{ id: "E0002", studentId: "S0001", groupId: "G0002", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" } satisfies Enrollment]);
    append(CHARGES, [{ id: "C0050", studentId: "S0001", enrollmentId: "E0002", month: "2026-11-01", amount: 400_000, dueDate: "2026-11-20", voided: false, note: "Abonement" } satisfies Charge]);
    append(PACKAGES, [{ id: "A0001", studentId: "S0001", enrollmentId: "E0002", chargeId: "C0050", lessons: 8, price: 400_000, purchasedOn: "2026-11-05", expiresOn: "2027-01-05" }]);
    pay("P0002", 400_000, "2026-11-06");
    ledger.syncLedger();
    for (const d of ["2026-11-09", "2026-11-10", "2026-11-11"]) actions.saveAttendance({ date: d, groupId: "G0002", marks: [{ studentId: "S0001", status: "present", minutesLate: 0 }] });
    const plan = money.planRefund({ ...base, kind: "package_remainder", payout: "cash", packageId: "A0001" });
    expect(plan).toMatchObject({ money: 250_000, reduction: 250_000, errors: [] });
    money.makeRefund({ ...base, kind: "package_remainder", payout: "cash", packageId: "A0001" });
    expect(shapeOf("refund")).toEqual([["4200", 250_000, 0], ["1000", 0, 250_000]]);
    expect(() => money.makeRefund({ ...base, kind: "package_remainder", payout: "cash", packageId: "A0001" })).toThrow(/qaytariladigan pul yo'q/);
    expect(() => money.makeRefund({ ...base, kind: "leaving", payout: "cash", chargeId: "C0050", leftOn: "2026-11-10" })).toThrow(/Abonement qoldig'i/);
  });

  it("demo students' refunds never reach the journal", () => {
    updateById(STUDENTS, "id", "S0001", { demo: true });
    const before = journal().length;
    money.makeRefund({ ...base, kind: "wrong_payment", payout: "cash", paymentId: "P0001", amount: 1000 });
    expect(journal()).toHaveLength(before);
    expect(read<Refund & { demo: boolean }>(REFUNDS)[0]!.demo).toBe(true);
  });

  it("a closed month refuses a cash refund dated inside it, a credit refund is not a journal matter", () => {
    ledger.postEntries([{ date: "2026-09-10", memo: "old", sourceType: "manual", sourceKey: "", lines: [["1000", 100, 0], ["3000", 0, 100]] }]);
    ledger.closePeriod("2026-09");
    expect(() => money.makeRefund({ ...base, kind: "wrong_payment", payout: "cash", paymentId: "P0001", amount: 1000, date: "2026-09-15" })).toThrow(/yopilgan/);
    expect(read(REFUNDS)).toHaveLength(0);
    money.makeRefund({ ...base, kind: "to_credit", payout: "credit", chargeId: "C0001", amount: 1000, date: "2026-09-15" });
    expect(read(REFUNDS)).toHaveLength(1);
  });
});

describe("daily cash close", () => {
  beforeEach(() => {
    seed();
    pay("P0001", 300_000, "2026-11-23");
    ledger.syncLedger();
  });

  it("previews the books, closes shifts and keeps the journal head", () => {
    const p = money.cashClosePreview();
    expect(p).toMatchObject({ date: "2026-11-23", bookBalance: 300_000, cashIn: 300_000, cashOut: 0, nextShift: 1 });
    const first = money.closeCash({ counted: 300_000 });
    expect(first).toMatchObject({ shiftNo: 1, difference: 0, status: "ok", entryNo: 0 });
    expect(read(CASH_CLOSES)[0]).toMatchObject({ id: "M0001", counted: 300_000, bookBalance: 300_000, difference: 0, journalSeq: 2, entryNo: 0 });
    expect(money.closeCash({ counted: 300_000 }).shiftNo).toBe(2);
    expect(entriesOf("cash_close")).toEqual([]);
  });

  it("a difference needs a note and is saved only with it", () => {
    for (const note of [undefined, "", "   "]) expect(() => money.closeCash({ counted: 280_000, note }), String(note)).toThrow(/izoh kiritish majburiy/);
    expect(read(CASH_CLOSES)).toHaveLength(0);
    expect(money.closeCash({ counted: 280_000, note: "sinf puli" })).toMatchObject({ difference: -20_000, status: "short", entryNo: 0 });
    expect(money.closeCash({ counted: 310_000, note: "qaytim berilmadi" })).toMatchObject({ difference: 10_000, status: "over" });
    expect(entriesOf("cash_close")).toEqual([]); // not posted unless asked
  });

  it("posting the difference books it and brings the books to the drawer", () => {
    const short = money.closeCash({ counted: 280_000, note: "kamomad", postDifference: true });
    expect(short.entryNo).toBeGreaterThan(0);
    expect(shapeOf("cash_close")).toEqual([["5900", 20_000, 0], ["1000", 0, 20_000]]);
    expect(money.cashClosePreview().bookBalance).toBe(280_000);
    money.closeCash({ counted: 290_000, note: "topilgan pul", postDifference: true });
    expect(shapeOf("cash_close").slice(2)).toEqual([["1000", 10_000, 0], ["4100", 0, 10_000]]);
    expect(ledger.verifyJournal().verdict.ok).toBe(true);
    expect(() => money.closeCash({ counted: 290_000, postDifference: true })).toThrow(/farq yo'q/);
  });

  it("refuses bad input, future dates and a difference that cannot be posted into a closed month", () => {
    for (const counted of [-1, 1.5, Number.NaN]) expect(() => money.closeCash({ counted }), String(counted)).toThrow(/Sanalgan summa/);
    expect(() => money.closeCash({ counted: 1, date: "2026-11-24" })).toThrow(/kelajak/);
    expect(() => money.closeCash({ counted: 1, date: "nope" })).toThrow(/Sana noto'g'ri/);
    const early = money.closeCash({ counted: 0, date: "2026-11-22" });
    expect(early.status).toBe("ok"); // the payment came on the 23rd: the books were empty on the 22nd
    ledger.postEntries([{ date: "2026-09-10", memo: "old", sourceType: "manual", sourceKey: "", lines: [["1000", 100, 0], ["3000", 0, 100]] }]);
    ledger.closePeriod("2026-09");
    const before = read(CASH_CLOSES).length;
    expect(() => money.closeCash({ counted: 0, date: "2026-09-30", note: "late", postDifference: true })).toThrow(/yopilgan/);
    expect(read(CASH_CLOSES)).toHaveLength(before); // a failed posting saves no close
  });

  it("cash given back lowers the expected cash", () => {
    generate();
    money.makeRefund({ studentId: "S0001", reason: "owner decision", kind: "wrong_payment", payout: "cash", paymentId: "P0001", amount: 100_000 });
    expect(money.cashClosePreview()).toMatchObject({ bookBalance: 200_000, cashIn: 300_000, cashOut: 100_000 });
  });
});

describe("menus", () => {
  beforeEach(() => {
    seed();
    generate();
    pay("P0001", 300_000, "2026-11-23");
    ledger.syncLedger();
  });

  it("the cash close menu asks for the count, the note and whether to post the difference", () => {
    h.prompts.push("280000", "sinf puli");
    h.answers.push("NO");
    money.menu.cashClose();
    expect(read(CASH_CLOSES)).toHaveLength(1);
    expect(read<{ difference: number; entryNo: number; note: string }>(CASH_CLOSES)[0]).toMatchObject({ difference: -20_000, entryNo: 0, note: "sinf puli" });
    expect(h.alerts[h.alerts.length - 1]!.message).toContain("Smena 1 yopildi");
    h.prompts.push("300000");
    money.menu.cashClose(); // the books still say 300000 (nothing was posted): balanced
    expect(read(CASH_CLOSES)).toHaveLength(2);
    h.prompts.push("1", "");
    money.menu.cashClose(); // a difference without a note is refused with a readable dialog
    expect(h.alerts[h.alerts.length - 1]!.message).toMatch(/izoh kiritish majburiy/);
    expect(read(CASH_CLOSES)).toHaveLength(2);
    money.menu.cashStatus();
    expect(h.alerts[h.alerts.length - 1]!.message).toContain("Keyingi smena: 3");
  });

  it("the refund menu confirms before writing, and the discount menus work through prompts", () => {
    h.prompts.push("kredit", "S0001", "C0001", "100000", "owner decision");
    h.answers.push("NO");
    money.menu.refund();
    expect(read(REFUNDS)).toHaveLength(0); // declined
    h.prompts.push("kredit", "S0001", "C0001", "100000", "owner decision");
    money.menu.refund();
    expect(read(REFUNDS)).toHaveLength(1);
    h.prompts.push("S0001", "stipendiya", "50", "olympiad winner", "");
    money.menu.addDiscount();
    expect(read<StudentDiscount>(DISCOUNTS)[0]).toMatchObject({ studentId: "S0001", kind: "scholarship", percent: 50 });
    h.prompts.push("D0001");
    money.menu.endDiscount();
    expect(read<StudentDiscount>(DISCOUNTS)[0]!.validTo).toBe("2026-11-23");
    h.prompts.push("2026-11");
    money.menu.discountReport();
    expect(h.rows("Buxgalteriya hisoboti")[0]![0]).toBe("Chegirmalar hisoboti, 2026-11");
  });
});
