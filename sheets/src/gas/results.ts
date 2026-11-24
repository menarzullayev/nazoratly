/** Learning results (G4): the teacher's note and grade per lesson or month, simple exam results, the monthly progress
 * report PDF and the course certificate with a verification code. Rules and wording live in ../domain/results.ts (shared
 * with the API product through tests/golden/results.json); this file moves data and talks to Drive/Telegram.
 * NOTHING is sent to a guardian unless a person confirms it in the dialog of `approveReport` / `sendCertificate`;
 * reports are drafts until then and are final once approved. */
import { inMonth, isIsoDate, monthStart } from "../domain/dates";
import { nextId } from "../domain/ids";
import {
  attendanceSummary, averageGrade, certificateCaption, certificateEligible, certificateNumber, examPercent, isValidGrade, maskName, monthLabel,
  newCertificateCode, parseCertificateCode, renderCertificateHtml, renderReportHtml, reportCaption,
  type CertificateSnapshot, type ReportExam, type ReportLesson, type ReportSnapshot,
} from "../domain/results";
import type { AttendanceRow, Enrollment, Group, Student } from "../domain/types";
import { guard, withLock } from "./actions";
import { pickId } from "./pick";
import { append, read, readIfPresent, replaceWhere, today, updateById } from "./repo";
import { ATTENDANCE, CERTIFICATES, ENROLLMENTS, EXAM_RESULTS, EXAMS, GROUPS, MARKS, REPORTS, STUDENTS } from "./schema";
import { readSettings } from "./settings";
import { getToken, props, sendDocument } from "./telegram";

const FOLDER = "nazoratly natijalar";
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();

export interface MarkRow {
  scope: "lesson" | "month";
  date: string;
  groupId: string;
  studentId: string;
  grade: number; // 0 = no grade (note only)
  note: string;
  updatedOn: string;
}
export interface ExamRow {
  id: string;
  groupId: string;
  title: string;
  heldOn: string;
  maxScore: number;
}
export interface ExamResultRow {
  examId: string;
  studentId: string;
  score: number;
  note: string;
}
export interface ReportRow {
  id: string;
  month: string;
  groupId: string;
  studentId: string;
  status: "draft" | "approved";
  percent: string; // attendance percent when the report was made; "" = no data
  average: string;
  link: string;
  generatedOn: string;
  approvedOn: string;
}
export interface CertificateRow {
  number: string;
  code: string;
  enrollmentId: string;
  studentId: string;
  groupId: string;
  courseName: string;
  studentName: string;
  issuedOn: string;
  completedOn: string;
  link: string;
  voided: boolean;
  voidReason: string;
  sentOn: string;
}

const MAX_NOTE = 1000;
const MAX_EXAM_NOTE = 500;

// ------------------------------------------------------------------ small helpers
function folder(): GoogleAppsScript.Drive.Folder {
  const found = DriveApp.getFoldersByName(FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER);
}

function storePdf(html: string, name: string): string {
  const pdf = Utilities.newBlob(html, "text/html", `${name}.html`).getAs("application/pdf").setName(`${name}.pdf`);
  return folder().createFile(pdf).getUrl();
}

const fileOf = (link: string): GoogleAppsScript.Drive.File => {
  const id = /\/d\/([\w-]+)/.exec(link)?.[1];
  if (!id) throw new Error("PDF havolasi noto'g'ri.");
  return DriveApp.getFileById(id);
};

function student(id: string): Student {
  const s = read<Student>(STUDENTS).find((x) => x.id === id);
  if (!s) throw new Error(`O'quvchi topilmadi: ${id}`);
  return s;
}
function group(id: string): Group {
  const g = read<Group>(GROUPS).find((x) => x.id === id);
  if (!g) throw new Error(`Guruh topilmadi: ${id}`);
  return g;
}
function assertEnrolled(studentId: string, groupId: string): Enrollment[] {
  const mine = read<Enrollment>(ENROLLMENTS).filter((e) => e.studentId === studentId && e.groupId === groupId);
  if (mine.length === 0) throw new Error("O'quvchi bu guruhga yozilmagan.");
  return mine;
}

