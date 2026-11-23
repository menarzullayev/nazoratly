/** Admission lifecycle actions: pending trial decisions, accept/drop a trial, lead to trial, funnel report.
 * Rules live in ../domain (lifecycle, funnel, billing); this file only moves data. Nothing here sends a message. */
import { effectiveFee } from "../domain/billing";
import { daysBetween, monthStart, withDay } from "../domain/dates";
import { nextId } from "../domain/ids";
import { funnelReport, STAGES } from "../domain/funnel";
import { firstMonthCharge, monthLessonDates, trialStatus, type FirstMonthMode } from "../domain/lifecycle";
import type { AttendanceRow, Charge, Enrollment, Group, Lead, Student } from "../domain/types";
import { guard, withLock } from "./actions";
import { pickId } from "./pick";
import { append, read, today, updateById } from "./repo";
import { ATTENDANCE, CHARGES, ENROLLMENTS, GROUPS, LEADS, STUDENTS } from "./schema";
import { readSettings } from "./settings";

export const PENDING_SHEET = "Qaror kutayotganlar";
export const FUNNEL_SHEET = "Voronka";

const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
type StudentRow = Student & { phone?: string };

function sheetOf(name: string): GoogleAppsScript.Spreadsheet.Sheet {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) ?? ss.insertSheet(name);
  sh.clear();
  return sh;
}

function writeTable(name: string, head: string[], rows: (string | number)[][], color: string): void {
  const sh = sheetOf(name);
  sh.getRange(1, 1, 1, head.length).setValues([head]).setBackground("#202124").setFontColor("#fff").setFontWeight("bold").setWrap(true);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.setTabColor(color);
  sh.activate();
}

function lessonsAttended(att: AttendanceRow[], e: Enrollment): number {
  return att.filter((a) => a.studentId === e.studentId && a.groupId === e.groupId && a.date >= e.startedOn && (a.status === "present" || a.status === "late")).length;
}

// ------------------------------------------------------------------ pending trials
export function pendingTrials(): void {
  const s = readSettings();
  const t = today();
  const att = read<AttendanceRow>(ATTENDANCE);
  const students = new Map(read<StudentRow>(STUDENTS).map((x) => [x.id, x]));
  const groups = new Map(read<Group>(GROUPS).map((g) => [g.id, g]));
  const rows: (string | number)[][] = [];
  for (const e of read<Enrollment>(ENROLLMENTS)) {
    if (e.status !== "trial") continue;
    const attended = lessonsAttended(att, e);
    const state = trialStatus({ startedOn: e.startedOn, today: t, lessonsAttended: attended, freeLessons: s.trialFreeLessons, freeDays: s.trialFreeDays });
    if (state !== "decision_needed") continue;
    const reason = attended >= s.trialFreeLessons ? `bepul dars(lar) o'tdi (${attended}/${s.trialFreeLessons})` : `bepul sinov kunlari o'tdi (${daysBetween(e.startedOn, t)}/${s.trialFreeDays} kun)`;
    rows.push([e.id, students.get(e.studentId)?.fullName ?? e.studentId, groups.get(e.groupId)?.name ?? e.groupId, e.startedOn, attended, Math.max(0, daysBetween(e.startedOn, t)), reason]);
  }
  writeTable(PENDING_SHEET, ["Yozilish ID", "O'quvchi", "Guruh", "Boshlangan sana", "O'tgan darslar", "Kunlar", "Sabab"], rows, "#e37400");
  SpreadsheetApp.getActive().toast(rows.length ? `${rows.length} ta sinov qaror kutmoqda. Qatorni tanlab, Qabul menyusidan qabul qiling yoki bekor qiling.` : "Qaror kutayotgan sinov yo'q.", "nazoratly", 8);
}

// ------------------------------------------------------------------ accept / drop
const MODES: Record<string, FirstMonthMode> = { "1": "prorated", "2": "full", "3": "free_until_next" };

function askMode(): FirstMonthMode {
  const r = ui().prompt(
    "Qabul qilish: birinchi oy",
    "Birinchi oy uchun qancha hisoblansin?\n1 = qolgan darslarga proratsiya (tavsiya)\n2 = to'liq oy\n3 = bu oy bepul, hisob keyingi oydan\nBo'sh qoldirsangiz: 1",
    ui().ButtonSet.OK_CANCEL,
  );
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  const v = r.getResponseText().trim() || "1";
  const mode = MODES[v];
  if (!mode) throw new Error(`Noto'g'ri javob: "${v}". 1, 2 yoki 3 kiriting.`);
  return mode;
}

