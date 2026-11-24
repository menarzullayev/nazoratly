/** Growth (G3): referral rewards, promo codes, marketing credits, lead source ROI and internal lead reminders.
 * Rules live in ../domain/growth (golden-tested against the API product); this file only moves data.
 * Rewards and promo discounts are credits in "Qoplash huquqlari" (kind credit), taken off the student's next monthly charge
 * by the existing billing run: nothing here edits billing. Nothing here sends anything to a lead, student or guardian:
 * the reminders are a list for staff. */
import { effectiveFee } from "../domain/billing";
import { monthStart } from "../domain/dates";
import { entitlementExpiresOn } from "../domain/entitlements";
import {
  growthCreditSummary,
  leadReminders,
  promoDiscount,
  promoState,
  referralConditionMet,
  referralRewardAmount,
  sourceRoi,
  splitCredit,
  type CreditFact,
  type RewardType,
} from "../domain/growth";
import { nextId } from "../domain/ids";
import { monthLessonDates } from "../domain/lifecycle";
import type { AttendanceRow, Entitlement, Enrollment, Group, Lead, LeadLogRow, Payment, Promo, PromoUse, Referral, SourceCostRow, Student } from "../domain/types";
import { guard, withLock } from "./actions";
import { fillLeadIds, writeTable } from "./admission";
import { pickId } from "./pick";
import { currentScope } from "./scope";
import { append, read, readIfPresent, today, updateById } from "./repo";
import { ATTENDANCE, ENROLLMENTS, ENTITLEMENTS, GROUPS, LEAD_LOG, PAYMENTS, PROMOS, PROMO_USES, REFERRALS, SOURCE_COSTS, STUDENTS } from "./schema";
import { readSettings } from "./settings";

export const CREDITS_SHEET = "Marketing chegirmalari";
export const ROI_SHEET = "Manba ROI";
export const REMINDERS_SHEET = "Lead eslatmalari";
const CREDIT_VALID_DAYS = 365;

const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const som = (n: number): string => n.toLocaleString("en-US").replace(/,/g, " ");

