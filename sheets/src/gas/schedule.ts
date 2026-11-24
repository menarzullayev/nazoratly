/** Schedule and rooms: week/day calendar of all groups, rooms with capacity, room/teacher clash and capacity checks,
 * moving / cancelling a lesson and a substitute teacher (payroll follows the substitute). Guardian messages for a moved or
 * cancelled lesson are only DRAFTS in "Eslatmalar": a person approves each one there. The rules are in
 * ../domain/schedule.ts (shared with the API through tests/golden/schedule.json); the expansion of the weekly texts in
 * ../domain/calendar.ts. No Apps Script service beyond the spreadsheet itself is used (no new OAuth scope). */
import { expandLessons, type CalendarLesson, type Room, type ScheduleChange } from "../domain/calendar";
import { isIsoDate } from "../domain/dates";
import { nextId, nextIds } from "../domain/ids";
import { changeMessage, findConflicts, isoWeekday, payrollEffect, toMinutes, fromMinutes, weekRange, type PayEffect, type Slot, type TeacherPay } from "../domain/schedule";
import type { Enrollment, Group, ReminderDraft, Student, Teacher } from "../domain/types";
import { guard, withLock } from "./actions";
import { pickId } from "./pick";
import { append, read, readIfPresent, today } from "./repo";
import { ATTENDANCE, DRAFTS, ENROLLMENTS, GROUPS, PAYROLL, ROOMS, SCHEDULE_CHANGES, STUDENTS, TEACHERS } from "./schema";
import { readSettings } from "./settings";

export const VIEW_SHEET = "Taqvim";
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const DAY_NAMES = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"];
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const normTime = (t: string): string => (TIME.test(t.trim()) ? fromMinutes(toMinutes(t.trim())) : "");
const SEAT_HOLDERS = new Set(["trial", "active"]);

/** Thrown when a lesson clashes with another one; the menu offers to save anyway. */
export class ScheduleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleConflictError";
  }
}

interface Ctx {
  groups: Group[];
  rooms: Room[];
  changes: ScheduleChange[];
  teachers: Teacher[];
  enrolled: Map<string, number>;
}

function load(): Ctx {
  const enrolled = new Map<string, number>();
  for (const e of read<Enrollment>(ENROLLMENTS)) if (SEAT_HOLDERS.has(e.status)) enrolled.set(e.groupId, (enrolled.get(e.groupId) ?? 0) + 1);
  return { groups: read<Group>(GROUPS), rooms: readIfPresent<Room>(ROOMS), changes: readIfPresent<ScheduleChange>(SCHEDULE_CHANGES), teachers: read<Teacher>(TEACHERS), enrolled };
}

const lessonsIn = (c: Ctx, from: string, to: string): ReturnType<typeof expandLessons> => expandLessons({ groups: c.groups, rooms: c.rooms, changes: c.changes, from, to, enrolled: c.enrolled });

function describe(l: CalendarLesson, c: Ctx): string[] {
  const out: string[] = [];
  const name = (id: string): string => c.groups.find((g) => g.id === id)?.name ?? id;
  for (const k of l.conflicts) {
    const other = k.otherId.split("|")[0] ?? "";
    out.push(`${k.kind === "room" ? "Xona band" : "O'qituvchi band"}: ${name(other)}`);
  }
  if (l.capacity === "group_capacity_over_room") out.push("Guruh sig'imi xonadan katta");
  if (l.capacity === "enrolled_over_room") out.push("O'quvchilar xonaga sig'maydi");
  return out;
}

// ------------------------------------------------------------------ calendar view
export function calendarTable(from: string, to: string, teacherId = ""): string[][] {
  const c = load();
  const { lessons } = lessonsIn(c, from, to);
  const teachers = new Map(c.teachers.map((t) => [t.id, t.fullName]));
  const rooms = new Map(c.rooms.map((r) => [r.id, r.name]));
  const rows: string[][] = [["Sana", "Kun", "Vaqt", "Guruh", "O'qituvchi", "Xona", "Holat", "Ogohlantirish"]];
  for (const l of lessons) {
    if (teacherId && l.teacherId !== teacherId) continue;
    const notes = l.cancelled ? [] : describe(l, c);
    if (l.substitute) notes.push("O'rinbosar o'qituvchi");
    if (l.movedFrom) notes.push(`Ko'chirilgan: ${l.movedFrom}`);
    rows.push([l.date, DAY_NAMES[isoWeekday(l.date) - 1]!, `${l.start}-${l.end}`, `${l.groupId} ${l.groupName}`, l.teacherId ? (teachers.get(l.teacherId) ?? l.teacherId) : "-", l.roomId ? (rooms.get(l.roomId) ?? l.roomId) : "-", l.cancelled ? `Bekor qilingan${l.cancelReason ? `: ${l.cancelReason}` : ""}` : "Rejada", notes.join("; ")]);
  }
  return rows;
}

