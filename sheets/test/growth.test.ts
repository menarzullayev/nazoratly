import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Charge, Entitlement, Lead, LeadLogRow, Payment, Promo, PromoUse, Referral, SourceCostRow } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import * as growth from "../src/gas/growth";
import { append, read } from "../src/gas/repo";
import { CHARGES, DRAFTS, ENROLLMENTS, ENTITLEMENTS, GROUPS, LEADS, LEAD_LOG, PAYMENTS, PROMOS, PROMO_USES, REFERRALS, SOURCE_COSTS, STUDENTS } from "../src/gas/schema";
import { readSettings } from "../src/gas/settings";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;

function setSetting(label: string, value: string): void {
  const row = h.sheets.get("Sozlamalar")!.data.find((r) => r[0] === label);
  if (!row) throw new Error(`no setting ${label}`);
  row[1] = value;
}

const student = (id: string, name: string) => ({ id, fullName: name, status: "active", phone: "", guardianName: "", guardianChatId: "", consentNotify: false });

/** S0001 (the referrer) studies in G0001, a Monday group of 600 000; S0002 is the invited student in G0002 (500 000). */
function seed(): void {
  append(STUDENTS, [student("S0001", "Ali Valiyev"), student("S0002", "Vali Aliyev"), student("S0003", "Sami Karimov")]);
  append(GROUPS, [
    { id: "G0001", name: "IELTS", teacherId: "T0001", monthlyFee: 600_000, schedule: "Du", status: "active" },
    { id: "G0002", name: "Math", teacherId: "T0001", monthlyFee: 500_000, schedule: "Se", status: "active" },
  ]);
  append(ENROLLMENTS, [
    { id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
    { id: "E0002", studentId: "S0002", groupId: "G0002", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
  ]);
}
const program = (type: string, value: number, condition = "To'lagandan keyin", minPaid = 0) => {
  setSetting("Tavsiya dasturi yoqilgan", "Ha");
  setSetting("Tavsiya mukofoti turi", type);
  setSetting("Tavsiya mukofoti qiymati", String(value));
  setSetting("Tavsiya sharti", condition);
  setSetting("Tavsiya: kamida to'langan (so'm)", String(minPaid));
};
const pay = (studentId: string, amount: number, id = `P${Math.random().toString(36).slice(2, 6)}`) =>
  append(PAYMENTS, [{ id, studentId, paidOn: "2026-11-23", amount, method: "Naqd", note: "", voided: false }]);
const credits = () => read<Entitlement>(ENTITLEMENTS).filter((e) => e.source === "referral" || e.source === "promo");
const bill = () => {
  h.prompts.push("2026-12");
  actions.generateMonthlyCharges();
};
const chargeOf = (studentId: string) => read<Charge>(CHARGES).find((c) => c.studentId === studentId)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z")); // a Monday
  h = installHarness();
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("settings", () => {
  it("has the growth settings with safe defaults", () => {
    const s = readSettings();
    expect([s.referralActive, s.referralRewardType, s.referralRewardValue, s.referralCondition, s.referralMinPaid, s.leadReminderDays]).toEqual([false, "amount", 0, "paid", 0, 3]);
    program("Foiz", 10, "Yozilgandan keyin", 5);
    setSetting("Lead eslatmasi: jim kunlar", "5");
    const t = readSettings();
    expect([t.referralActive, t.referralRewardType, t.referralRewardValue, t.referralCondition, t.referralMinPaid, t.leadReminderDays]).toEqual([true, "percent", 10, "enrolled", 5, 5]);
    setSetting("Lead eslatmasi: jim kunlar", "0");
    expect(readSettings().leadReminderDays).toBe(3); // out of range falls back
  });
});

describe("referral rewards", () => {
  it("refuses a referral while the program is off, for oneself, for unknown students and twice", () => {
    seed();
    expect(() => growth.addReferral("S0001", "S0002")).toThrow(/yoqilmagan/);
    program("Foiz", 10);
    expect(() => growth.addReferral("S0001", "S0001")).toThrow(/o'zini/);
    expect(() => growth.addReferral("S0001", "S9999")).toThrow(/topilmadi/);
    expect(() => growth.addReferral("S9999", "S0002")).toThrow(/topilmadi/);
    expect(growth.addReferral("S0001", "S0002")).toBe("F0001");
    expect(() => growth.addReferral("S0003", "S0002")).toThrow(/allaqachon/);
  });

  it("pays a percent reward as a credit once the invited student has paid, and billing consumes it", () => {
    seed();
    program("Foiz", 10, "To'lagandan keyin", 100_000);
    growth.addReferral("S0001", "S0002");
    program("Summa", 999); // the rule changed later: the referral keeps the one it was made under
    expect(growth.bookReferralRewards()).toMatchObject({ rewarded: [], total: 0 });
    pay("S0002", 99_999);
    expect(growth.bookReferralRewards().rewarded).toEqual([]); // below the minimum
    pay("S0002", 1);
    const res = growth.bookReferralRewards();
    expect(res.rewarded).toEqual([{ referralId: "F0001", referrer: "Ali Valiyev", amount: 60_000, credits: 1 }]);
    expect(growth.bookReferralRewards().rewarded).toEqual([]); // safe to repeat
    expect(read<Referral>(REFERRALS)[0]).toMatchObject({ status: "rewarded", rewardType: "percent", rewardValue: 10, rewardAmount: 60_000, rewardedOn: "2026-11-23" });
    expect(credits()).toMatchObject([{ studentId: "S0001", kind: "credit", amount: 60_000, status: "open", source: "referral", note: "Tavsiya: Vali Aliyev", groupId: "" }]);
    bill();
    expect(chargeOf("S0001").amount).toBe(540_000);
    expect(chargeOf("S0002").amount).toBe(500_000);
    expect(credits()[0]).toMatchObject({ status: "used", appliedChargeId: chargeOf("S0001").id });
  });

  it("splits a big fixed reward so that no money is lost to whole-credit consumption", () => {
    seed();
    program("Summa", 1_000_000, "Yozilgandan keyin");
    growth.addReferral("S0001", "S0002");
    const r = growth.bookReferralRewards();
    expect(r.rewarded).toEqual([{ referralId: "F0001", referrer: "Ali Valiyev", amount: 1_000_000, credits: 2 }]);
    expect(credits().map((c) => c.amount)).toEqual([600_000, 400_000]); // the fee of S0001 is 600 000: chunks 600k + 400k
    bill();
    expect(chargeOf("S0001").amount).toBe(0);
    expect(credits().map((c) => c.status)).toEqual(["used", "open"]);
  });

  it("pays free lessons at the lesson price of the month", () => {
    seed();
    program("Bepul dars", 2, "Yozilgandan keyin");
    growth.addReferral("S0001", "S0002");
    // November 2026 has five Mondays: 600 000 / 5 = 120 000 per lesson
    expect(growth.bookReferralRewards().rewarded[0]!.amount).toBe(240_000);
  });

  it("reports rewards it cannot pay and keeps them pending", () => {
    seed();
    program("Foiz", 10, "Yozilgandan keyin");
    growth.addReferral("S0003", "S0002"); // S0003 studies nowhere
    const r = growth.bookReferralRewards();
    expect(r.skipped).toEqual([{ referralId: "F0001", referrer: "Sami Karimov", reason: "referrer_has_no_active_enrollment" }]);
    expect(read<Referral>(REFERRALS)[0]!.status).toBe("pending");
    program("Bepul dars", 1, "Yozilgandan keyin");
    growth.addReferral("S0001", "S0003"); // S0003 not enrolled yet: condition not met
    expect(growth.bookReferralRewards().skipped.map((s) => s.reason)).toContain("condition_not_met");
  });

  it("cancels a referral together with its unused credits", () => {
    seed();
    program("Summa", 900_000, "Yozilgandan keyin");
    growth.addReferral("S0001", "S0002");
    growth.bookReferralRewards();
    bill(); // the first credit (600 000) is used
    growth.cancelReferral("F0001");
    expect(read<Referral>(REFERRALS)[0]!.status).toBe("cancelled");
    expect(credits().map((c) => c.status)).toEqual(["used", "cancelled"]);
    expect(() => growth.cancelReferral("F0001")).toThrow(/allaqachon/);
    expect(growth.bookReferralRewards().rewarded).toEqual([]);
  });
});

const promo = (over: Partial<Promo> = {}) =>
  append(PROMOS, [{ code: "KUZ50", name: "Kuz -50%", kind: "percent", value: 50, validFrom: "2026-11-01", validTo: "2026-11-30", maxUses: 0, active: true, ...over }]);

describe("promo codes", () => {
  it("is a credit for the next monthly charge, once per student, capped at the fee", () => {
    seed();
    promo();
    const r = growth.redeemPromo("kuz50", "S0001", "E0001");
    expect(r).toEqual({ code: "KUZ50", fee: 600_000, amount: 300_000 });
    expect(credits()).toMatchObject([{ studentId: "S0001", amount: 300_000, source: "promo", note: "KUZ50", status: "open" }]);
    expect(read<PromoUse>(PROMO_USES)).toMatchObject([{ code: "KUZ50", studentId: "S0001", enrollmentId: "E0001", fee: 600_000, amount: 300_000, usedOn: "2026-11-23" }]);
    expect(() => growth.redeemPromo("KUZ50", "S0001", "E0001")).toThrow(/allaqachon/);
    bill();
    expect(chargeOf("S0001").amount).toBe(300_000);
    append(PROMOS, [{ code: "BIG", name: "Big", kind: "amount", value: 900_000, validFrom: "2026-11-01", validTo: "", maxUses: 0, active: true }]);
    expect(growth.redeemPromo("BIG", "S0002", "E0002").amount).toBe(500_000); // never above the fee
  });

  it("refuses codes that are off, not started, expired, used up or unknown", () => {
    seed();
    promo({ code: "OFF", active: false });
    promo({ code: "FUTURE", validFrom: "2026-11-24" });
    promo({ code: "OLD", validTo: "2026-11-22" });
    promo({ code: "ONE", maxUses: 1 });
    expect(() => growth.redeemPromo("OFF", "S0001", "E0001")).toThrow(/o'chirilgan/);
    expect(() => growth.redeemPromo("FUTURE", "S0001", "E0001")).toThrow(/boshlanmagan/);
    expect(() => growth.redeemPromo("OLD", "S0001", "E0001")).toThrow(/tugagan/);
    expect(() => growth.redeemPromo("NOPE", "S0001", "E0001")).toThrow(/topilmadi/);
    growth.redeemPromo("ONE", "S0001", "E0001");
    expect(() => growth.redeemPromo("ONE", "S0002", "E0002")).toThrow(/limiti/);
    expect(credits()).toHaveLength(1);
  });

  it("refuses the wrong enrollment, a package group, a zero fee and a broken campaign row", () => {
    seed();
    promo();
    expect(() => growth.redeemPromo("KUZ50", "S0001", "E0002")).toThrow(/tegishli emas/);
    expect(() => growth.redeemPromo("KUZ50", "S0001", "E9999")).toThrow(/topilmadi/);
    expect(() => growth.redeemPromo("KUZ50", "S9999", "E0001")).toThrow(/topilmadi/);
    append(GROUPS, [{ id: "G0003", name: "Pack", teacherId: "T0001", monthlyFee: 0, schedule: "Pay", status: "active", billingMode: "package", packageLessons: 8, packagePrice: 400_000 }]);
    append(GROUPS, [{ id: "G0004", name: "Free", teacherId: "T0001", monthlyFee: 0, schedule: "Pay", status: "active" }]);
    append(ENROLLMENTS, [
      { id: "E0003", studentId: "S0003", groupId: "G0003", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
      { id: "E0004", studentId: "S0003", groupId: "G0004", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
    ]);
    expect(() => growth.redeemPromo("KUZ50", "S0003", "E0003")).toThrow(/oylik/);
    expect(() => growth.redeemPromo("KUZ50", "S0003", "E0004")).toThrow(/narx 0/);
    promo({ code: "BAD101", value: 101 });
    expect(() => growth.redeemPromo("BAD101", "S0001", "E0001")).toThrow(/noto'g'ri sozlangan/);
    promo({ code: "BACK", validFrom: "2026-11-10", validTo: "2026-11-09" });
    expect(() => growth.redeemPromo("BACK", "S0001", "E0001")).toThrow(/noto'g'ri sozlangan/);
  });
});

describe("marketing credits in accounting", () => {
  it("shows promo and referral credits separately from tuition, with applied and waiting money", () => {
    seed();
    program("Summa", 100_000, "Yozilgandan keyin");
    growth.addReferral("S0001", "S0002");
    growth.bookReferralRewards();
    promo();
    growth.redeemPromo("KUZ50", "S0001", "E0001");
    growth.refreshGrowthCredits();
    expect(h.rows(growth.CREDITS_SHEET).slice(1)).toEqual([
      ["Promo", "KUZ50 - Kuz -50%", 1, 300_000, 0, 300_000, 0],
      ["Tavsiya", "Referral", 1, 100_000, 0, 100_000, 0],
      ["JAMI", "", 2, 400_000, 0, 400_000, 0],
    ]);
    bill(); // 600 000 - 100 000 (oldest credit first: referral was granted first, same day, lower id) - 300 000
    growth.refreshGrowthCredits();
    expect(h.rows(growth.CREDITS_SHEET).at(-1)).toEqual(["JAMI", "", 2, 400_000, 400_000, 0, 0]);
    expect(chargeOf("S0001").amount).toBe(200_000);
  });
});

describe("lead source ROI", () => {
  const lead = (id: string, name: string, source: string, studentId = "") => ({ id, fullName: name, phone: "", source, stage: studentId ? "trial_scheduled" : "new", nextFollowUpOn: "", note: "", createdOn: "2026-11-02", studentId });

  it("compares the cost of a source with what its converted leads paid", () => {
    seed();
    append(LEADS, [lead("L0001", "Ali", "Instagram", "S0001"), lead("L0002", "Vali", "Instagram"), lead("L0003", "Sami", "Tanish", "S0002")]);
    pay("S0001", 300_000);
    pay("S0002", 100_000);
    growth.setSourceCost("instagram", "2026-11", "150 000");
    growth.setSourceCost("Instagram", "2026-11", "150000"); // repeating corrects, never duplicates
    expect(read<SourceCostRow>(SOURCE_COSTS)).toMatchObject([{ source: "instagram", month: "2026-11-01", amount: 150_000, note: "", branchId: "F0001" }]);
    growth.setSourceCost("Instagram", "2026-11", "160000");
    expect(read<SourceCostRow>(SOURCE_COSTS)).toMatchObject([{ amount: 160_000 }]);
    growth.setSourceCost("Instagram", "2026-11", "150000");
    growth.refreshSourceRoi();
    const rows = h.rows(growth.ROI_SHEET).slice(1);
    expect(rows[0]).toEqual(["Instagram", 2, 1, 300_000, 150_000, 100, 75_000, 150_000]);
    expect(rows[1]).toEqual(["Tanish", 1, 1, 100_000, 0, "", "", ""]);
    expect(rows.at(-1)).toEqual(["JAMI", 3, 2, 400_000, 150_000, 166.7, 50_000, 75_000]);
  });

  it("validates the cost input", () => {
    seed();
    expect(() => growth.setSourceCost("", "2026-11", "1")).toThrow(/nomi/);
    expect(() => growth.setSourceCost("OLX", "2026-13", "1")).toThrow(/oy/);
    expect(() => growth.setSourceCost("OLX", "2026-11", "-5")).toThrow(/manfiy/);
    expect(() => growth.setSourceCost("OLX", "2026-11", "1.5")).toThrow(/butun/);
    growth.setSourceCost("OLX", "2026-11", "0");
    expect(read<SourceCostRow>(SOURCE_COSTS)).toMatchObject([{ source: "OLX", amount: 0 }]);
  });
});

describe("lead reminders (internal)", () => {
  const lead = (id: string, name: string, stage: Lead["stage"], createdOn: string, nextFollowUpOn = "") => ({ id, fullName: name, phone: "+998901112233", source: "Instagram", stage, nextFollowUpOn, note: "", createdOn, studentId: "" });

  it("lists the leads that need a person, sends nothing and creates no draft", () => {
    seed();
    append(LEADS, [
      lead("L0001", "Quiet", "new", "2026-11-10"),
      lead("L0002", "Due", "contacted", "2026-11-01", "2026-11-21"),
      lead("L0003", "Planned", "new", "2026-11-01", "2026-11-30"),
      lead("L0004", "Fresh", "new", "2026-11-23"),
      lead("L0005", "Attended", "trial_attended", "2026-11-01"),
      lead("L0006", "Done", "enrolled", "2026-11-01"),
      lead("L0007", "Gone", "lost", "2026-11-01"),
    ]);
    append(LEAD_LOG, [{ leadId: "L0005", date: "2026-11-20", kind: "call", summary: "Trial done", nextFollowUpOn: "" } satisfies LeadLogRow]);
    const n = growth.refreshLeadReminders();
    expect(n).toBe(3);
    expect(h.rows(growth.REMINDERS_SHEET).slice(1).map((r) => [r[0], r[5], r[6]])).toEqual([
      ["L0002", "Aloqa sanasi keldi", 2],
      ["L0005", "Sinovdan keyin aloqa kerak", 3],
      ["L0001", "Uzoq vaqt aloqa bo'lmagan", 13],
    ]);
    expect(h.fetches).toEqual([]); // nothing was sent to anybody
    expect(read(DRAFTS)).toEqual([]);
    // a logged contact today silences the lead; a shorter setting reaches fresher leads
    append(LEAD_LOG, [{ leadId: "L0001", date: "2026-11-23", kind: "call", summary: "Called", nextFollowUpOn: "" }]);
    setSetting("Lead eslatmasi: jim kunlar", "1");
    growth.refreshLeadReminders();
    expect(h.rows(growth.REMINDERS_SHEET).slice(1).map((r) => r[0])).toEqual(["L0002", "L0005"]);
    expect(h.fetches).toEqual([]);
  });

  it("says so when nobody needs attention", () => {
    seed();
    expect(growth.refreshLeadReminders()).toBe(0);
    expect(h.rows(growth.REMINDERS_SHEET)).toHaveLength(1);
  });
});

describe("workbook", () => {
  it("creates the growth tabs and the credit source columns", () => {
    for (const name of ["Tavsiyalar", "Promo kodlar", "Promo ishlatilishi", "Manba xarajatlari"]) expect(h.sheets.has(name)).toBe(true);
    expect(h.rows("Qoplash huquqlari")[0]).toContain("Manba");
  });

  it("an old credit row without a source reads as an excused-lesson credit and still bills", () => {
    seed();
    append(ENTITLEMENTS, [{ id: "R0001", studentId: "S0001", groupId: "G0001", missedOn: "2026-11-16", kind: "credit", amount: 120_000, expiresOn: "2026-12-16", status: "open", makeupOn: "", usedOn: "", appliedChargeId: "", lastMakeupOn: "" }]);
    expect(read<Entitlement>(ENTITLEMENTS)[0]!.source).toBe("absence");
    bill();
    expect(chargeOf("S0001").amount).toBe(480_000);
  });
});
