/**
 * Schedule rules: time overlap, room/teacher conflicts, room capacity fit, who teaches (substitute), the payroll effect
 * of cancelling/moving/substituting a lesson, guardian message drafts and the weekly schedule text. Mirrored in Python
 * (backend/src/nazoratly/rules/schedule.py); both are checked against the same cases in tests/golden/schedule.json.
 * Times are "HH:MM", dates ISO "YYYY-MM-DD". Money is whole so'm here.
 */
import type { ISODate } from "./types";

export const DEFAULT_LESSON_MINUTES = 90;
const WEEKDAY_TOKENS: Record<string, number> = { du: 1, se: 2, chor: 3, pay: 4, ju: 5, sha: 6, yak: 7 };

export const toMinutes = (t: string): number => {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
};
export const fromMinutes = (n: number): string => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** Intervals that only touch (one ends when the other starts) do not overlap. */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return toMinutes(aStart) < toMinutes(bEnd) && toMinutes(bStart) < toMinutes(aEnd);
}

export interface Slot {
  id: string;
  date: ISODate;
  start: string;
  end: string;
  room: string | null;
  /** the EFFECTIVE teacher (see effectiveTeacher) */
  teacher: string | null;
  cancelled: boolean;
}
export interface Conflict {
  kind: "room" | "teacher";
  otherId: string;
}

/** Clashes of `candidate` with `others` on the same date. Cancelled lessons never clash; the candidate itself (same id) is
 * ignored, so a lesson can be re-saved. Sorted by kind, then other id. */
export function findConflicts(candidate: Slot, others: Slot[]): Conflict[] {
  if (candidate.cancelled) return [];
  const found = new Map<string, Conflict>();
  for (const o of others) {
    if (o.cancelled || o.id === candidate.id || o.date !== candidate.date) continue;
    if (!overlaps(candidate.start, candidate.end, o.start, o.end)) continue;
    if (candidate.room !== null && candidate.room === o.room) found.set(`room|${o.id}`, { kind: "room", otherId: o.id });
    if (candidate.teacher !== null && candidate.teacher === o.teacher) found.set(`teacher|${o.id}`, { kind: "teacher", otherId: o.id });
  }
  return [...found.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.otherId < b.otherId ? -1 : a.otherId > b.otherId ? 1 : 0));
}

export type CapacityCheck = "ok" | "group_capacity_over_room" | "enrolled_over_room";

export function capacityCheck(a: { groupCapacity: number | null; enrolled: number; roomCapacity: number | null }): CapacityCheck {
  if (a.roomCapacity === null) return "ok";
  if (a.groupCapacity !== null) return a.groupCapacity > a.roomCapacity ? "group_capacity_over_room" : "ok";
  return a.enrolled > a.roomCapacity ? "enrolled_over_room" : "ok";
}

/** Who actually teaches: the substitute, else the teacher set on the lesson, else the group's teacher. */
export function effectiveTeacher(a: { group: string | null; lesson: string | null; substitute: string | null }): string | null {
  return a.substitute || a.lesson || a.group || null;
}

export interface TeacherPay {
  id: string;
  payModel: "fixed" | "per_lesson" | "percent";
  payRate: number;
}
export interface PayEffect {
  teacher: string;
  month: string; // YYYY-MM
  delta: number;
}

/** What ONE lesson changes in a teacher's pay: only per-lesson teachers are paid by the lesson. */
export const lessonPay = (t: TeacherPay): number => (t.payModel === "per_lesson" && t.payRate > 0 ? t.payRate : 0);