function ask(title: string, text: string): string {
  const r = ui().prompt(title, text, ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  return r.getResponseText().trim();
}

function student(id: string): Student {
  const s = read<Student>(STUDENTS).find((x) => x.id === id);
  if (!s) throw new Error(`O'quvchi topilmadi: ${id}`);
  return s;
}

/** Money value paid by a student so far (voided payments excluded, demo payments excluded). */
function paidBy(studentId: string, payments: Payment[], upTo?: string): number {
  return payments.filter((p) => p.studentId === studentId && !p.voided && !p.demo && (!upTo || p.paidOn <= upTo)).reduce((n, p) => n + p.amount, 0);
}

function addCredits(studentId: string, chunks: number[], source: "referral" | "promo", note: string, on: string): void {
  const used: string[] = read<Entitlement>(ENTITLEMENTS).map((e) => e.id);
  const rows = chunks.map((amount) => {
    const id = nextId("R", used);
    used.push(id);
    // missedOn orders credits for billing (oldest first); a growth credit has no lesson, so it carries its grant date
    return { id, studentId, groupId: "", missedOn: on, kind: "credit", amount, expiresOn: entitlementExpiresOn(on, CREDIT_VALID_DAYS), status: "open", makeupOn: "", usedOn: "", appliedChargeId: "", lastMakeupOn: "", source, note };
  });
  append(ENTITLEMENTS, rows);
}

// ------------------------------------------------------------------ referrals
export function addReferral(referrerId?: string, invitedId?: string, note = ""): string {
  const a = referrerId ?? ask("Tavsiya", "Taklif qilgan o'quvchi ID (masalan S0001)");
  const b = invitedId ?? ask("Tavsiya", "Taklif qilingan (yangi) o'quvchi ID (masalan S0002)");
  return withLock(() => {
    const s = readSettings();
    if (!s.referralActive || s.referralRewardValue <= 0) throw new Error("Tavsiya dasturi yoqilmagan: Sozlamalar varag'ida 'Tavsiya dasturi yoqilgan' = Ha va mukofot qiymatini kiriting.");
    if (a === b) throw new Error("O'quvchi o'zini taklif qila olmaydi.");
    student(a);
    student(b);
    const refs = readIfPresent<Referral>(REFERRALS);
    if (refs.some((r) => r.invitedId === b)) throw new Error("Bu o'quvchi allaqachon kimdir tomonidan taklif qilingan.");
    const id = nextId("F", refs.map((r) => r.id));
    append(REFERRALS, [{ id, referrerId: a, invitedId: b, status: "pending", rewardType: s.referralRewardType, rewardValue: s.referralRewardValue, condition: s.referralCondition, minPaid: s.referralMinPaid, rewardAmount: 0, invitedOn: today(), rewardedOn: "", note }]);
    return id;
  });
}

export interface BookResult {
  rewarded: { referralId: string; referrer: string; amount: number; credits: number }[];
  skipped: { referralId: string; referrer: string; reason: "condition_not_met" | "referrer_has_no_active_enrollment" | "reward_is_zero" }[];
  total: number;
}

/** Pays the reward of every pending referral whose condition holds (credits for the referrer). Safe to repeat. */
export function bookReferralRewards(): BookResult {
  return withLock(() => {
    const on = today();
    const first = monthStart(on);
    const refs = readIfPresent<Referral>(REFERRALS).filter((r) => r.status === "pending");
    const enrollments = read<Enrollment>(ENROLLMENTS);
    const groups = read<Group>(GROUPS);
    const payments = read<Payment>(PAYMENTS);
    const students = new Map(read<Student>(STUDENTS).map((x) => [x.id, x]));
    const att = read<AttendanceRow>(ATTENDANCE);
    const out: BookResult = { rewarded: [], skipped: [], total: 0 };
    for (const r of refs) {
      const name = students.get(r.referrerId)?.fullName ?? r.referrerId;
      const met = referralConditionMet({
        condition: r.condition,
        minPaid: r.minPaid,
        invitedEnrolled: enrollments.some((e) => e.studentId === r.invitedId && (e.status === "active" || e.status === "frozen")),
        invitedPaid: paidBy(r.invitedId, payments),
      });
      if (!met) {
        out.skipped.push({ referralId: r.id, referrer: name, reason: "condition_not_met" });
        continue;
      }
      // the referrer's best active monthly enrollment sets the fee the reward is measured against
      let fee = 0;
      let group: Group | undefined;
      for (const e of enrollments.filter((x) => x.studentId === r.referrerId && x.status === "active")) {
        const g = groups.find((x) => x.id === e.groupId);
        if (!g || g.billingMode === "package") continue;
        const f = effectiveFee(g, e);
        if (!group || f > fee) {
          fee = f;
          group = g;
        }
      }
      if (!group && r.rewardType !== "amount") {
        out.skipped.push({ referralId: r.id, referrer: name, reason: "referrer_has_no_active_enrollment" });
        continue;
      }
      let lessons = group ? monthLessonDates(first, group.schedule ?? "").length : 0;
      if (group && lessons === 0) lessons = new Set(att.filter((a) => a.groupId === group!.id && a.date.slice(0, 7) === on.slice(0, 7)).map((a) => a.date)).size;
      const amount = referralRewardAmount({ rewardType: r.rewardType as RewardType, rewardValue: r.rewardValue, monthlyFee: fee, lessonsInMonth: lessons });
      const chunks = splitCredit({ amount, monthlyFee: fee });
      if (chunks.length === 0) {
        out.skipped.push({ referralId: r.id, referrer: name, reason: "reward_is_zero" });
        continue;
      }
      addCredits(r.referrerId, chunks, "referral", `Tavsiya: ${students.get(r.invitedId)?.fullName ?? r.invitedId}`, on);
      updateById(REFERRALS, "id", r.id, { status: "rewarded", rewardAmount: amount, rewardedOn: on });
      out.total += amount;
      out.rewarded.push({ referralId: r.id, referrer: name, amount, credits: chunks.length });
    }
    return out;
  });
}

const SKIP_TEXT: Record<string, string> = {
  condition_not_met: "shart hali bajarilmagan",
  referrer_has_no_active_enrollment: "taklif qilganning faol oylik guruhi yo'q",
  reward_is_zero: "mukofot 0 so'm (bu oyda dars yo'q yoki narx 0)",
};

export function cancelReferral(id?: string): void {
  const rid = pickId(id, REFERRALS.sheet, "Tavsiyani bekor qilish");
  withLock(() => {
    const r = readIfPresent<Referral>(REFERRALS).find((x) => x.id === rid);
    if (!r) throw new Error(`Tavsiya topilmadi: ${rid}`);
    if (r.status === "cancelled") throw new Error("Tavsiya allaqachon bekor qilingan.");
    for (const e of read<Entitlement>(ENTITLEMENTS)) {
      if (e.source === "referral" && e.status === "open" && e.studentId === r.referrerId && e.note === `Tavsiya: ${student(r.invitedId).fullName}`) {
        updateById(ENTITLEMENTS, "id", e.id, { status: "cancelled" });
      }
    }
    updateById(REFERRALS, "id", r.id, { status: "cancelled" });
  });
  SpreadsheetApp.getActive().toast("Tavsiya bekor qilindi. Ishlatilmagan kreditlar bekor qilindi.", "nazoratly", 6);
}

// ------------------------------------------------------------------ promo
function checkPromo(p: Promo): void {
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(p.code)) throw new Error(`Promo kod noto'g'ri: "${p.code}" (3-32 belgi: harf, raqam, - yoki _).`);
  if (p.value <= 0 || (p.kind === "percent" && p.value > 100)) throw new Error(`Promo "${p.code}" noto'g'ri sozlangan: qiymat ${p.kind === "percent" ? "1-100 foiz" : "0 dan katta summa"} bo'lishi kerak.`);
  if (p.validTo && p.validTo < p.validFrom) throw new Error(`Promo "${p.code}" noto'g'ri sozlangan: tugash sanasi boshlanishidan oldin.`);
}

