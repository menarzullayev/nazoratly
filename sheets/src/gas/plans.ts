/** Payment plans: a charge split into dated installments (sheet "To'lov rejalari"). Rules live in ../domain
 * (installments.ts, debt.ts); this file moves data. Nothing here sends a message. */
import { computeDebts } from "../domain/debt";
import { isIsoDate } from "../domain/dates";
import { equalInstallments, installmentBalances, PlanRuleError, validatePlan } from "../domain/installments";
import { formatSom, formatDmy } from "../domain/reminders";
import type { Refund, Charge, Installment, Payment, Student } from "../domain/types";
import { guard, withLock } from "./actions";
import { pickId } from "./pick";
import { read, readIfPresent, replaceWhere, today, updateById } from "./repo";
import { REFUNDS, CHARGES, INSTALLMENTS, PAYMENTS, STUDENTS } from "./schema";

export const VIEW_SHEET = "Qismlar holati";
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();

const RULE_TEXT: Record<string, string> = {
  count: "Qismlar soni 2 dan 24 gacha bo'lishi kerak",
  non_positive: "Har bir qism summasi musbat bo'lishi kerak (summa juda kichik bo'lishi mumkin)",
  sum_mismatch: "Qismlar yig'indisi hisob summasiga teng emas",
  dates_not_increasing: "Qism muddatlari o'sib borishi kerak",
};

function planOf(chargeId: string): Installment[] {
  return readIfPresent<Installment>(INSTALLMENTS).filter((i) => i.chargeId === chargeId).sort((a, b) => a.seq - b.seq);
}