/** A month typed as yyyy-mm (or a full date) -> the first day; never a month in the future. */
function pastMonth(text: string): string {
  const t = text.trim();
  const iso = /^\d{4}-(0[1-9]|1[0-2])$/.test(t) ? `${t}-01` : t;
  if (!isIsoDate(iso)) throw new Error(`Noto'g'ri oy: "${text}". Format: 2026-11`);
  const m = monthStart(iso);
  if (m > monthStart(today())) throw new Error("Kelajakdagi oy uchun hali baho, izoh yoki hisobot bo'lmaydi.");
  return m;
}

/** 12 random bytes from a random UUID (the platform's secure generator); the version and variant bytes are skipped. */
function randomBytes(): number[] {
  const hex = Utilities.getUuid().replace(/-/g, "");
  const out: number[] = [];
  for (let i = 0; i < 16 && out.length < 12; i++) if (i !== 6 && i !== 8) out.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return out;
}

// ------------------------------------------------------------------ notes and grades
export interface MarkInput {
  studentId: string;
  groupId: string;
  scope: "lesson" | "month";
  date: string; // lesson date, or any day of the month
  grade?: number | null;
  note?: string;
}

/** Writes or replaces the note/grade of a student for one lesson or one month. */
export function saveMark(a: MarkInput): MarkRow {
  return withLock(() => {
    student(a.studentId);
    group(a.groupId);
    assertEnrolled(a.studentId, a.groupId);
    const grade = a.grade ? Number(a.grade) : 0;
    if (grade !== 0 && !isValidGrade(grade)) throw new Error("Baho 1 dan 5 gacha butun son bo'lishi kerak.");
    const note = (a.note ?? "").trim();
    if (note.length > MAX_NOTE) throw new Error(`Izoh ${MAX_NOTE} belgidan oshmasin.`);
    if (grade === 0 && !note) throw new Error("Baho yoki izoh kerak (olib tashlash uchun menyudan 'Bahoni olib tashlash').");
    let date = a.date.trim();
    if (a.scope === "month") date = pastMonth(date);
    else if (!isIsoDate(date)) throw new Error(`Noto'g'ri sana: "${a.date}". Format: 2026-11-09`);
    const row: MarkRow = { scope: a.scope, date, groupId: a.groupId, studentId: a.studentId, grade, note, updatedOn: today() };
    replaceWhere<MarkRow>(MARKS, (r) => r.scope === a.scope && r.date === date && r.groupId === a.groupId && r.studentId === a.studentId, [row]);
    return row;
  });
}

export function removeMark(a: { studentId: string; groupId: string; scope: "lesson" | "month"; date: string }): void {
  withLock(() => {
    const date = a.scope === "month" ? monthStart(a.date) : a.date;
    const rows = read<MarkRow>(MARKS);
    const key = (r: MarkRow): boolean => r.scope === a.scope && r.date === date && r.groupId === a.groupId && r.studentId === a.studentId;
    if (!rows.some(key)) throw new Error("Bunday baho/izoh topilmadi.");
    replaceWhere<MarkRow>(MARKS, key, []);
  });
}

// ------------------------------------------------------------------ exams
export function addExam(a: { groupId: string; title: string; heldOn: string; maxScore: number }): ExamRow {
  return withLock(() => {
    group(a.groupId);
    const title = a.title.trim();
    if (!title || title.length > 200) throw new Error("Imtihon nomi 1-200 belgi bo'lsin.");
    if (!isIsoDate(a.heldOn)) throw new Error(`Noto'g'ri sana: "${a.heldOn}". Format: 2026-11-12`);
    if (!Number.isInteger(a.maxScore) || a.maxScore <= 0) throw new Error("Eng yuqori ball 0 dan katta butun son bo'lsin.");
    const exams = readIfPresent<ExamRow>(EXAMS);
    if (exams.some((e) => e.groupId === a.groupId && e.heldOn === a.heldOn && e.title.toLowerCase() === title.toLowerCase())) throw new Error("Bu guruhda shu sanada shunday nomli imtihon bor.");
    const row: ExamRow = { id: nextId("X", exams.map((e) => e.id)), groupId: a.groupId, title, heldOn: a.heldOn, maxScore: a.maxScore };
    append(EXAMS, [row]);
    return row;
  });
}

