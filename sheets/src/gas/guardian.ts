/** Guardian cabinet (G7), the center's side in the Sheets edition: linking guardians to students and approving what they ask.
 * The guardian-facing bot buttons, Mini App and web portal are API-only (the same rules, golden-tested in
 * tests/golden/guardian.json). Here staff RECORD a request a guardian made (by phone, in person, or through the bot's QR
 * link) and the owner approves or rejects it; nothing takes effect before approval and nothing is sent to a guardian
 * (Model B): the guardian sees the outcome from the center. */
import { daysBetween } from "../domain/dates";
import { freeSeats } from "../domain/capacity";
import {
  absenceCheck,
  linkDecision,
  makeupCheck,
  makeupOptions,
  phoneKey,
  promiseCheck,
  requestEffect,
  requestTransition,
  type SlotCandidate,
} from "../domain/guardian";
import { nextId } from "../domain/ids";
import { monthLessonDates } from "../domain/lifecycle";
import type { AttendanceRow, Enrollment, Entitlement, Group, GuardianLink, GuardianRequest, Student } from "../domain/types";
import { checkAttendance, guard, outstandingOf, withLock, writeAttendance } from "./actions";
import { pickId } from "./pick";
import { append, read, readIfPresent, today, updateById } from "./repo";
import { ATTENDANCE, ENROLLMENTS, ENTITLEMENTS, GROUPS, GUARDIAN_LINKS, GUARDIAN_REQUESTS, STUDENTS } from "./schema";
import { readSettings } from "./settings";

type StudentRow = Student & { phone?: string; linkCode?: string; linkUrl?: string; qrCode?: string };

const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const toast = (msg: string): void => SpreadsheetApp.getActive().toast(msg, "nazoratly", 8);

const REASON_TEXT: Record<string, string> = {
  reason_required: "Sababni yozing.",
  reason_too_long: "Sabab 300 belgidan oshmasligi kerak.",
  not_in_group: "O'quvchi bu guruhda emas.",
  lesson_cancelled: "Bu dars bekor qilingan.",
  lesson_started: "Dars kuni yoki o'tib ketgan: kela olmaslik haqida darsdan oldingi kunlarda xabar beriladi.",
  already_marked: "Bu dars uchun davomat belgilangan.",
  no_debt: "Qarz yo'q.",
  duplicate: "Kutilayotgan yoki amaldagi va'da bor.",
  date_past: "Sana o'tib ketgan.",
  date_too_far: "Sana juda uzoq (Sozlamalar: 'Vasiy to'lov va'dasi: eng uzoq kun').",
  amount_invalid: "Summa noto'g'ri: qarzdan oshmasin.",
  not_makeup: "Bu huquq qoplash darsi emas.",
  not_open: "Qoplash huquqi ochiq emas.",
  expired: "Qoplash huquqi muddati tugagan.",
  slot_unavailable: "Bu vaqt mavjud emas.",
};
const explain = (reason: string): Error => new Error(REASON_TEXT[reason] ?? reason);

const student = (id: string): StudentRow => {
  const s = read<StudentRow>(STUDENTS).find((x) => x.id === id);
  if (!s) throw new Error(`O'quvchi topilmadi: ${id}`);
  return s;
};

const newId = (def: typeof GUARDIAN_REQUESTS | typeof GUARDIAN_LINKS, prefix: string): string => nextId(prefix, readIfPresent<{ id: string }>(def).map((r) => r.id));

// ------------------------------------------------------------------ recording requests
const blank = (): Omit<GuardianRequest, "id" | "kind" | "studentId" | "createdOn" | "via"> => ({
  groupId: "",
  date: "",
  entitlementId: "",
  reason: "",
  promiseDate: "",
  amount: 0,
  status: "pending",
  decidedOn: "",
  note: "",
});

