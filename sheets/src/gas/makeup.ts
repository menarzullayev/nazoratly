/** Excused absence: make-up rights and credits. Rules live in ../domain (entitlements); this file moves data.
 * Nothing here sends a message. */
import { daysBetween, isIsoDate, monthStart } from "../domain/dates";
import { applyCredits, entitlementExpiresOn, entitlementState, lessonCreditAmount, type EffectiveStatus } from "../domain/entitlements";
import { nextId } from "../domain/ids";
import { monthLessonDates } from "../domain/lifecycle";
import { effectiveFee } from "../domain/billing";
import type { AttendanceRow, Enrollment, Entitlement, Group, Student } from "../domain/types";
import { guard, withLock } from "./actions";
import { pickId } from "./pick";
import { append, read, today, updateById, updateMany } from "./repo";
import { ATTENDANCE, ENROLLMENTS, ENTITLEMENTS, GROUPS, STUDENTS } from "./schema";
import { readSettings } from "./settings";

export const VIEW_SHEET = "Qoplash holati";
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();

const effective = (e: Entitlement): EffectiveStatus =>
  entitlementState({ status: e.status, expiresOn: e.expiresOn, today: today(), lapses: readSettings().makeupLapses });

/** Keeps entitlements in step with a saved roll call of one group and date (marks are the whole roll call). */
export function syncAttendance(date: string, groupId: string, marks: { studentId: string; status: AttendanceRow["status"] }[]): void {
  const all = read<Entitlement>(ENTITLEMENTS);
  const s = readSettings();
  const group = read<Group>(GROUPS).find((g) => g.id === groupId);
  const enrollments = read<Enrollment>(ENROLLMENTS);
  const marked = new Set(marks.map((m) => m.studentId));
  const usedIds = all.map((e) => e.id);

  for (const m of marks) {
    const closing = all.find((e) => e.studentId === m.studentId && e.groupId === groupId && e.makeupOn === date && (e.status === "scheduled" || e.status === "used"));
    if (closing) {
      if (m.status === "present" || m.status === "late") updateById(ENTITLEMENTS, "id", closing.id, { status: "used", usedOn: date });
      else updateById(ENTITLEMENTS, "id", closing.id, { status: "open", makeupOn: "", usedOn: "" }); // lastMakeupOn stays (payroll)
      continue;
    }
    const existing = all.find((e) => e.studentId === m.studentId && e.groupId === groupId && e.missedOn === date);
    if (m.status !== "excused") {
      if (existing?.status === "open") updateById(ENTITLEMENTS, "id", existing.id, { status: "cancelled" });
      continue;
    }
    if (s.excusedMode === "none" || !group) continue;
    if (group.billingMode === "package" && s.excusedMode === "credit") continue; // in a package group not consuming the lesson IS the credit
    if (!enrollments.some((e) => e.studentId === m.studentId && e.groupId === groupId && e.status === "active")) continue; // trials earn nothing
    const kind = s.excusedMode === "credit" ? "credit" : "makeup";
    let amount = 0;
    if (kind === "credit") {
      const month = monthStart(date);
      let lessons = monthLessonDates(month, group.schedule ?? "").length;
      if (lessons === 0) lessons = new Set(read<AttendanceRow>(ATTENDANCE).filter((a) => a.groupId === groupId && a.date.slice(0, 7) === date.slice(0, 7)).map((a) => a.date)).size;
      amount = lessonCreditAmount({ monthlyFee: effectiveFee(group, enrollments.find((e) => e.studentId === m.studentId && e.groupId === groupId)!), lessonsInMonth: lessons });
      if (amount <= 0) continue;
    }
    const patch = { kind, amount, expiresOn: entitlementExpiresOn(date, s.makeupExpiryDays), status: "open" as const, makeupOn: "", usedOn: "", appliedChargeId: "" };
    if (existing) {
      if (existing.status === "cancelled") updateById(ENTITLEMENTS, "id", existing.id, patch);
    } else {
      const id = nextId("R", usedIds);
      usedIds.push(id);
      append(ENTITLEMENTS, [{ id, studentId: m.studentId, groupId, missedOn: date, lastMakeupOn: "", ...patch }]);
    }
  }
  for (const e of all) {
    if (e.groupId === groupId && e.missedOn === date && e.status === "open" && !marked.has(e.studentId)) updateById(ENTITLEMENTS, "id", e.id, { status: "cancelled" });
  }
}

/** Reduces the planned tuition charges of a month by open credits (oldest first). Pure w.r.t. the sheets: returns what to write. */
export function reduceByCredits(planned: { studentId: string; amount: number }[], chargeIds: string[]): { amounts: number[]; consumed: { entitlementId: string; chargeId: string }[] } {
  const open = read<Entitlement>(ENTITLEMENTS).filter((e) => e.kind === "credit" && e.status === "open").sort((a, b) => (a.missedOn === b.missedOn ? a.id.localeCompare(b.id) : a.missedOn < b.missedOn ? -1 : 1));
  const taken = new Set<string>();
  const consumed: { entitlementId: string; chargeId: string }[] = [];
  const amounts = planned.map((c, i) => {
    const mine = open.filter((e) => e.studentId === c.studentId && !taken.has(e.id));
    const r = applyCredits({ fee: c.amount, credits: mine.map((e) => e.amount) });
    for (const e of mine.slice(0, r.used)) {
      taken.add(e.id);
      consumed.push({ entitlementId: e.id, chargeId: chargeIds[i]! });
    }
    return r.amount;
  });
  return { amounts, consumed };
}

