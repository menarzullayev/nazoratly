import type { ISODate } from "./types";

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = ISO.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function monthStart(d: ISODate): ISODate {
  if (!isIsoDate(d)) throw new Error(`invalid date: ${d}`);
  return `${d.slice(0, 7)}-01`;
}

export function nextMonthStart(d: ISODate): ISODate {
  const [y, m] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export function prevMonthStart(d: ISODate): ISODate {
  const [y, m] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

export function withDay(month: ISODate, day: number): ISODate {
  return `${month.slice(0, 7)}-${String(day).padStart(2, "0")}`;
}

/** Whole days from a to b (b - a); positive when b is later. */
export function daysBetween(a: ISODate, b: ISODate): number {
  const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

export function inMonth(d: ISODate, month: ISODate): boolean {
  return d >= month && d < nextMonthStart(month);
}