/** One score per student and exam (a repeat replaces it); never above the maximum; only for a student of the group. */
export function saveExamResult(a: { examId: string; studentId: string; score: number; note?: string }): ExamResultRow {
  return withLock(() => {
    const exam = read<ExamRow>(EXAMS).find((e) => e.id === a.examId);
    if (!exam) throw new Error(`Imtihon topilmadi: ${a.examId}`);
    student(a.studentId);
    assertEnrolled(a.studentId, exam.groupId);
    if (!Number.isInteger(a.score) || a.score < 0) throw new Error("Ball 0 yoki undan katta butun son bo'lsin.");
    if (a.score > exam.maxScore) throw new Error(`Ball eng yuqori balldan (${exam.maxScore}) oshmasin.`);
    const note = (a.note ?? "").trim();
    if (note.length > MAX_EXAM_NOTE) throw new Error(`Izoh ${MAX_EXAM_NOTE} belgidan oshmasin.`);
    const row: ExamResultRow = { examId: a.examId, studentId: a.studentId, score: a.score, note };
    replaceWhere<ExamResultRow>(EXAM_RESULTS, (r) => r.examId === a.examId && r.studentId === a.studentId, [row]);
    return row;
  });
}

export function examSummary(examId: string): string {
  const exam = read<ExamRow>(EXAMS).find((e) => e.id === examId);
  if (!exam) throw new Error(`Imtihon topilmadi: ${examId}`);
  const names = new Map(read<Student>(STUDENTS).map((s) => [s.id, s.fullName]));
  const rows = readIfPresent<ExamResultRow>(EXAM_RESULTS).filter((r) => r.examId === examId);
  const lines = rows.map((r) => `${names.get(r.studentId) ?? r.studentId}: ${r.score} / ${exam.maxScore} (${examPercent(r.score, exam.maxScore)}%)`);
  return `${exam.title} (${exam.heldOn}), eng yuqori ball ${exam.maxScore}\n${lines.length ? lines.join("\n") : "Hali natija kiritilmagan."}`;
}

