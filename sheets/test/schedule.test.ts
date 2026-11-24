import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expandLessons, teacherResolver, type Room, type ScheduleChange } from "../src/domain/calendar";
import { heldLessonsFor } from "../src/domain/payroll";
import type { AttendanceRow, Group, ReminderDraft } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import { append, read, updateById } from "../src/gas/repo";
import * as schedule from "../src/gas/schedule";
import { ATTENDANCE, DRAFTS, ENROLLMENTS, GROUPS, PAYROLL, ROOMS, SCHEDULE_CHANGES, STUDENTS, TEACHERS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, name: `Guruh ${id}`, teacherId: "T0001", monthlyFee: 100_000, schedule: "Du 10:00-11:00", status: "active", ...extra });
const room = (id: string, capacity = 0): Room => ({ id, name: `Xona ${id}`, capacity });
const change = (id: string, kind: ScheduleChange["kind"], extra: Partial<ScheduleChange> = {}): ScheduleChange => ({ id, kind, groupId: "G1", date: "2026-12-07", start: "10:00", newDate: "", newStart: "", newEnd: "", newRoomId: "", substituteId: "", reason: "", createdOn: "2026-12-01", payEffect: "", ...extra });
const expand = (groups: Group[], changes: ScheduleChange[] = [], from = "2026-12-07", to = "2026-12-13", rooms: Room[] = [], enrolled: Record<string, number> = {}) =>
  expandLessons({ groups, rooms, changes, from, to, enrolled: new Map(Object.entries(enrolled)) });