/** The guardian will not come to a lesson: allowed only BEFORE the lesson's day (the sheets keep no lesson times). */
export function recordAbsence(a: { studentId: string; groupId: string; date: string; reason: string; via?: string }): string {
  return withLock(() => {
    student(a.studentId);
    const inGroup = read<Enrollment>(ENROLLMENTS).some((e) => e.studentId === a.studentId && e.groupId === a.groupId && (e.status === "active" || e.status === "trial"));
    const mark = read<AttendanceRow>(ATTENDANCE).find((r) => r.studentId === a.studentId && r.groupId === a.groupId && r.date === a.date);
    const group = read<Group>(GROUPS).find((g) => g.id === a.groupId);
    const verdict = absenceCheck({
      reason: a.reason,
      lessonStart: `${a.date}T00:00:00`,
      now: `${today()}T00:00:00`,
      lessonStatus: group && group.status !== "cancelled" ? "planned" : "cancelled",
      inGroup,
      existingMark: mark ? mark.status : null,
    });
    if (verdict !== "ok") throw explain(verdict);
    const open = readIfPresent<GuardianRequest>(GUARDIAN_REQUESTS).some((r) => r.kind === "absence_reason" && r.status === "pending" && r.studentId === a.studentId && r.groupId === a.groupId && r.date === a.date);
    if (open) throw new Error("Bu dars uchun so'rov allaqachon kiritilgan va javob kutmoqda.");
    const id = newId(GUARDIAN_REQUESTS, "Q");
    append(GUARDIAN_REQUESTS, [{ id, kind: "absence_reason", studentId: a.studentId, createdOn: today(), via: a.via ?? "Markazda", ...blank(), groupId: a.groupId, date: a.date, reason: a.reason.trim() }]);
    return id;
  });
}

export function recordPromise(a: { studentId: string; promiseDate: string; amount?: number; via?: string }): string {
  return withLock(() => {
    student(a.studentId);
    const active = readIfPresent<GuardianRequest>(GUARDIAN_REQUESTS).some(
      (r) => r.kind === "payment_promise" && r.studentId === a.studentId && (r.status === "pending" || (r.status === "approved" && r.promiseDate >= today())),
    );
    const verdict = promiseCheck({
      today: today(),
      promiseDate: a.promiseDate,
      outstanding: outstandingOf(a.studentId),
      amount: a.amount ? a.amount : null,
      maxDays: readSettings().guardianPromiseDays,
      hasActive: active,
    });
    if (verdict !== "ok") throw explain(verdict);
    const id = newId(GUARDIAN_REQUESTS, "Q");
    append(GUARDIAN_REQUESTS, [{ id, kind: "payment_promise", studentId: a.studentId, createdOn: today(), via: a.via ?? "Markazda", ...blank(), promiseDate: a.promiseDate, amount: a.amount ?? 0 }]);
    return id;
  });
}

/** Dates a guardian may choose for an open make-up right: lessons of OTHER active groups (the sheets keep no course, the owner
 * checks the fit when approving) within the right's validity, with a free seat. Ids look like "G0002|2026-12-07". */
export function slotOptions(entitlementId: string): { id: string; groupId: string; date: string }[] {
  const e = read<Entitlement>(ENTITLEMENTS).find((x) => x.id === entitlementId);
  if (!e) throw new Error(`Qoplash huquqi topilmadi: ${entitlementId}`);
  const t = today();
  const enrollments = read<Enrollment>(ENROLLMENTS);
  const candidates: SlotCandidate[] = [];
  for (const g of read<Group>(GROUPS)) {
    if (g.id === e.groupId || g.status !== "active") continue;
    const occupied = enrollments.filter((x) => x.groupId === g.id && (x.status === "active" || x.status === "trial")).length;
    const free = freeSeats(g.capacity ?? null, occupied);
    const months = new Set<string>();
    for (let d = 1; d <= Math.min(daysBetween(t, e.expiresOn), 62); d++) months.add(addDays(t, d).slice(0, 7) + "-01");
    for (const m of months) {
      for (const date of monthLessonDates(m, g.schedule ?? "")) {
        candidates.push({ id: `${g.id}|${date}`, date, start: "", seatsLeft: free === null ? 999 : free });
      }
    }
  }
  return makeupOptions({ candidates, today: t, expiresOn: e.expiresOn }).map((id) => ({ id, groupId: id.split("|")[0]!, date: id.split("|")[1]! }));
}

function addDays(date: string, n: number): string {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + n));
  return d.toISOString().slice(0, 10);
}