export interface RedeemResult {
  code: string;
  fee: number;
  amount: number;
}

export function redeemPromo(code?: string, studentId?: string, enrollmentId?: string): RedeemResult {
  const c = (code ?? ask("Promo kod", "Promo kod")).toUpperCase();
  const sid = studentId ?? ask("Promo kod", "O'quvchi ID (masalan S0001)");
  const eid = enrollmentId ?? ask("Promo kod", "Yozilish ID (masalan E0001)");
  return withLock(() => {
    const promo = readIfPresent<Promo>(PROMOS).find((p) => p.code.toUpperCase() === c);
    if (!promo) throw new Error(`Promo kod topilmadi: ${c}`);
    checkPromo(promo);
    const uses = readIfPresent<PromoUse>(PROMO_USES);
    const state = promoState({ active: promo.active, validFrom: promo.validFrom, validTo: promo.validTo, maxUses: promo.maxUses > 0 ? promo.maxUses : null, used: uses.filter((u) => u.code.toUpperCase() === c).length, today: today() });
    const WHY: Record<string, string> = { inactive: "o'chirilgan", not_started: "hali boshlanmagan", expired: "muddati tugagan", exhausted: "ishlatish limiti tugagan" };
    if (state !== "ok") throw new Error(`Promo kod ishlamaydi: ${WHY[state]}.`);
    student(sid);
    const enr = read<Enrollment>(ENROLLMENTS).find((e) => e.id === eid);
    if (!enr) throw new Error(`Yozilish topilmadi: ${eid}`);
    if (enr.studentId !== sid) throw new Error("Bu yozilish shu o'quvchiga tegishli emas.");
    if (enr.status !== "trial" && enr.status !== "active") throw new Error("Promo faqat sinov yoki faol yozilishga qo'llanadi.");
    const group = read<Group>(GROUPS).find((g) => g.id === enr.groupId);
    if (!group) throw new Error(`Guruh topilmadi: ${enr.groupId}`);
    if (group.billingMode === "package") throw new Error("Promo faqat oylik hisoblanadigan guruhga qo'llanadi.");
    const fee = effectiveFee(group, enr);
    const amount = promoDiscount({ kind: promo.kind, value: promo.value, fee });
    if (amount <= 0) throw new Error("Oylik narx 0: chegirma qilinadigan narsa yo'q.");
    if (uses.some((u) => u.code.toUpperCase() === c && u.studentId === sid)) throw new Error("Bu o'quvchi bu promo kodni allaqachon ishlatgan.");
    const on = today();
    append(PROMO_USES, [{ code: promo.code, studentId: sid, enrollmentId: eid, fee, amount, usedOn: on }]);
    addCredits(sid, [amount], "promo", promo.code.toUpperCase(), on);
    return { code: promo.code, fee, amount };
  });
}

// ------------------------------------------------------------------ marketing credits report
export function refreshGrowthCredits(): void {
  const promos = new Map(readIfPresent<Promo>(PROMOS).map((p) => [p.code.toUpperCase(), p]));
  const facts: CreditFact[] = read<Entitlement>(ENTITLEMENTS)
    .filter((e) => e.source === "referral" || e.source === "promo")
    .map((e) => {
      const promo = e.source === "promo" ? promos.get((e.note ?? "").toUpperCase()) : undefined;
      return { source: e.source!, label: e.source === "promo" ? `${(e.note ?? "").toUpperCase()}${promo ? ` - ${promo.name}` : ""}` : "Referral", amount: e.amount, status: e.status === "used" || e.status === "cancelled" ? e.status : "open" };
    });
  const rep = growthCreditSummary(facts);
  const rows: (string | number)[][] = rep.rows.map((r) => [r.source === "promo" ? "Promo" : "Tavsiya", r.label, r.count, r.granted, r.applied, r.outstanding, r.cancelled]);
  rows.push(["JAMI", "", rep.totals.count, rep.totals.granted, rep.totals.applied, rep.totals.outstanding, rep.totals.cancelled]);
  writeTable(CREDITS_SHEET, ["Manba", "Kampaniya", "Soni", "Berilgan (so'm)", "Hisoblarga qo'llangan", "Kutayotgan", "Bekor qilingan"], rows, "#188038");
  SpreadsheetApp.getActive().toast("Marketing chegirmalari: tuition daromadidan alohida ko'rsatilgan.", "nazoratly", 6);
}

