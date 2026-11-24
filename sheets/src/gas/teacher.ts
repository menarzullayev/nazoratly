/** Teacher app, Sheets edition (G8): the owner invites a teacher with a one-time code, the teacher links a Telegram chat with it
 * and works through the bot: today's lessons and roll call by buttons, own groups, the week, hours and pay, and direct messages
 * to guardians (own groups only, a daily limit, templates or free text, every message logged, the owner can switch the right
 * off per teacher). Reminders are internal: a teacher whose lesson has no roll call after X hours, and the owner's end-of-day
 * list. Nothing is ever sent to a guardian by automation: only by a teacher's own tap or reply. The rules are in
 * ../domain/teacher.ts (shared with the API through tests/golden/teacher.json).
 * Mini App and email login exist only in the API product: a Sheet has no accounts. New OAuth scope: script.scriptapp (the
 * optional hourly trigger of the reminders). */
import { expandLessons, type CalendarLesson, type Room, type ScheduleChange } from "../domain/calendar";
import { computeDebts } from "../domain/debt";
import { isIsoDate } from "../domain/dates";
import { nextId } from "../domain/ids";
import { collectedTuition } from "../domain/payroll";
import { toMinutes, weekRange } from "../domain/schedule";
import { sha256Hex } from "../domain/sha256";
import * as R from "../domain/teacher";
import type { AttendanceRow, Enrollment, Group, Refund, Student, Teacher } from "../domain/types";
import { getRoster, loadFinance, saveAttendance, withLock } from "./actions";
import { append, read, readIfPresent, today, updateById } from "./repo";
import { ATTENDANCE, ENROLLMENTS, GROUPS, PAYROLL, REFUNDS, ROOMS, SCHEDULE_CHANGES, STUDENTS, TEACHER_INVITES, TEACHER_MESSAGES, TEACHER_NOTICES, TEACHERS } from "./schema";
import { readSettings } from "./settings";
import { sendMessage, tg } from "./telegram";

export type TeacherRow = Teacher & { telegramChatId?: string; msgOff?: boolean };
interface InviteRow {
  id: string;
  teacherId: string;
  codeHash: string;
  status: "pending" | "used" | "revoked";
  expiresAt: string;
  createdOn: string;
  usedOn: string;
}
interface NoticeRow {
  key: string;
  kind: "lesson" | "digest";
  date: string;
  text: string;
}
interface MessageRow {
  at: string;
  date: string;
  teacherId: string;
  studentId: string;
  groupId: string;
  template: string;
  body: string;
}
type StudentRow = Student;

const tz = (): string => SpreadsheetApp.getActive().getSpreadsheetTimeZone();
/** The center's local wall-clock time as "yyyy-MM-ddTHH:mm" (the rules work on local naive timestamps). */
export const nowStamp = (): string => Utilities.formatDate(new Date(), tz(), "yyyy-MM-dd'T'HH:mm");
const addDays = (d: string, n: number): string => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) + n * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ lessons of the Sheets edition (derived, see domain/calendar.ts)
function lessonsBetween(from: string, to: string): CalendarLesson[] {
  const groups = read<Group>(GROUPS);
  const enrolled = new Map<string, number>();
  return expandLessons({ groups, rooms: readIfPresent<Room>(ROOMS), changes: readIfPresent<ScheduleChange>(SCHEDULE_CHANGES), from, to, enrolled }).lessons.filter((l) => groups.find((g) => g.id === l.groupId)?.status === "active");
}
const markedKeys = (): Map<string, number> => {
  const m = new Map<string, number>();
  for (const a of read<AttendanceRow>(ATTENDANCE)) m.set(`${a.groupId}|${a.date}`, (m.get(`${a.groupId}|${a.date}`) ?? 0) + 1);
  return m;
};

// ------------------------------------------------------------------ invitations
function newCode(): string {
  const bytes = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
  let body = "";
  for (let i = 0; i < R.INVITE_LEN; i++) body += R.INVITE_ALPHABET[Number.parseInt(bytes.slice(i * 2, i * 2 + 2), 16) % R.INVITE_ALPHABET.length];
  return R.formatInviteCode(body);
}

