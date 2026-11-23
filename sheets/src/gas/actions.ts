/** Menu actions and the server side of the sidebars. Business rules live in ../domain; this file only moves data. */
import { planCharges } from "../domain/billing";
import { computeDebts, debtors, type StudentDebt } from "../domain/debt";
import { inMonth, isIsoDate, monthStart } from "../domain/dates";
import { nextId, nextIds } from "../domain/ids";
import { collectedTuition, computePayroll, heldLessons } from "../domain/payroll";
import { formatSom, INSTALLMENT_TEMPLATE, planReminders, planUpcomingReminders, UPCOMING_TEMPLATE, type SkipReason } from "../domain/reminders";
import type { AttendanceRow, Charge, Enrollment, Group, Installment, Payment, ReminderDraft, Student, Teacher } from "../domain/types";
import { append, read, readIfPresent, replaceWhere, today, updateById } from "./repo";
import {
  ATTENDANCE, CHARGES, DEBTORS_SHEET, DRAFTS, ENROLLMENTS, GROUPS, INSTALLMENTS, PAYMENTS, PAYROLL, STUDENTS, TEACHERS,
} from "./schema";
import { readSettings } from "./settings";
import { balanceRich, EFFECT_PARTY, receiptRich, reminderRich, type OpenCharge } from "../domain/messages";
import { applyBotProfile } from "./botProfile";
import { makeupDays, markCreditsUsed, reduceByCredits, syncAttendance } from "./makeup";
import { pickWebAppUrl, isWebAppUrl } from "../domain/urls";
import { getToken, props, sendMessage, sendRich, setToken, tg, webhookSecret } from "./telegram";

type StudentRow = Student & { phone?: string; consentDate?: string; consentPolicy?: string; linkCode?: string; linkUrl?: string };

const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const toast = (msg: string, title = "nazoratly"): void => SpreadsheetApp.getActive().toast(msg, title, 6);

export function withLock<T>(fn: () => T): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20_000)) throw new Error("Boshqa amal bajarilmoqda. Bir necha soniyadan keyin qayta urinib ko'ring.");
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Runs a menu action; any error becomes a readable dialog instead of a silent failure. */
export function guard(title: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    ui().alert(title, e instanceof Error ? e.message : String(e), ui().ButtonSet.OK);
  }
}

function promptMonth(title: string): string | null {
  const now = today().slice(0, 7);
  const r = ui().prompt(title, `Oyni kiriting (yyyy-mm). Bo'sh qoldirsangiz: ${now}`, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) return null;
  const v = (r.getResponseText().trim() || now).slice(0, 7);
  if (!isIsoDate(`${v}-01`)) throw new Error(`Noto'g'ri oy: "${v}". Format: 2026-03`);
  return `${v}-01`;
}

function loadFinance(): { charges: Charge[]; payments: Payment[]; installments: Installment[] } {
  return { charges: read<Charge>(CHARGES), payments: read<Payment>(PAYMENTS), installments: readIfPresent<Installment>(INSTALLMENTS) };
}

// ------------------------------------------------------------------ monthly charges
export function generateMonthlyCharges(): void {
  const month = promptMonth("Oylik hisoblarni yaratish");
  if (!month) return;
  const summary = withLock(() => {
    const s = readSettings();
    const charges = read<Charge>(CHARGES);
    const plan = planCharges({
      month, dueDay: s.dueDay, enrollments: read<Enrollment>(ENROLLMENTS), groups: read<Group>(GROUPS), students: read<StudentRow>(STUDENTS), charges,
    });
    const ids = nextIds("C", charges.map((c) => c.id), plan.create.length);
    const reduced = reduceByCredits(plan.create, ids);
    append(CHARGES, plan.create.map((c, i) => ({ ...c, amount: reduced.amounts[i]!, id: ids[i]!, voided: false })));
    markCreditsUsed(reduced.consumed);
    return `${month.slice(0, 7)}: ${plan.create.length} ta yangi hisob yaratildi (kreditdan ayirilgan: ${reduced.consumed.length}).\nAvval yaratilgan: ${plan.skippedExisting}.\nNarxi 0 bo'lgani uchun o'tkazib yuborilgan: ${plan.skippedZeroFee}.\nAbonement guruhlari (abonement sotilganda hisob yaratiladi): ${plan.skippedPackageGroups}.`;
  });
  ui().alert("Oylik hisoblar", summary, ui().ButtonSet.OK);
}

