/** Group capacity and the waiting list: queue a student for a full group, see the queue and the seats that freed up,
 * enroll the next in line with one action, and prepare guardian message DRAFTS. Rules live in ../domain/capacity.ts
 * (shared with the API through tests/golden/capacity.json). Nothing here enrolls or messages anybody by itself. */
import { canEnrollFromWaitlist, canJoinWaitlist, directEnrollAllowed, freeSeats, offers, queuePosition, waitlistOrder, type GroupSeats, type Offer, type WaitEntry } from "../domain/capacity";
import { isIsoDate } from "../domain/dates";
import { nextId, nextIds } from "../domain/ids";
import { planSeatReminders, type SkipReason } from "../domain/reminders";
import type { Enrollment, Group, ReminderDraft, Student, WaitlistRow } from "../domain/types";
import { guard, withLock } from "./actions";
import { pickId } from "./pick";
import { append, read, readIfPresent, today, updateById } from "./repo";
import { DRAFTS, ENROLLMENTS, GROUPS, STUDENTS, WAITLIST } from "./schema";
import { readSettings } from "./settings";

export const VIEW_SHEET = "Navbat holati";
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const SEAT_HOLDERS = new Set(["trial", "active"]);

export interface SeatState {
  capacity: number | null;
  occupied: number;
  waiting: number;
}

const capacityOf = (g: Group): number | null => (Number.isInteger(g.capacity) && (g.capacity as number) > 0 ? (g.capacity as number) : null);

/** Seats and queue of one group (trials count as seats; a frozen student holds none). */
export function seatState(groupId: string, enrollments: Enrollment[] = read<Enrollment>(ENROLLMENTS), groups: Group[] = read<Group>(GROUPS), entries: WaitlistRow[] = readIfPresent<WaitlistRow>(WAITLIST)): SeatState {
  const g = groups.find((x) => x.id === groupId);
  return {
    capacity: g ? capacityOf(g) : null,
    occupied: enrollments.filter((e) => e.groupId === groupId && SEAT_HOLDERS.has(e.status)).length,
    waiting: entries.filter((w) => w.groupId === groupId && w.status === "waiting").length,
  };
}

/** Throws when the student may not take a seat directly (full group, or seats reserved for the queue). */
export function assertSeat(groupId: string, studentId: string, opts: { ignoreWaitlist?: boolean } = {}): void {
  const entries = readIfPresent<WaitlistRow>(WAITLIST);
  const st = seatState(groupId, undefined, undefined, entries);
  if (st.capacity === null) return;
  const own = entries.find((w) => w.groupId === groupId && w.studentId === studentId && w.status === "waiting");
  if (own) {
    const pos = queuePosition(toEntries(entries), own.id) ?? 1;
    if (!canEnrollFromWaitlist({ capacity: st.capacity, occupied: st.occupied, position: pos })) throw new Error("Guruhda bu navbat uchun hali bo'sh o'rin yo'q.");
    return;
  }
  if (!directEnrollAllowed({ capacity: st.capacity, occupied: st.occupied, waiting: st.waiting, ignoreWaitlist: opts.ignoreWaitlist === true })) {
    throw new Error(freeSeats(st.capacity, st.occupied) === 0 ? "Guruh to'lgan. O'quvchini navbatga yozing: nazoratly > Navbat." : "Bo'sh o'rinlar navbatdagilar uchun saqlangan: avval navbatdagini yozing (nazoratly > Navbat).");
  }
}

function toEntries(rows: WaitlistRow[]): WaitEntry[] {
  return rows.filter((w) => w.status === "waiting").map((w, i) => ({ id: w.id, groupId: w.groupId, joinedAt: w.joinedOn, n: i }));
}

export function loadOffers(): { offers: Offer[]; groups: Map<string, Group>; entries: Map<string, WaitlistRow> } {
  const groups = read<Group>(GROUPS).filter((g) => g.status === "active" || g.status === "planned");
  const enrollments = read<Enrollment>(ENROLLMENTS);
  const rows = readIfPresent<WaitlistRow>(WAITLIST);
  const seats: GroupSeats[] = groups.map((g) => ({ groupId: g.id, capacity: capacityOf(g), occupied: enrollments.filter((e) => e.groupId === g.id && SEAT_HOLDERS.has(e.status)).length }));
  const entries = toEntries(rows.filter((w) => groups.some((g) => g.id === w.groupId)));
  return { offers: offers(seats, entries), groups: new Map(groups.map((g) => [g.id, g])), entries: new Map(rows.map((w) => [w.id, w])) };
}