/** A new one-time code for a teacher (an older open code of the same teacher is cancelled). Only the hash is stored. */
export function createInvite(teacherId: string, now: string = nowStamp()): { code: string; expiresAt: string } {
  return withLock(() => {
    const t = read<TeacherRow>(TEACHERS).find((x) => x.id === teacherId);
    if (!t) throw new Error(`${teacherId}: o'qituvchi topilmadi`);
    if (t.status !== "active") throw new Error("Nofaol o'qituvchini taklif qilib bo'lmaydi");
    if (t.telegramChatId) throw new Error("Bu ustoz allaqachon botga ulangan");
    const code = newCode();
    const rows = readIfPresent<InviteRow>(TEACHER_INVITES);
    for (const r of rows) if (r.teacherId === teacherId && r.status === "pending") updateById(TEACHER_INVITES, "id", r.id, { status: "revoked" });
    const expiresAt = R.inviteExpiresAt(now);
    append(TEACHER_INVITES, [{ id: nextId("U", rows.map((r) => r.id)), teacherId, codeHash: sha256Hex(code), status: "pending", expiresAt, createdOn: today(), usedOn: "" }]);
    return { code, expiresAt };
  });
}

export type AcceptResult =
  | { ok: true; teacher: TeacherRow }
  | { ok: false; reason: "bad_code" | "unknown" | "used" | "revoked" | "expired" | "teacher_already_linked" | "chat_already_teacher" };

/** The teacher's Telegram chat takes the invitation. One chat is one teacher, one teacher is one chat. */
export function acceptInvite(codeText: string, chatId: string, now: string = nowStamp()): AcceptResult {
  const code = R.normalizeInviteCode(codeText);
  if (code === null) return { ok: false, reason: "bad_code" };
  return withLock(() => {
    const inv = readIfPresent<InviteRow>(TEACHER_INVITES).find((r) => r.codeHash === sha256Hex(code));
    if (!inv) return { ok: false, reason: "unknown" } as const;
    const state = R.inviteState(inv.status, inv.expiresAt, now);
    if (state !== "valid") return { ok: false, reason: state } as const;
    const teachers = read<TeacherRow>(TEACHERS);
    const t = teachers.find((x) => x.id === inv.teacherId);
    if (!t) return { ok: false, reason: "unknown" } as const;
    if (t.telegramChatId && t.telegramChatId !== chatId) return { ok: false, reason: "teacher_already_linked" } as const;
    if (teachers.some((x) => x.id !== t.id && x.telegramChatId === chatId)) return { ok: false, reason: "chat_already_teacher" } as const;
    updateById(TEACHERS, "id", t.id, { telegramChatId: chatId });
    updateById(TEACHER_INVITES, "id", inv.id, { status: "used", usedOn: today() });
    return { ok: true, teacher: { ...t, telegramChatId: chatId } } as const;
  });
}

// ------------------------------------------------------------------ unmarked lessons and the reminders
export interface UnmarkedItem extends R.Unmarked {
  lesson: CalendarLesson;
}

/** Finished lessons of the last 7 days (up to `now`) that nobody has marked, with the rule's state. */
export function unmarkedNow(now: string = nowStamp(), afterHours: number = readSettings().teacherReminderHours): UnmarkedItem[] {
  const day = now.slice(0, 10);
  const lessons = lessonsBetween(addDays(day, -7), day);
  const marks = markedKeys();
  const sent = new Set(readIfPresent<NoticeRow>(TEACHER_NOTICES).map((n) => n.key));
  const facts: R.LessonFact[] = lessons.map((l) => ({ id: l.key, date: l.date, end_time: l.end, status: l.cancelled ? "cancelled" : "planned", marked: marks.get(`${l.groupId}|${l.date}`) ?? 0, reminded: sent.has(`lesson:${l.key}`) }));
  const byKey = new Map(lessons.map((l) => [l.key, l]));
  return R.unmarkedLessons(facts, now, afterHours).map((u) => ({ ...u, lesson: byKey.get(u.id)! }));
}

/** One reminder pass: a reminder to each teacher whose lesson is still unmarked after the wait, and (after the digest time)
 * the owner's list of today's unmarked lessons, once. Internal messages only. Safe to repeat: a sent notice is recorded. */