function askText(title: string, label: string): string {
  const r = ui().prompt(title, label, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  return r.getResponseText().trim();
}

export function createPaymentPlan(chargeId?: string, count?: number, firstDue?: string): void {
  const id = pickId(chargeId, CHARGES.sheet, "To'lov rejasi: hisobni tanlang");
  const done = withLock(() => {
    const charges = read<Charge>(CHARGES);
    const charge = charges.find((c) => c.id === id);
    if (!charge) throw new Error(`Hisob topilmadi: ${id}`);
    if (charge.voided) throw new Error("Bekor qilingan hisobga reja tuzib bo'lmaydi.");
    const existing = readIfPresent<Installment>(INSTALLMENTS);
    const { balances } = computeDebts(charges, read<Payment>(PAYMENTS), today(), existing, readIfPresent<Refund>(REFUNDS));
    const bal = balances.find((b) => b.id === id)!;
    if (bal.outstanding <= 0) throw new Error("Bu hisob to'liq to'langan: reja kerak emas.");

    const n = count ?? Number(askText("To'lov rejasi", `Hisob ${id}: ${formatSom(charge.amount)} so'm. Necha qismga bo'lamiz? (2-24)`));
    const first = firstDue ?? askText("To'lov rejasi", "Birinchi qism muddati (yyyy-mm-dd). Keyingilari har oy shu kunda.");
    if (!isIsoDate(first)) throw new Error(`Sana noto'g'ri: "${first}". Format: 2026-12-10`);
    let rows: { amount: number; dueDate: string }[];
    try {
      rows = equalInstallments(charge.amount, n, first);
    } catch (e) {
      if (e instanceof PlanRuleError) throw new Error(RULE_TEXT[e.code] ?? e.code);
      throw e;
    }
    const schedule = rows.map((r, i) => `${i + 1}. ${formatDmy(r.dueDate)}: ${formatSom(r.amount)} so'm`).join("\n");
    const replacing = existing.some((i) => i.chargeId === id) ? "\n\nEski reja almashtiriladi (to'langan pul saqlanadi)." : "";
    const ans = ui().alert("To'lov rejasi", `Hisob ${id} (${formatSom(charge.amount)} so'm) quyidagi qismlarga bo'linadi:\n\n${schedule}${replacing}\n\nTasdiqlaysizmi?`, ui().ButtonSet.YES_NO);
    if (ans !== ui().Button.YES) throw new Error("Bekor qilindi.");
    replaceWhere<Installment>(INSTALLMENTS, (r) => r.chargeId === id, rows.map((r, i) => ({ chargeId: id, seq: i + 1, dueDate: r.dueDate, amount: r.amount })));
    updateById(CHARGES, "id", id, { dueDate: rows[0]!.dueDate }); // FIFO between charges follows the first installment
    return `${id}: ${rows.length} qismli reja tuzildi.`;
  });
  SpreadsheetApp.getActive().toast(done, "nazoratly", 8);
}

export function removePlan(chargeId?: string): void {
  const id = pickId(chargeId, INSTALLMENTS.sheet, "Rejani olib tashlash");
  withLock(() => {
    if (planOf(id).length === 0) throw new Error(`${id} hisobida reja yo'q.`);
    const ans = ui().alert("Rejani olib tashlash", `${id} hisobining to'lov rejasi o'chiriladi. Hisob birinchi qismning muddati bilan qoladi. Davom etamizmi?`, ui().ButtonSet.YES_NO);
    if (ans !== ui().Button.YES) throw new Error("Bekor qilindi.");
    replaceWhere<Installment>(INSTALLMENTS, (r) => r.chargeId === id, []);
  });
  SpreadsheetApp.getActive().toast("Reja olib tashlandi.", "nazoratly", 6);
}

/** Lists plans that the debt calculation ignores (and why) and charges whose due date is not the first installment. */
export function checkPlans(): string {
  const charges = new Map(read<Charge>(CHARGES).map((c) => [c.id, c]));
  const byCharge = new Map<string, Installment[]>();
  for (const i of readIfPresent<Installment>(INSTALLMENTS)) (byCharge.get(i.chargeId) ?? byCharge.set(i.chargeId, []).get(i.chargeId)!).push(i);
  const problems: string[] = [];
  for (const [id, rows] of byCharge) {
    rows.sort((a, b) => a.seq - b.seq);
    const c = charges.get(id);
    if (!c) problems.push(`${id}: hisob topilmadi`);
    else if (c.voided) problems.push(`${id}: hisob bekor qilingan (rejani olib tashlang)`);
    else {
      const err = validatePlan(c.amount, rows);
      if (err) problems.push(`${id}: ${RULE_TEXT[err]} (reja hisobga olinmaydi)`);
      else if (rows.some((r, k) => r.seq !== k + 1)) problems.push(`${id}: qism raqamlari 1, 2, 3 ... bo'lishi kerak`);
      else if (c.dueDate !== rows[0]!.dueDate) problems.push(`${id}: hisob muddati (${formatDmy(c.dueDate)}) birinchi qism muddatiga (${formatDmy(rows[0]!.dueDate)}) teng emas`);
    }
  }
  return problems.length ? problems.join("\n") : "";
}

export function openInstallments(): void {
  const { balances } = computeDebts(read<Charge>(CHARGES), read<Payment>(PAYMENTS), today(), readIfPresent<Installment>(INSTALLMENTS), readIfPresent<Refund>(REFUNDS));
  const students = new Map(read<Student>(STUDENTS).map((s) => [s.id, s]));
  const byCharge = new Map<string, Installment[]>();
  for (const i of readIfPresent<Installment>(INSTALLMENTS)) (byCharge.get(i.chargeId) ?? byCharge.set(i.chargeId, []).get(i.chargeId)!).push(i);
  const rows: (string | number)[][] = [];
  for (const b of balances) {
    const plan = (byCharge.get(b.id) ?? []).sort((x, y) => x.seq - y.seq);
    if (plan.length === 0 || validatePlan(b.amount, plan) !== null) continue;
    installmentBalances(plan, b.paid, today()).forEach((r, k) => {
      const status = r.outstanding <= 0 ? "To'langan" : r.overdue ? "Muddati o'tgan" : "Kutilmoqda";
      rows.push([b.id, students.get(b.studentId)?.fullName ?? b.studentId, `${k + 1}/${plan.length}`, r.dueDate, r.amount, r.paid, r.outstanding, status]);
    });
  }
  rows.sort((a, b) => String(a[3]).localeCompare(String(b[3])));
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(VIEW_SHEET) ?? ss.insertSheet(VIEW_SHEET);
  sh.clear();
  const head = ["Hisob ID", "O'quvchi", "Qism", "Muddat", "Summa", "To'langan", "Qoldiq", "Holat"];
  sh.getRange(1, 1, 1, head.length).setValues([head]).setBackground("#202124").setFontColor("#fff").setFontWeight("bold").setWrap(true);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.activate();
}

export const menu = {
  create: (): void => guard("To'lov rejasi", () => createPaymentPlan()),
  view: (): void => guard("To'lov rejasi", openInstallments),
  remove: (): void => guard("To'lov rejasi", () => removePlan()),
  check: (): void =>
    guard("To'lov rejasi", () => {
      const problems = checkPlans();
      ui().alert("Rejalarni tekshirish", problems || "Barcha rejalar to'g'ri.", ui().ButtonSet.OK);
    }),
};
