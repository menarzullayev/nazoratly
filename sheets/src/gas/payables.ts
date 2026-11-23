/** Payables in the Sheets edition: suppliers, supplier bills (they accrue an expense row in "Xarajatlar" and credit 2000),
 * partial settlement from cash or bank, voiding, and the aging report. Rules: ../domain/accounting.ts (payablesAging,
 * postingLines), shared with the API product through tests/golden/accounting.json. */
import { payablesAging } from "../domain/accounting";
import { isIsoDate } from "../domain/dates";
import { nextId } from "../domain/ids";
import { parseMoney } from "../domain/ledger";
import type { Expense } from "../domain/types";
import { guard, withLock } from "./actions";
import { askText, syncLedger, writeReport } from "./ledger";
import { append, read, readIfPresent, today, updateById } from "./repo";
import { BILL_PAYMENTS, EXPENSES, SUPPLIER_BILLS, SUPPLIERS } from "./schema";

const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const CATEGORIES = ["rent", "utilities", "salary", "marketing", "equipment", "tax", "other"];

export interface Supplier { id: string; name: string; phone: string; note: string; active: boolean }
export interface Bill { id: string; supplierId: string; number: string; billDate: string; dueDate: string; category: string; amount: number; note: string; voided: boolean }
export interface BillPayment { id: string; billId: string; date: string; amount: number; paidFrom: string; note: string; voided: boolean }

export const suppliers = (): Supplier[] => readIfPresent<Supplier>(SUPPLIERS);
export const bills = (): Bill[] => readIfPresent<Bill>(SUPPLIER_BILLS);
export const billPayments = (): BillPayment[] => readIfPresent<BillPayment>(BILL_PAYMENTS);

export function paidOf(billId: string, pays = billPayments()): number {
  return pays.filter((p) => p.billId === billId && !p.voided).reduce((n, p) => n + p.amount, 0);
}

export function billStatus(b: Bill, pays = billPayments(), on = today()): "open" | "partial" | "overdue" | "paid" | "voided" {
  if (b.voided) return "voided";
  const paid = paidOf(b.id, pays);
  if (paid >= b.amount) return "paid";
  if (b.dueDate < on) return "overdue";
  return paid > 0 ? "partial" : "open";
}

/** Posts the new documents right away when the person may write the journal; otherwise the next sync does it. */
function postNow(): string {
  try {
    syncLedger();
    return "";
  } catch (e) {
    return `Jurnalga o'tkazilmadi (${e instanceof Error ? e.message : String(e)}). Menyu: Buxgalteriya > Kutayotganlarni o'tkazish.`;
  }
}

export function addSupplier(name: string, phone = "", note = ""): string {
  return withLock(() => {
    const n = name.trim();
    if (!n || n.length > 200) throw new Error("Ta'minotchi nomi 1-200 belgi bo'lishi kerak.");
    if (suppliers().some((s) => s.name.toLowerCase() === n.toLowerCase())) throw new Error("Bunday nomli ta'minotchi allaqachon bor.");
    const id = nextId("V", suppliers().map((s) => s.id));
    append(SUPPLIERS, [{ id, name: n, phone: phone.trim(), note: note.trim(), active: true }]);
    return id;
  });
}

export function setSupplierActive(id: string, active: boolean): void {
  withLock(() => {
    if (!updateById(SUPPLIERS, "id", id, { active })) throw new Error(`Ta'minotchi topilmadi: ${id}`);
  });
}

export interface BillInput { supplierId: string; number: string; billDate: string; dueDate: string; category: string; amount: number; note?: string }