describe("domain: weekly texts expanded over dates", () => {
  it("expands the weekly schedule of active groups, in order, with clashes and capacity flags", () => {
    const { lessons } = expand([group("G1", { schedule: "Du-Chor 18:00", roomId: "X1" }), group("G2", { teacherId: "T2", schedule: "Du 18:30-19:30", roomId: "X1", capacity: 12 }), group("G3", { status: "finished" })], [], "2026-12-07", "2026-12-13", [room("X1", 8)], { G1: 5 });
    expect(lessons.map((l) => `${l.date} ${l.start} ${l.groupId}`)).toEqual(["2026-12-07 18:00 G1", "2026-12-07 18:30 G2", "2026-12-09 18:00 G1"]);
    expect(lessons[0]!.conflicts).toEqual([{ kind: "room", otherId: "G2|2026-12-07|18:30" }]);
    expect(lessons[2]!.conflicts).toEqual([]);
    expect(lessons.map((l) => l.capacity)).toEqual(["ok", "group_capacity_over_room", "ok"]);
  });

  it("an unreadable schedule text gives no lessons and the same teacher clashes", () => {
    expect(expand([group("G1", { schedule: "kuni kora" })]).lessons).toEqual([]);
    const { lessons } = expand([group("G1"), group("G2", { schedule: "Du 10:30-11:30" })]);
    expect(lessons[0]!.conflicts.map((c) => c.kind)).toEqual(["teacher"]);
  });

  it("applies changes in order: cancel, substitute, move (also from outside the range), and keeps orphans apart", () => {
    const groups = [group("G1", { schedule: "Du 10:00-11:00" })];
    const changes = [
      change("J0001", "substitute", { substituteId: "T0002" }),
      change("J0002", "move", { newDate: "2026-12-09", newStart: "12:00", newEnd: "13:00" }),
      change("J0003", "cancel", { date: "2026-12-14", reason: "bayram" }),
      change("J0004", "cancel", { date: "2026-12-21" }), // matches a lesson, but outside the viewed week
      change("J0005", "cancel", { date: "2026-12-08" }), // Tuesday: no lesson there
    ];
    const week = expand(groups, changes);
    expect(week.lessons).toHaveLength(1);
    expect(week.lessons[0]).toMatchObject({ date: "2026-12-09", start: "12:00", end: "13:00", teacherId: "T0002", substitute: true, movedFrom: "2026-12-07 10:00", cancelled: false });
    expect(week.orphans.map((o) => o.id)).toEqual(["J0005"]);
    const next = expand(groups, changes, "2026-12-14", "2026-12-20");
    expect(next.lessons[0]).toMatchObject({ date: "2026-12-14", cancelled: true, cancelReason: "bayram" });
    // a lesson moved INTO the viewed week from a date before it
    const early = expand(groups, [change("J0001", "move", { date: "2026-11-30", newDate: "2026-12-08", newStart: "09:00", newEnd: "10:00" })], "2026-12-07", "2026-12-13");
    expect(early.lessons.map((l) => `${l.date} ${l.start}`)).toEqual(["2026-12-07 10:00", "2026-12-08 09:00"]);
  });

  it("clearing the substitute gives the lesson back; a cancelled lesson never clashes", () => {
    const groups = [group("G1"), group("G2", { schedule: "Du 10:00-11:00" })];
    const back = expand([group("G1")], [change("J0001", "substitute", { substituteId: "T0002" }), change("J0002", "substitute", { substituteId: "" })]);
    expect(back.lessons[0]).toMatchObject({ teacherId: "T0001", substitute: false });
    const { lessons } = expand(groups, [change("J0001", "cancel")]);
    expect(lessons.map((l) => [l.groupId, l.cancelled, l.conflicts.length])).toEqual([["G1", true, 0], ["G2", false, 0]]);
  });

  it("the teacher resolver follows substitutes and falls back to the group's teacher", () => {
    const groups = [group("G1"), group("G2", { teacherId: "T0009", status: "finished", schedule: "" })];
    const of = teacherResolver(groups, [change("J0001", "substitute", { substituteId: "T0002" })], "2026-12-01", "2026-12-31");
    expect(of("G1", "2026-12-07")).toBe("T0002");
    expect(of("G1", "2026-12-14")).toBe("T0001");
    expect(of("G2", "2026-12-07")).toBe("T0009");
    expect(of("G404", "2026-12-07")).toBe("");
  });

  it("heldLessonsFor counts a lesson for whoever taught it", () => {
    const att = (date: string, groupId: string, status: AttendanceRow["status"] = "present"): AttendanceRow => ({ date, groupId, studentId: "S1", status, minutesLate: 0 });
    const rows = [att("2026-12-07", "G1"), att("2026-12-07", "G1"), att("2026-12-14", "G1"), att("2026-11-30", "G1")];
    const of = teacherResolver([group("G1")], [change("J0001", "substitute", { substituteId: "T0002" })], "2026-12-01", "2026-12-31");
    expect(heldLessonsFor(rows, "2026-12-01", "T0001", of)).toBe(1);
    expect(heldLessonsFor(rows, "2026-12-01", "T0002", of)).toBe(1);
    expect(heldLessonsFor(rows, "2026-12-01", "T0003", of)).toBe(0);
  });
});

// ------------------------------------------------------------------ the Sheets actions
let h: Harness;
const teacher = (id: string, payModel: string, payRate: number, status = "active"): void => append(TEACHERS, [{ id, fullName: `Ustoz ${id}`, payModel, payRate, status }]);
const student = (id: string, name: string, extra: Record<string, unknown> = {}): void =>
  append(STUDENTS, [{ id, fullName: name, status: "active", phone: "", guardianName: "Dilnoza opa", guardianChatId: "555", consentNotify: true, ...extra }]);
const enroll = (id: string, studentId: string, groupId: string): void => append(ENROLLMENTS, [{ id, studentId, groupId, startedOn: "2026-11-01", endedOn: "", discountPercent: 0, status: "active" }]);
const addGroup = (g: Group): void => append(GROUPS, [g]);
const changes = (): ScheduleChange[] => read<ScheduleChange>(SCHEDULE_CHANGES);
const drafts = (): ReminderDraft[] => read<ReminderDraft>(DRAFTS);
const lastAlert = (): string => h.alerts[h.alerts.length - 1]!.message;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-01T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
  teacher("T0001", "per_lesson", 100_000);
  teacher("T0002", "per_lesson", 80_000);
  addGroup({ ...group("G0001", { name: "Ingliz A1", schedule: "Du-Chor 10:00-11:00" }), teacherId: "T0001" });
  student("S0001", "Ali");
  student("S0002", "Vali", { consentNotify: false });
  student("S0003", "Sami", { guardianChatId: "" });
  for (const [i, s] of ["S0001", "S0002", "S0003"].entries()) enroll(`E000${i + 1}`, s, "G0001");
});
afterEach(() => vi.useRealTimers());