export function recordMakeup(a: { entitlementId: string; slot: string; via?: string }): string {
  return withLock(() => {
    const e = read<Entitlement>(ENTITLEMENTS).find((x) => x.id === a.entitlementId);
    if (!e) throw new Error(`Qoplash huquqi topilmadi: ${a.entitlementId}`);
    const options = slotOptions(e.id).map((o) => o.id);
    const verdict = makeupCheck({ kind: e.kind, status: e.status, expiresOn: e.expiresOn, today: today(), slot: a.slot, options });
    if (verdict !== "ok") throw explain(verdict);
    if (readIfPresent<GuardianRequest>(GUARDIAN_REQUESTS).some((r) => r.kind === "makeup_choice" && r.status === "pending" && r.entitlementId === e.id)) {
      throw new Error("Bu huquq uchun tanlov allaqachon kiritilgan va javob kutmoqda.");
    }
    const [groupId, date] = a.slot.split("|") as [string, string];
    const id = newId(GUARDIAN_REQUESTS, "Q");
    append(GUARDIAN_REQUESTS, [{ id, kind: "makeup_choice", studentId: e.studentId, createdOn: today(), via: a.via ?? "Markazda", ...blank(), groupId, date, entitlementId: e.id }]);
    return id;
  });
}

// ------------------------------------------------------------------ deciding
/** Approve or reject a request; approval applies its effect in the same locked step. */
export function decide(id: string, action: "approve" | "reject" | "cancel", note = ""): GuardianRequest {
  return withLock(() => {
    const r = readIfPresent<GuardianRequest>(GUARDIAN_REQUESTS).find((x) => x.id === id);
    if (!r) throw new Error(`So'rov topilmadi: ${id}`);
    const next = requestTransition({ status: r.status, action });
    if (next === "invalid") throw new Error(`So'rov allaqachon: ${r.status}.`);
    if (action === "approve") {
      const effect = requestEffect({ kind: r.kind });
      if (effect === "mark_excused") applyAbsence(r);
      else if (effect === "schedule_makeup") applyMakeup(r);
    }
    updateById(GUARDIAN_REQUESTS, "id", r.id, { status: next, decidedOn: today(), note });
    return { ...r, status: next, decidedOn: today(), note };
  });
}

function applyAbsence(r: GuardianRequest): void {
  const marks = read<AttendanceRow>(ATTENDANCE).filter((a) => a.groupId === r.groupId && a.date === r.date);
  const mine = marks.find((a) => a.studentId === r.studentId);
  if (mine && (mine.status === "present" || mine.status === "late")) throw new Error("O'quvchi bu dars uchun 'keldi' deb belgilangan.");
  // the roll call of that group and day is saved as a whole (the make-up right follows from the saved marks)
  const input = {
    date: r.date as string,
    groupId: r.groupId,
    marks: [
      ...marks.filter((a) => a.studentId !== r.studentId).map((a) => ({ studentId: a.studentId, status: a.status, minutesLate: a.minutesLate })),
      { studentId: r.studentId, status: "excused" as AttendanceRow["status"], minutesLate: 0 },
    ],
  };
  checkAttendance(input);
  writeAttendance(input);
}

function applyMakeup(r: GuardianRequest): void {
  const e = read<Entitlement>(ENTITLEMENTS).find((x) => x.id === r.entitlementId);
  if (!e) throw new Error("Qoplash huquqi topilmadi.");
  const slot = `${r.groupId}|${r.date}`;
  const verdict = makeupCheck({ kind: e.kind, status: e.status, expiresOn: e.expiresOn, today: today(), slot, options: slotOptions(e.id).map((o) => o.id) });
  if (verdict !== "ok") throw explain(verdict);
  if (!read<Enrollment>(ENROLLMENTS).some((x) => x.studentId === e.studentId && x.groupId === e.groupId && x.status === "active")) {
    throw new Error("O'quvchi bu guruhda hozir faol emas.");
  }
  updateById(ENTITLEMENTS, "id", e.id, { status: "scheduled", makeupOn: r.date, lastMakeupOn: r.date });
}

// ------------------------------------------------------------------ links
const newCode = (): string => Utilities.getUuid().replace(/-/g, "").slice(0, 10).toUpperCase();

