/**
 * Multi-branch administration in the Sheets edition (G6): the "Filiallar" tab, staff of a branch, the view branch, moving a
 * student between branches, prices per branch and the per-branch report next to the total.
 *
 * One center, one books: every business row carries a "Filial" mark, staff of a branch see and write only their branch (see
 * scope.ts), center-wide staff see the total or pick one branch. The rules are in ../domain/branches.ts and shared with the API
 * product through tests/golden/branches.json. Nothing here sends a message.
 */
import { branchTotals, effectiveValue, transferCheck } from "../domain/branches";
import { computeDebts } from "../domain/debt";
import { isIsoDate, monthStart } from "../domain/dates";
import { nextId } from "../domain/ids";
import { formatSom } from "../domain/reminders";
import type { Charge, Enrollment, Expense, Group, Installment, Payment, Refund, Student, WaitlistRow } from "../domain/types";
import { guard, withLock } from "./actions";
import { cashBookBalance, ledgerReady } from "./ledger";
import { append, read, readIfPresent, readRaw, today, updateById } from "./repo";
import { BRANCHES, BRANCH_MOVES, BRANCH_PRICES, BRANCH_SETTINGS, CHARGES, ENROLLMENTS, EXPENSES, GROUPS, INSTALLMENTS, PAYMENTS, REFUNDS, SETTING_DEFAULTS, STAFF, STUDENTS, WAITLIST } from "./schema";
import { BRANCH_SETTING_KEYS } from "./settings";
import { branchRows, currentScope, DEFAULT_BRANCH, rawRead, requireCenterWide, resetScope, setViewBranch } from "./scope";

export const BRANCH_REPORT_SHEET = "Filial hisoboti";