export function openCalendar(view: "week" | "day" = "week", dayArg?: string, teacherArg?: string): string {
  const day = dayArg?.trim() || today();
  if (!isIsoDate(day)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
  const { monday, sunday } = weekRange(day);
  const [from, to] = view === "week" ? [monday, sunday] : [day, day];
  const rows = calendarTable(from, to, teacherArg?.trim() ?? "");
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(VIEW_SHEET) ?? ss.insertSheet(VIEW_SHEET);
  sh.clear();
  sh.getRange(1, 1, rows.length, rows[0]!.length).setValues(rows as never);
  sh.setFrozenRows(1);
  sh.activate();
  return `${from} ... ${to}: ${rows.length - 1} ta dars`;
}

// ------------------------------------------------------------------ rooms
export function roomAdd(nameArg?: string, capacityArg?: string): string {
  const ask = (label: string, hint: string): string => {
    const r = ui().prompt(label, hint, ui().ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
    return r.getResponseText().trim();
  };
  const name = (nameArg ?? ask("Xona qo'shish", "Xona nomi (masalan 1-xona)")).trim();
  const capText = (capacityArg ?? ask("Xona qo'shish", "Sig'im (o'quvchilar soni; bilmasangiz bo'sh qoldiring)")).trim();
  if (!name) throw new Error("Xona nomi kiritilmadi.");
  const capacity = capText === "" ? 0 : Number(capText);
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 10_000) throw new Error("Sig'im musbat butun son bo'lishi kerak.");
  return withLock(() => {
    const rooms = readIfPresent<Room>(ROOMS);
    if (rooms.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new Error(`"${name}" nomli xona allaqachon bor.`);
    const id = nextId("X", rooms.map((r) => r.id));
    append(ROOMS, [{ id, name, capacity }]);
    return `Xona qo'shildi: ${id} ${name}${capacity ? `, sig'im ${capacity}` : ""}. Guruhga biriktirish: Guruhlar varag'ida "Xona ID" ustuni.`;
  });
}

// ------------------------------------------------------------------ checks
export function checkSchedule(fromArg?: string): string {
  const from = fromArg?.trim() || today();
  if (!isIsoDate(from)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
  const to = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)) + 27)).toISOString().slice(0, 10);
  const c = load();
  const problems: string[] = [];
  const groupName = (id: string): string => c.groups.find((g) => g.id === id)?.name ?? id;
  for (const g of c.groups) {
    if (g.status !== "active") continue;
    if (String(g.schedule ?? "").trim() === "") continue;
    if (g.roomId && !c.rooms.some((r) => r.id === g.roomId)) problems.push(`${g.id} "${g.name}": Xona ID topilmadi (${g.roomId}).`);
  }
  const { lessons, orphans } = lessonsIn(c, from, to);
  const unreadable = c.groups.filter((g) => g.status === "active" && String(g.schedule ?? "").trim() !== "" && lessons.every((l) => l.groupId !== g.id) && !/\d{1,2}:\d{2}/.test(String(g.schedule)));
  for (const g of unreadable) problems.push(`${g.id} "${g.name}": jadval matni tushunarsiz ("${g.schedule}"). Namuna: Du-Chor-Ju 18:00-19:30.`);
  const seen = new Set<string>();
  const rooms = new Map(c.rooms.map((r) => [r.id, r.name]));
  for (const l of lessons) {
    for (const k of l.conflicts) {
      const pair = [l.key, k.otherId].sort().join(" <> ") + k.kind;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const other = k.otherId.split("|");
      problems.push(`${l.date} ${l.start}: ${groupName(l.groupId)} va ${groupName(other[0] ?? "")} - ${k.kind === "room" ? `xona band (${rooms.get(l.roomId) ?? l.roomId})` : "o'qituvchi band"}.`);
    }
  }
  const warned = new Set<string>();
  for (const l of lessons) {
    if (l.capacity === "ok" || warned.has(`${l.groupId}|${l.roomId}`)) continue;
    warned.add(`${l.groupId}|${l.roomId}`);
    problems.push(`${groupName(l.groupId)}: ${l.capacity === "group_capacity_over_room" ? "guruh sig'imi xona sig'imidan katta" : "o'quvchilar xonaga sig'maydi"} (${rooms.get(l.roomId) ?? l.roomId}).`);
  }
  for (const o of orphans) problems.push(`${o.id}: o'zgarish endi hech bir darsga mos kelmaydi (jadval matni o'zgargan): ${o.groupId} ${o.date} ${o.start}.`);
  return problems.length ? `${from} ... ${to}: ${problems.length} ta muammo:\n\n${problems.join("\n")}` : `${from} ... ${to}: to'qnashuvlar va sig'im muammolari yo'q.`;
}

// ------------------------------------------------------------------ changes
export interface ChangeArgs {
  groupId?: string;
  date?: string;
  start?: string;
  /** move */
  newDate?: string;
  newStart?: string;
  newEnd?: string;
  newRoomId?: string;
  /** substitute: empty string removes the substitute */
  substituteId?: string;
  reason?: string;
  /** prepare guardian message drafts (default yes) */
  notify?: boolean;
  /** save although the room or the teacher is busy */
  force?: boolean;
}

function findLesson(c: Ctx, groupId: string, date: string, start: string): CalendarLesson {
  if (!c.groups.some((g) => g.id === groupId)) throw new Error(`Guruh topilmadi: ${groupId}`);
  if (!isIsoDate(date)) throw new Error("Dars sanasi noto'g'ri (yyyy-mm-dd).");
  const { lessons } = lessonsIn(c, date, date);
  const here = lessons.filter((l) => l.groupId === groupId && (start === "" || l.start === start));
  if (here.length === 0) throw new Error(`${groupId} guruhining ${date}${start ? ` ${start}` : ""} kunida darsi yo'q (jadval matnini va oldingi o'zgarishlarni tekshiring).`);
  if (here.length > 1) throw new Error("Shu kuni bir nechta dars bor: boshlanish vaqtini ham kiriting.");
  const l = here[0]!;
  if (l.cancelled) throw new Error("Bu dars allaqachon bekor qilingan.");
  return l;
}

const hasAttendance = (groupId: string, date: string): boolean => readIfPresent<{ date: string; groupId: string }>(ATTENDANCE).some((a) => a.date === date && a.groupId === groupId);

const payOf = (t: Teacher | undefined): TeacherPay | null => (t ? { id: t.id, payModel: t.payModel, payRate: t.payRate } : null);

function effectsText(effects: PayEffect[], teachers: Teacher[]): string {
  const name = (id: string): string => teachers.find((t) => t.id === id)?.fullName ?? id;
  return effects.map((e) => `${name(e.teacher)} ${e.month}: ${e.delta > 0 ? "+" : ""}${e.delta}`).join("; ");
}

/** A teacher's payroll of a month that is already approved/paid cannot change: stop before touching anything. */
function assertPayrollOpen(effects: PayEffect[]): void {
  const rows = readIfPresent<{ month: string; teacherId: string; status: string }>(PAYROLL);
  for (const e of effects) {
    if (rows.some((r) => r.teacherId === e.teacher && r.month === `${e.month}-01` && r.status !== "draft")) {
      throw new Error(`${e.teacher} ning ${e.month} oyligi allaqachon tasdiqlangan yoki to'langan: darsni o'zgartirib bo'lmaydi. Oylikni tuzatish uchun bonus/jarimadan foydalaning.`);
    }
  }
}

function assertNoClash(c: Ctx, cand: Slot, ignoreKey: string, force: boolean): void {
  const { lessons } = lessonsIn(c, cand.date, cand.date);
  const others: Slot[] = lessons.filter((l) => l.key !== ignoreKey).map((l) => ({ id: l.key, date: l.date, start: l.start, end: l.end, room: l.roomId || null, teacher: l.teacherId || null, cancelled: l.cancelled }));
  const found = findConflicts(cand, others);
  if (found.length === 0 || force) return;
  const name = (id: string): string => c.groups.find((g) => g.id === id.split("|")[0])?.name ?? id;
  throw new ScheduleConflictError(found.map((k) => `${k.kind === "room" ? "Xona band" : "O'qituvchi band"}: ${name(k.otherId)} (${cand.date} ${cand.start})`).join("\n"));
}

/** Drafts for the guardians of the students of the lesson; only students whose guardian agreed to messages and linked the bot. */
function makeNotices(l: CalendarLesson, kind: "cancel" | "move", a: { newDate?: string; newStart?: string; reason: string }): { created: number; skipped: number } {
  const centre = readSettings().center;
  const students = new Map(read<Student>(STUDENTS).map((s) => [s.id, s]));
  const members = read<Enrollment>(ENROLLMENTS).filter((e) => e.groupId === l.groupId && SEAT_HOLDERS.has(e.status) && e.startedOn <= l.date && (e.endedOn === "" || e.endedOn >= l.date));
  const drafts = read<ReminderDraft>(DRAFTS);
  const plan: { studentId: string; text: string }[] = [];
  let skipped = 0;
  const done = new Set<string>();
  for (const e of members) {
    const s = students.get(e.studentId);
    if (!s || done.has(s.id)) continue;
    done.add(s.id);
    if (s.status === "left" || s.status === "paused" || !s.consentNotify || !s.guardianChatId) {
      skipped++;
      continue;
    }
    plan.push({ studentId: s.id, text: changeMessage({ kind, guardian: s.guardianName || "ota-ona", student: s.fullName, group: l.groupName, oldDate: l.date, oldStart: l.start, newDate: a.newDate ?? null, newStart: a.newStart ?? null, reason: a.reason || null, center: centre }) });
  }
  const ids = nextIds("R", drafts.map((d) => d.id), plan.length);
  append(DRAFTS, plan.map((p, i) => ({ id: ids[i]!, studentId: p.studentId, createdOn: today(), text: p.text, status: "pending", error: "" })));
  return { created: plan.length, skipped };
}

function record(c: Ctx, row: Omit<ScheduleChange, "id" | "createdOn">): string {
  const id = nextId("J", c.changes.map((x) => x.id));
  append(SCHEDULE_CHANGES, [{ ...row, id, createdOn: today() }]);
  return id;
}

const noticeText = (n: { created: number; skipped: number } | null): string =>
  n === null ? "" : `\nVasiylarga ${n.created} ta xabar loyihasi yaratildi (hali yuborilmadi: nazoratly > Eslatmalarni ko'rib chiqish). Xabar yuborib bo'lmaydigan o'quvchilar: ${n.skipped}.`;

export function lessonMove(a: ChangeArgs): string {
  const reason = (a.reason ?? "").trim();
  return withLock(() => {
    const c = load();
    const l = findLesson(c, (a.groupId ?? "").trim(), (a.date ?? "").trim(), normTime(a.start ?? ""));
    if (hasAttendance(l.groupId, l.date)) throw new Error("Bu dars uchun davomat belgilangan: ko'chirib bo'lmaydi.");
    const newDate = (a.newDate ?? "").trim();
    if (!isIsoDate(newDate)) throw new Error("Yangi sana noto'g'ri (yyyy-mm-dd).");
    const newStart = normTime(a.newStart ?? "");
    if (!newStart) throw new Error("Yangi boshlanish vaqti noto'g'ri (SS:DD).");
    const duration = toMinutes(l.end) - toMinutes(l.start);
    const newEnd = (a.newEnd ?? "").trim() ? normTime(a.newEnd ?? "") : fromMinutes(toMinutes(newStart) + duration);
    if (!newEnd || toMinutes(newEnd) <= toMinutes(newStart) || toMinutes(newEnd) > 24 * 60) throw new Error("Yangi tugash vaqti noto'g'ri.");
    const newRoomId = (a.newRoomId ?? "").trim();
    if (newRoomId && !c.rooms.some((r) => r.id === newRoomId)) throw new Error(`Xona topilmadi: ${newRoomId}`);
    if (newDate === l.date && newStart === l.start && newEnd === l.end && (newRoomId === "" || newRoomId === l.roomId)) throw new Error("Dars allaqachon shu sana, vaqt va xonada.");
    if (lessonsIn(c, newDate, newDate).lessons.some((x) => x.groupId === l.groupId && x.start === newStart && x.key !== l.key)) throw new Error("Guruhning shu sana va vaqtda boshqa darsi bor.");
    assertNoClash(c, { id: l.key, date: newDate, start: newStart, end: newEnd, room: (newRoomId || l.roomId) || null, teacher: l.teacherId || null, cancelled: false }, l.key, a.force === true);
    const effects = payrollEffect({ kind: "move", oldDate: l.date, newDate, teacher: payOf(c.teachers.find((t) => t.id === l.teacherId)) });
    assertPayrollOpen(effects);
    const id = record(c, { kind: "move", groupId: l.groupId, date: l.date, start: l.start, newDate, newStart, newEnd, newRoomId, substituteId: "", reason, payEffect: effectsText(effects, c.teachers) });
    const notices = a.notify === false ? null : makeNotices(l, "move", { newDate, newStart, reason });
    return `${id}: ${l.groupName} darsi ${l.date} ${l.start} dan ${newDate} ${newStart} ga ko'chirildi.${effects.length ? `\nOylik ta'siri: ${effectsText(effects, c.teachers)}` : ""}${noticeText(notices)}`;
  });
}

export function lessonCancel(a: ChangeArgs): string {
  const reason = (a.reason ?? "").trim();
  return withLock(() => {
    const c = load();
    const l = findLesson(c, (a.groupId ?? "").trim(), (a.date ?? "").trim(), normTime(a.start ?? ""));
    if (hasAttendance(l.groupId, l.date)) throw new Error("Bu dars uchun davomat belgilangan: bekor qilib bo'lmaydi.");
    const effects = payrollEffect({ kind: "cancel", oldDate: l.date, newDate: null, teacher: payOf(c.teachers.find((t) => t.id === l.teacherId)) });
    assertPayrollOpen(effects);
    const id = record(c, { kind: "cancel", groupId: l.groupId, date: l.date, start: l.start, newDate: "", newStart: "", newEnd: "", newRoomId: "", substituteId: "", reason, payEffect: effectsText(effects, c.teachers) });
    const notices = a.notify === false ? null : makeNotices(l, "cancel", { reason });
    return `${id}: ${l.groupName} ${l.date} ${l.start} darsi bekor qilindi.${effects.length ? `\nOylik ta'siri: ${effectsText(effects, c.teachers)}` : ""}${noticeText(notices)}`;
  });
}

export function lessonSubstitute(a: ChangeArgs): string {
  const reason = (a.reason ?? "").trim();
  return withLock(() => {
    const c = load();
    const l = findLesson(c, (a.groupId ?? "").trim(), (a.date ?? "").trim(), normTime(a.start ?? ""));
    const group = c.groups.find((g) => g.id === l.groupId)!;
    // naming the group's own teacher means "no substitute"
    const subId = (a.substituteId ?? "").trim() === group.teacherId ? "" : (a.substituteId ?? "").trim();
    if (subId) {
      const t = c.teachers.find((x) => x.id === subId);
      if (!t) throw new Error(`O'qituvchi topilmadi: ${subId}`);
      if (t.status !== "active") throw new Error("O'rinbosar o'qituvchi faol emas.");
    }
    const newTeacher = subId || group.teacherId;
    if ((subId === "" && !l.substitute) || (subId !== "" && l.substitute && subId === l.teacherId)) throw new Error("Darsda allaqachon shu o'qituvchi dars beradi.");
    if (newTeacher) assertNoClash(c, { id: l.key, date: l.date, start: l.start, end: l.end, room: l.roomId || null, teacher: newTeacher, cancelled: false }, l.key, a.force === true);
    const effects = payrollEffect({ kind: "substitute", oldDate: l.date, newDate: null, teacher: payOf(c.teachers.find((t) => t.id === l.teacherId)), substitute: payOf(c.teachers.find((t) => t.id === newTeacher)) });
    assertPayrollOpen(effects);
    const id = record(c, { kind: "substitute", groupId: l.groupId, date: l.date, start: l.start, newDate: "", newStart: "", newEnd: "", newRoomId: "", substituteId: subId, reason, payEffect: effectsText(effects, c.teachers) });
    const who = subId ? `o'rinbosar ${subId}` : "asosiy o'qituvchi qaytarildi";
    return `${id}: ${l.groupName} ${l.date} ${l.start} darsi: ${who}.${effects.length ? `\nOylik ta'siri: ${effectsText(effects, c.teachers)}` : "\nOylik ta'siri yo'q."}\nOylik "Dars uchun" bo'yicha davomat belgilangan darslardan hisoblanadi: o'rinbosar o'z oyligiga oladi.`;
  });
}

// ------------------------------------------------------------------ menu
function ask(label: string, hint: string, optional = false): string {
  const r = ui().prompt(label, hint, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  const v = r.getResponseText().trim();
  if (!v && !optional) throw new Error("Qiymat kiritilmadi.");
  return v;
}

/** Runs the change; when the room/teacher is busy the person may still save it (the clash stays visible in the calendar). */
function withClashChoice(run: (force: boolean) => string): string {
  try {
    return run(false);
  } catch (e) {
    if (e instanceof ScheduleConflictError && ui().alert("To'qnashuv", `${e.message}\n\nBaribir saqlaymizmi?`, ui().ButtonSet.YES_NO) === ui().Button.YES) return run(true);
    throw e;
  }
}

const whichLesson = (label: string): { groupId: string; date: string; start: string } => ({
  groupId: pickId(undefined, GROUPS.sheet, `${label}: guruh ID`),
  date: ask(label, "Dars sanasi (yyyy-mm-dd)"),
  start: ask(label, "Boshlanish vaqti (SS:DD), shu kuni bitta dars bo'lsa bo'sh qoldiring", true),
});

export const menu = {
  week: (): void => guard("Taqvim", () => ui().alert("Taqvim", openCalendar("week", ask("Haftalik taqvim", "Haftadagi istalgan sana (bo'sh = bugun)", true), ask("Haftalik taqvim", "Faqat bitta o'qituvchi uchun: o'qituvchi ID (bo'sh = hammasi)", true)), ui().ButtonSet.OK)),
  day: (): void => guard("Taqvim", () => ui().alert("Taqvim", openCalendar("day", ask("Kunlik taqvim", "Sana (bo'sh = bugun)", true), ask("Kunlik taqvim", "Faqat bitta o'qituvchi uchun: o'qituvchi ID (bo'sh = hammasi)", true)), ui().ButtonSet.OK)),
  room: (): void => guard("Xona", () => ui().alert("Xona", roomAdd(), ui().ButtonSet.OK)),
  check: (): void => guard("Jadvalni tekshirish", () => ui().alert("Jadvalni tekshirish", checkSchedule(), ui().ButtonSet.OK)),
  move: (): void =>
    guard("Darsni ko'chirish", () => {
      const w = whichLesson("Darsni ko'chirish");
      const newDate = ask("Darsni ko'chirish", "Yangi sana (yyyy-mm-dd)");
      const newStart = ask("Darsni ko'chirish", "Yangi boshlanish vaqti (SS:DD)");
      const newRoomId = ask("Darsni ko'chirish", "Yangi xona ID (bo'sh = xona o'zgarmaydi)", true);
      const reason = ask("Darsni ko'chirish", "Sabab (vasiyga xabarda ko'rinadi, bo'sh bo'lishi mumkin)", true);
      const notify = ui().alert("Darsni ko'chirish", "Vasiylarga xabar loyihalari yaratilsinmi? (Yuborish faqat siz tasdiqlaganingizdan keyin.)", ui().ButtonSet.YES_NO) === ui().Button.YES;
      ui().alert("Darsni ko'chirish", withClashChoice((force) => lessonMove({ ...w, newDate, newStart, newRoomId, reason, notify, force })), ui().ButtonSet.OK);
    }),
  cancel: (): void =>
    guard("Darsni bekor qilish", () => {
      const w = whichLesson("Darsni bekor qilish");
      const reason = ask("Darsni bekor qilish", "Sabab (vasiyga xabarda ko'rinadi, bo'sh bo'lishi mumkin)", true);
      const notify = ui().alert("Darsni bekor qilish", "Vasiylarga xabar loyihalari yaratilsinmi? (Yuborish faqat siz tasdiqlaganingizdan keyin.)", ui().ButtonSet.YES_NO) === ui().Button.YES;
      ui().alert("Darsni bekor qilish", lessonCancel({ ...w, reason, notify }), ui().ButtonSet.OK);
    }),
  substitute: (): void =>
    guard("O'rinbosar o'qituvchi", () => {
      const w = whichLesson("O'rinbosar o'qituvchi");
      const substituteId = ask("O'rinbosar o'qituvchi", "O'rinbosar o'qituvchi ID (bo'sh = o'rinbosarni olib tashlash)", true);
      const reason = ask("O'rinbosar o'qituvchi", "Sabab (bo'sh bo'lishi mumkin)", true);
      ui().alert("O'rinbosar o'qituvchi", withClashChoice((force) => lessonSubstitute({ ...w, substituteId, reason, force })), ui().ButtonSet.OK);
    }),
};