export function acceptTrial(enrollmentId?: string): void {
  const id = pickId(enrollmentId, PENDING_SHEET, "Sinovni qabul qilish");
  const note = withLock(() => {
    const e = read<Enrollment>(ENROLLMENTS).find((x) => x.id === id);
    if (!e) throw new Error(`Yozilish topilmadi: ${id}`);
    if (e.status !== "trial") throw new Error(e.acceptedOn ? "Bu yozilish allaqachon qabul qilingan." : "Faqat sinovdagi yozilishni qabul qilish mumkin.");
    const g = read<Group>(GROUPS).find((x) => x.id === e.groupId);
    if (!g) throw new Error(`Guruh topilmadi: ${e.groupId}`);
    if (g.billingMode === "package") {
      // a package group bills when a package is sold, never by the month
      const acceptedOn = today();
      if (acceptedOn < e.startedOn) throw new Error("Sinov hali boshlanmagan.");
      updateById(ENROLLMENTS, "id", e.id, { status: "active", acceptedOn, firstMonthMode: "" });
      return "Qabul qilindi. Bu abonement guruhi: hisob yaratilmadi. Abonement sotish: nazoratly > Abonement.";
    }
    const mode = askMode();
    const s = readSettings();
    const acceptedOn = today();
    if (acceptedOn < e.startedOn) throw new Error("Sinov hali boshlanmagan.");
    const first = monthStart(acceptedOn);
    const lessonDates = monthLessonDates(first, g.schedule ?? "");
    const result = firstMonthCharge({ mode, monthlyFee: effectiveFee(g, e), acceptedOn, lessonDates });
    if (result.amount > 0) {
      const charges = read<Charge>(CHARGES);
      const due = withDay(first, s.dueDay);
      append(CHARGES, [
        {
          id: nextId("C", charges.map((c) => c.id)),
          studentId: e.studentId,
          enrollmentId: e.id,
          month: first,
          amount: result.amount,
          dueDate: due > acceptedOn ? due : acceptedOn,
          voided: false,
          note: `O'qish haqi ${first.slice(0, 7)} (birinchi oy)`,
        },
      ]);
    }
    updateById(ENROLLMENTS, "id", e.id, { status: "active", acceptedOn, firstMonthMode: mode });
    const fallback = result.fallbackToFull ? "\nGuruh jadvalida hafta kunlari ko'rsatilmagani uchun proratsiya o'rniga to'liq oy hisoblandi (Guruhlar > Jadval: masalan Du-Chor-Ju 18:00)." : "";
    return `Qabul qilindi. Birinchi oy hisobi: ${result.amount} so'm.${fallback}`;
  });
  ui().alert("Qabul", note, ui().ButtonSet.OK);
}

export function dropTrial(enrollmentId?: string): void {
  const id = pickId(enrollmentId, PENDING_SHEET, "Sinovni bekor qilish");
  withLock(() => {
    const e = read<Enrollment>(ENROLLMENTS).find((x) => x.id === id);
    if (!e) throw new Error(`Yozilish topilmadi: ${id}`);
    if (e.status !== "trial") throw new Error("Faqat sinovdagi yozilishni bekor qilish mumkin.");
    const t = today();
    updateById(ENROLLMENTS, "id", e.id, { status: "finished", endedOn: t > e.startedOn ? t : e.startedOn, droppedTrial: true });
  });
  SpreadsheetApp.getActive().toast("Sinov bekor qilindi. Hisob yaratilmagan.", "nazoratly", 6);
}

