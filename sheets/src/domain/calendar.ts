/**
 * The Sheets edition has no lesson rows: lessons are the groups' weekly schedule texts ("Du-Chor-Ju 18:00-19:30")
 * expanded over dates, then changed by the rows of the "Dars o'zgarishlari" sheet (move, cancel, substitute) in the
 * order they were made. This module is that expansion plus the checks on it (room/teacher clashes, room capacity).
 * Pure functions; the clash, capacity and weekly-text rules are the ones shared with the API (schedule.ts, golden).
 */
import { daysBetween } from "./dates";
import { capacityCheck, findConflicts, parseSchedule, isoWeekday, type CapacityCheck, type Conflict, type Slot } from "./schedule";
import type { Group, ISODate } from "./types";

export interface Room {
  id: string;
  name: string;
  /** 0 = unknown (the sheet cell is empty) */
  capacity: number;
}

export type ChangeKind = "move" | "cancel" | "substitute";
export interface ScheduleChange {
  id: string;
  kind: ChangeKind;
  /** the lesson as it was when the change was made: group + date + start time */
  groupId: string;
  date: ISODate;
  start: string;
  newDate: ISODate | "";
  newStart: string;
  newEnd: string;
  newRoomId: string;
  /** substitute teacher; empty clears the substitute */
  substituteId: string;
  reason: string;
  createdOn: ISODate;
  payEffect: string;
}

export interface CalendarLesson {
  key: string;
  groupId: string;
  groupName: string;
  date: ISODate;
  start: string;
  end: string;
  roomId: string;
  teacherId: string;
  substitute: boolean;
  cancelled: boolean;
  cancelReason: string;
  movedFrom: string; // "YYYY-MM-DD HH:MM" of the first original slot, "" when never moved
  conflicts: Conflict[];
  capacity: CapacityCheck;
}

export const lessonKey = (groupId: string, date: ISODate, start: string): string => `${groupId}|${date}|${start}`;

const addDays = (d: ISODate, n: number): ISODate => {
  const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

/** Groups whose schedule text cannot be read (so no lessons come from them). */
export function invalidSchedules(groups: Group[]): Group[] {
  return groups.filter((g) => g.status === "active" && String(g.schedule ?? "").trim() !== "" && parseSchedule(String(g.schedule)) === null);
}

export interface ExpandArgs {
  groups: Group[];
  rooms: Room[];
  changes: ScheduleChange[];
  from: ISODate;
  to: ISODate;
  /** trial + active students per group */
  enrolled: Map<string, number>;
}

export interface Expanded {
  lessons: CalendarLesson[];
  /** changes that no longer match any lesson (the schedule text was edited afterwards) */
  orphans: ScheduleChange[];
}

export function expandLessons(a: ExpandArgs): Expanded {
  const live = a.groups.filter((g) => g.status === "active");
  const byId = new Map(a.groups.map((g) => [g.id, g]));
  let lo = a.from;
  let hi = a.to;
  for (const c of a.changes) {
    for (const d of [c.date, c.newDate]) {
      if (d && d < lo) lo = d;
      if (d && d > hi) hi = d;
    }
  }
  if (daysBetween(lo, hi) > 800) throw new Error("Sana oralig'i juda katta.");
  const lessons = new Map<string, CalendarLesson>();
  for (const g of live) {
    const slots = parseSchedule(String(g.schedule ?? ""));
    if (!slots) continue;
    for (let d = lo; d <= hi; d = addDays(d, 1)) {
      const wd = isoWeekday(d);
      for (const s of slots) {
        if (s.weekday !== wd) continue;
        const key = lessonKey(g.id, d, s.start);
        lessons.set(key, { key, groupId: g.id, groupName: g.name, date: d, start: s.start, end: s.end, roomId: g.roomId ?? "", teacherId: g.teacherId, substitute: false, cancelled: false, cancelReason: "", movedFrom: "", conflicts: [], capacity: "ok" });
      }
    }
  }
  const orphans: ScheduleChange[] = [];
  for (const c of [...a.changes].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const key = lessonKey(c.groupId, c.date, c.start);
    const l = lessons.get(key);
    if (!l || l.cancelled) {
      orphans.push(c);
      continue;
    }
    if (c.kind === "cancel") {
      l.cancelled = true;
      l.cancelReason = c.reason;
    } else if (c.kind === "substitute") {
      l.substitute = c.substituteId !== "";
      l.teacherId = c.substituteId !== "" ? c.substituteId : (byId.get(c.groupId)?.teacherId ?? "");
    } else {
      lessons.delete(key);
      l.movedFrom ||= `${c.date} ${c.start}`;
      l.date = c.newDate as ISODate;
      l.start = c.newStart;
      l.end = c.newEnd;
      if (c.newRoomId) l.roomId = c.newRoomId;
      l.key = lessonKey(l.groupId, l.date, l.start);
      lessons.set(l.key, l);
    }
  }
  const all = [...lessons.values()].filter((l) => l.date >= a.from && l.date <= a.to);
  const slotOf = (l: CalendarLesson): Slot => ({ id: l.key, date: l.date, start: l.start, end: l.end, room: l.roomId || null, teacher: l.teacherId || null, cancelled: l.cancelled });
  const slots = [...lessons.values()].map(slotOf);
  const roomOf = new Map(a.rooms.map((r) => [r.id, r]));
  for (const l of all) {
    l.conflicts = findConflicts(slotOf(l), slots);
    const g = byId.get(l.groupId);
    const room = roomOf.get(l.roomId);
    l.capacity = capacityCheck({ groupCapacity: g && Number.isInteger(g.capacity) && (g.capacity as number) > 0 ? (g.capacity as number) : null, enrolled: a.enrolled.get(l.groupId) ?? 0, roomCapacity: room && room.capacity > 0 ? room.capacity : null });
  }
  all.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.start < y.start ? -1 : x.start > y.start ? 1 : x.groupName.localeCompare(y.groupName)));
  return { lessons: all, orphans };
}

/** Who teaches the lesson of `groupId` on `date` (a substitute when one was set), falling back to the group's teacher. */
export function teacherResolver(groups: Group[], changes: ScheduleChange[], from: ISODate, to: ISODate): (groupId: string, date: ISODate) => string {
  const { lessons } = expandLessons({ groups, rooms: [], changes, from, to, enrolled: new Map() });
  const subs = new Map<string, string>();
  for (const l of lessons) if (!l.cancelled && l.substitute) subs.set(`${l.groupId}|${l.date}`, l.teacherId);
  const group = new Map(groups.map((g) => [g.id, g.teacherId]));
  return (groupId, date) => subs.get(`${groupId}|${date}`) ?? group.get(groupId) ?? "";
}
