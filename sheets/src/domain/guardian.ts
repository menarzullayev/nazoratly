/**
 * Guardian cabinet rules (G7). Pure functions, mirrored in Python (backend/src/nazoratly/rules/guardian.py); both are
 * checked against the same cases in tests/golden/guardian.json. Dates are "YYYY-MM-DD", date-times are naive local
 * "YYYY-MM-DDTHH:MM:SS" strings (they compare correctly as text).
 */
import { daysBetween } from "./dates";

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8;
export const CODE_TTL_HOURS = 72;
export const REASON_MAX = 300;
export const MAKEUP_OPTIONS_LIMIT = 6;

export type CodeState = "ok" | "used" | "expired" | "revoked";
export type LinkDecision = "active" | "pending" | "denied";
export type RequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type RequestKind = "absence_reason" | "payment_promise" | "makeup_choice";

export function normalizeCode(text: string): string {
  return text.replace(/[\s\-_]+/g, "").toUpperCase();
}

export function codeFormatValid(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((ch) => CODE_ALPHABET.includes(ch));
}

export function codeState(a: { expiresAt: string; now: string; used: boolean; revoked: boolean }): CodeState {
  if (a.revoked) return "revoked";
  if (a.used) return "used";
  if (a.now >= a.expiresAt) return "expired";
  return "ok";
}

export function linkDecision(a: { method: string; phoneVerified: boolean; phoneMatches: boolean }): LinkDecision {
  if (a.method === "code" || a.method === "manual") return "active";
  if (a.method === "qr") return "pending";
  if (a.method === "phone") return a.phoneVerified && a.phoneMatches ? "active" : "denied";
  return "denied";
}

export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : "";
}

export function absenceCheck(a: {
  reason: string;
  lessonStart: string;
  now: string;
  lessonStatus: string;
  inGroup: boolean;
  existingMark: string | null;
}): string {
  const text = a.reason.trim();
  if (!text) return "reason_required";
  if ([...text].length > REASON_MAX) return "reason_too_long";
  if (!a.inGroup) return "not_in_group";
  if (a.lessonStatus === "cancelled") return "lesson_cancelled";
  if (a.now >= a.lessonStart) return "lesson_started";
  if (a.existingMark !== null) return "already_marked";
  return "ok";
}

export function promiseCheck(a: {
  today: string;
  promiseDate: string;
  outstanding: number;
  amount: number | null;
  maxDays: number;
  hasActive: boolean;
}): string {
  if (a.outstanding <= 0) return "no_debt";
  if (a.hasActive) return "duplicate";
  if (a.promiseDate < a.today) return "date_past";
  if (daysBetween(a.today, a.promiseDate) > a.maxDays) return "date_too_far";
  if (a.amount !== null && (a.amount <= 0 || a.amount > a.outstanding)) return "amount_invalid";
  return "ok";
}

export function promiseState(a: { status: string; promiseDate: string; today: string; outstanding: number }): string {
  if (a.status !== "approved") return a.status;
  if (a.outstanding <= 0) return "kept";
  return a.promiseDate < a.today ? "broken" : "active";
}

export interface SlotCandidate {
  id: string;
  date: string;
  start: string;
  seatsLeft: number;
}

export function makeupOptions(a: { candidates: SlotCandidate[]; today: string; expiresOn: string; limit?: number }): string[] {
  const ok = a.candidates.filter((c) => c.date > a.today && c.date <= a.expiresOn && c.seatsLeft > 0);
  const key = (c: SlotCandidate) => `${c.date}|${c.start}|${c.id}`;
  ok.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  return ok.slice(0, a.limit ?? MAKEUP_OPTIONS_LIMIT).map((c) => c.id);
}

export function makeupCheck(a: { kind: string; status: string; expiresOn: string; today: string; slot: string; options: string[] }): string {
  if (a.kind !== "makeup") return "not_makeup";
  if (a.status !== "open") return "not_open";
  if (a.expiresOn < a.today) return "expired";
  if (!a.options.includes(a.slot)) return "slot_unavailable";
  return "ok";
}

const TRANSITIONS: Record<string, RequestStatus> = {
  "pending|approve": "approved",
  "pending|reject": "rejected",
  "pending|cancel": "cancelled",
};

export function requestTransition(a: { status: string; action: string }): RequestStatus | "invalid" {
  return TRANSITIONS[`${a.status}|${a.action}`] ?? "invalid";
}

const EFFECTS: Record<string, string> = {
  absence_reason: "mark_excused",
  payment_promise: "record_promise",
  makeup_choice: "schedule_makeup",
};

export function requestEffect(a: { kind: string }): string | null {
  return EFFECTS[a.kind] ?? null;
}
