/** Group G1 in the Sheets edition: lasting discounts (rules, report), refunds in four kinds and the daily cash close.
 * The rules live in ../domain (money.ts, debt.ts, billing.ts, accounting.ts) and are shared with the API product through
 * tests/golden/money.json; this file moves data. Refunds that move money go through the hash-chained journal (ledger.ts);
 * nothing here sends a message. There is deliberately no late-payment penalty. */
import { computeDebts, type ChargeBalance } from "../domain/debt";
import { isIsoDate, monthStart } from "../domain/dates";
import { nextId } from "../domain/ids";
import { cashCloseErrors, cashDifference, leavingSplit, packageRemainder, refundErrors, type Payout, type RefundKind } from "../domain/money";
import { creditedLessons } from "../domain/packages";
import { formatSom } from "../domain/reminders";
import type { CashClose, Charge, DiscountLineRow, Enrollment, Installment, Package, Payment, Refund, Student, StudentDiscount } from "../domain/types";
import { guard, withLock } from "./actions";
import { cashBookBalance, ledgerReady, postCashDifference, tryPostRefunds, writeReport } from "./ledger";
import { loadBalances } from "./packages";
import { pickId } from "./pick";
import { cashCloseBranch } from "../domain/branches";
import { append, read, readIfPresent, today, updateById } from "./repo";
import { currentScope } from "./scope";
import { CASH_CLOSES, CHARGES, DISCOUNT_LINES, DISCOUNTS, ENROLLMENTS, INSTALLMENTS, PACKAGES, PAYMENTS, PERIODS, REFUNDS, STUDENTS } from "./schema";

const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const toast = (msg: string): void => SpreadsheetApp.getActive().toast(msg, "nazoratly", 8);