// ------------------------------------------------------------------ monthly progress report
/** The facts of a student's month in a group (pure reads; nothing is written). */
export function reportSnapshot(studentId: string, groupId: string, month: string): ReportSnapshot {
  const s = student(studentId);
  const g = group(groupId);
  assertEnrolled(studentId, groupId);
  const att = readIfPresent<AttendanceRow>(ATTENDANCE).filter((a) => a.groupId === groupId && a.studentId === studentId && inMonth(a.date, month));
  const sum = attendanceSummary(att.map((a) => a.status));
  const marks = readIfPresent<MarkRow>(MARKS).filter((m) => m.groupId === groupId && m.studentId === studentId);
  const lessonMarks = marks.filter((m) => m.scope === "lesson" && inMonth(m.date, month)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const monthMark = marks.find((m) => m.scope === "month" && m.date === month);
  const grades = [...lessonMarks.map((m) => m.grade), ...(monthMark ? [monthMark.grade] : [])].filter((x) => x > 0);
  const lessons: ReportLesson[] = lessonMarks.map((m) => ({ date: m.date, grade: m.grade > 0 ? m.grade : null, note: m.note }));
  const results = readIfPresent<ExamResultRow>(EXAM_RESULTS).filter((r) => r.studentId === studentId);
  const exams: ReportExam[] = readIfPresent<ExamRow>(EXAMS)
    .filter((e) => e.groupId === groupId && inMonth(e.heldOn, month))
    .sort((a, b) => (a.heldOn < b.heldOn ? -1 : a.heldOn > b.heldOn ? 1 : a.id < b.id ? -1 : 1))
    .flatMap((e) => {
      const r = results.find((x) => x.examId === e.id);
      return r ? [{ title: e.title, heldOn: e.heldOn, score: r.score, maxScore: e.maxScore, percent: examPercent(r.score, e.maxScore) }] : [];
    });
  const settings = readSettings();
  return {
    centerName: settings.center, requisites: settings.requisites, studentName: s.fullName, groupName: g.name, periodMonth: month,
    monthLabel: monthLabel(Number(month.slice(0, 4)), Number(month.slice(5, 7))),
    present: sum.present, late: sum.late, absent: sum.absent, excused: sum.excused, attendancePercent: sum.percent,
    averageGrade: averageGrade(grades), monthGrade: monthMark && monthMark.grade > 0 ? monthMark.grade : null, monthNote: monthMark?.note ?? "",
    lessons, exams, generatedOn: today(),
  };
}

/** Creates (or, while it is still a draft, regenerates) the report. Never sends anything. */
export function makeReport(studentId: string, groupId: string, monthText: string): ReportRow {
  return withLock(() => makeReportLocked(studentId, groupId, monthText));
}

function makeReportLocked(studentId: string, groupId: string, monthText: string): ReportRow {
  const month = pastMonth(monthText);
  const snap = reportSnapshot(studentId, groupId, month);
  const all = readIfPresent<ReportRow>(REPORTS);
  const same = (r: ReportRow): boolean => r.studentId === studentId && r.groupId === groupId && r.month === month;
  const prev = all.find(same);
  if (prev?.status === "approved") throw new Error("Bu hisobot tasdiqlangan va yuborilgan: u o'zgarmaydi.");
  const id = prev?.id ?? nextId("R", all.map((r) => r.id));
  const link = storePdf(renderReportHtml(snap), `hisobot-${month.slice(0, 7)}-${studentId}-${groupId}`);
  const row: ReportRow = { id, month, groupId, studentId, status: "draft", percent: snap.attendancePercent === null ? "" : String(snap.attendancePercent), average: snap.averageGrade ?? "", link, generatedOn: today(), approvedOn: "" };
  if (prev) replaceWhere<ReportRow>(REPORTS, same, [row]);
  else append(REPORTS, [row]);
  return row;
}

/** Drafts for every trial/active student of the group; approved reports are left alone. */
export function makeGroupReports(groupId: string, monthText: string): { created: number; regenerated: number; skippedApproved: number } {
  return withLock(() => {
    group(groupId);
    const month = pastMonth(monthText);
    const ids = [...new Set(read<Enrollment>(ENROLLMENTS).filter((e) => e.groupId === groupId && (e.status === "active" || e.status === "trial")).map((e) => e.studentId))];
    const out = { created: 0, regenerated: 0, skippedApproved: 0 };
    for (const sid of ids) {
      const prev = readIfPresent<ReportRow>(REPORTS).find((r) => r.studentId === sid && r.groupId === groupId && r.month === month);
      if (prev?.status === "approved") out.skippedApproved++;
      else {
        makeReportLocked(sid, groupId, month);
        if (prev) out.regenerated++;
        else out.created++;
      }
    }
    return out;
  });
}

function assertDeliverable(s: Student): string {
  if (!getToken()) throw new Error("Avval Telegram botni sozlang: nazoratly > Telegram sozlash.");
  if (!s.consentNotify) throw new Error("Vasiy Telegram xabarlariga rozilik bermagan.");
  if (!s.guardianChatId) throw new Error("Vasiy Telegram botga ulanmagan.");
  return s.guardianChatId;
}

/** Approve and send: the confirmation dialog IS the approval. The report becomes final only after Telegram accepted it. */
export function approveReport(idArg?: string): string {
  const id = pickId(idArg, REPORTS.sheet, "Hisobotni tasdiqlab yuborish");
  return withLock(() => {
    const row = readIfPresent<ReportRow>(REPORTS).find((r) => r.id === id);
    if (!row) throw new Error(`Hisobot topilmadi: ${id}`);
    const s = student(row.studentId);
    const chat = assertDeliverable(s);
    const ans = ui().alert(
      "Hisobotni yuborish",
      `${row.month.slice(0, 7)} oylik hisobot ${s.guardianName || "vasiy"} ga (o'quvchi: ${s.fullName}) Telegramda yuboriladi.${row.status === "approved" ? `\n\nDiqqat: bu hisobot ${row.approvedOn} da allaqachon yuborilgan.` : ""}\n\nYuboraylikmi?`,
      ui().ButtonSet.YES_NO,
    );
    if (ans !== ui().Button.YES) throw new Error("Bekor qilindi.");
    const label = monthLabel(Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7)));
    const res = sendDocument(chat, fileOf(row.link).getBlob(), reportCaption(readSettings().center, s.fullName, label, row.percent === "" ? null : Number(row.percent), row.average || null));
    if (!res.ok) throw new Error(`Telegram xatosi: ${res.description ?? "noma'lum"}`);
    if (row.status === "draft") updateById(REPORTS, "id", row.id, { status: "approved", approvedOn: today() });
    return `${row.id} vasiyga yuborildi.`;
  });
}