export function reminderPass(now: string = nowStamp()): { teacherReminders: number; digests: number; skipped: string[] } {
  const s = readSettings();
  const items = unmarkedNow(now, s.teacherReminderHours);
  const teachers = read<TeacherRow>(TEACHERS);
  const notices = new Set(readIfPresent<NoticeRow>(TEACHER_NOTICES).map((n) => n.key));
  const skipped: string[] = [];
  let teacherReminders = 0;
  let digests = 0;
  for (const u of items) {
    if (u.state !== "reminder_due") continue;
    const l = u.lesson;
    const t = teachers.find((x) => x.id === l.teacherId);
    if (!t?.telegramChatId) {
      skipped.push(`${l.groupName} ${l.date} ${l.start}: ustoz botga ulanmagan`);
      continue;
    }
    const text = R.reminderText(l.groupName, l.date, l.start, l.end);
    if (!sendMessage(t.telegramChatId, text).ok) {
      skipped.push(`${l.groupName} ${l.date} ${l.start}: yuborilmadi`);
      continue;
    }
    withLock(() => append(TEACHER_NOTICES, [{ key: `lesson:${l.key}`, kind: "lesson", date: l.date, text }]));
    notices.add(`lesson:${l.key}`);
    teacherReminders++;
  }
  const day = now.slice(0, 10);
  const todays = items.filter((u) => u.lesson.date === day);
  const digestKey = `digest:${day}`;
  if (R.digestDue(now, s.teacherDigestAfter, todays.length, notices.has(digestKey))) {
    if (!s.ownerChatId) {
      skipped.push("Kun yakuni: egasining Telegram chat ID si Sozlamalarda yo'q");
    } else {
      const teacherName = new Map(teachers.map((t) => [t.id, t.fullName]));
      const text = R.digestText(day, todays.map((u) => ({ start: u.lesson.start, end: u.lesson.end, group: u.lesson.groupName, teacher: teacherName.get(u.lesson.teacherId) ?? "" })));
      if (sendMessage(s.ownerChatId, text).ok) {
        withLock(() => append(TEACHER_NOTICES, [{ key: digestKey, kind: "digest", date: day, text }]));
        digests = 1;
      } else skipped.push("Kun yakuni egasiga yuborilmadi");
    }
  }
  return { teacherReminders, digests, skipped };
}

// ------------------------------------------------------------------ hours and pay
export function monthFor(t: TeacherRow, month: string): R.MonthSummary & { payroll: { status: string; total: number } | null } {
  const first = `${month.slice(0, 7)}-01`;
  const last = addDays(`${addMonth(first)}`, -1);
  const marks = markedKeys();
  const minutes = lessonsBetween(first, last)
    .filter((l) => !l.cancelled && l.teacherId === t.id && (marks.get(`${l.groupId}|${l.date}`) ?? 0) > 0)
    .map((l) => toMinutes(l.end) - toMinutes(l.start));
  let collected = 0;
  if (t.payModel === "percent") {
    const { charges, payments, installments } = loadFinance();
    const { balances } = computeDebts(charges, payments, today(), installments, readIfPresent<Refund>(REFUNDS));
    collected = collectedTuition(balances, read<Enrollment>(ENROLLMENTS), read<Group>(GROUPS), t.id, first);
  }
  const summary = R.monthSummary(minutes, t.payModel, String(t.payRate), String(collected));
  const pr = readIfPresent<{ month: string; teacherId: string; status: string; total: number }>(PAYROLL).find((r) => r.month === first && r.teacherId === t.id);
  return { ...summary, payroll: pr ? { status: pr.status, total: pr.total } : null };
}
const addMonth = (first: string): string => {
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};

// ------------------------------------------------------------------ messages to guardians
export const messagesToday = (teacherId: string, day: string = today()): number => readIfPresent<MessageRow>(TEACHER_MESSAGES).filter((m) => m.teacherId === teacherId && m.date === day).length;

export type SendResult = { ok: true; left: number } | { ok: false; error: R.MessageError | "send_failed" | "unknown_student" };