// ------------------------------------------------------------------ debtors report
function debtState(): { students: StudentRow[]; debts: StudentDebt[]; balances: ReturnType<typeof computeDebts>["balances"] } {
  const { charges, payments, installments } = loadFinance();
  const r = computeDebts(charges, payments, today(), installments);
  return { students: read<StudentRow>(STUDENTS), debts: r.students, balances: r.balances };
}

/** Open (unpaid) charges of one student, oldest first, for message tables. */
export function openChargesOf(studentId: string, balances: ReturnType<typeof computeDebts>["balances"]): OpenCharge[] {
  return balances.filter((b) => b.studentId === studentId && b.outstanding > 0).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)).map((b) => ({ month: b.month, dueDate: b.dueDate, outstanding: b.outstanding }));
}

export function refreshDebtors(): void {
  const { students, debts } = debtState();
  const byId = new Map(students.map((s) => [s.id, s]));
  const rows = debts.filter((d) => d.outstanding > 0 || d.credit > 0).map((d) => {
    const s = byId.get(d.studentId);
    return [d.studentId, s?.fullName ?? "(topilmadi)", s?.guardianName ?? "", d.charged, d.paid, d.outstanding, d.overdue, d.oldestDue, d.maxDaysOverdue, d.credit];
  });
  const sh = SpreadsheetApp.getActive().getSheetByName(DEBTORS_SHEET) ?? SpreadsheetApp.getActive().insertSheet(DEBTORS_SHEET);
  sh.clear();
  sh.clearConditionalFormatRules();
  const head = ["O'quvchi ID", "F.I.Sh.", "Vasiy", "Jami hisob", "To'langan", "Qoldiq", "Muddati o'tgan", "Eng eski muddat", "Necha kun", "Kredit (ortiqcha)"];
  sh.getRange(1, 1, 1, head.length).setValues([head]).setBackground("#202124").setFontColor("#fff").setFontWeight("bold").setWrap(true);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.getRange(2, 4, rows.length, 3).setNumberFormat("#,##0");
    sh.getRange(2, 7, rows.length, 1).setNumberFormat("#,##0");
    sh.getRange(2, 10, rows.length, 1).setNumberFormat("#,##0");
    const days = sh.getRange(2, 9, rows.length, 1);
    sh.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(30).setBackground("#fce8e6").setFontColor("#c5221f").setRanges([days]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(1, 30).setBackground("#fef7e0").setFontColor("#b06000").setRanges([days]).build(),
    ]);
  }
  sh.setFrozenRows(1);
  sh.setColumnWidths(1, 1, 90);
  sh.setColumnWidths(2, 2, 200);
  sh.setColumnWidths(4, 7, 120);
  sh.setTabColor("#d93025");
  sh.activate();
  toast(`${debtors(debts).length} ta qarzdor, jami muddati o'tgan: ${formatSom(debts.reduce((s, d) => s + d.overdue, 0))} so'm`);
}

// ------------------------------------------------------------------ reminder drafts + sending
const REASONS: Record<SkipReason, string> = {
  no_consent: "roziligi yo'q", no_chat: "Telegram ulanmagan", cooldown: "yaqinda eslatma yaratilgan",
  below_threshold: "qarz minimal chegaradan kam", student_inactive: "o'quvchi faol emas", already_overdue: "muddati o'tgan qismi bor (qarz eslatmasi yaratiladi)",
};

