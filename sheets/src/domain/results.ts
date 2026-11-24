/**
 * Learning-results rules: grades, attendance percent, exam percent, report wording, certificate eligibility, number,
 * verification code and the privacy mask of a holder's name. Pure; mirrored in Python
 * (backend/src/nazoratly/rules/results.py) and checked against tests/golden/results.json.
 */
export const GRADE_MIN = 1;
export const GRADE_MAX = 5;
export const CERTIFICATE_TITLE = "SERTIFIKAT";
export const REPORT_TITLE = "OYLIK HISOBOT";

const MONTHS_UZ = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no I O 0 1 (same as the QR codes)
const CODE_PREFIX = "NZC";
export const CODE_LEN = 12;
const CODE_RE = new RegExp(`^${CODE_PREFIX}-[${ALPHABET}]{4}-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);

/** Round half up to `places` decimals; the epsilon absorbs binary noise (4.75 * 10 = 47.49999...). */
function halfUp(x: number, places: number): number {
  const k = 10 ** places;
  return Math.floor(x * k + 0.5 + 1e-9) / k;
}

export function isValidGrade(grade: number): boolean {
  return Number.isInteger(grade) && grade >= GRADE_MIN && grade <= GRADE_MAX;
}

export interface AttendanceSummary {
  present: number;
  late: number;
  absent: number;
  excused: number;
  counted: number;
  percent: number | null;
}

/** `late` counts as attended; `excused` stays out of the denominator; no counted lesson = no percent. */
export function attendanceSummary(statuses: string[]): AttendanceSummary {
  const n = (k: string): number => statuses.filter((s) => s === k).length;
  const present = n("present");
  const late = n("late");
  const absent = n("absent");
  const excused = n("excused");
  const counted = present + late + absent;
  return { present, late, absent, excused, counted, percent: counted === 0 ? null : halfUp(((present + late) * 100) / counted, 0) };
}

/** Mean of the grades with one decimal, half up ("4.5"); null when there is no grade. */
export function averageGrade(grades: number[]): string | null {
  if (grades.length === 0) return null;
  return halfUp(grades.reduce((a, b) => a + b, 0) / grades.length, 1).toFixed(1);
}

/** Whole percent of an exam score, half up. */
export function examPercent(score: number, max: number): number {
  return halfUp((score * 100) / max, 0);
}

export function monthLabel(year: number, month: number): string {
  return `${year} yil ${MONTHS_UZ[month - 1]}`;
}

export function reportCaption(center: string, student: string, label: string, percent: number | null, average: string | null): string {
  return [
    `${center}: oylik hisobot`,
    `O'quvchi: ${student}`,
    `Davr: ${label}`,
    percent !== null ? `Davomat: ${percent}%` : "Davomat: ma'lumot yo'q",
    average !== null ? `O'rtacha baho: ${average}` : "O'rtacha baho: baho qo'yilmagan",
    "PDF hujjat ilova qilingan.",
  ].join("\n");
}

/** A certificate is for a completed course: finished enrollment, or active in a finished group. */
export function certificateEligible(enrollmentStatus: string, groupStatus: string): boolean {
  if (enrollmentStatus === "finished") return true;
  return enrollmentStatus === "active" && groupStatus === "finished";
}

export function certificateNumber(year: number, serial: number): string {
  return `SR-${year}-${String(serial).padStart(6, "0")}`;
}

/** Builds a code from CODE_LEN random bytes (5 bits each): NZC-XXXX-XXXX-XXXX. */
export function newCertificateCode(bytes: number[]): string {
  if (bytes.length < CODE_LEN) throw new Error("need 12 random bytes");
  const s = bytes
    .slice(0, CODE_LEN)
    .map((b) => ALPHABET[b & 31]!)
    .join("");
  return `${CODE_PREFIX}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** Canonical code from what a person typed (any case; spaces, dashes or none between groups); null if not ours. */
export function parseCertificateCode(text: string): string | null {
  const t = text.replace(/[\s-]+/g, "").toUpperCase();
  if (!t.startsWith(CODE_PREFIX) || t.length !== CODE_PREFIX.length + CODE_LEN) return null;
  const body = t.slice(CODE_PREFIX.length);
  const code = `${CODE_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
  return CODE_RE.test(code) ? code : null;
}

/** Public verification never shows a full name: each word keeps its first letter, the rest become '*'. */
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => {
      const chars = Array.from(w);
      return chars[0]! + "*".repeat(chars.length - 1);
    })
    .join(" ");
}

export function certificateCaption(center: string, student: string, course: string, number: string, code: string): string {
  return [`${center}: sertifikat ${number}`, `O'quvchi: ${student}`, `Kurs: ${course}`, `Tekshirish kodi: ${code}`, "PDF hujjat ilova qilingan."].join("\n");
}
