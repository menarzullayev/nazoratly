/**
 * Teacher-app rules: invitation codes, unmarked lessons and their reminders, the owner's end-of-day list, the checks and
 * texts of a teacher's direct message to a guardian, and a teacher's month hours and pay estimate. Pure; mirrored in
 * Python (backend/src/nazoratly/rules/teacher.py) and checked against tests/golden/teacher.json.
 * Times are naive local ISO strings ("2026-11-24T17:30"): the caller converts to the center's time zone first.
 */
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // same 32 symbols as the QR and certificate codes
export const INVITE_LEN = 8;
export const INVITE_TTL_DAYS = 7;
export const INVITE_PREFIX = "T";
export const REMINDER_AFTER_HOURS_DEFAULT = 2;
export const DIGEST_AFTER_DEFAULT = "20:00";
export const DAILY_LIMIT_DEFAULT = 20;
export const MAX_TEXT = 1000;

const INVITE_BODY = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_LEN}}$`);

/** Round half up to `places` decimals; the epsilon absorbs binary noise. */
function halfUp(x: number, places: number): number {
  const k = 10 ** places;
  return Math.floor(x * k + 0.5 + 1e-9) / k;
}

/** "2026-11-24T17:30" -> minutes since the epoch of a fixed zone (only differences matter). */
function stamp(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad timestamp ${s}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 60000;
}
function unstamp(minutes: number): string {
  return new Date(minutes * 60000).toISOString().slice(0, 16);
}

// ---- invitation codes -------------------------------------------------------------------------------------------
export function formatInviteCode(raw: string): string {
  return `${INVITE_PREFIX}-${raw}`;
}

/** What a person typed or pasted -> the canonical `T-XXXXXXXX`, or null. Case, spaces and a missing dash are forgiven. */
export function normalizeInviteCode(text: string): string | null {
  const t = (text ?? "").replace(/[\s-]+/g, "").toUpperCase();
  if (!t.startsWith(INVITE_PREFIX)) return null;
  const body = t.slice(INVITE_PREFIX.length);
  return INVITE_BODY.test(body) ? formatInviteCode(body) : null;
}

export type InviteState = "valid" | "used" | "revoked" | "expired";
/** A used or revoked invitation never becomes valid again; `expiresAt` is the first instant the code no longer works. */
export function inviteState(status: string, expiresAt: string, now: string): InviteState {
  if (status === "used" || status === "revoked") return status;
  return stamp(now) >= stamp(expiresAt) ? "expired" : "valid";
}
export function inviteExpiresAt(now: string): string {
  return unstamp(stamp(now) + INVITE_TTL_DAYS * 24 * 60);
}

// ---- unmarked lessons ----------------------------------------------------------------------------------------------
export interface LessonFact {
  id: string;
  date: string;
  end_time: string;
  status: string;
  marked: number;
  reminded: boolean;
}
export interface Unmarked {
  id: string;
  ended_at: string;
  reminder_at: string;
  state: "waiting" | "reminder_due" | "reminded";
}

/** Lessons that are over but have no roll call at all. Cancelled, marked and still-running lessons are never listed. */
export function unmarkedLessons(lessons: LessonFact[], now: string, afterHours: number): Unmarked[] {
  const tNow = stamp(now);
  const out: Unmarked[] = [];
  for (const l of lessons) {
    if (l.status === "cancelled" || l.marked > 0) continue;
    const ended = stamp(`${l.date}T${l.end_time}`);
    if (ended > tNow) continue;
    const remindAt = ended + afterHours * 60;
    const state = l.reminded ? "reminded" : remindAt <= tNow ? "reminder_due" : "waiting";
    out.push({ id: l.id, ended_at: unstamp(ended), reminder_at: unstamp(remindAt), state });
  }
  out.sort((a, b) => (a.ended_at < b.ended_at ? -1 : a.ended_at > b.ended_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export function reminderText(group: string, day: string, start: string, end: string): string {
  return `Eslatma: ${group} guruhining ${day} ${start}-${end} darsi uchun davomat belgilanmagan. Iltimos, belgilang.`;
}

/** The owner's end-of-day list is sent once, after `digestAfter`, and only when something is unmarked today. */
export function digestDue(now: string, digestAfter: string, todayCount: number, alreadySent: boolean): boolean {
  if (alreadySent || todayCount <= 0) return false;
  return now.slice(11, 16) >= digestAfter;
}

export interface DigestItem {
  start: string;
  end: string;
  group: string;
  teacher: string;
}
export function digestText(day: string, items: DigestItem[]): string {
  const lines = [`${day}: davomat belgilanmagan darslar (${items.length}):`];
  items.forEach((it, i) => lines.push(`${i + 1}. ${it.start}-${it.end} ${it.group}${it.teacher ? ` (${it.teacher})` : ""}`));
  return lines.join("\n");
}

// ---- a teacher's message to a guardian ------------------------------------------------------------------------------
export const TEMPLATES: Record<string, string> = {
  absent: "{student} bugun ({date}) {group} darsiga kelmadi. Sababini bilsak bo'ladimi?",
  late: "{student} bugun ({date}) {group} darsiga kechikib keldi.",
  homework: "{student} {group} bo'yicha uy vazifasini bajarmadi. Iltimos, e'tibor bering.",
  praise: "{student} bugun ({date}) {group} darsida a'lo qatnashdi. Rahmat!",
  meeting: "{student} haqida suhbatlashish uchun markazga tashrif buyurishingizni so'raymiz ({group}).",
};

export function renderTemplate(code: string, student: string, group: string, day: string): string | null {
  const t = Object.prototype.hasOwnProperty.call(TEMPLATES, code) ? TEMPLATES[code]! : null;
  return t === null ? null : t.replaceAll("{student}", student).replaceAll("{group}", group).replaceAll("{date}", day);
}

export function signedText(text: string, teacher: string, center: string): string {
  return `${text.trim()}\n\n— ${teacher}, ${center}`;
}

export interface MessageCheckIn {
  enabled: boolean;
  own_student: boolean;
  text: string;
  recipients: number;
  sent_today: number;
  limit: number;
}
export type MessageError = "right_off" | "not_own_student" | "empty_text" | "text_too_long" | "no_recipient" | "daily_limit";
export type MessageCheck = { ok: true } | { ok: false; error: MessageError };

/** Order: right on, own student, text 1..1000 chars, somebody can receive it, daily limit (per recipient, all or nothing). */
export function checkMessage(i: MessageCheckIn): MessageCheck {
  if (!i.enabled) return { ok: false, error: "right_off" };
  if (!i.own_student) return { ok: false, error: "not_own_student" };
  const body = i.text.trim();
  if (!body) return { ok: false, error: "empty_text" };
  if (body.length > MAX_TEXT) return { ok: false, error: "text_too_long" };
  if (i.recipients <= 0) return { ok: false, error: "no_recipient" };
  if (i.sent_today + i.recipients > i.limit) return { ok: false, error: "daily_limit" };
  return { ok: true };
}

// ---- hours and pay ---------------------------------------------------------------------------------------------------
export interface MonthSummary {
  lessons: number;
  minutes: number;
  hours: string;
  estimate: number;
}
/** `fixed` = the rate, `per_lesson` = lessons x rate, `percent` = collected tuition x rate / 100; whole so'm, half up. */
export function monthSummary(minutes: number[], payModel: string, payRate: string, collected: string): MonthSummary {
  const n = minutes.length;
  const total = minutes.reduce((a, b) => a + b, 0);
  const rate = Number(payRate);
  const pay = payModel === "fixed" ? rate : payModel === "per_lesson" ? rate * n : (Number(collected) * rate) / 100;
  return { lessons: n, minutes: total, hours: halfUp(total / 60, 1).toFixed(1), estimate: halfUp(pay, 0) };
}