function askText(title: string, label: string): string {
  const r = ui().prompt(title, label, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  return r.getResponseText().trim();
}
const num = (text: string, what: string): number => {
  const n = Number(text.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`${what} son bo'lishi kerak: "${text}"`);
  return n;
};
const demoStudents = (): Set<string> => new Set(read<Student>(STUDENTS).filter((s) => s.demo === true).map((s) => s.id));

// ---- lasting discounts: rules ---------------------------------------------------------------------------------------
export interface DiscountInput {
  studentId: string;
  kind: StudentDiscount["kind"];
  percent?: number;
  amount?: number;
  payByDay?: number;
  enrollmentId?: string;
  reason: string;
  validFrom?: string;
  validTo?: string;
}

/** Adds a discount rule for a student. Same validation as the API (POST /v1/discounts). Returns the rule id. */
export function createDiscount(input?: DiscountInput): string {
  const i = input ?? promptDiscount();
  const reason = i.reason.trim();
  if (reason.length < 3 || reason.length > 500) throw new Error("Sabab 3-500 belgidan iborat bo'lishi kerak.");
  if (!["individual", "scholarship", "early_pay"].includes(i.kind)) throw new Error(`Chegirma turi noto'g'ri: ${i.kind}`);
  const hasPercent = (i.percent ?? 0) > 0;
  const hasAmount = (i.amount ?? 0) > 0;
  if (hasPercent === hasAmount) throw new Error("Faqat bittasini kiriting: foiz yoki summa.");
  if (hasPercent && (i.percent! > 100 || Math.round(i.percent! * 100) !== i.percent! * 100)) throw new Error("Foiz 0 dan katta, 100 dan oshmaydigan va ko'pi bilan 2 xonali kasr bo'lishi kerak.");
  if (hasAmount && !Number.isInteger(i.amount)) throw new Error("Summa butun so'm bo'lishi kerak.");
  if (i.kind === "scholarship" && !hasPercent) throw new Error("Stipendiya foizda beriladi (100 = to'liq bepul).");
  if (i.kind === "early_pay") {
    if (!hasPercent || i.percent! >= 100) throw new Error("Erta to'lov chegirmasi 100 dan kam foiz bo'lishi kerak.");
    if (!Number.isInteger(i.payByDay) || i.payByDay! < 1 || i.payByDay! > 28) throw new Error("Muddat kuni 1-28 bo'lishi kerak.");
  } else if (i.payByDay !== undefined && i.payByDay !== 0) throw new Error("Muddat kuni faqat erta to'lov uchun.");
  return withLock(() => {
    const student = read<Student>(STUDENTS).find((s) => s.id === i.studentId);
    if (!student) throw new Error(`O'quvchi topilmadi: ${i.studentId}`);
    const enrollmentId = i.enrollmentId?.trim() ?? "";
    if (enrollmentId !== "") {
      const e = read<Enrollment>(ENROLLMENTS).find((x) => x.id === enrollmentId);
      if (!e || e.studentId !== i.studentId) throw new Error("Yozilish topilmadi yoki boshqa o'quvchiniki.");
    }
    const validFrom = i.validFrom ?? today();
    const validTo = i.validTo ?? "";
    if (!isIsoDate(validFrom) || (validTo !== "" && !isIsoDate(validTo))) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
    if (validTo !== "" && validTo < validFrom) throw new Error("Tugash sanasi boshlanishdan oldin.");
    const id = nextId("D", readIfPresent<StudentDiscount>(DISCOUNTS).map((d) => d.id));
    append(DISCOUNTS, [{ id, studentId: i.studentId, enrollmentId, kind: i.kind, percent: hasPercent ? i.percent : 0, amount: hasAmount ? i.amount : 0, payByDay: i.kind === "early_pay" ? i.payByDay : 0, reason, validFrom, validTo, demo: student.demo === true }]);
    return id;
  });
}

/** Ends a rule (its last day is `validTo`, default today). An ended rule is never extended: add a new one. */
export function endDiscount(id?: string, validTo?: string): void {
  const did = pickId(id, DISCOUNTS.sheet, "Chegirmani tugatish");
  withLock(() => {
    const d = readIfPresent<StudentDiscount>(DISCOUNTS).find((x) => x.id === did);
    if (!d) throw new Error(`Chegirma topilmadi: ${did}`);
    const to = validTo ?? today();
    if (!isIsoDate(to)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
    if (to < d.validFrom) throw new Error("Tugash sanasi boshlanishdan oldin.");
    if (d.validTo !== "" && to > d.validTo) throw new Error("Tugatilgan qoidani uzaytirib bo'lmaydi: yangisini qo'shing.");
    updateById(DISCOUNTS, "id", did, { validTo: to });
  });
}

function promptDiscount(): DiscountInput {
  const t = "Chegirma qo'shish";
  const studentId = pickId(undefined, STUDENTS.sheet, `${t}: o'quvchini tanlang`);
  const word = askText(t, "Turi: individual, stipendiya yoki erta (erta to'lov)").toLowerCase();
  const kind: DiscountInput["kind"] = word.startsWith("stip") ? "scholarship" : word.startsWith("erta") ? "early_pay" : "individual";
  const value = askText(t, kind === "individual" ? "Foiz (masalan 10) yoki summa (masalan 50000 so'm, oxirida 'so'm' yozing)" : "Foiz (masalan 50)");
  const isAmount = kind === "individual" && /so'?m$/i.test(value);
  const n = num(value.replace(/so'?m$/i, ""), "Qiymat");
  const payByDay = kind === "early_pay" ? num(askText(t, "Oyning nechanchi kunigacha to'lansa chegirma beriladi? (1-28)"), "Kun") : undefined;
  const reason = askText(t, "Sabab (majburiy)");
  const validTo = askText(t, "Tugash sanasi (yyyy-mm-dd), bo'sh = tugatilmaguncha");
  return { studentId, kind, ...(isAmount ? { amount: n } : { percent: n }), payByDay, reason, validTo: validTo || undefined };
}

// ---- lasting discounts: report -------------------------------------------------------------------------------------------
export interface DiscountReportRow { kind: string; lines: number; students: number; amount: number }
export interface DiscountReport { month: string; rows: DiscountReportRow[]; total: number; scholarshipTotal: number; otherTotal: number }

/** What was discounted in a month, by kind; scholarships are shown apart. Early-payment discounts count once earned. */
export function discountReport(month?: string): DiscountReport {
  const first = monthStart(month ?? today());
  const charges = read<Charge>(CHARGES);
  const live = new Set(charges.filter((c) => !c.voided).map((c) => c.id));
  const lines = readIfPresent<DiscountLineRow>(DISCOUNT_LINES).filter((l) => l.month === first && (l.chargeId === "" || live.has(l.chargeId)));
  const items = lines.map((l) => ({ kind: l.kind as string, studentId: l.studentId, amount: l.amount }));
  const { balances } = computeDebts(charges, read<Payment>(PAYMENTS), today(), readIfPresent<Installment>(INSTALLMENTS), readIfPresent<Refund>(REFUNDS));
  for (const b of balances) if (b.earlyGranted && b.month === first) items.push({ kind: "early_pay", studentId: b.studentId, amount: b.earlyDiscount ?? 0 });
  const by = new Map<string, { lines: number; students: Set<string>; amount: number }>();
  for (const it of items) {
    const row = by.get(it.kind) ?? by.set(it.kind, { lines: 0, students: new Set(), amount: 0 }).get(it.kind)!;
    row.lines++;
    row.students.add(it.studentId);
    row.amount += it.amount;
  }
  const rows = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, r]) => ({ kind, lines: r.lines, students: r.students.size, amount: r.amount }));
  const total = rows.reduce((n, r) => n + r.amount, 0);
  const scholarshipTotal = rows.filter((r) => r.kind === "scholarship").reduce((n, r) => n + r.amount, 0);
  return { month: first, rows, total, scholarshipTotal, otherTotal: total - scholarshipTotal };
}

const KIND_NAME: Record<string, string> = { family: "Oilaviy", individual: "Individual", scholarship: "Stipendiya", early_pay: "Erta to'lov" };

export function showDiscountReport(month?: string): void {
  const r = discountReport(month);
  const rows: (string | number)[][] = [["Turi", "Qatorlar", "O'quvchilar", "Summa (so'm)"], ...r.rows.map((x) => [KIND_NAME[x.kind] ?? x.kind, x.lines, x.students, x.amount]), ["", "", "", ""], ["Jami chegirma", "", "", r.total], ["shundan stipendiya (alohida)", "", "", r.scholarshipTotal], ["boshqa chegirmalar", "", "", r.otherTotal]];
  writeReport(`Chegirmalar hisoboti, ${r.month.slice(0, 7)}`, rows);
}

// ---- refunds ------------------------------------------------------------------------------------------------------------
export interface RefundInput {
  kind: RefundKind;
  studentId: string;
  payout: Payout;
  reason: string;
  paymentId?: string;
  amount?: number;
  chargeId?: string;
  leftOn?: string;
  packageId?: string;
  date?: string;
  note?: string;
}
export interface RefundPlan {
  kind: RefundKind;
  payout: Payout;
  money: number; // cash/bank that leaves or credit that is kept
  reduction: number; // how much the charge shrinks
  available: number;
  chargeId: string;
  paymentId: string;
  packageId: string;
  leftOn: string;
  errors: string[];
}

const ERROR_TEXT: Record<string, string> = {
  not_positive: "summa musbat bo'lishi kerak",
  bad_payout: "bu turdagi qaytarish uchun bunday to'lov usuli mumkin emas (xato to'lov: naqd/bank; kreditga o'tkazish: faqat kredit)",
  exceeds_available: "summa qaytarilishi mumkin bo'lgan miqdordan oshib ketdi",
  bad_kind: "qaytarish turi noto'g'ri",
  nothing_to_reduce: "o'quvchi oyni to'liq o'qigan: hisobni kamaytirish kerak emas",
  nothing_to_refund: "qaytariladigan pul yo'q (hisob qoldiq summadan ko'p to'lanmagan yoki abonementda dars qolmagan)",
};

/** What a refund would do, without writing anything (same rules and caps as POST /v1/refunds/preview). */
export function planRefund(i: RefundInput): RefundPlan {
  const student = read<Student>(STUDENTS).find((s) => s.id === i.studentId);
  if (!student) throw new Error(`O'quvchi topilmadi: ${i.studentId}`);
  const charges = read<Charge>(CHARGES);
  const payments = read<Payment>(PAYMENTS);
  const installments = readIfPresent<Installment>(INSTALLMENTS);
  const refunds = readIfPresent<Refund>(REFUNDS);
  const { balances } = computeDebts(charges, payments, today(), installments, refunds);
  const plan: RefundPlan = { kind: i.kind, payout: i.payout, money: 0, reduction: 0, available: 0, chargeId: "", paymentId: "", packageId: "", leftOn: "", errors: [] };
  const liveCharge = (id: string | undefined): ChargeBalance => {
    const c = charges.find((x) => x.id === (id ?? ""));
    if (!c) throw new Error(`Hisob topilmadi: ${id ?? ""}`);
    if (c.studentId !== i.studentId) throw new Error("Hisob boshqa o'quvchiniki.");
    if (c.voided) throw new Error("Hisob bekor qilingan.");
    const b = balances.find((x) => x.id === c.id)!;
    if (installments.some((p) => p.chargeId === b.id)) throw new Error("Hisobda to'lov rejasi bor: avval rejani olib tashlang.");
    return b;
  };
  if (i.kind === "wrong_payment") {
    const pay = payments.find((p) => p.id === (i.paymentId ?? ""));
    if (!pay) throw new Error(`To'lov topilmadi: ${i.paymentId ?? ""}`);
    if (pay.studentId !== i.studentId) throw new Error("To'lov boshqa o'quvchiniki.");
    if (pay.voided) throw new Error("To'lov bekor qilingan: qaytariladigan pul yo'q.");
    plan.paymentId = pay.id;
    plan.available = pay.amount - refunds.filter((r) => r.paymentId === pay.id && r.payout !== "credit").reduce((n, r) => n + r.amount, 0);
    plan.money = i.amount ?? plan.available;
  } else if (i.kind === "leaving") {
    const b = liveCharge(i.chargeId);
    if (readIfPresent<Package>(PACKAGES).some((p) => p.chargeId === b.id)) throw new Error("Bu abonement hisobi: 'Abonement qoldig'i' turini tanlang.");
    if (refunds.some((r) => r.kind === "leaving" && r.chargeId === b.id)) throw new Error("Bu hisob uchun ketish qaytarishi allaqachon qilingan.");
    const leftOn = i.leftOn ?? today();
    if (!isIsoDate(leftOn)) throw new Error("Ketgan sana noto'g'ri (yyyy-mm-dd).");
    plan.chargeId = b.id;
    plan.leftOn = leftOn;
    const split = leavingSplit({ amount: b.amount, paid: b.paid, leftOn, month: b.month });
    plan.money = plan.available = split.refund;
    plan.reduction = split.reduction;
    if (split.reduction <= 0) plan.errors.push("nothing_to_reduce");
    else if (split.refund <= 0) plan.errors.push("nothing_to_refund");
  } else if (i.kind === "package_remainder") {
    const pkg = readIfPresent<Package>(PACKAGES).find((p) => p.id === (i.packageId ?? ""));
    if (!pkg) throw new Error(`Abonement topilmadi: ${i.packageId ?? ""}`);
    const b = liveCharge(pkg.chargeId);
    const credited = creditedLessons({ paid: b.paid, price: pkg.price, lessons: pkg.lessons });
    const mine = loadBalances(["active", "frozen", "finished"]).balances.find((x) => x.enrollmentId === pkg.enrollmentId);
    const remaining = mine ? Math.min(mine.balance.available, credited) : 0;
    plan.chargeId = b.id;
    plan.packageId = pkg.id;
    plan.money = plan.reduction = plan.available = packageRemainder({ price: pkg.price, packageLessons: pkg.lessons, remainingLessons: remaining, paid: b.paid, keepLessons: credited - remaining });
    if (plan.money <= 0) plan.errors.push("nothing_to_refund");
  } else {
    const b = liveCharge(i.chargeId);
    plan.chargeId = b.id;
    plan.available = b.paid;
    plan.money = plan.reduction = i.amount ?? 0;
  }
  if (plan.errors.length === 0) plan.errors.push(...refundErrors({ kind: plan.kind, payout: plan.payout, amount: plan.money, available: plan.available }));
  return plan;
}

/** Records a refund (a row of "Qaytarishlar") and, when money leaves, its journal entry. Returns the new id. */
export function makeRefund(input?: RefundInput): { id: string; plan: RefundPlan; ledger: string } {
  const i = input ?? promptRefund();
  const reason = i.reason.trim();
  if (reason.length < 3 || reason.length > 500) throw new Error("Sabab 3-500 belgidan iborat bo'lishi kerak.");
  const date = i.date ?? today();
  if (!isIsoDate(date)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
  if (date > today()) throw new Error("Qaytarish kelajak sanasi bilan yozilmaydi.");
  const out = withLock(() => {
    const plan = planRefund(i);
    if (plan.errors.length) throw new Error(`Qaytarib bo'lmaydi: ${plan.errors.map((e) => ERROR_TEXT[e] ?? e).join("; ")}.`);
    if (plan.payout !== "credit" && ledgerReady() && readIfPresent<{ month: string }>(PERIODS).some((p) => p.month === date.slice(0, 7))) throw new Error(`${date.slice(0, 7)} oyi yopilgan: bu sanaga pul qaytarishini yozib bo'lmaydi.`);
    const id = nextId("R", readIfPresent<Refund>(REFUNDS).map((r) => r.id));
    append(REFUNDS, [{ id, studentId: i.studentId, date, kind: plan.kind, payout: plan.payout, amount: plan.money, chargeReduction: plan.reduction, chargeId: plan.chargeId, paymentId: plan.paymentId, packageId: plan.packageId, leftOn: plan.leftOn, reason, note: i.note ?? "", demo: demoStudents().has(i.studentId) }]);
    return { id, plan };
  });
  const ledger = out.plan.payout !== "credit" && !demoStudents().has(i.studentId) ? tryPostRefunds() : "";
  return { ...out, ledger };
}

function promptRefund(): RefundInput {
  const t = "Qaytarish";
  const word = askText(t, "Turi: xato (xato to'lov), ketdi (oy qoldig'i), abonement (qoldiq) yoki kredit (kreditga o'tkazish)").toLowerCase();
  const kind: RefundKind = word.startsWith("xato") ? "wrong_payment" : word.startsWith("ket") ? "leaving" : word.startsWith("abon") ? "package_remainder" : "to_credit";
  const studentId = pickId(undefined, STUDENTS.sheet, `${t}: o'quvchini tanlang`);
  const payout: Payout = kind === "to_credit" ? "credit" : ((p) => (p.startsWith("b") ? "bank" : p.startsWith("k") ? "credit" : "cash"))(askText(t, "Qanday: naqd, bank" + (kind === "wrong_payment" ? "" : " yoki kredit (pul o'quvchida qoladi)")).toLowerCase());
  const base: RefundInput = { kind, studentId, payout, reason: "" };
  if (kind === "wrong_payment") {
    base.paymentId = askText(t, "To'lov ID (masalan P0003)");
    const a = askText(t, "Summa (bo'sh = to'lovning qolgan hammasi)");
    if (a) base.amount = num(a, "Summa");
  } else if (kind === "leaving") {
    base.chargeId = askText(t, "Hisob ID (masalan C0007)");
    const d = askText(t, "Oxirgi kelgan sana (yyyy-mm-dd), bo'sh = bugun");
    if (d) base.leftOn = d;
  } else if (kind === "package_remainder") base.packageId = askText(t, "Abonement ID (masalan A0002)");
  else {
    base.chargeId = askText(t, "Hisob ID (masalan C0007)");
    base.amount = num(askText(t, "Kreditga o'tkaziladigan summa"), "Summa");
  }
  base.reason = askText(t, "Sabab (majburiy)");
  return base;
}

// ---- daily cash close -------------------------------------------------------------------------------------------------------
/** The branch of a cash desk: staff of a branch = their own; center-wide staff name it, or the only active branch implies it. */
export function cashBranch(requested?: string | null): string {
  const info = currentScope();
  const r = cashCloseBranch({ scope: info.scope, requested: requested || null, active: info.active });
  if (r.error === "forbidden_branch") throw new Error("Bu filial sizga ochiq emas.");
  if (r.error === "unknown_branch") throw new Error(`Filial topilmadi yoki yopilgan: ${requested}.`);
  if (r.error === "branch_required") throw new Error("Markazda bir nechta filial bor: kassa filialini ko'rsating (menyu so'raydi yoki Filiallar > Filialni tanlash).");
  return r.branch!;
}

export interface CashPreview { branchId: string; date: string; bookBalance: number; cashIn: number; cashOut: number; journalSeq: number; nextShift: number }

export function cashClosePreview(date?: string, branchId?: string | null): CashPreview {
  const day = date ?? today();
  if (!isIsoDate(day)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
  const branch = cashBranch(branchId);
  const b = cashBookBalance(day, branch);
  const shifts = readIfPresent<CashClose>(CASH_CLOSES).filter((c) => c.date === day && c.branchId === branch).map((c) => c.shiftNo); // shifts count per branch
  return { branchId: branch, date: day, bookBalance: b.balance, cashIn: b.cashIn, cashOut: b.cashOut, journalSeq: b.seq, nextShift: Math.max(0, ...shifts) + 1 };
}

export interface CloseInput { date?: string; counted: number; note?: string; postDifference?: boolean; branchId?: string }

/** Closes the cash desk of a day: the counted cash is compared with the books, a difference needs a note, the close keeps the
 * journal head of that moment and, when asked, the difference is booked in the journal. Closes are append-only. */
export function closeCash(input?: CloseInput): { id: string; shiftNo: number; difference: number; status: "ok" | "over" | "short"; entryNo: number } {
  const i = input ?? promptClose();
  const day = i.date ?? today();
  if (!isIsoDate(day)) throw new Error("Sana noto'g'ri (yyyy-mm-dd).");
  if (day > today()) throw new Error("Kassa kelajak sanasi bilan yopilmaydi.");
  if (!Number.isInteger(i.counted) || i.counted < 0 || i.counted > 1_000_000_000_000) throw new Error("Sanalgan summa 0 yoki musbat butun son bo'lishi kerak.");
  return withLock(() => {
    const p = cashClosePreview(day, i.branchId);
    const d = cashDifference({ book: p.bookBalance, counted: i.counted });
    const errors = cashCloseErrors({ counted: i.counted, difference: d.difference, note: i.note ?? "" });
    if (i.postDifference && d.difference === 0) errors.push("nothing_to_post");
    if (errors.length) throw new Error(`Smenani yopib bo'lmaydi: ${errors.map((e) => CLOSE_TEXT[e] ?? e).join("; ")}.`);
    const id = nextId("M", readIfPresent<CashClose>(CASH_CLOSES).map((c) => c.id));
    const entryNo = i.postDifference ? postCashDifference(day, id, d.difference, p.branchId) : 0; // a failed posting saves nothing
    append(CASH_CLOSES, [{ id, branchId: p.branchId, date: day, shiftNo: p.nextShift, counted: i.counted, bookBalance: p.bookBalance, difference: d.difference, note: (i.note ?? "").trim(), journalSeq: p.journalSeq, entryNo }]);
    return { id, shiftNo: p.nextShift, difference: d.difference, status: d.status, entryNo };
  });
}

const CLOSE_TEXT: Record<string, string> = {
  negative_counted: "sanalgan summa manfiy bo'lmasin",
  note_required: "hisobdan farq bor: izoh kiritish majburiy",
  nothing_to_post: "farq yo'q: jurnalga yozadigan narsa yo'q",
};

function promptClose(): CloseInput {
  const t = "Kassani yopish (smena)";
  const info = currentScope();
  const branchId = info.scope === null && info.active.length > 1 ? askText(t, `Qaysi filial kassasi? Filial ID (${info.active.join(", ")}):`) : undefined;
  const p = cashClosePreview(undefined, branchId);
  const counted = num(askText(t, `Jurnal bo'yicha kassada ${formatSom(p.bookBalance)} so'm bo'lishi kerak (bugun kirim ${formatSom(p.cashIn)}, chiqim ${formatSom(p.cashOut)}).\nHaqiqiy sanalgan naqd pul (so'm):`), "Summa");
  const diff = counted - p.bookBalance;
  const note = diff === 0 ? "" : askText(t, `Farq: ${formatSom(diff)} so'm. Izoh (majburiy):`);
  const post = diff !== 0 && ui().alert(t, "Farqni jurnalga yozamizmi? (Ortiqcha = boshqa daromad, kam = kassa kamomadi)", ui().ButtonSet.YES_NO) === ui().Button.YES;
  return { counted, note, postDifference: post, branchId };
}

// ---- menus ------------------------------------------------------------------------------------------------------------------------
export const menu = {
  addDiscount: (): void => guard("Chegirma", () => toast(`Chegirma ${createDiscount()} qo'shildi.`)),
  endDiscount: (): void => guard("Chegirma", () => { endDiscount(); toast("Chegirma tugatildi."); }),
  discountReport: (): void =>
    guard("Chegirmalar hisoboti", () => {
      const m = askText("Chegirmalar hisoboti", "Oy (yyyy-mm), bo'sh = shu oy");
      if (m && !isIsoDate(`${m}-01`)) throw new Error(`Oy noto'g'ri: "${m}". Format: 2026-12`);
      showDiscountReport(m ? `${m}-01` : undefined);
    }),
  refund: (): void =>
    guard("Qaytarish", () => {
      const input = promptRefund();
      const plan = planRefund(input);
      if (plan.errors.length) throw new Error(`Qaytarib bo'lmaydi: ${plan.errors.map((e) => ERROR_TEXT[e] ?? e).join("; ")}.`);
      const what = plan.payout === "credit" ? "o'quvchi kreditida qoladi" : `${plan.payout === "cash" ? "naqd" : "bankdan"} qaytariladi (jurnalga yoziladi)`;
      const ok = ui().alert("Qaytarish", `${formatSom(plan.money)} so'm ${what}.${plan.reduction > 0 ? `\nOylik hisob ${formatSom(plan.reduction)} so'mga kamayadi.` : ""}\n\nTasdiqlaysizmi?`, ui().ButtonSet.YES_NO);
      if (ok !== ui().Button.YES) throw new Error("Bekor qilindi.");
      const r = makeRefund(input);
      ui().alert("Qaytarish", `Qaytarish ${r.id} yozildi.${r.ledger ? `\n${r.ledger}` : ""}`, ui().ButtonSet.OK);
    }),
  cashClose: (): void =>
    guard("Kassani yopish", () => {
      const r = closeCash();
      ui().alert("Kassani yopish", `Smena ${r.shiftNo} yopildi (${r.id}). Farq: ${formatSom(r.difference)} so'm${r.entryNo ? `, jurnal yozuvi №${r.entryNo}` : ""}.`, ui().ButtonSet.OK);
    }),
  cashStatus: (): void =>
    guard("Kassa holati", () => {
      const info = currentScope();
      const p = cashClosePreview(undefined, info.scope === null && info.active.length > 1 ? askText("Kassa holati", `Qaysi filial? Filial ID (${info.active.join(", ")}):`) : undefined);
      ui().alert("Kassa holati", `Jurnal bo'yicha kassa (${p.branchId}, ${p.date}): ${formatSom(p.bookBalance)} so'm.\nBugun kirim: ${formatSom(p.cashIn)}, chiqim: ${formatSom(p.cashOut)}.\nKeyingi smena: ${p.nextShift}.`, ui().ButtonSet.OK);
    }),
};