export function createReminderDrafts(): void {
  const msg = withLock(() => {
    const s = readSettings();
    const { students, debts } = debtState();
    const drafts = read<ReminderDraft>(DRAFTS);
    const overdue = planReminders({
      debtors: debtors(debts), students, drafts, today: today(), cooldownDays: s.cooldownDays, minOverdueSom: s.minOverdue, template: s.template, centerName: s.center, installmentTemplate: INSTALLMENT_TEMPLATE,
    });
    // ahead of an installment (payment plans): a draft before the due date; students drafted just now are left out
    const upcoming = planUpcomingReminders({
      debts, students, drafts, today: today(), cooldownDays: s.cooldownDays, remindDays: s.installmentRemindDays, template: UPCOMING_TEMPLATE, centerName: s.center, exclude: new Set(overdue.drafts.map((d) => d.studentId)),
    });
    const plan = { drafts: [...overdue.drafts, ...upcoming.drafts], skipped: [...overdue.skipped, ...upcoming.skipped] };
    const ids = nextIds("R", drafts.map((d) => d.id), plan.drafts.length);
    append(DRAFTS, plan.drafts.map((d, i) => ({ id: ids[i]!, studentId: d.studentId, createdOn: today(), text: d.text, status: "pending", error: "" })));
    const counts = new Map<SkipReason, number>();
    for (const k of plan.skipped) counts.set(k.reason, (counts.get(k.reason) ?? 0) + 1);
    const skipped = [...counts].map(([r, n]) => `  - ${n} ta: ${REASONS[r]}`).join("\n");
    return `${plan.drafts.length} ta eslatma loyihasi yaratildi (hali yuborilmadi).\n\nO'tkazib yuborilgan:\n${skipped || "  yo'q"}\n\nKeyingi qadam: nazoratly > Eslatmalarni ko'rib chiqish.`;
  });
  ui().alert("Eslatma loyihalari", msg, ui().ButtonSet.OK);
}

export interface DraftView { id: string; studentName: string; text: string; overdue: number; createdOn: string }

export function getPendingDrafts(): DraftView[] {
  const { students, debts } = debtState();
  const byId = new Map(students.map((s) => [s.id, s]));
  const debt = new Map(debts.map((d) => [d.studentId, d]));
  return read<ReminderDraft>(DRAFTS).filter((d) => d.status === "pending").map((d) => ({
    id: d.id, studentName: byId.get(d.studentId)?.fullName ?? d.studentId, text: d.text, overdue: debt.get(d.studentId)?.overdue ?? 0, createdOn: d.createdOn,
  }));
}

export function decideDrafts(input: { approve: string[]; reject: string[]; edits: Record<string, string> }): { approved: number; rejected: number } {
  return withLock(() => {
    const pending = new Set(read<ReminderDraft>(DRAFTS).filter((d) => d.status === "pending").map((d) => d.id));
    let approved = 0, rejected = 0;
    for (const id of input.approve) {
      if (!pending.has(id)) continue;
      const text = (input.edits[id] ?? "").trim();
      if (text.length > 4000) throw new Error("Xabar 4000 belgidan oshmasligi kerak");
      updateById(DRAFTS, "id", id, { status: "approved", ...(text ? { text } : {}) });
      approved++;
    }
    for (const id of input.reject) if (pending.has(id) && updateById(DRAFTS, "id", id, { status: "rejected" })) rejected++;
    return { approved, rejected };
  });
}

