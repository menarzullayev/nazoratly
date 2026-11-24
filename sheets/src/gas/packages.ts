/** Lesson packages (abonement): sell a package, lesson balance, expiry and extension, "payment needed" list and
 * reminder DRAFTS. Rules live in ../domain (packages.ts, reminders.ts, shared with the API through
 * tests/golden/packages.json); this file moves data. Nothing here sends a message: drafts wait for a human. */
import { computeDebts } from "../domain/debt";
import { daysBetween, isIsoDate, monthStart } from "../domain/dates";
import { nextId, nextIds } from "../domain/ids";
import { enrollmentBalances, packageExpiresOn, type EnrollmentBalance, type Need } from "../domain/packages";
import { formatDmy, formatSom, planPackageReminders, type SkipReason } from "../domain/reminders";
import type { Refund, AttendanceRow, Charge, Enrollment, Entitlement, Group, Installment, Package, Payment, ReminderDraft, Student } from "../domain/types";
import { guard, withLock } from "./actions";
import { pickId } from "./pick";
import { append, read, readIfPresent, today, updateById } from "./repo";
import { REFUNDS, ATTENDANCE, CHARGES, DRAFTS, ENROLLMENTS, ENTITLEMENTS, GROUPS, INSTALLMENTS, PACKAGES, PAYMENTS, STUDENTS } from "./schema";
import { readSettings } from "./settings";

export const VIEW_SHEET = "Abonement holati";
const MAX_EXTENSION_DAYS = 730;
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();

const NEED_LABEL: Record<Need, string> = { ok: "Yetarli", low: "Oz qoldi", exhausted: "Tugadi", debt: "Qarz (manfiy dars)" };
const RANK: Record<Need, number> = { debt: 0, exhausted: 1, low: 2, ok: 3 };
const REASONS: Record<SkipReason, string> = {
  no_consent: "roziligi yo'q", no_chat: "Telegram ulanmagan", cooldown: "yaqinda eslatma yaratilgan",
  below_threshold: "chegaradan kam", student_inactive: "o'quvchi faol emas", already_overdue: "muddati o'tgan qarz bor",
};

/** Balances of the active enrollments in package groups, plus the package rows that cannot be used. */
export function loadBalances(statuses?: Enrollment["status"][]): { balances: EnrollmentBalance[]; problems: { id: string; reason: string }[] } {
  const charges = read<Charge>(CHARGES);
  const debts = computeDebts(charges, read<Payment>(PAYMENTS), today(), readIfPresent<Installment>(INSTALLMENTS), readIfPresent<Refund>(REFUNDS));
  const s = readSettings();
  return enrollmentBalances({
    groups: read<Group>(GROUPS),
    enrollments: read<Enrollment>(ENROLLMENTS),
    attendance: read<AttendanceRow>(ATTENDANCE),
    entitlements: readIfPresent<Entitlement>(ENTITLEMENTS),
    packages: readIfPresent<Package>(PACKAGES),
    charges,
    paidByCharge: new Map(debts.balances.map((b) => [b.id, b.paid])),
    excusedMode: s.excusedMode,
    lowLessons: s.packageLowLessons,
    today: today(),
    statuses,
  });
}

function askText(title: string, label: string): string {
  const r = ui().prompt(title, label, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  return r.getResponseText().trim();
}

const addDays = (iso: string, days: number): string => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days)).toISOString().slice(0, 10);

export function sellPackage(enrollmentId?: string, purchasedOn?: string): void {
  const id = pickId(enrollmentId, ENROLLMENTS.sheet, "Abonement sotish: yozilishni tanlang");
  const done = withLock(() => {
    const e = read<Enrollment>(ENROLLMENTS).find((x) => x.id === id);
    if (!e) throw new Error(`Yozilish topilmadi: ${id}`);
    const g = read<Group>(GROUPS).find((x) => x.id === e.groupId);
    if (!g) throw new Error(`Guruh topilmadi: ${e.groupId}`);
    if (g.billingMode !== "package") throw new Error("Bu guruh abonement bilan hisoblanmaydi (Guruhlar > Hisoblash turi = Abonement).");
    const lessons = g.packageLessons ?? 0;
    const price = g.packagePrice ?? 0;
    if (lessons < 1 || !(price > 0)) throw new Error("Guruhda abonement darslari soni va narxi to'ldirilmagan (Guruhlar varag'i).");
    if (e.status !== "active") throw new Error("Abonement faqat faol yozilishga sotiladi (avval sinovni qabul qiling).");
    const on = purchasedOn ?? today();
    if (!isIsoDate(on)) throw new Error(`Sana noto'g'ri: "${on}". Format: 2026-12-10`);
    const expires = packageExpiresOn(on, readSettings().packageExpiryDays);
    const name = read<Student>(STUDENTS).find((s) => s.id === e.studentId)?.fullName ?? e.studentId;
    const ans = ui().alert("Abonement sotish", `${name}, ${g.name}\n${lessons} dars, ${formatSom(price)} so'm\nSotilgan sana: ${formatDmy(on)}\nMuddati: ${formatDmy(expires)}\n\nHisob yaratiladi; to'langan pul darslarni beradi. Tasdiqlaysizmi?`, ui().ButtonSet.YES_NO);
    if (ans !== ui().Button.YES) throw new Error("Bekor qilindi.");
    const chargeId = nextId("C", read<Charge>(CHARGES).map((c) => c.id));
    const packageId = nextId("P", readIfPresent<Package>(PACKAGES).map((p) => p.id));
    append(CHARGES, [{ id: chargeId, studentId: e.studentId, enrollmentId: e.id, month: monthStart(on), amount: price, dueDate: on, voided: false, note: `Abonement ${lessons} dars (${g.name})` }]);
    append(PACKAGES, [{ id: packageId, studentId: e.studentId, enrollmentId: e.id, chargeId, lessons, price, purchasedOn: on, expiresOn: expires }]);
    return `${packageId}: ${lessons} dars, hisob ${chargeId} (${formatSom(price)} so'm), muddati ${formatDmy(expires)}. To'lovni "To'lov qabul qilish" orqali yozing.`;
  });
  SpreadsheetApp.getActive().toast(done, "nazoratly", 10);
}