export function waitlistAdd(groupArg?: string, studentArg?: string): string {
  const groupId = pickId(groupArg, GROUPS.sheet, "Qaysi guruh navbatiga yozamiz?");
  const studentId = pickId(studentArg, STUDENTS.sheet, "Qaysi o'quvchi?");
  return withLock(() => {
    const g = read<Group>(GROUPS).find((x) => x.id === groupId);
    const s = read<Student>(STUDENTS).find((x) => x.id === studentId);
    if (!g) throw new Error(`Guruh topilmadi: ${groupId}`);
    if (!s) throw new Error(`O'quvchi topilmadi: ${studentId}`);
    if (g.status === "finished" || g.status === "cancelled") throw new Error("Guruh tugagan yoki bekor qilingan.");
    const enrollments = read<Enrollment>(ENROLLMENTS);
    if (enrollments.some((e) => e.groupId === groupId && e.studentId === studentId && e.status !== "finished")) throw new Error("O'quvchi bu guruhda allaqachon bor.");
    const rows = readIfPresent<WaitlistRow>(WAITLIST);
    if (rows.some((w) => w.groupId === groupId && w.studentId === studentId && w.status === "waiting")) throw new Error("O'quvchi bu guruh navbatida allaqachon turibdi.");
    const st = seatState(groupId, enrollments, [g], rows);
    if (!canJoinWaitlist({ capacity: st.capacity, occupied: st.occupied, waiting: st.waiting })) {
      throw new Error(st.capacity === null ? "Guruhda sig'im chegarasi yo'q: o'quvchini to'g'ridan-to'g'ri yozing." : "Guruhda bo'sh o'rin bor: o'quvchini to'g'ridan-to'g'ri yozing.");
    }
    const id = nextId("W", rows.map((w) => w.id));
    append(WAITLIST, [{ id, groupId, studentId, joinedOn: today(), status: "waiting", note: "" }]);
    return `${s.fullName} "${g.name}" navbatiga yozildi (${st.waiting + 1}-o'rin). ID: ${id}`;
  });
}

export function waitlistRemove(entryArg?: string): string {
  const id = pickId(entryArg, WAITLIST.sheet, "Navbat yozuvi ID si (W0001)");
  return withLock(() => {
    const w = readIfPresent<WaitlistRow>(WAITLIST).find((x) => x.id === id);
    if (!w) throw new Error(`Navbat yozuvi topilmadi: ${id}`);
    if (w.status !== "waiting") throw new Error("Bu yozuv allaqachon yopilgan.");
    updateById(WAITLIST, "id", id, { status: "removed" });
    return `${id} navbatdan olib tashlandi.`;
  });
}

/** Enrolls the student of a waiting entry: only while a seat is free for their place in the line. */
export function waitlistEnroll(entryArg?: string, asTrial?: boolean): string {
  const id = pickId(entryArg, WAITLIST.sheet, "Qaysi navbat yozuvini guruhga yozamiz? (W0001)");
  const trial = asTrial ?? ui().alert("Yozish", "Sinov sifatida yozamizmi? (Ha = sinov, Yo'q = faol o'quvchi)", ui().ButtonSet.YES_NO) === ui().Button.YES;
  return withLock(() => {
    const rows = readIfPresent<WaitlistRow>(WAITLIST);
    const w = rows.find((x) => x.id === id);
    if (!w) throw new Error(`Navbat yozuvi topilmadi: ${id}`);
    if (w.status !== "waiting") throw new Error("Bu yozuv allaqachon yopilgan.");
    assertSeat(w.groupId, w.studentId);
    const enrollments = read<Enrollment>(ENROLLMENTS);
    const eid = nextId("E", enrollments.map((e) => e.id));
    append(ENROLLMENTS, [{ id: eid, studentId: w.studentId, groupId: w.groupId, startedOn: today(), endedOn: "", discountPercent: 0, status: trial ? "trial" : "active" }]);
    updateById(WAITLIST, "id", id, { status: "enrolled" });
    return `${w.studentId} ${w.groupId} guruhiga yozildi (${eid}, ${trial ? "sinov" : "faol"}).`;
  });
}

export function checkCapacity(): string {
  const groups = read<Group>(GROUPS);
  const enrollments = read<Enrollment>(ENROLLMENTS);
  const rows = readIfPresent<WaitlistRow>(WAITLIST);
  const problems: string[] = [];
  for (const g of groups) {
    const cap = capacityOf(g);
    if (g.capacity !== undefined && g.capacity !== null && String(g.capacity) !== "" && cap === null) problems.push(`${g.id} "${g.name}": sig'im noto'g'ri (musbat butun son bo'lishi kerak) va e'tiborga olinmaydi.`);
    const occupied = enrollments.filter((e) => e.groupId === g.id && SEAT_HOLDERS.has(e.status)).length;
    if (cap !== null && occupied > cap) problems.push(`${g.id} "${g.name}": ${occupied} ta o'quvchi, sig'im ${cap}.`);
  }
  const known = new Set(groups.map((g) => g.id));
  const students = new Set(read<Student>(STUDENTS).map((s) => s.id));
  for (const w of rows) {
    if (!known.has(w.groupId)) problems.push(`${w.id}: guruh topilmadi (${w.groupId}).`);
    else if (!students.has(w.studentId)) problems.push(`${w.id}: o'quvchi topilmadi (${w.studentId}).`);
    else if (w.status === "waiting" && !isIsoDate(w.joinedOn)) problems.push(`${w.id}: sana noto'g'ri, navbat tartibi buziladi.`);
    else if (w.status === "waiting" && enrollments.some((e) => e.groupId === w.groupId && e.studentId === w.studentId && e.status !== "finished")) problems.push(`${w.id}: o'quvchi allaqachon guruhda, yozuvni "Olib tashlandi" qiling.`);
  }
  return problems.length ? `${problems.length} ta muammo:\n\n${problems.join("\n")}` : "Hammasi joyida: guruhlar sig'imdan oshmagan, navbat yozuvlari to'g'ri.";
}