/** The student's one-time code the guardian confirms the link with (consent comes next, in the bot). */
function ensureLinkCode(s: StudentRow): string {
  if (s.linkCode) return s.linkCode;
  const code = newCode();
  updateById(STUDENTS, "id", s.id, { linkCode: code });
  return code;
}

/** A guardian sent the student's QR card code to the bot: the center decides (a card can be photographed). */
export function qrLinkRequest(chatId: string, name: string, qrCode: string): "pending" | "unknown" {
  return withLock(() => {
    const s = read<StudentRow>(STUDENTS).find((x) => x.qrCode && x.qrCode === qrCode && x.status !== "left");
    if (!s) return "unknown";
    if (linkDecision({ method: "qr", phoneVerified: false, phoneMatches: false }) !== "pending") return "unknown";
    const dup = readIfPresent<GuardianLink>(GUARDIAN_LINKS).some((l) => l.status === "pending" && l.studentId === s.id && l.chatId === chatId);
    if (!dup) append(GUARDIAN_LINKS, [{ id: newId(GUARDIAN_LINKS, "V"), studentId: s.id, chatId, name, method: "qr", status: "pending", createdOn: today(), decidedOn: "" }]);
    return "pending";
  });
}

/** A guardian shared his own Telegram contact: the students whose phone matches get the consent step (no code typed). */
export function phoneLinkStudents(phone: string, verified: boolean): { id: string; fullName: string; code: string }[] {
  const key = phoneKey(phone);
  return withLock(() => {
    const hits = key ? read<StudentRow>(STUDENTS).filter((s) => s.status !== "left" && s.phone && phoneKey(s.phone) === key) : [];
    if (linkDecision({ method: "phone", phoneVerified: verified, phoneMatches: hits.length > 0 }) !== "active") return [];
    return hits.map((s) => ({ id: s.id, fullName: s.fullName, code: ensureLinkCode(s) }));
  });
}

/** Students linked to this chat who still have to accept the privacy consent (approved by the center or linked by hand). */
export function awaitingConsent(chatId: string): { id: string; fullName: string; code: string }[] {
  return withLock(() =>
    read<StudentRow>(STUDENTS)
      .filter((s) => s.guardianChatId === chatId && !s.consentNotify)
      .map((s) => ({ id: s.id, fullName: s.fullName, code: ensureLinkCode(s) })),
  );
}

function setChat(studentId: string, chatId: string): void {
  const s = student(studentId);
  if (s.guardianChatId && s.guardianChatId !== chatId) throw new Error(`Bu o'quvchi boshqa Telegram hisobiga ulangan (${s.guardianChatId}). Avval ulanishni olib tashlang.`);
  const taken = read<StudentRow>(STUDENTS).find((x) => x.id !== studentId && x.guardianChatId === chatId && x.guardianName && s.guardianName && x.guardianName !== s.guardianName);
  if (taken) throw new Error(`Bu Telegram hisobi boshqa vasiyga (${taken.guardianName}) ulangan.`);
  updateById(STUDENTS, "id", studentId, { guardianChatId: chatId });
  ensureLinkCode(student(studentId));
}

export function approveLink(id: string): void {
  withLock(() => {
    const l = readIfPresent<GuardianLink>(GUARDIAN_LINKS).find((x) => x.id === id);
    if (!l) throw new Error(`Ulanish so'rovi topilmadi: ${id}`);
    if (l.status !== "pending") throw new Error(`So'rov allaqachon: ${l.status}.`);
    setChat(l.studentId, l.chatId);
    updateById(GUARDIAN_LINKS, "id", id, { status: "approved", decidedOn: today() });
  });
}

export function rejectLink(id: string): void {
  withLock(() => {
    const l = readIfPresent<GuardianLink>(GUARDIAN_LINKS).find((x) => x.id === id);
    if (!l) throw new Error(`Ulanish so'rovi topilmadi: ${id}`);
    if (l.status !== "pending") throw new Error(`So'rov allaqachon: ${l.status}.`);
    updateById(GUARDIAN_LINKS, "id", id, { status: "rejected", decidedOn: today() });
  });
}

