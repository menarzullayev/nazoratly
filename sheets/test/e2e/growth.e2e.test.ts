import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Charge, Entitlement } from "../../src/domain/types";
import * as actions from "../../src/gas/actions";
import { append, read } from "../../src/gas/repo";
import { CHARGES, ENTITLEMENTS, LEADS, PROMO_USES, PROMOS, REFERRALS } from "../../src/gas/schema";
import type { Harness } from "../harness";
import { boot, drive, enrollment, seedClass, setSetting, student } from "./support";

let h: Harness;
beforeEach(() => {
  h = boot();
  seedClass({ students: [student("S0001", { guardianName: "Aliyev" }), student("S0002", { guardianName: "Botirov" }), student("S0003", { guardianName: "Valiyev" })] });
});
afterEach(() => vi.useRealTimers());

const charge = (studentId: string): Charge => read<Charge>(CHARGES).find((c) => c.studentId === studentId && c.month === "2026-12-01")!;

describe("journey: referral credit", () => {
  it("refuses a referral while the program is off, then credits the referrer once the invited student pays", () => {
    expect(drive(h, "menuReferralAdd", "S0001", "S0002").last).toMatch(/yoqilmagan/);
    setSetting(h, "Tavsiya dasturi yoqilgan", "Ha");
    setSetting(h, "Tavsiya mukofoti turi", "Summa");
    setSetting(h, "Tavsiya mukofoti qiymati", "100000");
    setSetting(h, "Tavsiya sharti", "To'lagandan keyin");
    expect(drive(h, "menuReferralAdd", "S0001", "S0001").last).toMatch(/o'zini/);
    drive(h, "menuReferralAdd", "S0001", "S0002");
    expect(drive(h, "menuReferralAdd", "S0003", "S0002").last).toMatch(/allaqachon/); // one inviter per student
    expect(read<{ id: string; status: string }>(REFERRALS).map((r) => [r.id, r.status])).toEqual([["F0001", "pending"]]);

    // the invited student has not paid yet: nothing is booked
    expect(drive(h, "menuReferralBook").last).toMatch(/Mukofot berildi: 0 ta/);
    drive(h, "menuGenerateCharges", "2026-11");
    actions.recordPayment({ studentId: "S0002", amount: 500_000, method: "Naqd", paidOn: "2026-11-05", note: "", notifyGuardian: false });
    const booked = drive(h, "menuReferralBook");
    expect(booked.last).toMatch(/Mukofot berildi: 1 ta, jami 100 000 so'm/);
    const credits = read<Entitlement>(ENTITLEMENTS).filter((e) => e.source === "referral");
    expect(credits.map((c) => [c.studentId, c.amount, c.status])).toEqual([["S0001", 100_000, "open"]]);
    // booking again changes nothing
    expect(drive(h, "menuReferralBook").last).toMatch(/Mukofot berildi: 0 ta/);
    expect(read<Entitlement>(ENTITLEMENTS).filter((e) => e.source === "referral")).toHaveLength(1);

    // the credit shrinks the referrer's NEXT monthly charge
    drive(h, "menuGenerateCharges", "2026-12");
    expect(charge("S0001").amount).toBe(400_000);
    expect(charge("S0003").amount).toBe(500_000);
    expect(read<Entitlement>(ENTITLEMENTS).find((e) => e.source === "referral")!.status).toBe("used");

    const rep = drive(h, "menuGrowthCredits");
    expect(rep.alerts).toEqual([]); // the report is a sheet, not a dialog
    expect(JSON.stringify(h.rows("Marketing chegirmalari"))).toContain("Referral");
  });

  it("cancelling a referral cancels its unused credit and cannot be repeated", () => {
    setSetting(h, "Tavsiya dasturi yoqilgan", "Ha");
    setSetting(h, "Tavsiya mukofoti qiymati", "50000");
    setSetting(h, "Tavsiya sharti", "Yozilgandan keyin");
    drive(h, "menuReferralAdd", "S0001", "S0002");
    drive(h, "menuReferralBook");
    expect(read<Entitlement>(ENTITLEMENTS).filter((e) => e.source === "referral" && e.status === "open")).toHaveLength(1);
    drive(h, "menuReferralCancel", "F0001");
    expect(read<Entitlement>(ENTITLEMENTS).filter((e) => e.source === "referral").map((e) => e.status)).toEqual(["cancelled"]);
    expect(read<{ status: string }>(REFERRALS)[0]!.status).toBe("cancelled");
    expect(drive(h, "menuReferralCancel", "F0001").last).toMatch(/allaqachon bekor/);
    expect(drive(h, "menuReferralCancel", "F0099").last).toMatch(/topilmadi/);
  });
});

describe("journey: promo codes", () => {
  const promo = (extra: Record<string, unknown> = {}) =>
    append(PROMOS, [{ code: "KUZ50", name: "Kuz aksiyasi", kind: "percent", value: 50, validFrom: "2026-11-01", validTo: "2026-12-31", maxUses: 1, active: true, ...extra }]);

  it("redeems once per student and per limit, then the credit is taken off the next monthly charge", () => {
    promo();
    const ok = drive(h, "menuPromoRedeem", "kuz50", "S0001", "E0001");
    expect(ok.last).toMatch(/KUZ50: 250 000 so'm chegirma/);
    expect(read(PROMO_USES)).toHaveLength(1);
    // limit of one use reached
    expect(drive(h, "menuPromoRedeem", "KUZ50", "S0002", "E0002").last).toMatch(/limiti tugagan/);
    // unknown code, wrong enrollment
    expect(drive(h, "menuPromoRedeem", "YOQ", "S0002", "E0002").last).toMatch(/topilmadi/);
    promo({ code: "OPEN", maxUses: 0 });
    expect(drive(h, "menuPromoRedeem", "OPEN", "S0002", "E0001").last).toMatch(/shu o'quvchiga tegishli emas/);
    drive(h, "menuGenerateCharges", "2026-12");
    expect(charge("S0001").amount).toBe(250_000);
    expect(charge("S0002").amount).toBe(500_000);
    // the same student cannot use the same code twice
    expect(drive(h, "menuPromoRedeem", "KUZ50", "S0001", "E0001").last).toMatch(/limiti tugagan|allaqachon/);
  });

  it("refuses an expired, not yet started, or switched-off code and a mis-configured one", () => {
    promo({ code: "OLD", validFrom: "2026-09-01", validTo: "2026-10-31" });
    promo({ code: "SOON", validFrom: "2026-12-01", validTo: "" });
    promo({ code: "OFF", active: false });
    promo({ code: "BAD", value: 150 });
    expect(drive(h, "menuPromoRedeem", "OLD", "S0001", "E0001").last).toMatch(/muddati tugagan/);
    expect(drive(h, "menuPromoRedeem", "SOON", "S0001", "E0001").last).toMatch(/hali boshlanmagan/);
    expect(drive(h, "menuPromoRedeem", "OFF", "S0001", "E0001").last).toMatch(/o'chirilgan/);
    expect(drive(h, "menuPromoRedeem", "BAD", "S0001", "E0001").last).toMatch(/noto'g'ri sozlangan/);
    expect(read(PROMO_USES)).toEqual([]);
  });
});

describe("journey: lead source cost, ROI and internal reminders", () => {
  const lead = (id: string, source: string, extra: Record<string, unknown> = {}) =>
    append(LEADS, [{ id, fullName: `Lead ${id}`, phone: "", source, stage: "new", nextFollowUpOn: "", note: "", createdOn: "2026-11-10", studentId: "", ...extra }]);

  it("computes ROI per source from costs, leads and what the converted students paid", () => {
    lead("L0001", "Instagram", { stage: "enrolled", studentId: "S0001" });
    lead("L0002", "instagram");
    lead("L0003", "Telegram");
    drive(h, "menuGenerateCharges", "2026-11");
    actions.recordPayment({ studentId: "S0001", amount: 500_000, method: "Naqd", paidOn: "2026-11-12", note: "", notifyGuardian: false });
    drive(h, "menuSourceCost", "Instagram", "2026-11", "200 000");
    drive(h, "menuSourceCost", "Telegram", "", "100000"); // empty month = this month
    drive(h, "menuSourceCost", "Instagram", "2026-11", "250000"); // repeating corrects the same month, never doubles it
    expect(drive(h, "menuSourceCost", "Instagram", "2026-13", "1").last).toMatch(/Noto'g'ri oy/);
    expect(drive(h, "menuSourceCost", "Instagram", "2026-11", "-5").last).toMatch(/butun/);
    drive(h, "menuSourceRoi");
    const roi = h.rows("Manba ROI");
    const ig = roi.find((r) => r[0] === "Instagram")!;
    const tg = roi.find((r) => r[0] === "Telegram")!;
    // columns: source, leads, paying, revenue, cost, roi, ...
    expect([ig[1], ig[2], ig[3], ig[4]]).toEqual([2, 1, 500_000, 250_000]);
    expect(ig[5]).toBe(100); // (500k - 250k) / 250k
    expect([tg[1], tg[2], tg[3], tg[4]]).toEqual([1, 0, 0, 100_000]);
    const total = roi.find((r) => r[0] === "JAMI")!;
    expect([total[1], total[3], total[4]]).toEqual([3, 500_000, 350_000]);
  });

  it("lists leads that need attention in an internal sheet and sends nothing to them", () => {
    lead("L0001", "Instagram", { createdOn: "2026-11-01" }); // silent for 22 days
    lead("L0002", "Instagram", { createdOn: "2026-11-22", nextFollowUpOn: "2026-11-23" }); // follow-up due today
    lead("L0003", "Instagram", { createdOn: "2026-11-22" }); // fresh: not listed
    lead("L0004", "Instagram", { createdOn: "2026-11-01", stage: "lost" }); // closed: not listed
    drive(h, "menuLeadReminders");
    const ids = h.rows("Lead eslatmalari").slice(1).map((r) => r[0]);
    expect(ids.sort()).toEqual(["L0001", "L0002"]);
    expect(h.fetches).toHaveLength(0);
  });
});