/** A teacher writes to the guardian of a student of an own group. Returns the rule's error or the Telegram failure. */
export function sendGuardianMessage(t: TeacherRow, studentId: string, template: string | null, freeText: string | null, now: string = nowStamp()): SendResult {
  const day = now.slice(0, 10);
  const s = readSettings();
  const student = read<StudentRow>(STUDENTS).find((x) => x.id === studentId && x.status !== "left");
  if (!student) return { ok: false, error: "unknown_student" };
  const group = read<Group>(GROUPS).find((g) => g.teacherId === t.id && g.status === "active" && read<Enrollment>(ENROLLMENTS).some((e) => e.groupId === g.id && e.studentId === studentId && e.status === "active"));
  const reachable = !!student.guardianChatId && student.consentNotify;
  let body = (freeText ?? "").trim();
  if (template !== null) body = group ? (R.renderTemplate(template, student.fullName, group.name, day) ?? "") : "x";
  const sent = messagesToday(t.id, day);
  const verdict = R.checkMessage({ enabled: !t.msgOff, own_student: !!group, text: body, recipients: reachable ? 1 : 0, sent_today: sent, limit: s.teacherDailyLimit });
  if (!verdict.ok) return { ok: false, error: verdict.error };
  const final = R.signedText(body, t.fullName, s.center);
  if (!sendMessage(student.guardianChatId, final).ok) return { ok: false, error: "send_failed" };
  withLock(() => append(TEACHER_MESSAGES, [{ at: now.replace("T", " "), date: day, teacherId: t.id, studentId, groupId: group!.id, template: template ?? "", body: final }]));
  return { ok: true, left: s.teacherDailyLimit - sent - 1 };
}

// ------------------------------------------------------------------ the bot
const HELP = "Ustoz boti buyruqlari:\n/bugun - bugungi darslar va davomat\n/guruhlar - mening guruhlarim\n/jadval - shu haftaning jadvali\n/oylik - soatlar va oylik\n/xabar - vasiyga xabar yozish\n/yordam - shu ro'yxat";
const LINK_ERRORS: Record<string, string> = {
  bad_code: "Taklif kodi T-XXXXXXXX ko'rinishida bo'ladi. Kodni tekshiring.",
  unknown: "Bunday taklif kodi topilmadi. Kodni tekshiring.",
  used: "Bu kod allaqachon ishlatilgan. Markazdan yangisini so'rang.",
  revoked: "Bu taklif bekor qilingan. Markazdan yangisini so'rang.",
  expired: "Taklifning muddati tugagan. Markazdan yangisini so'rang.",
  teacher_already_linked: "Bu o'qituvchi allaqachon boshqa Telegram hisobiga ulangan.",
  chat_already_teacher: "Bu Telegram hisobi boshqa o'qituvchiga ulangan.",
};
const MESSAGE_ERRORS: Record<string, string> = {
  right_off: "Sizga vasiylarga yozish huquqi o'chirilgan.",
  not_own_student: "Bu o'quvchi sizning guruhingizda emas.",
  no_recipient: "Bu o'quvchining vasiysiga Telegram orqali yozib bo'lmaydi (ulanmagan yoki rozilik yo'q).",
  daily_limit: "Bugungi xabarlar limiti tugadi.",
  empty_text: "Xabar bo'sh.",
  text_too_long: `Xabar ${R.MAX_TEXT} belgidan uzun.`,
  send_failed: "Telegram xabarni qabul qilmadi. Keyinroq urinib ko'ring.",
  unknown_student: "O'quvchi topilmadi.",
};
const ICON: Record<string, string> = { present: "✅", absent: "❌", late: "⏰", excused: "🟡", "": "▫️" };
const CODES: Record<string, AttendanceRow["status"]> = { p: "present", a: "absent", l: "late", e: "excused" };
const PAGE = 8;
type Markup = { inline_keyboard: { text: string; callback_data: string }[][] };
const kb = (rows: [string, string][][]): Markup => ({ inline_keyboard: rows.map((r) => r.map(([text, callback_data]) => ({ text, callback_data }))) });

interface RawUpdate {
  message?: { text?: string; from?: { id?: number }; chat?: { id?: number; type?: string }; reply_to_message?: { text?: string } };
  callback_query?: { id?: string; data?: string; from?: { id?: number }; message?: { message_id?: number; chat?: { id?: number; type?: string } } };
}

