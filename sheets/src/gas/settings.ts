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
  return {
    center: map.get("center") || "Markaz",
    dueDay: num("dueDay", 10, 1, 28),
    cooldownDays: num("cooldownDays", 7, 0, 365),
    minOverdue: num("minOverdue", 50_000, 0, 1_000_000_000),
    template: map.get("template") || DEFAULT_TEMPLATE,
    policyVersion: map.get("policyVersion") || "2026-11",
    policyText: map.get("policyText") || "",
    payInfo: map.get("payInfo") ?? "",
    ownerChatId: /^-?\d{5,}$/.test(map.get("ownerChatId") ?? "") ? (map.get("ownerChatId") as string) : "",
  };
}