export function addBill(input: BillInput): { id: string; warning: string } {
  const id = withLock(() => {
    const sup = suppliers().find((s) => s.id === input.supplierId);
    if (!sup) throw new Error(`Ta'minotchi topilmadi: ${input.supplierId}`);
    if (!sup.active) throw new Error("Ta'minotchi faol emas.");
    const number = input.number.trim();
    if (!number) throw new Error("Hisob raqami kiritilmadi.");
    if (!isIsoDate(input.billDate) || !isIsoDate(input.dueDate)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
    if (input.dueDate < input.billDate) throw new Error("To'lov muddati hisob sanasidan oldin bo'lishi mumkin emas.");
    if (!CATEGORIES.includes(input.category)) throw new Error(`Xarajat turi noto'g'ri: ${input.category}`);
    if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > 1_000_000_000_000) throw new Error("Summa musbat butun son bo'lishi kerak.");
    if (bills().some((b) => b.supplierId === sup.id && b.number === number)) throw new Error("Bu ta'minotchida bunday raqamli hisob allaqachon bor.");
    const billId = nextId("H", bills().map((b) => b.id));
    append(SUPPLIER_BILLS, [{ id: billId, supplierId: sup.id, number, billDate: input.billDate, dueDate: input.dueDate, category: input.category, amount: input.amount, note: input.note ?? "", voided: false }]);
    const expenseId = nextId("X", readIfPresent<Expense>(EXPENSES).map((x) => x.id));
    append(EXPENSES, [{ id: expenseId, date: input.billDate, category: input.category, amount: input.amount, note: `${sup.name} #${number}`, voided: false, paidFrom: "cash", billId }]);
    return billId;
  });
  return { id, warning: postNow() };
}

export interface BillPaymentInput { billId: string; amount: number; paidOn: string; paidFrom?: "cash" | "bank"; note?: string }

