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

// ---------------------------------------------------------------------------------------------------------------
// Printed documents (the Sheets edition renders HTML that Apps Script turns into the PDF; the API product renders the
// PDF with reportlab from the same facts). Wording of the captions above is golden-tested; layout is not.
// ---------------------------------------------------------------------------------------------------------------
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dmy = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export interface ReportLesson {
  date: string;
  grade: number | null;
  note: string;
}
export interface ReportExam {
  title: string;
  heldOn: string;
  score: number;
  maxScore: number;
  percent: number;
}
export interface ReportSnapshot {
  centerName: string;
  requisites: string;
  studentName: string;
  groupName: string;
  periodMonth: string; // first day, ISO
  monthLabel: string;
  present: number;
  late: number;
  absent: number;
  excused: number;
  attendancePercent: number | null;
  averageGrade: string | null;
  monthGrade: number | null;
  monthNote: string;
  lessons: ReportLesson[];
  exams: ReportExam[];
  generatedOn: string;
}

const STYLE =
  `<style>body{font-family:Arial,sans-serif;font-size:12px;margin:24px}h1{font-size:20px;margin:14px 0 4px}h2{font-size:14px;margin:16px 0 4px}` +
  `.c{font-size:17px;font-weight:bold}.s{color:#555;font-size:10px}table{border-collapse:collapse;width:100%;margin-top:6px}` +
  `td,th{border-bottom:1px solid #bbb;padding:4px;text-align:left}th{border-bottom:2px solid #000}.r{text-align:right}</style>`;

export function renderReportHtml(r: ReportSnapshot): string {
  const pct = r.attendancePercent !== null ? `${r.attendancePercent}%` : "ma'lumot yo'q";
  const lessons = r.lessons.length
    ? `<h2>Darslar bo'yicha</h2><table><tr><th>Sana</th><th>Baho</th><th>Izoh</th></tr>${r.lessons
        .map((l) => `<tr><td>${dmy(l.date)}</td><td>${l.grade ?? ""}</td><td>${esc(l.note)}</td></tr>`)
        .join("")}</table>`
    : "";
  const exams = r.exams.length
    ? `<h2>Imtihon va testlar</h2><table><tr><th>Nomi</th><th>Sana</th><th>Ball</th><th class="r">Foiz</th></tr>${r.exams
        .map((e) => `<tr><td>${esc(e.title)}</td><td>${dmy(e.heldOn)}</td><td>${e.score} / ${e.maxScore}</td><td class="r">${e.percent}%</td></tr>`)
        .join("")}</table>`
    : "";
  return (
    `<html><head><meta charset="utf-8">${STYLE}</head><body><div class="c">${esc(r.centerName)}</div>` +
    `${r.requisites ? `<div class="s">${esc(r.requisites).replace(/\n/g, "<br>")}</div>` : ""}` +
    `<h1>${REPORT_TITLE}: ${esc(r.monthLabel)}</h1><p>O'quvchi: <b>${esc(r.studentName)}</b><br>Guruh: ${esc(r.groupName)}</p>` +
    `<h2>Davomat</h2><p>Keldi: ${r.present}, kechikdi: ${r.late}, kelmadi: ${r.absent}, sababli: ${r.excused}. Davomat: ${pct}</p>` +
    `<h2>Baho</h2><p>O'rtacha baho (1-5): ${r.averageGrade ?? "baho qo'yilmagan"}` +
    `${r.monthGrade !== null ? `<br>Oy bahosi: ${r.monthGrade}` : ""}${r.monthNote ? `<br>O'qituvchi izohi: ${esc(r.monthNote)}` : ""}</p>` +
    `${lessons}${exams}<p class="s" style="margin-top:30px">Hisobot sanasi: ${dmy(r.generatedOn)}</p></body></html>`
  );
}

export interface CertificateSnapshot {
  centerName: string;
  requisites: string;
  studentName: string;
  courseName: string;
  groupName: string;
  startedOn: string;
  completedOn: string;
  issuedOn: string;
  number: string;
  code: string;
}

export function renderCertificateHtml(c: CertificateSnapshot): string {
  return (
    `<html><head><meta charset="utf-8">${STYLE}<style>body{text-align:center;margin:40px;border:3px double #1a3c6e;padding:30px}` +
    `.t{font-size:40px;font-weight:bold;margin:10px 0}.n{font-size:26px;font-weight:bold;margin:14px 0}</style></head><body>` +
    `<div class="c">${esc(c.centerName)}</div><div class="t">${CERTIFICATE_TITLE}</div><div>№ ${esc(c.number)}</div>` +
    `<p>Ushbu sertifikat</p><div class="n">${esc(c.studentName)}</div>` +
    `<p>«${esc(c.courseName)}» kursini muvaffaqiyatli tamomlagani uchun beriladi.</p>` +
    `<p>Guruh: ${esc(c.groupName)}. O'qish davri: ${dmy(c.startedOn)} - ${dmy(c.completedOn)}.</p>` +
    `<p>Berilgan sana: ${dmy(c.issuedOn)}</p><p>Tekshirish kodi: <b>${esc(c.code)}</b></p>` +
    `<p class="s">Sertifikat haqiqiyligini shu kod bilan markazdan yoki tekshirish xizmatida aniqlash mumkin.</p>` +
    `${c.requisites ? `<p class="s">${esc(c.requisites).replace(/\n/g, "<br>")}</p>` : ""}</body></html>`
  );
}