/** Change of per-lesson pay caused by a change of ONE planned lesson, per teacher and month. */
export function payrollEffect(a: { kind: "cancel" | "substitute" | "move"; oldDate: ISODate; newDate: ISODate | null; teacher: TeacherPay | null; substitute?: TeacherPay | null }): PayEffect[] {
  const acc = new Map<string, PayEffect>();
  const add = (t: TeacherPay | null | undefined, month: string, amount: number): void => {
    if (!t || amount === 0) return;
    const key = `${t.id}|${month}`;
    const cur = acc.get(key);
    if (cur) cur.delta += amount;
    else acc.set(key, { teacher: t.id, month, delta: amount });
  };
  const oldMonth = a.oldDate.slice(0, 7);
  if (a.kind === "cancel") {
    if (a.teacher) add(a.teacher, oldMonth, -lessonPay(a.teacher));
  } else if (a.kind === "substitute") {
    if (a.teacher) add(a.teacher, oldMonth, -lessonPay(a.teacher));
    if (a.substitute) add(a.substitute, oldMonth, lessonPay(a.substitute));
  } else if (a.kind === "move") {
    if (a.newDate !== null && a.teacher && a.newDate.slice(0, 7) !== oldMonth) {
      const pay = lessonPay(a.teacher);
      add(a.teacher, oldMonth, -pay);
      add(a.teacher, a.newDate.slice(0, 7), pay);
    }
  } else throw new Error(`unknown change kind: ${String(a.kind)}`);
  return [...acc.values()].filter((e) => e.delta !== 0).sort((x, y) => (x.teacher < y.teacher ? -1 : x.teacher > y.teacher ? 1 : x.month < y.month ? -1 : x.month > y.month ? 1 : 0));
}

const uzDate = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Guardian message DRAFT for a cancelled or moved lesson (a person approves it before anything is sent). */
export function changeMessage(a: { kind: "cancel" | "move"; guardian: string; student: string; group: string; oldDate: ISODate; oldStart: string; newDate: ISODate | null; newStart: string | null; reason: string | null; center: string }): string {
  const reason = a.reason?.trim() ?? "";
  const why = reason ? ` Sabab: ${reason.replace(/\.+$/, "")}.` : "";
  const old = `${uzDate(a.oldDate)} ${a.oldStart}`;
  if (a.kind === "cancel") return `Assalomu alaykum, ${a.guardian}! ${a.student} o'qiydigan ${a.group} guruhining ${old} dagi darsi bekor qilindi.${why} Keyingi dars jadval bo'yicha o'tadi. ${a.center}`;
  if (a.kind === "move" && a.newDate !== null && a.newStart !== null) return `Assalomu alaykum, ${a.guardian}! ${a.student} o'qiydigan ${a.group} guruhining ${old} dagi darsi ko'chirildi: yangi vaqt ${uzDate(a.newDate)} ${a.newStart}.${why} ${a.center}`;
  throw new Error(`no guardian message for change kind: ${String(a.kind)}`);
}

export interface WeeklySlot {
  weekday: number; // 1 = Monday
  start: string;
  end: string;
}

/** `Du-Chor-Ju 18:00` or `Se, Pay 17:30-19:00` -> weekly slots; a missing end time means 90 minutes. null when invalid. */
export function parseSchedule(text: string): WeeklySlot[] | null {
  const m = /^\s*(.+?)\s+(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?\s*$/.exec(text ?? "");
  if (!m) return null;
  const days: number[] = [];
  for (const tok of m[1]!.trim().toLowerCase().split(/[-,/\s]+/)) {
    if (!tok) continue;
    const wd = WEEKDAY_TOKENS[tok];
    if (wd === undefined) return null;
    if (!days.includes(wd)) days.push(wd);
  }
  if (days.length === 0) return null;
  if (Number(m[2]!.split(":")[1]) > 59 || (m[3] !== undefined && Number(m[3].split(":")[1]) > 59)) return null;
  const startMin = toMinutes(m[2]!);
  const endMin = m[3] !== undefined ? toMinutes(m[3]) : startMin + DEFAULT_LESSON_MINUTES;
  if (startMin >= 24 * 60 || endMin > 24 * 60 || endMin <= startMin) return null;
  return days.sort((a, b) => a - b).map((weekday) => ({ weekday, start: fromMinutes(startMin), end: fromMinutes(endMin) }));
}

const isoOf = (t: number): ISODate => new Date(t).toISOString().slice(0, 10);

/** Monday and Sunday of the week that contains `day`. */
export function weekRange(day: ISODate): { monday: ISODate; sunday: ISODate } {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  const iso = ((new Date(t).getUTCDay() + 6) % 7) + 1;
  const monday = t - (iso - 1) * 86_400_000;
  return { monday: isoOf(monday), sunday: isoOf(monday + 6 * 86_400_000) };
}

/** ISO weekday (1 = Monday) of a date. */
export function isoWeekday(day: ISODate): number {
  return ((new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))).getUTCDay() + 6) % 7) + 1;
}