export function markCreditsUsed(consumed: { entitlementId: string; chargeId: string }[]): void {
  updateMany(ENTITLEMENTS, "id", new Map(consumed.map((c) => [c.entitlementId, { status: "used", appliedChargeId: c.chargeId }])));
}

/** Dates on which a group had a make-up lesson: payroll counts such a day only when someone attended. */
export function makeupDays(): Set<string> {
  const out = new Set<string>();
  for (const e of read<Entitlement>(ENTITLEMENTS)) if (e.lastMakeupOn) out.add(`${e.lastMakeupOn}|${e.groupId}`);
  return out;
}

// ------------------------------------------------------------------ actions
const find = (id: string): Entitlement => {
  const e = read<Entitlement>(ENTITLEMENTS).find((x) => x.id === id);
  if (!e) throw new Error(`Qoplash huquqi topilmadi: ${id}`);
  return e;
};

export function scheduleMakeup(entitlementId?: string): void {
  const id = pickId(entitlementId, ENTITLEMENTS.sheet, "Qoplash darsini rejalash");
  withLock(() => {
    const e = find(id);
    if (e.kind === "credit") throw new Error("Kredit qoplash darsiga rejalanmaydi: u keyingi oylik hisobdan ayriladi.");
    const state = effective(e);
    if (state !== "open") throw new Error(`Bu huquq ochiq emas (${state}).`);
    const r = ui().prompt("Qoplash darsi", "Qoplash darsi sanasi (yyyy-mm-dd)", ui().ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
    const date = r.getResponseText().trim();
    if (!isIsoDate(date)) throw new Error(`Sana noto'g'ri: "${date}". Format: 2026-12-07`);
    if (date < today()) throw new Error("Qoplash darsini o'tgan sana ga rejalab bo'lmaydi.");
    if (!read<Enrollment>(ENROLLMENTS).some((x) => x.studentId === e.studentId && x.groupId === e.groupId && x.status === "active")) throw new Error("O'quvchi bu guruhda hozir faol emas.");
    updateById(ENTITLEMENTS, "id", e.id, { status: "scheduled", makeupOn: date, lastMakeupOn: date });
  });
  SpreadsheetApp.getActive().toast("Qoplash darsi rejalandi. O'sha kuni Davomat oynasida shu guruhni belgilang.", "nazoratly", 8);
}

export function cancelEntitlement(entitlementId?: string): void {
  const id = pickId(entitlementId, ENTITLEMENTS.sheet, "Qoplash huquqini bekor qilish");
  withLock(() => {
    const e = find(id);
    if (e.status !== "open" && e.status !== "scheduled") throw new Error(`Bu huquq ochiq emas (${e.status}).`);
    updateById(ENTITLEMENTS, "id", e.id, { status: "cancelled", makeupOn: "" });
  });
  SpreadsheetApp.getActive().toast("Huquq bekor qilindi.", "nazoratly", 6);
}

const LABEL: Record<EffectiveStatus, string> = { open: "Ochiq", scheduled: "Rejalangan", used: "Ishlatilgan", cancelled: "Bekor", lapsed: "Muddati o'tgan" };

export function openEntitlements(): void {
  const students = new Map(read<Student>(STUDENTS).map((s) => [s.id, s]));
  const groups = new Map(read<Group>(GROUPS).map((g) => [g.id, g]));
  const t = today();
  const rows = read<Entitlement>(ENTITLEMENTS)
    .filter((e) => e.status === "open" || e.status === "scheduled")
    .map((e) => [e.id, students.get(e.studentId)?.fullName ?? e.studentId, groups.get(e.groupId)?.name ?? e.groupId, e.kind === "credit" ? "Kredit" : "Qoplash darsi", e.amount, e.missedOn, e.expiresOn, LABEL[effective(e)], e.makeupOn, daysBetween(t, e.expiresOn)]);
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(VIEW_SHEET) ?? ss.insertSheet(VIEW_SHEET);
  sh.clear();
  const head = ["ID", "O'quvchi", "Guruh", "Turi", "Summa", "Qoldirilgan sana", "Muddat", "Holat", "Qoplash sanasi", "Qolgan kun"];
  sh.getRange(1, 1, 1, head.length).setValues([head]).setBackground("#202124").setFontColor("#fff").setFontWeight("bold").setWrap(true);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.activate();
}

export const menu = {
  view: (): void => guard("Qoplash", openEntitlements),
  schedule: (): void => guard("Qoplash", () => scheduleMakeup()),
  cancel: (): void => guard("Qoplash", () => cancelEntitlement()),
};