/** The center links a Telegram chat to a student by hand. The guardian still has to accept the consent in the bot. */
export function manualLink(studentId: string, chatId: string): void {
  if (!/^-?\d{5,}$/.test(chatId)) throw new Error("Telegram chat ID raqamlardan iborat bo'lishi kerak.");
  withLock(() => {
    setChat(studentId, chatId);
    append(GUARDIAN_LINKS, [{ id: newId(GUARDIAN_LINKS, "V"), studentId, chatId, name: "", method: "manual", status: "approved", createdOn: today(), decidedOn: today() }]);
  });
}

// ------------------------------------------------------------------ menu
const prompt = (title: string, text: string): string => {
  const r = ui().prompt(title, text, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  return r.getResponseText().trim();
};

export const menu = {
  absence: (): void => guard("Vasiy so'rovi", () => {
    const id = recordAbsence({ studentId: prompt("Darsga kela olmaslik", "O'quvchi ID (masalan S0001)"), groupId: prompt("Darsga kela olmaslik", "Guruh ID (masalan G0001)"), date: prompt("Darsga kela olmaslik", "Dars sanasi (yyyy-mm-dd)"), reason: prompt("Darsga kela olmaslik", "Sabab"), via: "Markazda" });
    toast(`${id} kiritildi. Tasdiqlanmaguncha davomat o'zgarmaydi.`);
  }),
  promise: (): void => guard("Vasiy so'rovi", () => {
    const studentId = prompt("To'lov va'dasi", "O'quvchi ID (masalan S0001)");
    const promiseDate = prompt("To'lov va'dasi", "Qaysi sanagacha to'laydi (yyyy-mm-dd)");
    const amount = Number(prompt("To'lov va'dasi", "Summa (so'm), bo'sh = butun qarz").replace(/\s/g, "") || "0");
    const id = recordPromise({ studentId, promiseDate, amount: Number.isFinite(amount) ? amount : 0, via: "Markazda" });
    toast(`${id} kiritildi.`);
  }),
  makeup: (): void => guard("Vasiy so'rovi", () => {
    const entitlementId = prompt("Qoplash darsi", "Qoplash huquqi ID (masalan R0001)");
    const options = slotOptions(entitlementId);
    if (!options.length) throw new Error("Tanlash mumkin bo'lgan vaqt yo'q.");
    const shown = options.slice(0, 8).map((o, i) => `${i + 1}) ${o.date}, guruh ${o.groupId}`).join("\n");
    const n = Number(prompt("Qoplash darsi", `Raqamini kiriting:\n${shown}`));
    const slot = options[n - 1];
    if (!slot) throw new Error("Noto'g'ri raqam.");
    const id = recordMakeup({ entitlementId, slot: slot.id, via: "Markazda" });
    toast(`${id} kiritildi.`);
  }),
  approve: (): void => guard("So'rovni tasdiqlash", () => {
    const id = pickId(undefined, GUARDIAN_REQUESTS.sheet, "So'rovni tasdiqlash");
    const r = decide(id, "approve");
    toast(`${r.id} tasdiqlandi.`);
  }),
  reject: (): void => guard("So'rovni rad etish", () => {
    const id = pickId(undefined, GUARDIAN_REQUESTS.sheet, "So'rovni rad etish");
    const r = decide(id, "reject", prompt("Rad etish", "Sabab (ixtiyoriy)"));
    toast(`${r.id} rad etildi.`);
  }),
  approveLink: (): void => guard("Ulanishni tasdiqlash", () => {
    approveLink(pickId(undefined, GUARDIAN_LINKS.sheet, "Ulanishni tasdiqlash"));
    toast("Ulandi. Vasiy botga /start yuborib rozilikni bersin.");
  }),
  rejectLink: (): void => guard("Ulanishni rad etish", () => {
    rejectLink(pickId(undefined, GUARDIAN_LINKS.sheet, "Ulanishni rad etish"));
    toast("Rad etildi.");
  }),
  manualLink: (): void => guard("Qo'lda ulash", () => {
    manualLink(prompt("Qo'lda ulash", "O'quvchi ID (masalan S0001)"), prompt("Qo'lda ulash", "Vasiyning Telegram chat ID si"));
    toast("Ulandi. Vasiy botga /start yuborib rozilikni bersin.");
  }),
};
