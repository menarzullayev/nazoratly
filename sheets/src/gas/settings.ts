import { DEFAULT_TEMPLATE } from "../domain/reminders";
import { SETTINGS_SHEET, SETTING_DEFAULTS } from "./schema";

export interface Settings {
  center: string;
  dueDay: number;
  cooldownDays: number;
  minOverdue: number;
  template: string;
  policyVersion: string;
  policyText: string;
  payInfo: string;
  ownerChatId: string;
  trialFreeLessons: number;
  trialFreeDays: number;
  excusedMode: "makeup" | "credit" | "none";
  makeupExpiryDays: number;
  makeupLapses: boolean;
  installmentRemindDays: number;
  dashboardWindowDays: number;
  packageExpiryDays: number;
  packageLowLessons: number;
  requisites: string;
  ledgerEditors: string;
  referralActive: boolean;
  referralRewardType: "amount" | "percent" | "free_lesson";
  referralRewardValue: number;
  referralCondition: "enrolled" | "paid";
  referralMinPaid: number;
  leadReminderDays: number;

  familySecond: number; // percent, 0 = off
  familyThird: number;
}

export function readSettings(): Settings {
  const sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  const map = new Map<string, string>();
  if (sh && sh.getLastRow() > 1) {
    for (const row of sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()) {
      const label = String(row[0]).trim();
      const def = SETTING_DEFAULTS.find((d) => d.label === label);
      if (def) map.set(def.key, String(row[1] ?? "").trim());
    }
  }
  const num = (key: string, fallback: number, min: number, max: number): number => {
    const n = Number(map.get(key));
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  const pct = (key: string): number => {
    const n = Number((map.get(key) ?? "").replace(",", "."));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : 0;
  };
  return {
    center: map.get("center") || "Markaz",
    dueDay: num("dueDay", 10, 1, 28),
    cooldownDays: num("cooldownDays", 7, 0, 365),
    minOverdue: num("minOverdue", 50_000, 0, 1_000_000_000),
    template: map.get("template") || DEFAULT_TEMPLATE,
    policyVersion: map.get("policyVersion") || "2026-11",
    policyText: map.get("policyText") || "",
    trialFreeLessons: num("trialFreeLessons", 1, 0, 100),
    trialFreeDays: num("trialFreeDays", 7, 0, 365),
    excusedMode: ((v) => (v.startsWith("kredit") ? "credit" : v === "yo'q" || v === "yoq" || v === "yo`q" ? "none" : "makeup"))((map.get("excusedMode") ?? "").toLowerCase()),
    makeupExpiryDays: num("makeupExpiryDays", 30, 0, 365),
    makeupLapses: !["yo'q", "yoq", "yo`q", "no", "false"].includes((map.get("makeupLapses") ?? "ha").toLowerCase()),
    dashboardWindowDays: num("dashboardWindowDays", 7, 1, 60),
    installmentRemindDays: num("installmentRemindDays", 3, 0, 30),
    packageExpiryDays: num("packageExpiryDays", 60, 1, 730),
    packageLowLessons: num("packageLowLessons", 2, 0, 50),
    requisites: map.get("requisites") ?? "",
    payInfo: map.get("payInfo") ?? "",
    ledgerEditors: map.get("ledgerEditors") ?? "",
    referralActive: ["ha", "yes", "true"].includes((map.get("referralActive") ?? "").toLowerCase()),
    referralRewardType: ((v) => (v.startsWith("foiz") ? "percent" : v.startsWith("bepul") ? "free_lesson" : "amount"))((map.get("referralRewardType") ?? "").toLowerCase()),
    referralRewardValue: num("referralRewardValue", 0, 0, 1_000_000_000),
    referralCondition: (map.get("referralCondition") ?? "").toLowerCase().startsWith("yozil") ? "enrolled" : "paid",
    referralMinPaid: num("referralMinPaid", 0, 0, 1_000_000_000),
    leadReminderDays: num("leadReminderDays", 3, 1, 60),

    familySecond: pct("familySecond"),
    familyThird: pct("familyThird"),
    ownerChatId: /^-?\d{5,}$/.test(map.get("ownerChatId") ?? "") ? (map.get("ownerChatId") as string) : "",
  };
}