const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const toast = (msg: string): void => SpreadsheetApp.getActive().toast(msg, "nazoratly", 8);
function ask(title: string, label: string): string {
  const r = ui().prompt(title, label, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  return r.getResponseText().trim();
}
const hasSheet = (name: string): boolean => SpreadsheetApp.getActive().getSheetByName(name) !== null;

export interface BranchRow { id: string; name: string; address: string; status: "active" | "closed"; isDefault: boolean }

// ---- branches ---------------------------------------------------------------------------------------------------------------
/** The first branch of a center: "Asosiy filial", the default. Safe to repeat. */
export function ensureDefaultBranch(): void {
  if (!hasSheet(BRANCHES.sheet)) return;
  if (branchRows().length === 0) {
    append(BRANCHES, [{ id: DEFAULT_BRANCH, name: "Asosiy filial", address: "", status: "active", isDefault: true }]);
    resetScope();
  }
}

export function listBranches(): BranchRow[] {
  const rows = branchRows();
  return rows.length ? rows : [{ id: DEFAULT_BRANCH, name: "Asosiy filial", address: "", status: "active", isDefault: true }];
}

export function addBranch(name?: string, address?: string): string {
  requireCenterWide("Filial qo'shish");
  const n = (name ?? ask("Filial qo'shish", "Filial nomi")).trim();
  const a = (address ?? ask("Filial qo'shish", "Manzil (bo'sh bo'lishi mumkin)")).trim();
  if (!n) throw new Error("Filial nomi kiritilmadi.");
  return withLock(() => {
    ensureDefaultBranch();
    const all = branchRows();
    if (all.some((b) => b.name.trim().toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" nomli filial allaqachon bor.`);
    const id = nextId("F", all.map((b) => b.id));
    append(BRANCHES, [{ id, name: n, address: a, status: "active", isDefault: false }]);
    resetScope();
    return id;
  });
}

export function setBranchStatus(id: string, status: "active" | "closed"): void {
  requireCenterWide("Filialni yopish");
  withLock(() => {
    const b = branchRows().find((x) => x.id === id);
    if (!b) throw new Error(`Filial topilmadi: ${id}`);
    if (status === "closed" && b.isDefault) throw new Error("Asosiy filialni yopib bo'lmaydi: avval boshqa filialni asosiy qiling.");
    updateById(BRANCHES, "id", id, { status });
    resetScope();
  });
}

export function makeDefault(id: string): void {
  requireCenterWide("Asosiy filialni almashtirish");
  withLock(() => {
    const all = branchRows();
    const b = all.find((x) => x.id === id);
    if (!b) throw new Error(`Filial topilmadi: ${id}`);
    if (b.status !== "active") throw new Error("Yopilgan filial asosiy bo'la olmaydi.");
    for (const o of all) if (o.isDefault && o.id !== id) updateById(BRANCHES, "id", o.id, { isDefault: false });
    updateById(BRANCHES, "id", id, { isDefault: true });
    resetScope();
  });
}

/** Ties a staff member (Google email) to a branch; an empty branch makes the person center-wide. */
export function setStaff(email: string, role: string, branchId: string): void {
  requireCenterWide("Xodimni filialga biriktirish");
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw new Error(`Email noto'g'ri: "${email}"`);
  if (branchId && !branchRows().some((b) => b.id === branchId) && branchId !== DEFAULT_BRANCH) throw new Error(`Filial topilmadi: ${branchId}`);
  withLock(() => {
    const rows = rawRead<{ email: string }>(STAFF);
    if (rows.some((r) => r.email.trim().toLowerCase() === e)) updateById(STAFF, "email", rows.find((r) => r.email.trim().toLowerCase() === e)!.email, { role, branchId });
    else append(STAFF, [{ email: e, role, branchId }]);
    resetScope();
  });
}

// ---- the view branch --------------------------------------------------------------------------------------------------------
export function chooseView(id?: string): string {
  const info = currentScope();
  if (info.member) throw new Error("Siz bitta filialga biriktirilgansiz: boshqa filialni ko'ra olmaysiz.");
  const v = (id ?? ask("Filialni tanlash", `Filial ID (${listBranches().map((b) => `${b.id} ${b.name}`).join(", ")}). Bo'sh = barcha filiallar`)).trim();
  if (!v) {
    setViewBranch(null);
    return "Barcha filiallar ko'rsatiladi.";
  }
  if (!info.known.includes(v)) throw new Error(`Filial topilmadi: ${v}`);
  setViewBranch(v);
  return `Endi faqat ${v} filiali ko'rsatiladi va yangi yozuvlar shu filialga tushadi.`;
}

// ---- moving a student -------------------------------------------------------------------------------------------------------
export interface TransferResult { studentId: string; from: string; to: string; ended: number }

/**
 * Moves a student to another branch (center-wide staff). His history and money stay in the branch where they arose; his live
 * enrollments in groups of other branches must be ended (endEnrollments) or the move is refused. Rules: domain/branches.ts.
 */
export function transferStudent(studentId: string, toBranch: string, endEnrollments: boolean, reason = "", date?: string): TransferResult {
  requireCenterWide("O'quvchini filialga ko'chirish");
  return withLock(() => {
    const info = currentScope();
    const student = readRaw<Student>(STUDENTS).find((s) => s.id === studentId);
    if (!student) throw new Error(`O'quvchi topilmadi: ${studentId}`);
    const target = listBranches().find((b) => b.id === toBranch);
    if (!target) throw new Error(`Filial topilmadi: ${toBranch}`);
    const from = student.branchId || info.defaultId;
    const groups = new Map(readRaw<Group>(GROUPS).map((g) => [g.id, g.branchId || info.defaultId]));
    const live = readRaw<Enrollment>(ENROLLMENTS).filter((e) => e.studentId === studentId && ["trial", "active", "frozen"].includes(e.status));
    const verdict = transferCheck({ from, to: toBranch, toStatus: target.status, enrollmentBranches: live.map((e) => groups.get(e.groupId) ?? info.defaultId), endEnrollments });
    if (!verdict.ok) {
      const text: Record<string, string> = {
        same_branch: "O'quvchi allaqachon shu filialda.",
        target_closed: "Ko'chiriladigan filial yopilgan.",
        enrollments_in_old_branch: `O'quvchi boshqa filial guruhlarida o'qiydi (${verdict.endCount} ta yozilish): avval ularni tugating yoki "tugatish" bilan ko'chiring.`,
      };
      throw new Error(text[verdict.error!] ?? verdict.error!);
    }
    const day = date ?? today();
    if (!isIsoDate(day)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
    let ended = 0;
    for (const e of live) {
      if ((groups.get(e.groupId) ?? info.defaultId) === toBranch) continue;
      updateById(ENROLLMENTS, "id", e.id, { status: "finished", endedOn: day < e.startedOn ? e.startedOn : day });
      ended++;
    }
    if (hasSheet(WAITLIST.sheet)) {
      for (const w of readRaw<WaitlistRow>(WAITLIST)) {
        if (w.studentId === studentId && w.status === "waiting" && (groups.get(w.groupId) ?? info.defaultId) !== toBranch) updateById(WAITLIST, "id", w.id, { status: "removed" });
      }
    }
    updateById(STUDENTS, "id", studentId, { branchId: toBranch });
    if (hasSheet(BRANCH_MOVES.sheet)) append(BRANCH_MOVES, [{ id: nextId("B", rawRead<{ id: string }>(BRANCH_MOVES).map((m) => m.id)), date: day, studentId, fromBranchId: from, toBranchId: toBranch, endedEnrollments: ended, reason: reason.trim() }]);
    return { studentId, from, to: toBranch, ended };
  });
}

// ---- prices and settings per branch ---------------------------------------------------------------------------------------------
/** The price a new group of a branch starts with: the branch's price for the course (the group name starts with it), else the fallback. */
export function branchPrice(branchId: string, course: string, fallback: number): number {
  if (!hasSheet(BRANCH_PRICES.sheet)) return fallback;
  const own = rawRead<{ branchId: string; course: string; monthlyFee: number }>(BRANCH_PRICES).filter((p) => p.branchId === branchId && course.toLowerCase().startsWith(p.course.trim().toLowerCase()) && p.course.trim() !== "");
  const best = own.sort((a, b) => b.course.length - a.course.length)[0];
  const v = effectiveValue({ override: best ? String(best.monthlyFee) : null, base: String(fallback) });
  return Number(v);
}

export function setBranchPrice(branchId: string, course: string, fee: number): void {
  requireCenterWide("Filial narxi");
  if (!listBranches().some((b) => b.id === branchId)) throw new Error(`Filial topilmadi: ${branchId}`);
  if (!course.trim()) throw new Error("Kurs nomi kiritilmadi.");
  if (!Number.isInteger(fee) || fee < 0) throw new Error("Narx 0 yoki musbat butun son bo'lishi kerak.");
  withLock(() => {
    const rows = rawRead<{ branchId: string; course: string }>(BRANCH_PRICES);
    const same = rows.findIndex((r) => r.branchId === branchId && r.course.trim().toLowerCase() === course.trim().toLowerCase());
    if (same < 0) append(BRANCH_PRICES, [{ branchId, course: course.trim(), monthlyFee: fee }]);
    else {
      const sh = SpreadsheetApp.getActive().getSheetByName(BRANCH_PRICES.sheet)!;
      const head = (sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] as unknown[]).map((h) => String(h).trim());
      sh.getRange(same + 2, head.indexOf("Oylik narx (so'm)") + 1).setValue(fee);
    }
  });
}

/** Puts the branch's price (if it has one for this course) on a group's monthly fee; returns the new fee. */
export function applyBranchPrice(groupId: string): number {
  requireCenterWide("Guruh narxini yangilash");
  const g = readRaw<Group>(GROUPS).find((x) => x.id === groupId);
  if (!g) throw new Error(`Guruh topilmadi: ${groupId}`);
  const fee = branchPrice(g.branchId || currentScope().defaultId, g.name, g.monthlyFee);
  if (fee !== g.monthlyFee) updateById(GROUPS, "id", groupId, { monthlyFee: fee });
  return fee;
}

/** Sets (or with an empty value clears) a branch's own value of a setting; the label is the one in the Sozlamalar tab. */
export function setBranchSetting(branchId: string, label: string, value: string): void {
  requireCenterWide("Filial sozlamasi");
  const def = SETTING_DEFAULTS.find((d) => d.label === label.trim());
  if (!def || !BRANCH_SETTING_KEYS.has(def.key)) throw new Error(`"${label}" filial uchun alohida o'rnatiladigan sozlama emas.`);
  if (!listBranches().some((b) => b.id === branchId)) throw new Error(`Filial topilmadi: ${branchId}`);
  withLock(() => {
    const sh = SpreadsheetApp.getActive().getSheetByName(BRANCH_SETTINGS.sheet);
    if (!sh) throw new Error(`"${BRANCH_SETTINGS.sheet}" varag'i yo'q. Menyudan: nazoratly > Boshlang'ich sozlash.`);
    const rows = rawRead<{ branchId: string; label: string }>(BRANCH_SETTINGS);
    const at = rows.findIndex((r) => r.branchId === branchId && r.label.trim() === def.label);
    if (at >= 0) {
      if (value.trim() === "") sh.deleteRow(at + 2);
      else sh.getRange(at + 2, 3).setValue(value.trim());
    } else if (value.trim() !== "") append(BRANCH_SETTINGS, [{ branchId, label: def.label, value: value.trim() }]);
  });
}

// ---- the report: per branch and total ---------------------------------------------------------------------------------------
export interface BranchReportRow { branchId: string | null; name: string; studentsActive: number; groupsActive: number; enrollmentsActive: number; revenue: number; charges: number; expenses: number; net: number; debt: number; cashBalance: number }

export function buildBranchReport(monthText?: string): { month: string; rows: BranchReportRow[]; total: BranchReportRow } {
  const first = monthText ? `${monthText.slice(0, 7)}-01` : monthStart(today());
  if (!isIsoDate(first)) throw new Error(`Oy noto'g'ri: "${monthText}". Format: 2026-11`);
  const [y, m] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))];
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const info = currentScope();
  const branches = listBranches().filter((b) => info.scope === null || b.id === info.scope);
  const payments = read<Payment>(PAYMENTS);
  const refunds = readIfPresent<Refund>(REFUNDS);
  const inMonth = (d: string): boolean => d >= first && d <= last;
  const facts: { branch: string | null; kind: "payment" | "charge" | "expense"; amount: number; voided: boolean }[] = [];
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  for (const p of payments) if (inMonth(p.paidOn)) facts.push({ branch: p.branchId ?? null, kind: "payment", amount: p.amount, voided: p.voided });
  // money given back reduces what the branch took: against its payment's month, or the refund's own month without a payment
  for (const r of refunds) {
    if (r.payout === "credit" || !(r.amount > 0)) continue;
    const pay = r.paymentId ? paymentById.get(r.paymentId) : undefined;
    if (inMonth(pay ? pay.paidOn : r.date)) facts.push({ branch: pay?.branchId ?? r.branchId ?? null, kind: "payment", amount: -r.amount, voided: false });
  }
  for (const c of read<Charge>(CHARGES)) if (c.month === first) facts.push({ branch: c.branchId ?? null, kind: "charge", amount: c.amount, voided: c.voided });
  for (const x of readIfPresent<Expense>(EXPENSES)) if (inMonth(x.date)) facts.push({ branch: x.branchId ?? null, kind: "expense", amount: x.amount, voided: x.voided });
  const folded = branchTotals(branches.map((b) => ({ id: b.id })), facts);
  const students = read<Student>(STUDENTS);
  const groups = read<Group>(GROUPS);
  const enrollments = read<Enrollment>(ENROLLMENTS);
  const balances = computeDebts(read<Charge>(CHARGES), payments, today(), readIfPresent<Installment>(INSTALLMENTS), refunds).balances;
  const debtBy = new Map<string, number>();
  for (const b of balances) debtBy.set(b.branchId ?? info.defaultId, (debtBy.get(b.branchId ?? info.defaultId) ?? 0) + b.outstanding);
  const rows: BranchReportRow[] = branches.map((b, i) => {
    const money = folded.rows[i]!;
    return {
      branchId: b.id,
      name: b.name,
      studentsActive: students.filter((s) => s.branchId === b.id && s.status === "active").length,
      groupsActive: groups.filter((g) => g.branchId === b.id && g.status === "active").length,
      enrollmentsActive: enrollments.filter((e) => e.branchId === b.id && e.status === "active").length,
      revenue: money.revenue, charges: money.charges, expenses: money.expenses, net: money.net,
      debt: debtBy.get(b.id) ?? 0,
      cashBalance: ledgerReady() ? cashBookBalance(last, b.id).balance : 0,
    };
  });
  const sum = (f: (r: BranchReportRow) => number): number => rows.reduce((n, r) => n + f(r), 0);
  const total: BranchReportRow = {
    branchId: null, name: "Jami",
    studentsActive: sum((r) => r.studentsActive), groupsActive: sum((r) => r.groupsActive), enrollmentsActive: sum((r) => r.enrollmentsActive),
    revenue: folded.total.revenue, charges: folded.total.charges, expenses: folded.total.expenses, net: folded.total.net,
    debt: sum((r) => r.debt), cashBalance: sum((r) => r.cashBalance),
  };
  return { month: first, rows, total };
}