// ------------------------------------------------------------------ leads
function fillLeadIds(): Lead[] {
  const leads = read<Lead>(LEADS);
  const sh = SpreadsheetApp.getActive().getSheetByName(LEADS.sheet);
  if (!sh) return leads;
  const missing = leads.filter((l) => !l.id);
  if (!missing.length) return leads;
  const used = leads.map((l) => l.id).filter(Boolean);
  for (const l of missing) {
    l.id = nextId("L", used);
    used.push(l.id);
  }
  // ids are written back by row order (read() skips blank rows, so match on the remaining identifying cells)
  const data = sh.getDataRange().getValues();
  const head = (data[0] ?? []).map((h) => String(h).trim());
  const idCol = head.indexOf(LEADS.cols[0]!.header);
  const nameCol = head.indexOf(LEADS.cols[1]!.header);
  let k = 0;
  for (let r = 1; r < data.length && k < missing.length; r++) {
    if (String(data[r]![idCol] ?? "").trim() === "" && String(data[r]![nameCol] ?? "").trim() !== "") {
      sh.getRange(r + 1, idCol + 1).setValue(missing[k]!.id);
      k++;
    }
  }
  return leads;
}

export function enrollLeadInTrial(leadId?: string, groupId?: string): void {
  const id = pickId(leadId, LEADS.sheet, "Lead'ni sinovga yozish");
  let gid = groupId;
  if (!gid) {
    const r = ui().prompt("Guruh", "Qaysi guruhga sinovga yozamiz? Guruh ID (masalan G0001)", ui().ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
    gid = r.getResponseText().trim();
  }
  const groupKey = gid;
  withLock(() => {
    fillLeadIds();
    const lead = read<Lead>(LEADS).find((l) => l.id === id);
    if (!lead) throw new Error(`Lead topilmadi: ${id}`);
    if (lead.studentId) throw new Error("Bu lead allaqachon sinovga yozilgan.");
    const g = read<Group>(GROUPS).find((x) => x.id === groupKey);
    if (!g) throw new Error(`Guruh topilmadi: ${groupKey}`);
    const students = read<StudentRow>(STUDENTS);
    if (lead.phone && students.some((s) => s.phone === lead.phone)) throw new Error("Bu telefon raqami bilan o'quvchi allaqachon bor. Ikkilanishni oldini olish uchun avval o'sha o'quvchini tekshiring.");
    const sid = nextId("S", students.map((s) => s.id));
    append(STUDENTS, [{ id: sid, fullName: lead.fullName, status: "active", phone: lead.phone, guardianName: "", guardianChatId: "", consentNotify: false, note: `Lead ${lead.id}` }]);
    const enrollments = read<Enrollment>(ENROLLMENTS);
    append(ENROLLMENTS, [{ id: nextId("E", enrollments.map((e) => e.id)), studentId: sid, groupId: g.id, startedOn: today(), endedOn: "", discountPercent: 0, status: "trial" }]);
    updateById(LEADS, "id", lead.id, { stage: "trial_scheduled", studentId: sid });
  });
  SpreadsheetApp.getActive().toast("Lead sinovga yozildi. Hisob yaratilmaydi.", "nazoratly", 6);
}

// ------------------------------------------------------------------ funnel
const STAGE_LABELS: Record<string, string> = { new: "Yangi", contacted: "Aloqada", trial_scheduled: "Sinovga yozilgan", trial_attended: "Sinovda bo'ldi", enrolled: "Yozildi", lost: "Yo'qotildi" };

export function refreshFunnel(): void {
  const leads = fillLeadIds();
  const t = today();
  const from = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)) - 90)).toISOString().slice(0, 10);
  const rep = funnelReport(leads.map((l) => ({ stage: l.stage, source: l.source || null, createdOn: l.createdOn })), { from, to: t });
  const rows: (string | number)[][] = STAGES.map((s) => [STAGE_LABELS[s]!, rep.stages[s]]);
  rows.push(["", ""], ["Sinovdan yozilishga (%)", rep.trialToEnrolled], ["", ""], ["Manba", "Lead soni | Yozildi | Konversiya %"]);
  for (const s of rep.bySource) rows.push([s.source ?? "(manba yo'q)", `${s.leads} | ${s.enrolled} | ${s.conversion}`]);
  writeTable(FUNNEL_SHEET, [`Voronka: oxirgi 90 kun (${from} dan)`, "Soni"], rows, "#e37400");
}

// menu wiring helpers (kept here so Code.ts stays a thin list)
export const menu = {
  pending: (): void => guard("Qaror kutayotganlar", pendingTrials),
  accept: (): void => guard("Qabul", () => acceptTrial()),
  drop: (): void => guard("Sinov", () => dropTrial()),
  leadToTrial: (): void => guard("Lead", () => enrollLeadInTrial()),
  funnel: (): void => guard("Voronka", refreshFunnel),
};