export function sendApprovedReminders(): void {
  const msg = withLock(() => {
    if (!getToken()) throw new Error("Avval Telegram botni sozlang: nazoratly > Telegram sozlash.");
    const students = new Map(read<StudentRow>(STUDENTS).map((s) => [s.id, s]));
    const queue = read<ReminderDraft>(DRAFTS).filter((d) => d.status === "approved").slice(0, 100);
    const { balances } = debtState();
    const payInfo = readSettings().payInfo;
    const started = Date.now();
    let sent = 0, failed = 0;
    for (const d of queue) {
      if (Date.now() - started > 4.5 * 60_000) break; // Apps Script limit is 6 min: continue on the next run
      const s = students.get(d.studentId);
      let error = "";
      if (!s || !s.consentNotify || !s.guardianChatId) error = "Rozilik yoki Telegram chat yo'q (yuborish paytida tekshirildi)";
      else {
        // the human-approved text + a live table of what is owed + one-tap buttons (Bot API 10.x rich message)
        const r = sendRich(s.guardianChatId, reminderRich({ text: d.text, studentId: s.id, charges: openChargesOf(s.id, balances), payInfo }));
        if (!r.ok) error = r.description ?? "Noma'lum xato";
      }
      updateById(DRAFTS, "id", d.id, error ? { status: "failed", error } : { status: "sent", error: "" });
      if (error) failed++; else sent++;
      Utilities.sleep(60);
    }
    const left = read<ReminderDraft>(DRAFTS).filter((d) => d.status === "approved").length;
    return `Yuborildi: ${sent}\nXato: ${failed}${failed ? " (Eslatmalar varag'ida sababi ko'rsatilgan)" : ""}\nNavbatda qoldi: ${left}`;
  });
  ui().alert("Telegram", msg, ui().ButtonSet.OK);
}

// ------------------------------------------------------------------ attendance sidebar
export interface RosterRow { studentId: string; fullName: string; status: AttendanceRow["status"] | ""; minutesLate: number }