// ------------------------------------------------------------------ source costs and ROI
export function setSourceCost(source?: string, monthText?: string, amountText?: string): void {
  const src = (source ?? ask("Manba xarajati", "Manba nomi (Lead'lar varag'idagi bilan bir xil, masalan Instagram)")).trim();
  const m = (monthText ?? ask("Manba xarajati", `Oy (yyyy-mm). Bo'sh qoldirsangiz: ${today().slice(0, 7)}`)).trim() || today().slice(0, 7);
  const a = (amountText ?? ask("Manba xarajati", "Shu oydagi xarajat (so'm, butun son)")).replace(/[\s,]/g, "");
  if (!src) throw new Error("Manba nomi kiritilmadi.");
  if (!/^\d{4}-\d{2}$/.test(m) || Number(m.slice(5)) < 1 || Number(m.slice(5)) > 12) throw new Error(`Noto'g'ri oy: "${m}". Format: 2026-11`);
  const amount = Number(a);
  if (!/^\d+$/.test(a) || !Number.isSafeInteger(amount)) throw new Error("Xarajat butun, manfiy bo'lmagan son bo'lishi kerak.");
  const month = `${m}-01`;
  withLock(() => {
    const info = currentScope();
    const branch = info.scope ?? info.defaultId; // a cost belongs to a branch: the one you work in, else the default branch
    const rows = readIfPresent<SourceCostRow>(SOURCE_COSTS);
    const same = rows.find((r) => r.source.toLowerCase() === src.toLowerCase() && r.month === month && r.branchId === branch);
    if (same) {
      // one figure per source and month: repeating corrects it (the sheet row is found by source + month)
      const sh = SpreadsheetApp.getActive().getSheetByName(SOURCE_COSTS.sheet)!;
      const data = sh.getDataRange().getValues();
      const head = (data[0] ?? []).map((h) => String(h).trim());
      const sCol = head.indexOf(SOURCE_COSTS.cols[0]!.header);
      const aCol = head.indexOf(SOURCE_COSTS.cols[2]!.header);
      const bCol = head.indexOf("Filial");
      for (let r = 1; r < data.length; r++) {
        const rowBranch = bCol < 0 ? "" : String(data[r]![bCol] ?? "").trim() || info.defaultId;
        if (String(data[r]![sCol]).trim().toLowerCase() === src.toLowerCase() && (bCol < 0 || rowBranch === branch)) {
          const dc = data[r]![head.indexOf(SOURCE_COSTS.cols[1]!.header)];
          const iso = dc instanceof Date ? Utilities.formatDate(dc, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), "yyyy-MM-dd") : String(dc).trim();
          if (iso === month) sh.getRange(r + 1, aCol + 1).setValue(amount);
        }
      }
    } else {
      append(SOURCE_COSTS, [{ source: src, month, amount, note: "", branchId: branch }]);
    }
  });
  SpreadsheetApp.getActive().toast(`${src} ${m}: ${som(amount)} so'm.`, "nazoratly", 5);
}

export function refreshSourceRoi(): void {
  const leads = fillLeadIds();
  const t = today();
  const from = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)) - 90)).toISOString().slice(0, 10);
  const payments = read<Payment>(PAYMENTS);
  // the lead sheet spells a source freely: costs match it ignoring case, and the first spelling seen is the one shown
  const spelling = new Map<string, string>();
  for (const l of leads) if (l.source && !spelling.has(l.source.toLowerCase())) spelling.set(l.source.toLowerCase(), l.source);
  const canon = (s: string): string => spelling.get(s.trim().toLowerCase()) ?? s.trim();
  const rep = sourceRoi(
    leads.map((l) => ({ source: l.source ? canon(l.source) : null, createdOn: l.createdOn, revenue: l.studentId ? paidBy(l.studentId, payments, t) : 0 })),
    readIfPresent<SourceCostRow>(SOURCE_COSTS).filter((c) => c.source && c.month).map((c) => ({ source: canon(c.source), month: c.month, amount: c.amount })),
    { from, to: t },
  );
  const fmt = (n: number | null): string | number => (n === null ? "" : n);
  const rows: (string | number)[][] = [...rep.rows, rep.total].map((r) => [r.source === null ? "(manba yo'q)" : r.source === "TOTAL" ? "JAMI" : r.source, r.leads, r.paying, r.revenue, r.cost, fmt(r.roi), fmt(r.costPerLead), fmt(r.costPerPaying)]);
  writeTable(ROI_SHEET, [`Manba (oxirgi 90 kun, ${from} dan)`, "Lead'lar", "To'lagan o'quvchilar", "Tushum (so'm)", "Xarajat (so'm)", "ROI %", "Lead narxi", "To'lagan o'quvchi narxi"], rows, "#e37400");
}