describe("rooms and the calendar sheet", () => {
  it("adds rooms with ids, refuses duplicates and bad capacity", () => {
    expect(schedule.roomAdd("1-xona", "12")).toContain("X0001");
    expect(schedule.roomAdd("Zal", "")).toContain("X0002");
    expect(read<Room>(ROOMS).map((r) => [r.id, r.name, r.capacity])).toEqual([["X0001", "1-xona", 12], ["X0002", "Zal", 0]]);
    expect(() => schedule.roomAdd("1-XONA", "5")).toThrow(/allaqachon/);
    expect(() => schedule.roomAdd("", "5")).toThrow(/nomi/);
    expect(() => schedule.roomAdd("Yangi", "-3")).toThrow(/Sig'im/);
    expect(() => schedule.roomAdd("Yangi", "abc")).toThrow(/Sig'im/);
  });

  it("the week view lists every lesson of the week with teacher, room, status and warnings", () => {
    schedule.roomAdd("Kichik", "1");
    updateById(GROUPS, "id", "G0001", { roomId: "X0001" });
    schedule.lessonCancel({ groupId: "G0001", date: "2026-12-09", reason: "qor", notify: false });
    expect(schedule.openCalendar("week", "2026-12-10")).toContain("2026-12-07 ... 2026-12-13: 2 ta dars");
    const rows = h.rows(schedule.VIEW_SHEET);
    expect(rows[0]).toEqual(["Sana", "Kun", "Vaqt", "Guruh", "O'qituvchi", "Xona", "Holat", "Ogohlantirish"]);
    expect(rows.slice(1)).toEqual([
      ["2026-12-07", "Dushanba", "10:00-11:00", "G0001 Ingliz A1", "Ustoz T0001", "Kichik", "Rejada", "O'quvchilar xonaga sig'maydi"],
      ["2026-12-09", "Chorshanba", "10:00-11:00", "G0001 Ingliz A1", "Ustoz T0001", "Kichik", "Bekor qilingan: qor", ""],
    ]);
    schedule.openCalendar("day", "2026-12-07");
    expect(h.rows(schedule.VIEW_SHEET)).toHaveLength(2);
    schedule.openCalendar("week", "2026-12-07", "T0002");
    expect(h.rows(schedule.VIEW_SHEET)).toHaveLength(1); // a teacher filter: nothing of T0002
    expect(() => schedule.openCalendar("week", "07.12.2026")).toThrow(/Sana noto'g'ri/);
  });
});

describe("moving a lesson", () => {
  it("records the change, keeps the old slot visible and prepares drafts only for guardians who agreed", () => {
    const msg = schedule.lessonMove({ groupId: "G0001", date: "2026-12-07", newDate: "2026-12-08", newStart: "12:00", reason: "Bayram." });
    expect(msg).toContain("J0001");
    expect(msg).toContain("1 ta xabar loyihasi");
    expect(msg).toContain("Xabar yuborib bo'lmaydigan o'quvchilar: 2");
    expect(changes()).toEqual([expect.objectContaining({ id: "J0001", kind: "move", groupId: "G0001", date: "2026-12-07", start: "10:00", newDate: "2026-12-08", newStart: "12:00", newEnd: "13:00", reason: "Bayram." })]);
    expect(drafts()).toHaveLength(1);
    const d = drafts()[0]!;
    expect(d).toMatchObject({ studentId: "S0001", status: "pending", createdOn: "2026-12-01" });
    expect(d.text).toContain("Ingliz A1");
    expect(d.text).toContain("07.12.2026 10:00");
    expect(d.text).toContain("08.12.2026 12:00");
    expect(d.text).toContain("Sabab: Bayram.");
    expect(h.fetches).toEqual([]); // a draft is not a message: nothing was sent
    const lessons = expandLessons({ groups: read<Group>(GROUPS), rooms: [], changes: changes(), from: "2026-12-07", to: "2026-12-13", enrolled: new Map() }).lessons;
    expect(lessons.map((l) => `${l.date} ${l.start}`)).toEqual(["2026-12-08 12:00", "2026-12-09 10:00"]);
  });

  it("notify=false makes no drafts; a second move works from the lesson's current slot", () => {
    schedule.lessonMove({ groupId: "G0001", date: "2026-12-07", newDate: "2026-12-08", newStart: "12:00", notify: false });
    expect(drafts()).toEqual([]);
    expect(() => schedule.lessonMove({ groupId: "G0001", date: "2026-12-07", newDate: "2026-12-10", newStart: "12:00" })).toThrow(/darsi yo'q/);
    schedule.lessonMove({ groupId: "G0001", date: "2026-12-08", newDate: "2026-12-10", newStart: "09:00", newEnd: "09:30", notify: false });
    expect(changes().map((c) => [c.id, c.date, c.newDate, c.newEnd])).toEqual([["J0001", "2026-12-07", "2026-12-08", "13:00"], ["J0002", "2026-12-08", "2026-12-10", "09:30"]]);
  });

  it("validates dates, times, rooms, attendance and the group's own slots", () => {
    const base = { groupId: "G0001", date: "2026-12-07", newDate: "2026-12-08", newStart: "12:00", notify: false };
    expect(() => schedule.lessonMove({ ...base, groupId: "G9999" })).toThrow(/Guruh topilmadi/);
    expect(() => schedule.lessonMove({ ...base, date: "2026-12-08" })).toThrow(/darsi yo'q/);
    expect(() => schedule.lessonMove({ ...base, date: "bad" })).toThrow(/sanasi noto'g'ri/);
    expect(() => schedule.lessonMove({ ...base, newDate: "2026-02-30" })).toThrow(/Yangi sana/);
    expect(() => schedule.lessonMove({ ...base, newStart: "25:00" })).toThrow(/boshlanish/);
    expect(() => schedule.lessonMove({ ...base, newEnd: "11:00" })).toThrow(/tugash/);
    expect(() => schedule.lessonMove({ ...base, newRoomId: "X0404" })).toThrow(/Xona topilmadi/);
    expect(() => schedule.lessonMove({ ...base, newDate: "2026-12-07", newStart: "10:00" })).toThrow(/allaqachon shu/);
    expect(() => schedule.lessonMove({ ...base, newDate: "2026-12-09", newStart: "10:00" })).toThrow(/boshqa darsi bor/); // the group's Wednesday lesson
    append(ATTENDANCE, [{ date: "2026-12-07", groupId: "G0001", studentId: "S0001", status: "present", minutesLate: 0 }]);
    expect(() => schedule.lessonMove(base)).toThrow(/davomat belgilangan/);
    expect(changes()).toEqual([]);
  });

  it("refuses a busy room or teacher unless forced, and says who is in the way", () => {
    schedule.roomAdd("Zal", "30");
    updateById(GROUPS, "id", "G0001", { roomId: "X0001" });
    addGroup({ ...group("G0002", { name: "Matematika", teacherId: "T0002", schedule: "Se 12:00-13:00" }), roomId: "X0001" });
    const mv = { groupId: "G0001", date: "2026-12-07", newDate: "2026-12-08", newStart: "12:30", notify: false };
    expect(() => schedule.lessonMove(mv)).toThrow(schedule.ScheduleConflictError);
    expect(() => schedule.lessonMove(mv)).toThrow(/Xona band: Matematika/);
    expect(changes()).toEqual([]);
    schedule.lessonMove({ ...mv, force: true });
    expect(changes()).toHaveLength(1);
  });

  it("the menu offers to save a clash anyway", () => {
    schedule.roomAdd("Zal", "30");
    updateById(GROUPS, "id", "G0001", { roomId: "X0001" });
    addGroup({ ...group("G0002", { teacherId: "T0002", schedule: "Se 12:00-13:00" }), roomId: "X0001" });
    h.prompts.push("G0001", "2026-12-07", "", "2026-12-08", "12:30", "", "");
    h.answers.push("NO", "NO"); // no drafts; do not save the clash
    schedule.menu.move();
    expect(lastAlert()).toContain("Xona band");
    expect(changes()).toEqual([]);
    h.prompts.push("G0001", "2026-12-07", "", "2026-12-08", "12:30", "", "");
    h.answers.push("NO", "YES"); // no drafts; save anyway
    h.alerts.length = 0;
    schedule.menu.move();
    expect(changes()).toHaveLength(1);
    expect(lastAlert()).toContain("ko'chirildi");
  });
});

describe("cancelling a lesson", () => {
  it("cancels one lesson, prepares the drafts and never twice", () => {
    const msg = schedule.lessonCancel({ groupId: "G0001", date: "2026-12-09", start: "10:00", reason: "O'qituvchi kasal" });
    expect(msg).toContain("bekor qilindi");
    expect(msg).toContain("Oylik ta'siri: Ustoz T0001 2026-12: -100000");
    expect(changes()[0]).toMatchObject({ kind: "cancel", date: "2026-12-09", reason: "O'qituvchi kasal", payEffect: "Ustoz T0001 2026-12: -100000" });
    expect(drafts().map((d) => [d.studentId, d.status])).toEqual([["S0001", "pending"]]);
    expect(drafts()[0]!.text).toContain("bekor qilindi");
    expect(drafts()[0]!.text).toContain("Sabab: O'qituvchi kasal.");
    expect(() => schedule.lessonCancel({ groupId: "G0001", date: "2026-12-09" })).toThrow(/bekor qilingan/);
    expect(h.fetches).toEqual([]);
  });

  it("a held lesson cannot be cancelled; a fixed-salary teacher has no pay effect", () => {
    append(ATTENDANCE, [{ date: "2026-12-07", groupId: "G0001", studentId: "S0001", status: "absent", minutesLate: 0 }]);
    expect(() => schedule.lessonCancel({ groupId: "G0001", date: "2026-12-07" })).toThrow(/davomat/);
    updateById(TEACHERS, "id", "T0001", { payModel: "fixed", payRate: 5_000_000 });
    expect(schedule.lessonCancel({ groupId: "G0001", date: "2026-12-09", notify: false })).not.toContain("Oylik ta'siri");
  });
});

describe("substitute teacher and payroll", () => {
  const attend = (date: string): void => append(ATTENDANCE, [{ date, groupId: "G0001", studentId: "S0001", status: "present", minutesLate: 0 }]);
  const payroll = (): Record<string, { lessons: number; total: number; status: string }> =>
    Object.fromEntries(h.rows(PAYROLL).slice(1).map((r) => [String(r[1]), { lessons: Number(r[3]), total: Number(r[6]), status: String(r[7]) }]));

  it("pays the lesson to the substitute, not the group's teacher", () => {
    const msg = schedule.lessonSubstitute({ groupId: "G0001", date: "2026-12-07", substituteId: "T0002", reason: "kasal" });
    expect(msg).toContain("Ustoz T0001 2026-12: -100000");
    expect(msg).toContain("Ustoz T0002 2026-12: +80000");
    attend("2026-12-07"); // substituted
    attend("2026-12-09"); // taught by the group's teacher
    h.prompts.push("2026-12");
    actions.calculatePayroll();
    expect(payroll()).toMatchObject({ T0001: { lessons: 1, total: 100_000 }, T0002: { lessons: 1, total: 80_000 } });
  });

  it("clearing the substitute returns the lesson; rules for who may substitute", () => {
    schedule.lessonSubstitute({ groupId: "G0001", date: "2026-12-07", substituteId: "T0002" });
    schedule.lessonSubstitute({ groupId: "G0001", date: "2026-12-07", substituteId: "" });
    attend("2026-12-07");
    h.prompts.push("2026-12");
    actions.calculatePayroll();
    expect(payroll()).toMatchObject({ T0001: { lessons: 1, total: 100_000 }, T0002: { lessons: 0, total: 0 } });
    expect(() => schedule.lessonSubstitute({ groupId: "G0001", date: "2026-12-07", substituteId: "T0001" })).toThrow(/allaqachon shu/);
    expect(() => schedule.lessonSubstitute({ groupId: "G0001", date: "2026-12-07", substituteId: "T0404" })).toThrow(/O'qituvchi topilmadi/);
    teacher("T0003", "per_lesson", 10_000, "inactive");
    expect(() => schedule.lessonSubstitute({ groupId: "G0001", date: "2026-12-07", substituteId: "T0003" })).toThrow(/faol emas/);
  });

  it("a busy substitute is refused unless forced; an approved payroll blocks the change", () => {
    addGroup({ ...group("G0002", { teacherId: "T0002", schedule: "Du 10:30-11:30" }) });
    expect(() => schedule.lessonSubstitute({ groupId: "G0001", date: "2026-12-07", substituteId: "T0002" })).toThrow(/O'qituvchi band/);
    schedule.lessonSubstitute({ groupId: "G0001", date: "2026-12-07", substituteId: "T0002", force: true });
    expect(changes()).toHaveLength(1);
    h.prompts.push("2026-12");
    actions.calculatePayroll();
    const row = h.rows(PAYROLL).findIndex((r) => r[1] === "T0001");
    h.sheet(PAYROLL).getRange(row + 1, 8).setValue("Tasdiqlangan");
    expect(() => schedule.lessonCancel({ groupId: "G0001", date: "2026-12-09", notify: false })).toThrow(/allaqachon tasdiqlangan/);
    expect(changes()).toHaveLength(1);
  });
});

describe("checks", () => {
  it("reports clashes, room capacity, unknown rooms and orphan changes for the next four weeks", () => {
    expect(schedule.checkSchedule("2026-12-01")).toContain("yo'q");
    schedule.roomAdd("Kichik", "2");
    updateById(GROUPS, "id", "G0001", { roomId: "X0001" });
    addGroup({ ...group("G0002", { name: "Matematika", teacherId: "T0002", schedule: "Du 10:30-11:30" }), roomId: "X0001" });
    addGroup({ ...group("G0003", { name: "Fizika", schedule: "tushunarsiz" }), roomId: "X0404" });
    append(SCHEDULE_CHANGES, [change("J0001", "cancel", { groupId: "G0001", date: "2026-12-08" })]);
    const out = schedule.checkSchedule("2026-12-01");
    expect(out).toContain("xona band (Kichik)");
    expect(out).toContain("o'quvchilar xonaga sig'maydi");
    expect(out).toContain("Xona ID topilmadi (X0404)");
    expect(out).toContain("jadval matni tushunarsiz");
    expect(out).toContain("J0001: o'zgarish endi hech bir darsga mos kelmaydi");
    expect(() => schedule.checkSchedule("nope")).toThrow(/Sana noto'g'ri/);
  });
});

describe("the workbook", () => {
  it("has the new sheets and the group room column, and no new OAuth scope is needed", async () => {
    expect(h.sheets.has("Xonalar")).toBe(true);
    expect(h.sheets.has("Dars o'zgarishlari")).toBe(true);
    expect(h.rows(GROUPS)[0]).toContain("Xona ID");
    const manifest = JSON.parse((await import("node:fs")).readFileSync(new URL("../appsscript.json", import.meta.url), "utf8")) as { oauthScopes: string[] };
    expect(manifest.oauthScopes).toEqual(["https://www.googleapis.com/auth/spreadsheets.currentonly", "https://www.googleapis.com/auth/script.container.ui", "https://www.googleapis.com/auth/script.external_request", "https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/userinfo.email"]);
  });
});
