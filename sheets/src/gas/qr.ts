/** QR attendance: student QR codes and printable cards (PDF in Drive), sending a card to a guardian, and the scan that
 * marks `present`. Rules live in ../domain/qr.ts (shared with the API through tests/golden/qr.json); the encoder in
 * ../domain/qrcode.ts is checked by decoding it with an independent decoder. A scan never changes anything but one
 * attendance mark, and manual marking stays as it is. */
import { isIsoDate } from "../domain/dates";
import { newCode, parsePayload, qrPayload, scanDecision, type ScanResult } from "../domain/qr";
import { qrSvg } from "../domain/qrcode";
import type { AttendanceRow, Enrollment, Group, Student } from "../domain/types";
import { getAttendanceGroups, guard, rosterFor, withLock } from "./actions";
import { pickId } from "./pick";
import { append, read, replaceWhere, today, updateById, updateMany } from "./repo";
import { ATTENDANCE, ENROLLMENTS, GROUPS, STUDENTS } from "./schema";
import { readSettings } from "./settings";
import { getToken, sendDocument } from "./telegram";
import { syncAttendance } from "./makeup";

const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const FOLDER = "nazoratly QR kartalar";
type StudentRow = Student & { phone?: string };

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** 20 random bytes from two random UUIDs (the platform's secure generator). */
function randomBytes(): number[] {
  const hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length && out.length < 20; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function freshCode(taken: Set<string>): string {
  for (let i = 0; i < 5; i++) {
    const c = newCode(randomBytes());
    if (!taken.has(c)) {
      taken.add(c);
      return c;
    }
  }
  throw new Error("QR kod yaratib bo'lmadi, qayta urinib ko'ring.");
}

/** Gives every student who has no code one; returns the students that were issued a code. */
export function ensureQrCodes(onlyIds?: Set<string>): string[] {
  return withLock(() => {
    const students = read<StudentRow>(STUDENTS);
    const taken = new Set(students.map((s) => s.qrCode ?? "").filter(Boolean));
    const issued: string[] = [];
    const patches = new Map<string, Record<string, unknown>>();
    for (const s of students) {
      if (s.qrCode || s.status === "left" || (onlyIds && !onlyIds.has(s.id))) continue;
      patches.set(s.id, { qrCode: freshCode(taken) });
      issued.push(s.id);
    }
    updateMany(STUDENTS, "id", patches); // one write for any number of students (see updateMany)
    return issued;
  });
}

/** Replaces the code of one student (a lost card): the old card stops working at once. */
export function rotateQr(studentArg?: string): string {
  const id = pickId(studentArg, STUDENTS.sheet, "Qaysi o'quvchining QR kartasini almashtiramiz?");
  return withLock(() => {
    const students = read<StudentRow>(STUDENTS);
    const s = students.find((x) => x.id === id);
    if (!s) throw new Error(`O'quvchi topilmadi: ${id}`);
    const code = freshCode(new Set(students.map((x) => x.qrCode ?? "")));
    updateById(STUDENTS, "id", id, { qrCode: code });
    return `${s.fullName}: yangi QR kod berildi. Eski karta endi ishlamaydi. Yangi kartani chop eting.`;
  });
}

export interface Card {
  name: string;
  code: string;
  group?: string;
}

export function cardsHtml(cards: Card[], center: string): string {
  const one = (c: Card): string =>
    `<div class="card"><div class="qr">${qrSvg(qrPayload(c.code), 4)}</div><div class="txt"><div class="center">${esc(center)}</div><div class="name">${esc(c.name)}</div>${c.group ? `<div class="grp">${esc(c.group)}</div>` : ""}<div class="hint">Darsga kirishda shu kodni skanerlang</div><div class="code">${esc(c.code)}</div></div></div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 10mm; }
body { font-family: Arial, sans-serif; margin: 0; }
.sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.card { box-sizing: border-box; border: 1px dashed #999; padding: 4mm; height: 62mm; display: flex; gap: 4mm; align-items: center; page-break-inside: avoid; }
.qr svg { width: 38mm; height: 38mm; display: block; }
.txt { flex: 1; min-width: 0; }
.center { font-weight: bold; font-size: 10pt; } .name { font-weight: bold; font-size: 13pt; margin-top: 3mm; } .grp { font-size: 9pt; color: #444; margin-top: 1mm; }
.hint { font-size: 8pt; color: #444; margin-top: 4mm; } .code { font-size: 6.5pt; color: #777; margin-top: 3mm; word-break: break-all; }
</style></head><body><div class="sheet">${cards.map(one).join("")}</div></body></html>`;
}

function folder(): GoogleAppsScript.Drive.Folder {
  const found = DriveApp.getFoldersByName(FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER);
}

function pdfOf(html: string, name: string): GoogleAppsScript.Base.Blob {
  return Utilities.newBlob(html, "text/html", `${name}.html`).getAs("application/pdf").setName(`${name}.pdf`);
}

/** Cards of every active and trial student of a group (codes are issued first); the PDF is saved in Drive. */
export function qrCards(groupArg?: string): string {
  const gid = pickId(groupArg, GROUPS.sheet, "Qaysi guruh uchun QR kartalar? (G0001)");
  const group = read<Group>(GROUPS).find((g) => g.id === gid);
  if (!group) throw new Error(`Guruh topilmadi: ${gid}`);
  const members = new Set(read<Enrollment>(ENROLLMENTS).filter((e) => e.groupId === gid && (e.status === "active" || e.status === "trial")).map((e) => e.studentId));
  if (members.size === 0) throw new Error("Guruhda faol o'quvchi yo'q.");
  const issued = ensureQrCodes(members);
  const students = read<StudentRow>(STUDENTS).filter((s) => members.has(s.id) && s.status !== "left").sort((a, b) => a.fullName.localeCompare(b.fullName));
  const html = cardsHtml(students.map((s) => ({ name: s.fullName, code: s.qrCode as string, group: group.name })), readSettings().center);
  const file = folder().createFile(pdfOf(html, `QR-${group.id}-${today()}`));
  return `${students.length} ta karta tayyor (${issued.length} ta yangi kod berildi).\n\nPDF: ${file.getUrl()}\n\nChop eting va o'quvchilarga bering. Karta yo'qolsa: QR kartani almashtirish.`;
}

/** The card of one student to the guardian's Telegram; a person confirms first (consent and chat are required). */
export function sendQrCard(studentArg?: string): string {
  const id = pickId(studentArg, STUDENTS.sheet, "Qaysi o'quvchining QR kartasini vasiyga yuboramiz?");
  return withLock(() => {
    if (!getToken()) throw new Error("Avval Telegram botni sozlang: nazoratly > Telegram sozlash.");
    const s = read<StudentRow>(STUDENTS).find((x) => x.id === id);
    if (!s) throw new Error(`O'quvchi topilmadi: ${id}`);
    if (!s.consentNotify) throw new Error("Vasiy Telegram xabarlariga rozilik bermagan.");
    if (!s.guardianChatId) throw new Error("Vasiy Telegram botga ulanmagan.");
    const ans = ui().alert("QR kartani yuborish", `${s.fullName} uchun QR karta ${s.guardianName || "vasiy"} ga Telegramda yuboriladi.\n\nYuboraylikmi?`, ui().ButtonSet.YES_NO);
    if (ans !== ui().Button.YES) throw new Error("Bekor qilindi.");
    ensureQrCodes(new Set([id]));
    const fresh = read<StudentRow>(STUDENTS).find((x) => x.id === id) as StudentRow;
    const center = readSettings().center;
    const blob = pdfOf(cardsHtml([{ name: fresh.fullName, code: fresh.qrCode as string }], center), `QR-${id}`);
    const sent = sendDocument(fresh.guardianChatId, blob, `${fresh.fullName} uchun davomat QR kartasi. Darsga kirishda shu kodni skanerlang. ${center}`.trim());
    if (!sent.ok) throw new Error(`Telegram xatosi: ${sent.description ?? "noma'lum"}`);
    return `${fresh.fullName} uchun QR karta vasiyga yuborildi.`;
  });
}

export interface ScanOut {
  result: ScanResult;
  studentName?: string;
  status?: string;
  previous?: string | null;
}

/** One scan: `present` when the student is in the group's roll call of that date; an existing present/late is kept. */
export function scanQr(input: { code: string; groupId: string; date: string }): ScanOut {
  if (!isIsoDate(input.date)) throw new Error("Sana noto'g'ri");
  if (!getAttendanceGroups().some((g) => g.id === input.groupId)) throw new Error("Guruh topilmadi yoki faol emas");
  return withLock(() => {
    const parsed = parsePayload(input.code);
    const student = parsed ? read<StudentRow>(STUDENTS).find((s) => s.qrCode === parsed) : undefined;
    const inRoster = !!student && rosterFor(input.groupId, input.date).some((r) => r.studentId === student.id);
    const marks = read<AttendanceRow>(ATTENDANCE).filter((a) => a.groupId === input.groupId && a.date === input.date);
    const existing = student ? (marks.find((a) => a.studentId === student.id)?.status ?? null) : null;
    const d = scanDecision({ codeText: input.code, known: !!student, lessonStatus: "planned", inRoster, existing });
    const base: ScanOut = { result: d.result, ...(student ? { studentName: student.fullName } : {}), previous: d.previous };
    if (!d.write || !student) return { ...base, ...(d.result === "already_present" ? { status: d.previous ?? "present" } : {}) };
    const row = { date: input.date, groupId: input.groupId, studentId: student.id, status: "present" as const, minutesLate: 0 };
    if (existing === null) append(ATTENDANCE, [row]);
    else replaceWhere<AttendanceRow>(ATTENDANCE, (a) => a.date === input.date && a.groupId === input.groupId, [...marks.filter((m) => m.studentId !== student.id), row]);
    syncAttendance(input.date, input.groupId, [{ studentId: student.id, status: "present" }]);
    return { ...base, status: "present" };
  });
}

export const menu = {
  cards: (): void => guard("QR kartalar", () => ui().alert("QR kartalar", qrCards(), ui().ButtonSet.OK)),
  send: (): void => guard("QR karta", () => ui().alert("QR karta", sendQrCard(), ui().ButtonSet.OK)),
  rotate: (): void => guard("QR karta", () => ui().alert("QR karta", rotateQr(), ui().ButtonSet.OK)),
  issue: (): void => guard("QR kodlar", () => ui().alert("QR kodlar", `${ensureQrCodes().length} ta o'quvchiga QR kod berildi.`, ui().ButtonSet.OK)),
};

