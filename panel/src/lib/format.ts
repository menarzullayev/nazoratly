/** The one place that formats money, dates and times. Money arrives from the server as a decimal string and is never
 * turned into a float: it is only grouped for reading. The panel does no money arithmetic. */

const MONEY = /^(-?)(\d+)(?:\.(\d+))?$/;

export function formatAmount(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const match = MONEY.exec(String(value));
  if (!match) return String(value);
  const [, sign, whole, fraction] = match;
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const cents = fraction && /[1-9]/.test(fraction) ? `,${fraction.padEnd(2, "0")}` : "";
  return `${sign}${grouped}${cents}`;
}

/** What a person types ("1 200 000", "1200000,5") as the decimal string the API takes; null when it is not an amount. */
export function parseAmount(text: string): string | null {
  const compact = text.replace(/[\s ']/g, "").replace(",", ".");
  return /^\d{1,12}(\.\d{1,2})?$/.test(compact) ? compact : null;
}

/** True when the server's decimal string is above zero (only for showing or hiding things, never for sums). */
export const isPositive = (value: string | null | undefined): boolean => !!value && !value.startsWith("-") && /[1-9]/.test(value);

/** 2026-10-21 -> 21.10.2026 (a calendar date has no time zone, so no Date object is involved). */
export function formatDate(value: string | null | undefined): string {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "—";
}

export const formatMonth = (value: string | null | undefined): string => (value ? `${value.slice(5, 7)}.${value.slice(0, 4)}` : "—");

export const formatTime = (value: string | null | undefined): string => (value ? value.slice(0, 5) : "—");

function parts(instant: Date, timeZone: string): Record<string, string> {
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, p.value]));
}

/** A moment in the center's time zone: 21.10.2026 14:05. */
export function formatDateTime(value: string | null | undefined, timeZone: string): string {
  if (!value) return "—";
  const p = parts(new Date(value), timeZone);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

/** Today's calendar date in the center's time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const p = parts(now, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Calendar arithmetic on YYYY-MM-DD (UTC midnight is used only as a day counter). */
export function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export const monthStart = (day: string): string => `${day.slice(0, 7)}-01`;