function rosterFor(groupId: string, date: string): { studentId: string; fullName: string }[] {
  const students = new Map(read<StudentRow>(STUDENTS).map((s) => [s.id, s]));
  return read<Enrollment>(ENROLLMENTS)
    .filter((e) => e.groupId === groupId && e.startedOn <= date && (e.endedOn === "" || e.endedOn >= date) && e.status !== "frozen")
    .map((e) => students.get(e.studentId))
    .filter((s): s is StudentRow => !!s && s.status !== "left")
    .map((s) => ({ studentId: s.id, fullName: s.fullName }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export function getAttendanceGroups(): { id: string; name: string }[] {
  return read<Group>(GROUPS).filter((g) => g.status === "active" || g.status === "planned").map((g) => ({ id: g.id, name: g.name }));
}

export function getRoster(groupId: string, date: string): RosterRow[] {
  if (!isIsoDate(date)) throw new Error("Sana noto'g'ri");
  const marks = new Map(read<AttendanceRow>(ATTENDANCE).filter((a) => a.groupId === groupId && a.date === date).map((a) => [a.studentId, a]));
  return rosterFor(groupId, date).map((r) => ({ ...r, status: marks.get(r.studentId)?.status ?? "", minutesLate: marks.get(r.studentId)?.minutesLate ?? 0 }));
}

export function saveAttendance(input: { date: string; groupId: string; marks: { studentId: string; status: AttendanceRow["status"]; minutesLate: number }[] }): { saved: number } {
  if (!isIsoDate(input.date)) throw new Error("Sana noto'g'ri");
  if (!getAttendanceGroups().some((g) => g.id === input.groupId)) throw new Error("Guruh topilmadi yoki faol emas");
  const allowed = new Set(rosterFor(input.groupId, input.date).map((r) => r.studentId));
  const seen = new Set<string>();
  for (const m of input.marks) {
    if (!allowed.has(m.studentId)) throw new Error(`${m.studentId} bu guruhning shu kundagi ro'yxatida yo'q`);
    if (seen.has(m.studentId)) throw new Error(`${m.studentId} ikki marta belgilangan`);
    seen.add(m.studentId);
    if (!["present", "absent", "late", "excused"].includes(m.status)) throw new Error("Holat noto'g'ri");
    if (m.status !== "late" && m.minutesLate) throw new Error("Kechikish daqiqasi faqat 'Kechikdi' bilan");
    if (!Number.isInteger(m.minutesLate) || m.minutesLate < 0 || m.minutesLate > 600) throw new Error("Kechikish daqiqasi 0-600");
  }
  return withLock(() => {
    replaceWhere<AttendanceRow>(ATTENDANCE, (a) => a.date === input.date && a.groupId === input.groupId, input.marks.map((m) => ({ date: input.date, groupId: input.groupId, ...m })));
    syncAttendance(input.date, input.groupId, input.marks);
    return { saved: input.marks.length };
  });
}

// ------------------------------------------------------------------ payment dialog
export function searchStudents(q: string): { id: string; fullName: string; outstanding: number }[] {
  const needle = q.trim().toLowerCase();
  const { students, debts } = debtState();
  const debt = new Map(debts.map((d) => [d.studentId, d]));
  return students
    .filter((s) => s.status !== "left" && (!needle || s.fullName.toLowerCase().includes(needle) || s.id.toLowerCase() === needle))
    .slice(0, 15)
    .map((s) => ({ id: s.id, fullName: s.fullName, outstanding: debt.get(s.id)?.outstanding ?? 0 }));
}

export function getBalance(studentId: string): StudentDebt & { fullName: string } {
  const { students, debts } = debtState();
  const s = students.find((x) => x.id === studentId);
  if (!s) throw new Error("O'quvchi topilmadi");
  const d = debts.find((x) => x.studentId === studentId) ?? { studentId, charged: 0, paid: 0, outstanding: 0, overdue: 0, credit: 0, oldestDue: "", maxDaysOverdue: 0, openCharges: 0 };
  return { ...d, fullName: s.fullName };
}

export function recordPayment(input: { studentId: string; amount: number; method: string; paidOn: string; note: string; notifyGuardian: boolean }): { id: string; balance: StudentDebt; telegram: string } {
  if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > 1_000_000_000) throw new Error("Summa musbat butun son bo'lishi kerak");
  if (!isIsoDate(input.paidOn)) throw new Error("Sana noto'g'ri");
  if (input.note.length > 500) throw new Error("Izoh 500 belgidan oshmasin");
  const student = read<StudentRow>(STUDENTS).find((s) => s.id === input.studentId);
  if (!student) throw new Error("O'quvchi topilmadi");
  const id = withLock(() => {
    const payments = read<Payment>(PAYMENTS);
    const pid = nextId("P", payments.map((p) => p.id));
    append(PAYMENTS, [{ id: pid, studentId: input.studentId, paidOn: input.paidOn, amount: input.amount, method: input.method || "Naqd", note: input.note, voided: false }]);
    return pid;
  });
  const balance = getBalance(input.studentId);
  let telegram = "";
  if (input.notifyGuardian) {
    if (!student.consentNotify || !student.guardianChatId) telegram = "Telegram yuborilmadi: vasiy ulanmagan yoki rozilik yo'q";
    else {
      const html = receiptRich({
        center: readSettings().center, student: student.fullName, amount: input.amount, paidOn: input.paidOn, method: input.method || "Naqd",
        outstanding: balance.outstanding, charges: openChargesOf(student.id, debtState().balances),
      });
      const r = sendRich(student.guardianChatId, html, balance.outstanding <= 0 ? { message_effect_id: EFFECT_PARTY } : {});
      telegram = r.ok ? "Vasiyga chek yuborildi" : `Telegram xatosi: ${r.description}`;
    }
  }
  return { id, balance, telegram };
}

// ------------------------------------------------------------------ payroll
export function calculatePayroll(): void {
  const month = promptMonth("Oylik hisoblash");
  if (!month) return;
  const msg = withLock(() => {
    const teachers = read<Teacher>(TEACHERS).filter((t) => t.status === "active");
    const groups = read<Group>(GROUPS);
    const enrollments = read<Enrollment>(ENROLLMENTS);
    const attendance = read<AttendanceRow>(ATTENDANCE);
    const { charges, payments, installments } = loadFinance();
    const { balances } = computeDebts(charges, payments, today(), installments);
    type PayRow = { month: string; teacherId: string; status: string; bonus: number };
    const existing = read<PayRow>(PAYROLL);
    const locked = new Set(existing.filter((r) => r.month === month && r.status !== "draft").map((r) => r.teacherId));
    const bonus = new Map(existing.filter((r) => r.month === month && r.status === "draft").map((r) => [r.teacherId, r.bonus]));
    const rows = teachers.filter((t) => !locked.has(t.id)).map((t) => {
      const gids = new Set(groups.filter((g) => g.teacherId === t.id).map((g) => g.id));
      const r = computePayroll(t, month, { heldLessons: heldLessons(attendance, gids, month, makeupDays()), collectedTuition: collectedTuition(balances, enrollments, groups, t.id, month) });
      const b = bonus.get(t.id) ?? 0;
      return { month, teacherId: t.id, teacherName: t.fullName, heldLessons: r.heldLessons, collected: r.collectedTuition, bonus: b, total: r.total + b, status: "draft" };
    });
    replaceWhere<PayRow>(PAYROLL, (r) => r.month === month && r.status === "draft", rows);
    return `${month.slice(0, 7)}: ${rows.length} ta o'qituvchi uchun oylik qoralama hisoblandi.${locked.size ? `\nTasdiqlangan/to'langan (o'zgartirilmadi): ${locked.size}` : ""}\nBonus/jarimani qo'lda kiriting, so'ng "Holat"ni Tasdiqlangan qiling.`;
  });
  ui().alert("Oylik", msg, ui().ButtonSet.OK);
}

// ------------------------------------------------------------------ dashboard (moved to ./dashboard, kept importable from here)
export { refreshDashboard } from "./dashboard";

// ------------------------------------------------------------------ Telegram setup and guardian linking
export function setupTelegram(): void {
  if (getToken()) {
    const keep = ui().alert("Telegram", "Bot tokeni allaqachon saqlangan. Shu token bilan bot profili va webhook yangilansinmi?\n(Yo'q = yangi token kiritish)", ui().ButtonSet.YES_NO);
    if (keep === ui().Button.YES) {
      finishTelegramSetup();
      return;
    }
  }
  const r = ui().prompt("Telegram bot", "@BotFather bergan bot tokenini kiriting. Token faqat Apps Script xavfsiz xotirasida saqlanadi, varaqda ko'rinmaydi.", ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) return;
  const token = r.getResponseText().trim();
  if (!/^\d{6,}:[\w-]{30,}$/.test(token)) throw new Error("Token formati noto'g'ri (masalan 123456789:AAH...)");
  setToken(token);
  const me = tg("getMe");
  if (!me.ok) {
    props().deleteProperty("TELEGRAM_BOT_TOKEN");
    throw new Error(`Token tekshiruvdan o'tmadi: ${me.description}`);
  }
  finishTelegramSetup();
}

function finishTelegramSetup(): void {
  const me = tg("getMe");
  if (!me.ok) throw new Error(`Bot bilan bog'lanib bo'lmadi: ${me.description}`);
  const username = String((me.result as { username?: string }).username ?? "");
  props().setProperty("BOT_USERNAME", username);
  const profile = applyBotProfile(readSettings().center);
  const url = pickWebAppUrl(props().getProperty("WEBAPP_URL"), ScriptApp.getService().getUrl());
  let hook = "";
  let relay = props().getProperty("RELAY_URL") ?? "";
  if (!relay) {
    const r = ui().prompt(
      "Webhook relay",
      "Telegram Apps Script'ga to'g'ridan-to'g'ri yubora olmaydi (Apps Script POST'ga redirect qaytaradi). Relay manzilini kiriting (masalan https://sizning-domen/hooks/telegram). Bo'sh qoldirsangiz to'g'ridan-to'g'ri urinib ko'riladi.",
      ui().ButtonSet.OK_CANCEL,
    );
    const v = r.getSelectedButton() === ui().Button.OK ? r.getResponseText().trim() : "";
    if (/^https:\/\/[^\s]+$/.test(v)) {
      relay = v;
      props().setProperty("RELAY_URL", v);
    }
  }
  if (relay) {
    const w = tg("setWebhook", { url: relay, secret_token: webhookSecret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    hook = w.ok ? `Vasiylarni ulash (webhook relay orqali) yoqildi: ${relay}` : `Webhook xatosi: ${w.description}`;
  } else if (url) {
    const w = tg("setWebhook", { url: `${url}?s=${webhookSecret()}`, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    hook = w.ok ? "Vasiylarni ulash (webhook) yoqildi." : `Webhook xatosi: ${w.description}`;
  } else {
    hook = "Vasiylarni botga ulash uchun skriptni Web App sifatida joylang (Deploy > New deployment > Web app, 'Anyone'), so'ng bu amalni qayta bajaring.";
  }
  const prof = profile.length ? `Bot profili (qisman): ${profile.slice(0, 3).join("; ")}` : "Bot profili yangilandi (buyruqlar uz/ru/en, tavsif).";
  ui().alert("Telegram", `Bot ulandi: @${username}\n${prof}\n${hook}`, ui().ButtonSet.OK);
}

export function generateLinkCodes(): void {
  const username = props().getProperty("BOT_USERNAME");
  if (!username) throw new Error("Avval Telegram botni sozlang.");
  const students = read<StudentRow>(STUDENTS).filter((s) => s.status === "active" && !s.guardianChatId && !s.linkCode);
  for (const s of students) {
    const code = Utilities.getUuid().replace(/-/g, "").slice(0, 10).toUpperCase();
    updateById(STUDENTS, "id", s.id, { linkCode: code, linkUrl: `https://t.me/${username}?start=${code}` });
  }
  toast(`${students.length} ta o'quvchi uchun ulash havolasi yaratildi (O'quvchilar varag'ida).`);
}

/** /qarz in the bot: the balance of every student linked to this Telegram chat. */
export function balanceHtmlForChat(chatId: string): string {
  const { students, debts, balances } = debtState();
  const mine = students.filter((s) => s.guardianChatId === chatId && s.consentNotify);
  const debt = new Map(debts.map((d) => [d.studentId, d]));
  const s = readSettings();
  return balanceRich({
    center: s.center,
    payInfo: s.payInfo,
    students: mine.map((st) => ({
      name: st.fullName, outstanding: debt.get(st.id)?.outstanding ?? 0, overdue: debt.get(st.id)?.overdue ?? 0, credit: debt.get(st.id)?.credit ?? 0,
      charges: openChargesOf(st.id, balances),
    })),
  });
}

/** Values the relay needs (NAZORATLY_TG_RELAY_TARGET / NAZORATLY_TG_RELAY_SECRET). Shown only to the sheet owner. */
export function showWebhookInfo(): void {
  let url = pickWebAppUrl(props().getProperty("WEBAPP_URL"), ScriptApp.getService().getUrl());
  if (!url) {
    const r = ui().prompt(
      "Web App manzili",
      "Skript manzili avtomatik aniqlanmadi. Deploy > Manage deployments dan Web app URL'ni (https://script.google.com/macros/s/.../exec) kiriting.",
      ui().ButtonSet.OK_CANCEL,
    );
    const v = r.getSelectedButton() === ui().Button.OK ? r.getResponseText().trim() : "";
    if (!isWebAppUrl(v)) throw new Error("Web App manzili https://script.google.com/macros/s/.../exec ko'rinishida bo'lishi kerak.");
    props().setProperty("WEBAPP_URL", v);
    url = v;
  }
  ui().alert(
    "Webhook relay sozlamalari",
    `NAZORATLY_TG_RELAY_TARGET=${url}
NAZORATLY_TG_RELAY_SECRET=${webhookSecret()}

Bu sirni boshqalarga bermang.`,
    ui().ButtonSet.OK,
  );
}

export function showHelp(): void {
  ui().alert(
    "nazoratly yordam",
    "1) Boshlang'ich sozlash  2) Sozlamalar varag'ini to'ldiring  3) O'quvchi/guruh/yozilishlarni kiriting\n4) Har oy: Oylik hisoblarni yaratish  5) Kundalik: Davomat va To'lov oynalari\n6) Qarzdorlar hisoboti > Eslatma loyihalari > Ko'rib chiqish > Yuborish\n\nEslatma faqat vasiy botda rozilik bergan o'quvchilarga yaratiladi va faqat siz tasdiqlagandan keyin yuboriladi.",
    ui().ButtonSet.OK,
  );
}