export function showBranchReport(monthText?: string): void {
  const r = buildBranchReport(monthText);
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(BRANCH_REPORT_SHEET) ?? ss.insertSheet(BRANCH_REPORT_SHEET);
  sh.clear();
  const head = ["Filial", "Faol o'quvchilar", "Faol guruhlar", "Faol yozilishlar", "Tushum", "Hisoblangan", "Xarajat", "Sof (tushum - xarajat)", "Qarz", "Kassa (jurnal)"];
  const line = (x: BranchReportRow): (string | number)[] => [x.name, x.studentsActive, x.groupsActive, x.enrollmentsActive, x.revenue, x.charges, x.expenses, x.net, x.debt, x.cashBalance];
  const out = [[`Filiallar bo'yicha hisobot · ${r.month.slice(0, 7)}${currentScope().scope ? " · faqat sizning filialingiz" : ""}`], head, ...r.rows.map(line), line(r.total)];
  sh.getRange(1, 1, 1, 1).setValue(out[0]![0]!).setFontWeight("bold");
  sh.getRange(2, 1, 1, head.length).setValues([head]).setBackground("#202124").setFontColor("#fff").setFontWeight("bold").setWrap(true);
  sh.getRange(3, 1, r.rows.length + 1, head.length).setValues(out.slice(2) as (string | number)[][]);
  sh.getRange(3, 5, r.rows.length + 1, 6).setNumberFormat("#,##0");
  sh.getRange(r.rows.length + 3, 1, 1, head.length).setFontWeight("bold");
  ss.toast(`Jami tushum: ${formatSom(r.total.revenue)} so'm, ${r.rows.length} ta filial.`, "nazoratly", 6);
}