// ------------------------------------------------------------------ certificates
export function issueCertificate(enrollmentId: string, completedOn?: string): CertificateRow {
  return withLock(() => {
    const e = read<Enrollment>(ENROLLMENTS).find((x) => x.id === enrollmentId);
    if (!e) throw new Error(`Yozilish topilmadi: ${enrollmentId}`);
    const all = readIfPresent<CertificateRow>(CERTIFICATES);
    const live = all.find((c) => c.enrollmentId === enrollmentId && !c.voided);
    if (live) return live; // one live certificate per enrollment
    const g = group(e.groupId);
    if (!certificateEligible(e.status, g.status)) throw new Error("Sertifikat tugatilgan kurs uchun beriladi: yozilish 'Tugagan' bo'lishi yoki faol yozilish tugagan guruhda bo'lishi kerak.");
    const t = today();
    const done = (completedOn ?? "").trim() || e.endedOn || t;
    if (!isIsoDate(done)) throw new Error(`Noto'g'ri sana: "${done}". Format: 2026-11-20`);
    if (done < e.startedOn || done > t) throw new Error("Tugatgan sana yozilish boshidan bugungi kungacha bo'lishi kerak.");
    const s = student(e.studentId);
    const year = Number(t.slice(0, 4));
    const serialKey = `CERT_SERIAL_${year}`;
    const serial = Number(props().getProperty(serialKey) ?? "0") + 1;
    props().setProperty(serialKey, String(serial));
    const number = certificateNumber(year, serial);
    const taken = new Set(all.map((c) => c.code));
    let code = "";
    for (let i = 0; i < 5 && !code; i++) {
      const c = newCertificateCode(randomBytes());
      if (!taken.has(c)) code = c;
    }
    if (!code) throw new Error("Kod yaratib bo'lmadi, qayta urinib ko'ring.");
    const settings = readSettings();
    const snap: CertificateSnapshot = {
      centerName: settings.center, requisites: settings.requisites, studentName: s.fullName, courseName: g.name, groupName: g.name,
      startedOn: e.startedOn, completedOn: done, issuedOn: t, number, code,
    };
    const link = storePdf(renderCertificateHtml(snap), number);
    const row: CertificateRow = { number, code, enrollmentId, studentId: e.studentId, groupId: e.groupId, courseName: g.name, studentName: s.fullName, issuedOn: t, completedOn: done, link, voided: false, voidReason: "", sentOn: "" };
    append(CERTIFICATES, [row]);
    return row;
  });
}

export function voidCertificate(number: string, reason: string): void {
  withLock(() => {
    const row = readIfPresent<CertificateRow>(CERTIFICATES).find((c) => c.number === number);
    if (!row) throw new Error(`Sertifikat topilmadi: ${number}`);
    if (row.voided) throw new Error("Sertifikat allaqachon bekor qilingan.");
    const why = reason.trim();
    if (!why || why.length > 500) throw new Error("Bekor qilish sababi 1-500 belgi bo'lsin.");
    updateById(CERTIFICATES, "number", number, { voided: true, voidReason: why });
  });
}

/** The certificate PDF to the guardian's Telegram, only after the person confirms the dialog. */
export function sendCertificate(numberArg?: string): string {
  const number = pickId(numberArg, CERTIFICATES.sheet, "Sertifikatni vasiyga yuborish");
  return withLock(() => {
    const row = readIfPresent<CertificateRow>(CERTIFICATES).find((c) => c.number === number);
    if (!row) throw new Error(`Sertifikat topilmadi: ${number}`);
    if (row.voided) throw new Error("Bekor qilingan sertifikat yuborilmaydi.");
    const s = student(row.studentId);
    const chat = assertDeliverable(s);
    const ans = ui().alert(
      "Sertifikatni yuborish",
      `${row.number} ${s.guardianName || "vasiy"} ga (o'quvchi: ${s.fullName}) Telegramda yuboriladi${row.sentOn ? `\n\nDiqqat: bu sertifikat ${row.sentOn} da allaqachon yuborilgan.` : ""}\n\nYuboraylikmi?`,
      ui().ButtonSet.YES_NO,
    );
    if (ans !== ui().Button.YES) throw new Error("Bekor qilindi.");
    const res = sendDocument(chat, fileOf(row.link).getBlob(), certificateCaption(readSettings().center, row.studentName, row.courseName, row.number, row.code));
    if (!res.ok) throw new Error(`Telegram xatosi: ${res.description ?? "noma'lum"}`);
    updateById(CERTIFICATES, "number", row.number, { sentOn: today() });
    return `${row.number} vasiyga yuborildi.`;
  });
}

