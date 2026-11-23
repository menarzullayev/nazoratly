/**
 * QR attendance rules. Pure functions, mirrored in Python (backend/src/nazoratly/rules/qr.py); both are checked against
 * the same cases in tests/golden/qr.json. The QR carries only the random student code, never personal data.
 */

export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no I O 0 1
export const PREFIX = "NZQ1-";
export const CODE_LEN = 20;
const CODE = new RegExp(`^${PREFIX}[${ALPHABET}]{${CODE_LEN}}$`);

export type ScanResult = "marked" | "already_present" | "not_in_group" | "lesson_cancelled" | "unknown_code" | "bad_code";
export interface ScanDecision {
  result: ScanResult;
  /** the caller must store `present` */
  write: boolean;
  /** the mark that was overwritten (or kept), if any */
  previous: string | null;
}

/** Builds a code from CODE_LEN random bytes (5 bits each: 100 bits of entropy). */
export function newCode(bytes: ArrayLike<number>): string {
  if (bytes.length < CODE_LEN) throw new Error("need 20 random bytes");
  let s = PREFIX;
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[(bytes[i] as number) & 31];
  return s;
}

export function isValidCode(text: string): boolean {
  return CODE.test(text);
}

export function qrPayload(code: string): string {
  return code;
}

/** Canonical code from scanner output (trims whitespace, any case); null when it is not one of ours. */
export function parsePayload(text: string): string | null {
  const t = text.trim().toUpperCase();
  return isValidCode(t) ? t : null;
}

/** What a scan does. Order matters: a malformed code is reported before any lookup result is used. */
export function scanDecision(a: { codeText: string; known: boolean; lessonStatus: string; inRoster: boolean; existing: string | null }): ScanDecision {
  if (parsePayload(a.codeText) === null) return { result: "bad_code", write: false, previous: null };
  if (!a.known) return { result: "unknown_code", write: false, previous: null };
  if (a.lessonStatus === "cancelled") return { result: "lesson_cancelled", write: false, previous: null };
  if (!a.inRoster) return { result: "not_in_group", write: false, previous: null };
  if (a.existing === "present" || a.existing === "late") return { result: "already_present", write: false, previous: a.existing };
  return { result: "marked", write: true, previous: a.existing };
}