// ---- menus -----------------------------------------------------------------------------------------------------------------------------
export const menu = {
  list: (): void =>
    guard("Filiallar", () => {
      const s = currentScope();
      const lines = listBranches().map((b) => `${b.id}  ${b.name}${b.isDefault ? "  (asosiy)" : ""}${b.status === "closed" ? "  (yopilgan)" : ""}`);
      ui().alert("Filiallar", `${lines.join("\n")}\n\nSiz: ${s.email || "noma'lum"} · ${s.member ? `faqat ${s.member} filiali` : "butun markaz"}${s.scope && !s.member ? ` (ko'rinish: ${s.scope})` : ""}`, ui().ButtonSet.OK);
    }),
  add: (): void => guard("Filial qo'shish", () => toast(`Filial ${addBranch()} qo'shildi.`)),
  close: (): void => guard("Filialni yopish", () => { const id = ask("Filialni yopish", "Filial ID"); setBranchStatus(id, "closed"); toast(`${id} yopildi.`); }),
  reopen: (): void => guard("Filialni ochish", () => { const id = ask("Filialni qayta ochish", "Filial ID"); setBranchStatus(id, "active"); toast(`${id} ochildi.`); }),
  makeDefault: (): void => guard("Asosiy filial", () => { const id = ask("Asosiy filialni almashtirish", "Yangi asosiy filial ID"); makeDefault(id); toast(`${id} endi asosiy filial.`); }),
  choose: (): void => guard("Filialni tanlash", () => toast(chooseView())),
  staff: (): void => guard("Xodimni biriktirish", () => {
    const email = ask("Xodimni filialga biriktirish", "Xodimning Google emaili");
    const role = ask("Xodimni filialga biriktirish", "Rol (admin, manager, accountant, teacher, viewer)").toLowerCase();
    const branch = ask("Xodimni filialga biriktirish", "Filial ID (bo'sh = butun markaz)");
    setStaff(email, role, branch);
    toast(`${email}: ${branch ? `faqat ${branch}` : "butun markaz"}.`);
  }),
  transfer: (): void => guard("Filialga ko'chirish", () => {
    const sid = ask("O'quvchini filialga ko'chirish", "O'quvchi ID (masalan S0001)");
    const to = ask("O'quvchini filialga ko'chirish", "Qaysi filialga (Filial ID)");
    const end = /^(ha|yes|\+|1)/i.test(ask("O'quvchini filialga ko'chirish", "Eski filial guruhlaridagi yozilishlari tugatilsinmi? (Ha / Yo'q)"));
    const reason = ask("O'quvchini filialga ko'chirish", "Sabab (bo'sh bo'lishi mumkin)");
    const r = transferStudent(sid, to, end, reason);
    ui().alert("Filialga ko'chirish", `${r.studentId}: ${r.from} → ${r.to}. Tugatilgan yozilishlar: ${r.ended}.\nTarix va pul eski filialda qoladi.`, ui().ButtonSet.OK);
  }),
  price: (): void => guard("Filial narxi", () => {
    const b = ask("Filial narxi", "Filial ID");
    const course = ask("Filial narxi", "Kurs nomi (guruh nomi shu so'z bilan boshlanadi)");
    const fee = Number(ask("Filial narxi", "Oylik narx (so'm)").replace(/\s/g, ""));
    setBranchPrice(b, course, fee);
    toast(`${b}: ${course} = ${formatSom(fee)} so'm.`);
  }),
  applyPrice: (): void => guard("Filial narxi", () => {
    const id = ask("Guruh narxini filial narxidan olish", "Guruh ID (masalan G0001)");
    toast(`${id}: oylik narx ${formatSom(applyBranchPrice(id))} so'm.`);
  }),
  setting: (): void => guard("Filial sozlamasi", () => {
    const b = ask("Filial sozlamasi", "Filial ID");
    const label = ask("Filial sozlamasi", "Sozlama nomi (Sozlamalar varag'idagi bilan bir xil)");
    const value = ask("Filial sozlamasi", "Qiymat (bo'sh = markaz qiymatiga qaytish)");
    setBranchSetting(b, label, value);
    toast(`${b}: "${label}" ${value ? `= ${value}` : "markaz qiymatiga qaytdi"}.`);
  }),
  report: (): void => guard("Filial hisoboti", () => showBranchReport(ask("Filial hisoboti", `Oy (yyyy-mm). Bo'sh = ${today().slice(0, 7)}`) || undefined)),
};