export interface Verification {
  status: "valid" | "voided" | "unknown";
  number?: string;
  center?: string;
  course?: string;
  holder?: string; // masked
  issuedOn?: string;
  completedOn?: string;
}

/** Answers for any typed code. The holder's name is masked: it is a public check (see doGet in webhook.ts). */
export function verifyCertificate(text: string): Verification {
  const code = parseCertificateCode(text);
  const row = code ? readIfPresent<CertificateRow>(CERTIFICATES).find((c) => c.code === code) : undefined;
  if (!row) return { status: "unknown" };
  return {
    status: row.voided ? "voided" : "valid", number: row.number, center: readSettings().center, course: row.courseName,
    holder: maskName(row.studentName), issuedOn: row.issuedOn, completedOn: row.completedOn,
  };
}

// ------------------------------------------------------------------ menu (prompts)
function ask(title: string, label: string, optional = false): string {
  const r = ui().prompt(title, label, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  const v = r.getResponseText().trim();
  if (!v && !optional) throw new Error("Qiymat kiritilmadi.");
  return v;
}

const num = (text: string, what: string): number => {
  const n = Number(text.replace(/\s/g, ""));
  if (!Number.isFinite(n)) throw new Error(`${what} son bo'lishi kerak.`);
  return n;
};

function scopeAndDate(): { scope: "lesson" | "month"; date: string } {
  const v = ask("Baho / izoh", "Dars sanasi (yyyy-mm-dd) yoki oy (yyyy-mm):");
  return /^\d{4}-\d{2}$/.test(v) ? { scope: "month", date: `${v}-01` } : { scope: "lesson", date: v };
}

export const menu = {
  mark: (): void =>
    guard("Baho / izoh", () => {
      const studentId = pickId(undefined, STUDENTS.sheet, "Baho/izoh: o'quvchini tanlang");
      const groupId = ask("Baho / izoh", "Guruh ID (masalan G0001):");
      const { scope, date } = scopeAndDate();
      const g = ask("Baho / izoh", "Baho (1-5). Faqat izoh bo'lsa bo'sh qoldiring:", true);
      const note = ask("Baho / izoh", "Izoh (ixtiyoriy):", true);
      const row = saveMark({ studentId, groupId, scope, date, grade: g ? num(g, "Baho") : null, note });
      ui().alert("Baho / izoh", `Saqlandi: ${row.scope === "month" ? "oy" : "dars"} ${row.date}${row.grade ? `, baho ${row.grade}` : ""}.`, ui().ButtonSet.OK);
    }),
  removeMark: (): void =>
    guard("Bahoni olib tashlash", () => {
      const studentId = pickId(undefined, STUDENTS.sheet, "O'quvchini tanlang");
      const groupId = ask("Bahoni olib tashlash", "Guruh ID:");
      const { scope, date } = scopeAndDate();
      removeMark({ studentId, groupId, scope, date });
      ui().alert("Bahoni olib tashlash", "Olib tashlandi.", ui().ButtonSet.OK);
    }),
  examAdd: (): void =>
    guard("Imtihon qo'shish", () => {
      const groupId = pickId(undefined, GROUPS.sheet, "Imtihon: guruhni tanlang");
      const title = ask("Imtihon", "Imtihon nomi:");
      const heldOn = ask("Imtihon", "Sana (yyyy-mm-dd):");
      const maxScore = num(ask("Imtihon", "Eng yuqori ball (butun son):"), "Ball");
      const e = addExam({ groupId, title, heldOn, maxScore });
      ui().alert("Imtihon", `Imtihon qo'shildi: ${e.id}. Natijalar: nazoratly > Natijalar > Imtihon natijasini kiritish.`, ui().ButtonSet.OK);
    }),
  examScore: (): void =>
    guard("Imtihon natijasi", () => {
      const examId = pickId(undefined, EXAMS.sheet, "Imtihon natijasi: imtihonni tanlang");
      const studentId = ask("Imtihon natijasi", "O'quvchi ID (masalan S0001):");
      const score = num(ask("Imtihon natijasi", "Ball (butun son):"), "Ball");
      const note = ask("Imtihon natijasi", "Izoh (ixtiyoriy):", true);
      saveExamResult({ examId, studentId, score, note });
      ui().alert("Imtihon natijasi", examSummary(examId), ui().ButtonSet.OK);
    }),
  examView: (): void => guard("Imtihon natijalari", () => ui().alert("Imtihon natijalari", examSummary(pickId(undefined, EXAMS.sheet, "Imtihonni tanlang")), ui().ButtonSet.OK)),
  reportMake: (): void =>
    guard("Oylik hisobot", () => {
      const studentId = pickId(undefined, STUDENTS.sheet, "Oylik hisobot: o'quvchini tanlang");
      const groupId = ask("Oylik hisobot", "Guruh ID:");
      const month = ask("Oylik hisobot", "Oy (yyyy-mm):");
      const r = makeReport(studentId, groupId, month);
      ui().alert("Oylik hisobot", `Qoralama tayyor: ${r.id}. PDF "${FOLDER}" papkasida. Vasiyga yuborish uchun: Natijalar > Hisobotni tasdiqlab yuborish.`, ui().ButtonSet.OK);
    }),
  reportGroup: (): void =>
    guard("Guruh hisobotlari", () => {
      const groupId = pickId(undefined, GROUPS.sheet, "Hisobotlar: guruhni tanlang");
      const month = ask("Guruh hisobotlari", "Oy (yyyy-mm):");
      const r = makeGroupReports(groupId, month);
      ui().alert("Guruh hisobotlari", `Yangi qoralamalar: ${r.created}. Qayta yaratilgan: ${r.regenerated}. Tasdiqlangani uchun o'tkazib yuborilgan: ${r.skippedApproved}.\nHech narsa yuborilmadi.`, ui().ButtonSet.OK);
    }),
  reportSend: (): void => guard("Hisobot", () => ui().alert("Hisobot", approveReport(), ui().ButtonSet.OK)),
  certIssue: (): void =>
    guard("Sertifikat", () => {
      const enrollmentId = pickId(undefined, ENROLLMENTS.sheet, "Sertifikat: yozilishni tanlang");
      const done = ask("Sertifikat", "Tugatgan sana (yyyy-mm-dd). Bo'sh = yozilish tugagan sana yoki bugun:", true);
      const c = issueCertificate(enrollmentId, done || undefined);
      ui().alert("Sertifikat", `Raqam: ${c.number}. Tekshirish kodi: ${c.code}. PDF "${FOLDER}" papkasida, havola "Sertifikatlar" varag'ida.`, ui().ButtonSet.OK);
    }),
  certVoid: (): void =>
    guard("Sertifikatni bekor qilish", () => {
      const number = pickId(undefined, CERTIFICATES.sheet, "Bekor qilinadigan sertifikat");
      voidCertificate(number, ask("Sertifikatni bekor qilish", "Sabab:"));
      ui().alert("Sertifikat", "Bekor qilindi. Kod endi 'bekor qilingan' deb ko'rsatiladi.", ui().ButtonSet.OK);
    }),
  certSend: (): void => guard("Sertifikat", () => ui().alert("Sertifikat", sendCertificate(), ui().ButtonSet.OK)),
  certVerify: (): void =>
    guard("Sertifikatni tekshirish", () => {
      const v = verifyCertificate(ask("Sertifikatni tekshirish", "Tekshirish kodi (NZC-XXXX-XXXX-XXXX):"));
      const text =
        v.status === "unknown"
          ? "Bunday kodli sertifikat topilmadi."
          : `${v.status === "valid" ? "HAQIQIY" : "BEKOR QILINGAN"}: ${v.number}\n${v.center}\nKurs: ${v.course}\nEgasi: ${v.holder}\nBerilgan: ${v.issuedOn}, tugatgan: ${v.completedOn}`;
      ui().alert("Sertifikatni tekshirish", text, ui().ButtonSet.OK);
    }),
};

/** The public check behind `doGet?verify=CODE`: JSON, holder masked, nothing else leaves the workbook. */
export function verifyJson(text: string): string {
  const v = verifyCertificate(text);
  return JSON.stringify(v.status === "unknown" ? { valid: false, status: "unknown" } : { valid: v.status === "valid", ...v });
}