export function openWaitlistView(): void {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(VIEW_SHEET) ?? ss.insertSheet(VIEW_SHEET);
  sh.clear();
  const groups = read<Group>(GROUPS).filter((g) => capacityOf(g) !== null || readIfPresent<WaitlistRow>(WAITLIST).some((w) => w.groupId === g.id && w.status === "waiting"));
  const enrollments = read<Enrollment>(ENROLLMENTS);
  const rows = readIfPresent<WaitlistRow>(WAITLIST);
  const students = new Map(read<Student>(STUDENTS).map((s) => [s.id, s]));
  const { offers: offered } = loadOffers();
  const offerIds = new Set(offered.map((o) => o.entryId));
  const out: (string | number)[][] = [["Guruh", "Sig'im", "Band", "Bo'sh", "Navbatda", "Navbat (tartib bilan)", "Bo'sh o'rin taklifi"]];
  for (const g of groups) {
    const cap = capacityOf(g);
    const occupied = enrollments.filter((e) => e.groupId === g.id && SEAT_HOLDERS.has(e.status)).length;
    const line = waitlistOrder(toEntries(rows.filter((w) => w.groupId === g.id)));
    const names = line.map((e, i) => `${i + 1}. ${students.get(rows.find((w) => w.id === e.id)!.studentId)?.fullName ?? rows.find((w) => w.id === e.id)!.studentId} (${e.id})`).join("; ");
    const next = line.filter((e) => offerIds.has(e.id)).map((e) => students.get(rows.find((w) => w.id === e.id)!.studentId)?.fullName ?? e.id).join(", ");
    out.push([`${g.id} ${g.name}`, cap ?? "cheklanmagan", occupied, cap === null ? "-" : Math.max(0, cap - occupied), line.length, names || "-", next || "-"]);
  }
  sh.getRange(1, 1, out.length, out[0]!.length).setValues(out as never);
  sh.setFrozenRows(1);
  sh.activate();
}

const REASONS: Record<SkipReason, string> = { no_consent: "vasiy roziligi yo'q", no_chat: "vasiy Telegramga ulanmagan", cooldown: "yaqinda eslatma yaratilgan", below_threshold: "chegaradan past", student_inactive: "o'quvchi faol emas", already_overdue: "oldin yaratilgan" };

/** Guardian message DRAFTS for the next in line; a person approves each draft in "Eslatmalarni ko'rib chiqish". */
export function createSeatDrafts(): string {
  return withLock(() => {
    const s = readSettings();
    const { offers: offered, groups } = loadOffers();
    const entries = readIfPresent<WaitlistRow>(WAITLIST);
    const drafts = read<ReminderDraft>(DRAFTS);
    const plan = planSeatReminders({
      offers: offered.map((o) => ({ studentId: entries.find((w) => w.id === o.entryId)!.studentId, groupName: groups.get(o.groupId)?.name ?? o.groupId, freeSeats: o.freeSeats })),
      students: read<Student>(STUDENTS),
      drafts,
      today: today(),
      cooldownDays: s.cooldownDays,
      centerName: s.center,
    });
    const ids = nextIds("R", drafts.map((d) => d.id), plan.drafts.length);
    append(DRAFTS, plan.drafts.map((d, i) => ({ id: ids[i]!, studentId: d.studentId, createdOn: today(), text: d.text, status: "pending", error: "" })));
    const counts = new Map<SkipReason, number>();
    for (const k of plan.skipped) counts.set(k.reason, (counts.get(k.reason) ?? 0) + 1);
    const skipped = [...counts].map(([r, n]) => `  - ${n} ta: ${REASONS[r]}`).join("\n");
    return `${plan.drafts.length} ta bo'sh o'rin xabari loyihasi yaratildi (hali yuborilmadi, hech kim yozilmadi).\n\nO'tkazib yuborilgan:\n${skipped || "  yo'q"}\n\nKeyingi qadam: nazoratly > Eslatmalarni ko'rib chiqish.`;
  });
}

export const menu = {
  add: (): void => guard("Navbat", () => ui().alert("Navbat", waitlistAdd(), ui().ButtonSet.OK)),
  view: (): void => guard("Navbat", openWaitlistView),
  enroll: (): void => guard("Navbat", () => ui().alert("Navbat", waitlistEnroll(), ui().ButtonSet.OK)),
  remove: (): void => guard("Navbat", () => ui().alert("Navbat", waitlistRemove(), ui().ButtonSet.OK)),
  drafts: (): void => guard("Navbat", () => ui().alert("Bo'sh o'rin xabarlari", createSeatDrafts(), ui().ButtonSet.OK)),
  check: (): void => guard("Navbat", () => ui().alert("Sig'imni tekshirish", checkCapacity(), ui().ButtonSet.OK)),
};
