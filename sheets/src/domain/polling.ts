/** Rules of the getUpdates mode and of the daily trigger-runtime accounting (pure, unit-tested). */

export type PollMinutes = 1 | 5;
export const DEFAULT_POLL_MINUTES: PollMinutes = 5;

/**
 * Google's quota for the total runtime of triggers per day (https://developers.google.com/apps-script/guides/services/quotas,
 * read 2026-11-27): 90 minutes for a consumer (gmail.com) account, 6 hours for Google Workspace. The account kind is
 * judged by the owner's address; an unknown address gets the smaller quota.
 */
export function dailyLimitMs(ownerEmail: string): number {
  const domain = ownerEmail.split("@")[1]?.toLowerCase() ?? "";
  const consumer = domain === "" || domain === "gmail.com" || domain === "googlemail.com";
  return (consumer ? 90 : 360) * 60_000;
}

/** How long one run may keep fetching: below the next run for 1 minute, well below the 6-minute execution limit otherwise. */
export const runBudgetMs = (minutes: PollMinutes): number => (minutes === 1 ? 45_000 : 240_000);

export interface Usage {
  date: string; // yyyy-mm-dd in the spreadsheet's time zone
  ms: number; // measured runtime of this Sheet's triggers today
  pollRuns: number;
  pollMs: number;
  updates: number;
  warned: "" | "near" | "over";
}

export const emptyUsage = (date: string): Usage => ({ date, ms: 0, pollRuns: 0, pollMs: 0, updates: 0, warned: "" });

export const WARN_SHARE = 0.7;
const OVER_SHARE = 0.9;
/** A projection needs a few runs: one slow start must not raise an alarm. */
export const MIN_RUNS_FOR_PROJECTION = 12;

/** A whole day of polling at the average cost of today's runs; null while there are too few runs to say. */
export function projectedMs(u: Usage, minutes: PollMinutes): number | null {
  if (u.pollRuns < MIN_RUNS_FOR_PROJECTION) return null;
  return Math.round((u.pollMs / u.pollRuns) * ((24 * 60) / minutes));
}

/** "over": nearly spent. "near": 70% spent, or at this pace the day will pass 70%. */
export function quotaLevel(u: Usage, minutes: PollMinutes, limitMs: number): "ok" | "near" | "over" {
  if (u.ms >= limitMs * OVER_SHARE) return "over";
  const projected = projectedMs(u, minutes);
  return u.ms >= limitMs * WARN_SHARE || (projected !== null && projected >= limitMs * WARN_SHARE) ? "near" : "ok";
}

const mins = (ms: number): string => (ms / 60_000).toFixed(1);

export function usageText(u: Usage, minutes: PollMinutes, limitMs: number): string {
  const projected = projectedMs(u, minutes);
  return [
    `Bugun (${u.date}) o'lchangan ishlash vaqti: ${mins(u.ms)} daqiqa; Google chegarasi: ${Math.round(limitMs / 60_000)} daqiqa.`,
    `So'rovlar: ${u.pollRuns} ta, xabarlar: ${u.updates} ta.`,
    projected === null ? "Kunlik taxmin uchun hali ma'lumot yetarli emas." : `Shu tezlikda to'liq kun: taxminan ${mins(projected)} daqiqa.`,
  ].join("\n");
}

export function quotaWarning(level: "near" | "over", u: Usage, minutes: PollMinutes, limitMs: number): string {
  const head =
    level === "over"
      ? "DIQQAT: bugungi trigger vaqti chegaraga yaqin. Chegara tugasa bot ertagacha javob bermaydi."
      : "Ogohlantirish: botni so'rab turish Google'ning kunlik trigger vaqtining katta qismini sarflayapti.";
  const advice = minutes === 1 ? "Oraliqni 5 daqiqaga qaytarish tavsiya etiladi (Telegram eslatmalar menyusi)." : "Webhook relay rejimiga o'tishni ko'rib chiqing.";
  return `${head}\n${usageText(u, minutes, limitMs)}\n${advice}`;
}

/** The numeric bot id a token starts with: the saved getUpdates offset belongs to one bot only. */
export const botIdOfToken = (token: string): string => /^(\d+):/.exec(token)?.[1] ?? "";