export function extendPackage(packageId?: string, expiresOn?: string): void {
  const id = pickId(packageId, PACKAGES.sheet, "Abonement muddatini uzaytirish");
  const done = withLock(() => {
    const p = readIfPresent<Package>(PACKAGES).find((x) => x.id === id);
    if (!p) throw new Error(`Abonement topilmadi: ${id}`);
    const to = expiresOn ?? askText("Muddatni uzaytirish", `${id}: hozirgi muddat ${formatDmy(p.expiresOn)}. Yangi muddat (yyyy-mm-dd)`);
    if (!isIsoDate(to)) throw new Error(`Sana noto'g'ri: "${to}". Format: 2026-12-10`);
    if (to <= p.expiresOn) throw new Error("Yangi muddat hozirgisidan keyin bo'lishi kerak.");
    if (to > addDays(p.purchasedOn, MAX_EXTENSION_DAYS)) throw new Error(`Muddat sotilgan kundan ${MAX_EXTENSION_DAYS} kundan oshmasligi kerak.`);
    updateById(PACKAGES, "id", id, { expiresOn: to });
    return `${id}: yangi muddat ${formatDmy(to)}.`;
  });
  SpreadsheetApp.getActive().toast(done, "nazoratly", 8);
}

export function checkPackages(): string {
  const { problems } = loadBalances();
  const groups = read<Group>(GROUPS).filter((g) => g.billingMode === "package" && ((g.packageLessons ?? 0) < 1 || !((g.packagePrice ?? 0) > 0)));
  const lines = [...problems.map((p) => `${p.id}: ${p.reason}`), ...groups.map((g) => `${g.id} ${g.name}: abonement darslari soni yoki narxi to'ldirilmagan`)];
  return lines.length ? `Quyidagi qatorlar hisobga olinmaydi:\n${lines.join("\n")}` : "Hammasi joyida: abonement qatorlarida xato topilmadi.";
}

function openStatus(): { rows: (string | number)[][]; balances: EnrollmentBalance[] } {
  const { balances } = loadBalances();
  const students = new Map(read<Student>(STUDENTS).map((s) => [s.id, s]));
  const groups = new Map(read<Group>(GROUPS).map((g) => [g.id, g]));
  const sorted = [...balances].sort((a, b) => RANK[a.need] - RANK[b.need] || a.balance.balance - b.balance.balance || a.studentId.localeCompare(b.studentId));
  const t = today();
  const rows = sorted.map((b) => [
    b.studentId, students.get(b.studentId)?.fullName ?? b.studentId, groups.get(b.groupId)?.name ?? b.groupId, b.balance.balance, b.balance.burned, b.debtLessons, b.debtAmount, NEED_LABEL[b.need], b.balance.nextExpiry ?? "", b.balance.nextExpiry ? daysBetween(t, b.balance.nextExpiry) : "",
  ]);
  return { rows, balances: sorted };
}

export function openPackageStatus(): void {
  const { rows } = openStatus();
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(VIEW_SHEET) ?? ss.insertSheet(VIEW_SHEET);
  sh.clear();
  const head = ["O'quvchi ID", "O'quvchi", "Guruh", "Qolgan darslar", "Kuygan darslar", "Qarz (dars)", "Qarz (so'm)", "Holat", "Eng yaqin muddat", "Qolgan kun"];
  sh.getRange(1, 1, 1, head.length).setValues([head]).setBackground("#202124").setFontColor("#fff").setFontWeight("bold").setWrap(true);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.activate();
}

export function createPackageReminderDrafts(): void {
  const msg = withLock(() => {
    const s = readSettings();
    const { balances } = loadBalances();
    const drafts = read<ReminderDraft>(DRAFTS);
    const plan = planPackageReminders({ balances, students: read<Student>(STUDENTS), drafts, today: today(), cooldownDays: s.cooldownDays, centerName: s.center });
    const ids = nextIds("R", drafts.map((d) => d.id), plan.drafts.length);
    append(DRAFTS, plan.drafts.map((d, i) => ({ id: ids[i]!, studentId: d.studentId, createdOn: today(), text: d.text, status: "pending", error: "" })));
    const counts = new Map<SkipReason, number>();
    for (const k of plan.skipped) counts.set(k.reason, (counts.get(k.reason) ?? 0) + 1);
    const skipped = [...counts].map(([r, n]) => `  - ${n} ta: ${REASONS[r]}`).join("\n");
    return `${plan.drafts.length} ta to'lov eslatmasi loyihasi yaratildi (hali yuborilmadi).\n\nO'tkazib yuborilgan:\n${skipped || "  yo'q"}\n\nKeyingi qadam: nazoratly > Eslatmalarni ko'rib chiqish.`;
  });
  ui().alert("Abonement eslatmalari", msg, ui().ButtonSet.OK);
}

export const menu = {
  sell: (): void => guard("Abonement", () => sellPackage()),
  status: (): void => guard("Abonement", openPackageStatus),
  extend: (): void => guard("Abonement", () => extendPackage()),
  drafts: (): void => guard("Abonement", createPackageReminderDrafts),
  check: (): void => guard("Abonement", () => ui().alert("Abonementlarni tekshirish", checkPackages(), ui().ButtonSet.OK)),
};