export function payBill(input: BillPaymentInput): { id: string; warning: string } {
  const id = withLock(() => {
    const bill = bills().find((b) => b.id === input.billId);
    if (!bill) throw new Error(`Hisob topilmadi: ${input.billId}`);
    if (bill.voided) throw new Error("Hisob bekor qilingan.");
    if (!isIsoDate(input.paidOn)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
    if (input.paidOn > today()) throw new Error("To'lov kelajak sanasi bilan yozilmaydi.");
    if (input.paidOn < bill.billDate) throw new Error("To'lov hisob sanasidan oldin bo'lishi mumkin emas.");
    if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error("Summa musbat butun son bo'lishi kerak.");
    const left = bill.amount - paidOf(bill.id);
    if (input.amount > left) throw new Error(`To'lov qolgan qarzdan oshib ketdi: qolgan ${left}.`);
    const payId = nextId("Q", billPayments().map((p) => p.id));
    append(BILL_PAYMENTS, [{ id: payId, billId: bill.id, date: input.paidOn, amount: input.amount, paidFrom: input.paidFrom ?? "cash", note: input.note ?? "", voided: false }]);
    return payId;
  });
  return { id, warning: postNow() };
}

export function voidBillPayment(id: string): string {
  withLock(() => {
    const p = billPayments().find((x) => x.id === id);
    if (!p) throw new Error(`To'lov topilmadi: ${id}`);
    if (p.voided) throw new Error("To'lov allaqachon bekor qilingan.");
    updateById(BILL_PAYMENTS, "id", id, { voided: true });
  });
  return postNow();
}

export function voidBill(id: string): string {
  withLock(() => {
    const b = bills().find((x) => x.id === id);
    if (!b) throw new Error(`Hisob topilmadi: ${id}`);
    if (b.voided) throw new Error("Hisob allaqachon bekor qilingan.");
    if (paidOf(id) > 0) throw new Error("Avval hisobning to'lovlarini bekor qiling.");
    updateById(SUPPLIER_BILLS, "id", id, { voided: true });
    for (const x of read<Expense>(EXPENSES)) if (x.billId === id) updateById(EXPENSES, "id", x.id, { voided: true });
  });
  return postNow();
}

export function agingReport(asOf = today()): ReturnType<typeof payablesAging> & { names: Map<string, string> } {
  const sup = new Map(suppliers().map((s) => [s.id, s.name]));
  const pays = billPayments();
  const live = bills().filter((b) => !b.voided && b.billDate <= asOf);
  const res = payablesAging(
    live.map((b) => ({ id: b.id, dueDate: b.dueDate, amount: b.amount * 100, paid: pays.filter((p) => p.billId === b.id && !p.voided && p.date <= asOf).reduce((n, p) => n + p.amount, 0) * 100 })),
    asOf,
  );
  return { ...res, names: new Map(live.map((b) => [b.id, `${sup.get(b.supplierId) ?? b.supplierId} #${b.number}`])) };
}

export function showAging(asOf = today()): void {
  const r = agingReport(asOf);
  const som = (s: string): number => parseMoney(s) / 100;
  const label: Record<string, string> = { not_due: "Muddati kelmagan", d1_30: "1-30 kun", d31_60: "31-60 kun", d61_90: "61-90 kun", d90_plus: "90+ kun" };
  writeReport(`Ta'minotchilarga qarz (yoshi), ${asOf} holatiga`, [
    ["Hisob", "Ta'minotchi / raqam", "Muddat", "Qoldiq", "Kechikish (kun)", "Guruh"],
    ...r.rows.map((x) => [x.id, r.names.get(x.id) ?? "", x.due_date, som(x.outstanding), x.days_overdue, label[x.bucket] ?? x.bucket]),
    ["", "", "", "", "", ""],
    ...Object.entries(r.buckets).map(([k, v]) => ["", label[k] ?? k, "", som(v), "", ""]),
    ["", "JAMI", "", som(r.total), "", ""],
  ]);
}

const askNumber = (title: string, label: string): number => {
  const n = Number(askText(title, label).replace(/[\s,]/g, ""));
  if (!Number.isFinite(n)) throw new Error("Son kiriting.");
  return n;
};

export const menu = {
  addSupplier: (): void => guard("Ta'minotchi", () => ui().alert("Ta'minotchi", `Ta'minotchi ${addSupplier(askText("Ta'minotchi", "Nomi"), askText("Ta'minotchi", "Telefon (bo'sh bo'lishi mumkin)"))} qo'shildi.`, ui().ButtonSet.OK)),
  addBill: (): void =>
    guard("Ta'minotchi hisobi", () => {
      const r = addBill({
        supplierId: askText("Ta'minotchi hisobi", "Ta'minotchi ID (V0001)"),
        number: askText("Ta'minotchi hisobi", "Hisob raqami"),
        billDate: askText("Ta'minotchi hisobi", `Hisob sanasi (yyyy-mm-dd). Bugun: ${today()}`),
        dueDate: askText("Ta'minotchi hisobi", "To'lov muddati (yyyy-mm-dd)"),
        category: askText("Ta'minotchi hisobi", `Turi: ${CATEGORIES.join(", ")}`),
        amount: askNumber("Ta'minotchi hisobi", "Summa (so'm)"),
      });
      ui().alert("Ta'minotchi hisobi", `Hisob ${r.id} yozildi (xarajat va ta'minotchi qarzi hisobga olindi).${r.warning ? `\n${r.warning}` : ""}`, ui().ButtonSet.OK);
    }),
  pay: (): void =>
    guard("Ta'minotchiga to'lov", () => {
      const from = askText("Ta'minotchiga to'lov", "Qayerdan: cash (kassa) yoki bank").toLowerCase();
      if (from !== "cash" && from !== "bank") throw new Error("Cash yoki bank deb yozing.");
      const r = payBill({ billId: askText("Ta'minotchiga to'lov", "Hisob ID (H0001)"), amount: askNumber("Ta'minotchiga to'lov", "Summa (so'm)"), paidOn: askText("Ta'minotchiga to'lov", `Sana (yyyy-mm-dd). Bugun: ${today()}`), paidFrom: from });
      ui().alert("Ta'minotchiga to'lov", `To'lov ${r.id} yozildi.${r.warning ? `\n${r.warning}` : ""}`, ui().ButtonSet.OK);
    }),
  voidPayment: (): void => guard("To'lovni bekor qilish", () => ui().alert("To'lovni bekor qilish", `Bekor qilindi.${voidBillPayment(askText("To'lovni bekor qilish", "To'lov ID (Q0001)")) ? "\nJurnalga o'tkazilmadi: menyudan 'Kutayotganlarni o'tkazish' ni bosing." : ""}`, ui().ButtonSet.OK)),
  voidBill: (): void => guard("Hisobni bekor qilish", () => ui().alert("Hisobni bekor qilish", `Bekor qilindi.${voidBill(askText("Hisobni bekor qilish", "Hisob ID (H0001)")) ? "\nJurnalga o'tkazilmadi: menyudan 'Kutayotganlarni o'tkazish' ni bosing." : ""}`, ui().ButtonSet.OK)),
  aging: (): void => guard("Qarz yoshi", () => showAging(askText("Qarz yoshi", "Sana (yyyy-mm-dd), bo'sh = bugun") || undefined)),
};