const say = (chatId: string, text: string, markup?: Markup): void => void sendMessage(chatId, text, markup ? { reply_markup: markup } : {});
const edit = (chatId: string, messageId: number, text: string, markup?: Markup): void => void tg("editMessageText", { chat_id: chatId, message_id: messageId, text, ...(markup ? { reply_markup: markup } : {}) });
const answer = (id: string, text?: string): void => void tg("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
const lessonCb = (l: CalendarLesson): string => `l:${l.groupId}:${l.date}:${l.start.replace(":", "")}`;

function ownLesson(t: TeacherRow, groupId: string, date: string, start4: string): CalendarLesson | null {
  if (!isIsoDate(date) || !/^\d{4}$/.test(start4)) return null;
  const start = `${start4.slice(0, 2)}:${start4.slice(2)}`;
  return lessonsBetween(date, date).find((l) => l.groupId === groupId && l.date === date && l.start === start && l.teacherId === t.id && !l.cancelled) ?? null;
}

function rosterView(t: TeacherRow, l: CalendarLesson, page: number): { text: string; markup: Markup } {
  const roster = getRoster(l.groupId, l.date);
  const pages = Math.max(1, Math.ceil(roster.length / PAGE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const rows: [string, string][][] = [];
  for (const r of roster.slice(p * PAGE, (p + 1) * PAGE)) {
    rows.push([[`${ICON[r.status]} ${r.fullName}`.slice(0, 40), "tn"]]);
    rows.push((["p", "a", "l", "e"] as const).map((c) => [ICON[CODES[c]!]!, `a:${l.groupId}:${l.date}:${r.studentId}:${c}:${p}`] as [string, string]));
  }
  const nav: [string, string][] = [];
  if (p > 0) nav.push(["⬅️", `r:${l.groupId}:${l.date}:${l.start.replace(":", "")}:${p - 1}`]);
  if (p < pages - 1) nav.push(["➡️", `r:${l.groupId}:${l.date}:${l.start.replace(":", "")}:${p + 1}`]);
  if (nav.length) rows.push(nav);
  const marked = roster.filter((r) => r.status).length;
  void t;
  return { text: `${l.groupName} ${l.start}-${l.end}: davomat (${marked}/${roster.length} belgilangan, ${p + 1}/${pages})\n✅ keldi  ❌ kelmadi  ⏰ kechikdi  🟡 sababli`, markup: kb(rows) };
}

function showToday(chat: string, t: TeacherRow): void {
  const day = today();
  const marks = markedKeys();
  const lessons = lessonsBetween(day, day).filter((l) => l.teacherId === t.id);
  if (!lessons.length) return say(chat, "Bugun darsingiz yo'q.");
  const lines = [`Bugungi darslar (${day}):`];
  const buttons: [string, string][][] = [];
  for (const l of lessons) {
    const m = marks.get(`${l.groupId}|${l.date}`) ?? 0;
    lines.push(`${l.start}-${l.end} ${l.groupName} (${l.cancelled ? "bekor" : m ? `${m} belgilangan` : "belgilanmagan"})`);
    if (!l.cancelled) buttons.push([[`📋 ${l.start} ${l.groupName}`, lessonCb(l)]]);
  }
  say(chat, lines.join("\n"), buttons.length ? kb(buttons) : undefined);
}

function showGroups(chat: string, t: TeacherRow): void {
  const groups = read<Group>(GROUPS).filter((g) => g.teacherId === t.id && (g.status === "active" || g.status === "planned"));
  if (!groups.length) return say(chat, "Sizga biriktirilgan guruh yo'q.");
  const en = read<Enrollment>(ENROLLMENTS);
  say(chat, "Guruhlarim:\n" + groups.map((g) => `• ${g.name}: ${en.filter((e) => e.groupId === g.id && e.status === "active").length} o'quvchi`).join("\n"));
}

function showWeek(chat: string, t: TeacherRow): void {
  const { monday, sunday } = weekRange(today());
  const lessons = lessonsBetween(monday, sunday).filter((l) => l.teacherId === t.id);
  if (!lessons.length) return say(chat, "Bu hafta darsingiz yo'q.");
  const lines = ["Shu hafta:"];
  let day = "";
  for (const l of lessons) {
    if (l.date !== day) {
      day = l.date;
      lines.push(`\n${day}:`);
    }
    lines.push(`  ${l.start}-${l.end} ${l.groupName}${l.cancelled ? " (bekor)" : ""}`);
  }
  say(chat, lines.join("\n"));
}

function showPay(chat: string, t: TeacherRow): void {
  const m = monthFor(t, today());
  const lines = [`${today().slice(0, 7)}: ${m.lessons} ta dars, ${m.hours} soat.`, `Taxminiy oylik: ${String(m.estimate).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} so'm`];
  if (m.payroll) lines.push(`Hisoblangan oylik (${({ draft: "qoralama", approved: "tasdiqlangan", paid: "to'langan" } as Record<string, string>)[m.payroll.status] ?? m.payroll.status}): ${String(m.payroll.total).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} so'm`);
  say(chat, lines.join("\n"));
}

function messageGroups(chat: string, t: TeacherRow): void {
  if (t.msgOff) return say(chat, MESSAGE_ERRORS.right_off!);
  const groups = read<Group>(GROUPS).filter((g) => g.teacherId === t.id && g.status === "active");
  if (!groups.length) return say(chat, "Sizga biriktirilgan guruh yo'q.");
  const left = Math.max(0, readSettings().teacherDailyLimit - messagesToday(t.id));
  say(chat, `Qaysi guruh? (bugun yana ${left} ta xabar yuborish mumkin)`, kb(groups.map((g) => [[g.name, `m1:${g.id}`] as [string, string]])));
}

function messageStudents(chat: string, t: TeacherRow, groupId: string): string {
  const g = read<Group>(GROUPS).find((x) => x.id === groupId && x.teacherId === t.id);
  if (!g) return MESSAGE_ERRORS.not_own_student!;
  const students = new Map(read<StudentRow>(STUDENTS).map((s) => [s.id, s]));
  const rows = read<Enrollment>(ENROLLMENTS).filter((e) => e.groupId === g.id && e.status === "active").map((e) => students.get(e.studentId)).filter((s): s is StudentRow => !!s && s.status !== "left").slice(0, 90);
  if (!rows.length) return "Guruhda faol o'quvchi yo'q.";
  say(chat, "Qaysi o'quvchining vasiysiga?", kb(rows.map((s) => [[s.fullName.slice(0, 40), `m2:${s.id}`] as [string, string]])));
  return "";
}

const TEMPLATE_LABELS: Record<string, string> = { absent: "Kelmadi", late: "Kechikdi", homework: "Uy vazifasi", praise: "Maqtov", meeting: "Suhbatga chaqirish" };

function sendAndReport(chat: string, t: TeacherRow, studentId: string, template: string | null, text: string | null): void {
  const r = sendGuardianMessage(t, studentId, template, text);
  say(chat, r.ok ? `Yuborildi. Bugun yana ${r.left} ta xabar yuborish mumkin.` : (MESSAGE_ERRORS[r.error] ?? "Yuborilmadi."));
}

function onCallback(cb: NonNullable<RawUpdate["callback_query"]>, chat: string, t: TeacherRow): void {
  const id = String(cb.id ?? "");
  const mid = Number(cb.message?.message_id ?? 0);
  const parts = String(cb.data ?? "").split(":");
  let toast = "";
  try {
    if (parts[0] === "l" && parts.length === 4) {
      const l = ownLesson(t, parts[1]!, parts[2]!, parts[3]!);
      if (!l) toast = "Bu sizning darsingiz emas";
      else {
        const v = rosterView(t, l, 0);
        say(chat, v.text, v.markup);
      }
    } else if (parts[0] === "r" && parts.length === 5) {
      const l = ownLesson(t, parts[1]!, parts[2]!, parts[3]!);
      if (!l) toast = "Bu sizning darsingiz emas";
      else {
        const v = rosterView(t, l, Number(parts[4]));
        edit(chat, mid, v.text, v.markup);
      }
    } else if (parts[0] === "a" && parts.length === 6) {
      const group = read<Group>(GROUPS).find((g) => g.id === parts[1]);
      const status = CODES[parts[4]!];
      const start = lessonsBetween(parts[2]!, parts[2]!).find((x) => x.groupId === parts[1] && x.teacherId === t.id && !x.cancelled);
      const l = group && start ? ownLesson(t, group.id, parts[2]!, start.start.replace(":", "")) : null;
      const current = l ? getRoster(l.groupId, l.date) : [];
      if (!l || !status) toast = "Bu sizning darsingiz emas";
      else if (!current.some((r) => r.studentId === parts[3])) toast = "O'quvchi topilmadi, ro'yxatni yangilang";
      else {
        const marks = current.filter((r) => r.status && r.studentId !== parts[3]).map((r) => ({ studentId: r.studentId, status: r.status as AttendanceRow["status"], minutesLate: r.minutesLate }));
        marks.push({ studentId: parts[3]!, status, minutesLate: 0 });
        saveAttendance({ date: l.date, groupId: l.groupId, marks });
        toast = "Saqlandi";
        const v = rosterView(t, l, Number(parts[5]));
        edit(chat, mid, v.text, v.markup);
      }
    } else if (parts[0] === "m1" && parts.length === 1) messageGroups(chat, t);
    else if (parts[0] === "m1" && parts.length === 2) toast = messageStudents(chat, t, parts[1]!);
    else if (parts[0] === "m2" && parts.length === 2) {
      const rows: [string, string][][] = Object.keys(R.TEMPLATES).map((c) => [[TEMPLATE_LABELS[c]!, `m3:${parts[1]}:${c}`] as [string, string]]);
      rows.push([["✍️ Erkin matn", `m4:${parts[1]}`]]);
      say(chat, "Qaysi xabar?", kb(rows));
    } else if (parts[0] === "m3" && parts.length === 3) sendAndReport(chat, t, parts[1]!, parts[2]!, null);
    else if (parts[0] === "m4" && parts.length === 2) void tg("sendMessage", { chat_id: chat, text: `Vasiyga yuboriladigan matnni shu xabarga javob qilib yozing. #${parts[1]}`, reply_markup: { force_reply: true, input_field_placeholder: "Matn..." } });
  } catch (e) {
    toast = e instanceof Error ? e.message.slice(0, 150) : "Xato";
  }
  answer(id, toast || undefined);
}

/** Handles a Telegram update that belongs to the teacher bot. Returns true when it did (the guardian flow must not see it). */
export function handleTeacherUpdate(raw: unknown): boolean {
  const u = (raw ?? {}) as RawUpdate;
  const m = u.message;
  const cb = u.callback_query;
  const chatObj = m?.chat ?? cb?.message?.chat;
  const fromId = m?.from?.id ?? cb?.from?.id;
  if (!chatObj || chatObj.type !== "private" || chatObj.id === undefined || chatObj.id !== fromId) return false;
  const chat = String(chatObj.id);
  const teachers = read<TeacherRow>(TEACHERS);
  const t = teachers.find((x) => x.telegramChatId === chat && x.status === "active");
  if (m && typeof m.text === "string") {
    const text = m.text.trim();
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/i.exec(text);
    const candidate = start ? (start[1] ?? "") : text;
    if (R.normalizeInviteCode(candidate) !== null) {
      const r = acceptInvite(candidate, chat);
      say(chat, r.ok ? `Ulandi! O'qituvchi: ${r.teacher.fullName}.\n\n${HELP}` : (LINK_ERRORS[r.reason] ?? "Ulanib bo'lmadi."));
      return true;
    }
    if (!t) return false; // not a teacher: the guardian flow decides
    const cmd = /^\/(\w+)/.exec(text)?.[1]?.toLowerCase() ?? "";
    if (["qarz", "balance", "privacy", "stop"].includes(cmd)) return false; // a teacher can be a guardian too
    if (start && start[1]) return false; // a guardian link code
    const tag = /#([A-Za-z]\d{4,})\b/.exec(m.reply_to_message?.text ?? "");
    if (!cmd && tag && text) sendAndReport(chat, t, tag[1]!, null, text);
    else if (cmd === "bugun" || cmd === "darslar") showToday(chat, t);
    else if (cmd === "guruhlar") showGroups(chat, t);
    else if (cmd === "jadval") showWeek(chat, t);
    else if (cmd === "oylik") showPay(chat, t);
    else if (cmd === "xabar") messageGroups(chat, t);
    else say(chat, HELP);
    return true;
  }
  if (cb && t) {
    const verb = String(cb.data ?? "").split(":")[0];
    if (verb === "tn") {
      answer(String(cb.id ?? ""));
      return true;
    }
    if (!["l", "r", "a", "m1", "m2", "m3", "m4"].includes(verb ?? "")) return false;
    onCallback(cb, chat, t);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ menu actions
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const ask = (title: string, label: string): string => {
  const r = ui().prompt(title, label, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  return r.getResponseText().trim();
};

export const menu = {
  invite: (): void => {
    const id = ask("Ustozni taklif qilish", "O'qituvchi ID (masalan T0001)");
    const { code, expiresAt } = createInvite(id);
    const bot = PropertiesService.getScriptProperties().getProperty("BOT_USERNAME");
    ui().alert("Taklif kodi", `Kod: ${code}\n\nMuddati: ${expiresAt.replace("T", " ")} gacha. Kod faqat shu yerda ko'rsatiladi (saqlanmaydi).\nUstoz botga ${bot ? `@${bot} ` : ""}"/start ${code}" yuboradi.`, ui().ButtonSet.OK);
  },
  unmarked: (): void => {
    const items = unmarkedNow();
    const names = new Map(read<TeacherRow>(TEACHERS).map((t) => [t.id, t.fullName]));
    ui().alert("Davomat belgilanmagan darslar", items.length ? items.map((u) => `${u.lesson.date} ${u.lesson.start}-${u.lesson.end} ${u.lesson.groupName} (${names.get(u.lesson.teacherId) ?? "-"}): ${u.state === "waiting" ? "kutilmoqda" : u.state === "reminded" ? "eslatildi" : "eslatma kerak"}`).join("\n") : "Hammasi belgilangan.", ui().ButtonSet.OK);
  },
  remind: (): void => {
    const r = reminderPass();
    ui().alert("Ustoz eslatmalari", `Ustozlarga: ${r.teacherReminders} ta, egaga kun yakuni: ${r.digests} ta.${r.skipped.length ? `\n\nO'tkazib yuborilgan:\n${r.skipped.join("\n")}` : ""}`, ui().ButtonSet.OK);
  },
  toggleMessaging: (): void => {
    const id = ask("Vasiyga yozish huquqi", "O'qituvchi ID (huquq almashtiriladi)");
    const t = read<TeacherRow>(TEACHERS).find((x) => x.id === id);
    if (!t) throw new Error(`${id}: o'qituvchi topilmadi`);
    withLock(() => updateById(TEACHERS, "id", t.id, { msgOff: !t.msgOff }));
    ui().alert("Vasiyga yozish huquqi", `${t.fullName}: ${t.msgOff ? "YOQILDI" : "O'CHIRILDI"}.`, ui().ButtonSet.OK);
  },
  triggerOn: (): void => {
    const exists = ScriptApp.getProjectTriggers().some((x) => x.getHandlerFunction() === "teacherTick");
    if (!exists) ScriptApp.newTrigger("teacherTick").timeBased().everyHours(1).create();
    ui().alert("Avto-eslatma", exists ? "Avto-eslatma allaqachon yoqilgan." : "Yoqildi: har soatda ustozlarga va egaga ichki eslatmalar tekshiriladi.", ui().ButtonSet.OK);
  },
  triggerOff: (): void => {
    let n = 0;
    for (const x of ScriptApp.getProjectTriggers()) {
      if (x.getHandlerFunction() !== "teacherTick") continue;
      ScriptApp.deleteTrigger(x);
      n++;
    }
    ui().alert("Avto-eslatma", n ? "O'chirildi." : "Avto-eslatma yoqilmagan edi.", ui().ButtonSet.OK);
  },
};

/** The hourly trigger target. */
export const tick = (): void => void reminderPass();