// ------------------------------------------------------------------ internal lead reminders
const REASON_TEXT: Record<string, string> = { follow_up_due: "Aloqa sanasi keldi", after_trial: "Sinovdan keyin aloqa kerak", silent: "Uzoq vaqt aloqa bo'lmagan" };

export function refreshLeadReminders(): number {
  const s = readSettings();
  const t = today();
  const leads = fillLeadIds();
  const log = readIfPresent<LeadLogRow>(LEAD_LOG);
  const last = new Map<string, string>();
  for (const x of log) if (x.date && (last.get(x.leadId) ?? "") < x.date) last.set(x.leadId, x.date);
  const byId = new Map(leads.map((l) => [l.id, l]));
  const due = leadReminders(
    leads.filter((l) => l.createdOn).map((l) => ({ id: l.id, stage: l.stage, createdOn: l.createdOn, lastContactOn: last.get(l.id) ?? "", nextFollowUpOn: l.nextFollowUpOn })),
    { today: t, silenceDays: s.leadReminderDays },
  );
  const rows: (string | number)[][] = due.map((d) => {
    const l = byId.get(d.id)!;
    return [l.id, l.fullName, l.phone, l.source, l.stage, REASON_TEXT[d.reason]!, d.days, l.nextFollowUpOn, last.get(l.id) ?? ""];
  });
  writeTable(REMINDERS_SHEET, ["Lead ID", "F.I.Sh.", "Telefon", "Manba", "Bosqich", "Sabab", "Kun", "Keyingi aloqa", "Oxirgi aloqa"], rows, "#e37400");
  SpreadsheetApp.getActive().toast(rows.length ? `${rows.length} ta lead e'tibor kutmoqda. Bu faqat ichki ro'yxat: lead'ga hech narsa yuborilmagan.` : "Hozir e'tibor kutayotgan lead yo'q.", "nazoratly", 8);
  return rows.length;
}

// menu wiring helpers (kept here so Code.ts stays a thin list)
export const menu = {
  addReferral: (): void =>
    guard("Tavsiya", () => {
      const id = addReferral();
      SpreadsheetApp.getActive().toast(`Tavsiya ${id} qo'shildi. Shart bajarilgach: O'sish > Tavsiya mukofotlarini hisoblash.`, "nazoratly", 6);
    }),
  book: (): void =>
    guard("Tavsiya mukofoti", () => {
      const r = bookReferralRewards();
      const lines = [`Mukofot berildi: ${r.rewarded.length} ta, jami ${som(r.total)} so'm (kredit sifatida, keyingi oylik hisobdan ayiriladi).`];
      for (const x of r.rewarded) lines.push(`  ${x.referralId} ${x.referrer}: ${som(x.amount)} so'm (${x.credits} ta kredit)`);
      if (r.skipped.length) lines.push(`Kutmoqda: ${r.skipped.length} ta`, ...r.skipped.slice(0, 15).map((x) => `  ${x.referralId} ${x.referrer}: ${SKIP_TEXT[x.reason]}`));
      ui().alert("Tavsiya mukofotlari", lines.join("\n"), ui().ButtonSet.OK);
    }),
  cancelReferral: (): void => guard("Tavsiya", () => cancelReferral()),
  redeem: (): void =>
    guard("Promo kod", () => {
      const r = redeemPromo();
      ui().alert("Promo kod", `${r.code}: ${som(r.amount)} so'm chegirma (oylik narx ${som(r.fee)} so'm). U keyingi oylik hisobdan ayiriladi.`, ui().ButtonSet.OK);
    }),
  credits: (): void => guard("Marketing chegirmalari", refreshGrowthCredits),
  cost: (): void => guard("Manba xarajati", () => setSourceCost()),
  roi: (): void => guard("Manba ROI", refreshSourceRoi),
  reminders: (): void => guard("Lead eslatmalari", () => void refreshLeadReminders()),
};

