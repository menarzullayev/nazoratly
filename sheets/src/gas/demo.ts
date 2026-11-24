/** Demo data: which rows are flagged, and "Demo ma'lumotni tozalash": deletes ONLY flagged rows and refuses, with the
 * reason, when a real row references one. Demo money never enters the journal (see ledger.ts), so the immutable
 * journal is never involved. */
import { demoBlockers, type Blocker, type DemoRow, type DemoTable } from "../domain/demo";
import { guard, withLock } from "./actions";
import { readIfPresent, replaceWhere } from "./repo";
import { ATTENDANCE, BRANCHES, CASH_CLOSES, CERTIFICATES, CHARGES, DISCOUNT_LINES, DISCOUNTS, DOCUMENTS, DRAFTS, ENROLLMENTS, ENTITLEMENTS, EXAM_RESULTS, EXAMS, EXPENSES, GROUPS, GUARDIAN_LINKS, GUARDIAN_REQUESTS, INSTALLMENTS, LEADS, LEAD_LOG, MARKS, PACKAGES, PAYMENTS, PROMO_USES, PROMOS, REFERRALS, REFUNDS, REPORTS, ROOMS, SCHEDULE_CHANGES, SOURCE_COSTS, STUDENTS, TEACHER_INVITES, TEACHERS, WAITLIST, type TableDef } from "./schema";

type Row = Record<string, unknown>;
const flagged = (r: Row): boolean => r.demo === true;
const s = (v: unknown): string => String(v ?? "").trim();

interface Spec {
  key: string;
  def: TableDef;
  id: (r: Row) => string;
  refs: (r: Row) => [string, string][];
  label: string;
}
const SPECS: Spec[] = [
  { key: "students", def: STUDENTS, label: "O'quvchilar", id: (r) => s(r.id), refs: (r) => [["branches", s(r.branchId)]] },
  { key: "teachers", def: TEACHERS, label: "O'qituvchilar", id: (r) => s(r.id), refs: () => [] },
  { key: "groups", def: GROUPS, label: "Guruhlar", id: (r) => s(r.id), refs: (r) => [["teachers", s(r.teacherId)], ["rooms", s(r.roomId)], ["branches", s(r.branchId)]] },
  { key: "enrollments", def: ENROLLMENTS, label: "Yozilishlar", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)], ["groups", s(r.groupId)]] },
  { key: "attendance", def: ATTENDANCE, label: "Davomat", id: (r) => `${s(r.date)}|${s(r.groupId)}|${s(r.studentId)}`, refs: (r) => [["students", s(r.studentId)], ["groups", s(r.groupId)]] },
  { key: "charges", def: CHARGES, label: "Hisoblar", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)], ["enrollments", s(r.enrollmentId)]] },
  { key: "payments", def: PAYMENTS, label: "To'lovlar", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)]] },
  { key: "expenses", def: EXPENSES, label: "Xarajatlar", id: (r) => s(r.id), refs: () => [] },
  { key: "leads", def: LEADS, label: "Lead'lar", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)]] },
  { key: "discounts", def: DISCOUNTS, label: "Chegirmalar", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)], ["enrollments", s(r.enrollmentId)]] },
  { key: "discountLines", def: DISCOUNT_LINES, label: "Chegirma qatorlari", id: (r) => `${s(r.enrollmentId)}|${s(r.month)}|${s(r.kind)}|${s(r.sourceId)}`, refs: (r) => [["students", s(r.studentId)], ["enrollments", s(r.enrollmentId)], ["charges", s(r.chargeId)]] },
  { key: "refunds", def: REFUNDS, label: "Qaytarishlar", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)], ["charges", s(r.chargeId)], ["payments", s(r.paymentId)]] },
  { key: "waitlist", def: WAITLIST, label: "Navbat", id: (r) => s(r.id), refs: (r) => [["groups", s(r.groupId)], ["students", s(r.studentId)]] },
  { key: "entitlements", def: ENTITLEMENTS, label: "Qoplash huquqlari", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)], ["groups", s(r.groupId)]] },
  { key: "scheduleChanges", def: SCHEDULE_CHANGES, label: "Dars o'zgarishlari", id: (r) => s(r.id), refs: (r) => [["groups", s(r.groupId)], ["teachers", s(r.substituteId)]] },
  { key: "referrals", def: REFERRALS, label: "Tavsiyalar", id: (r) => s(r.id), refs: (r) => [["students", s(r.referrerId)], ["students", s(r.invitedId)]] },
  { key: "promoUses", def: PROMO_USES, label: "Promo ishlatilishi", id: (r) => `${s(r.code)}|${s(r.studentId)}`, refs: (r) => [["students", s(r.studentId)], ["enrollments", s(r.enrollmentId)]] },
  { key: "marks", def: MARKS, label: "Baholar", id: (r) => `${s(r.scope)}|${s(r.date)}|${s(r.groupId)}|${s(r.studentId)}`, refs: (r) => [["students", s(r.studentId)], ["groups", s(r.groupId)]] },
  { key: "exams", def: EXAMS, label: "Imtihonlar", id: (r) => s(r.id), refs: (r) => [["groups", s(r.groupId)]] },
  { key: "examResults", def: EXAM_RESULTS, label: "Imtihon natijalari", id: (r) => `${s(r.examId)}|${s(r.studentId)}`, refs: (r) => [["exams", s(r.examId)], ["students", s(r.studentId)]] },
  { key: "reports", def: REPORTS, label: "Oylik hisobotlar", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)], ["groups", s(r.groupId)]] },
  { key: "certificates", def: CERTIFICATES, label: "Sertifikatlar", id: (r) => s(r.number), refs: (r) => [["students", s(r.studentId)], ["groups", s(r.groupId)], ["enrollments", s(r.enrollmentId)]] },
  { key: "rooms", def: ROOMS, label: "Xonalar", id: (r) => s(r.id), refs: () => [] },
  { key: "promos", def: PROMOS, label: "Promo kodlar", id: (r) => s(r.code), refs: () => [] },
  { key: "sourceCosts", def: SOURCE_COSTS, label: "Manba xarajatlari", id: (r) => `${s(r.source)}|${s(r.month)}`, refs: () => [] },
  { key: "cashCloses", def: CASH_CLOSES, label: "Kassa smenalari", id: (r) => s(r.id), refs: () => [] },
  { key: "guardianRequests", def: GUARDIAN_REQUESTS, label: "Vasiy so'rovlari", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)], ["groups", s(r.groupId)], ["entitlements", s(r.entitlementId)]] },
  { key: "guardianLinks", def: GUARDIAN_LINKS, label: "Vasiy ulanishlari", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)]] },
  { key: "teacherInvites", def: TEACHER_INVITES, label: "Ustoz taklifnomalari", id: (r) => s(r.id), refs: (r) => [["teachers", s(r.teacherId)]] },
  { key: "branches", def: BRANCHES, label: "Filiallar", id: (r) => s(r.id), refs: () => [] },
];
/** Tables without a Demo column: every row is real, so any of them pointing at a demo row blocks the removal. */
const REAL_ONLY: Spec[] = [
  { key: "drafts", def: DRAFTS, label: "Eslatmalar", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)]] },
  { key: "packages", def: PACKAGES, label: "Abonementlar", id: (r) => s(r.id), refs: (r) => [["students", s(r.studentId)], ["enrollments", s(r.enrollmentId)], ["charges", s(r.chargeId)]] },
  { key: "installments", def: INSTALLMENTS, label: "To'lov rejalari", id: (r) => `${s(r.chargeId)}#${s(r.seq)}`, refs: (r) => [["charges", s(r.chargeId)]] },
  { key: "documents", def: DOCUMENTS, label: "Hujjatlar", id: (r) => s(r.number), refs: (r) => [["students", s(r.studentId)], ["payments", s(r.paymentId)]] },
  { key: "leadLog", def: LEAD_LOG, label: "Lead aloqalari", id: (r) => `${s(r.leadId)}|${s(r.date)}|${s(r.summary)}`, refs: (r) => [["leads", s(r.leadId)]] },
];

export function hasDemoRows(): boolean {
  return SPECS.some((sp) => readIfPresent<Row>(sp.def).some(flagged));
}

export function demoCounts(): { label: string; count: number }[] {
  return SPECS.map((sp) => ({ label: sp.label, count: readIfPresent<Row>(sp.def).filter(flagged).length })).filter((c) => c.count > 0);
}

export function findBlockers(): { blockers: Blocker[]; labels: Map<string, string> } {
  const tables: DemoTable[] = [];
  for (const sp of SPECS) {
    tables.push({ table: sp.key, rows: readIfPresent<Row>(sp.def).map((r): DemoRow => ({ id: sp.id(r), demo: flagged(r), refs: sp.refs(r) })) });
  }
  for (const sp of REAL_ONLY) tables.push({ table: sp.key, rows: readIfPresent<Row>(sp.def).map((r): DemoRow => ({ id: sp.id(r), demo: false, refs: sp.refs(r) })) });
  return { blockers: demoBlockers(tables), labels: new Map([...SPECS, ...REAL_ONLY].map((sp) => [sp.key, sp.label])) };
}

/** Deletes the flagged rows of every table; throws, deleting nothing, when a real row references one. */
export function clearDemoData(): { deleted: { label: string; count: number }[] } {
  return withLock(() => {
    const { blockers, labels } = findBlockers();
    if (blockers.length) {
      const lines = blockers.slice(0, 10).map((b) => `  - ${labels.get(b.table) ?? b.table} ${b.id} -> ${labels.get(b.refTable) ?? b.refTable} ${b.refId} (demo)`);
      throw new Error(`Demo ma'lumotni tozalab bo'lmaydi: haqiqiy yozuvlar demo qatorlarga bog'langan (${blockers.length} ta):\n${lines.join("\n")}${blockers.length > 10 ? "\n  ..." : ""}\n\nAvval shu yozuvlarni o'chiring yoki boshqa qatorga o'tkazing.`);
    }
    const deleted = demoCounts();
    for (const sp of SPECS) if (SpreadsheetApp.getActive().getSheetByName(sp.def.sheet)) replaceWhere<Row>(sp.def, (r) => flagged(r), []);
    return { deleted };
  });
}

export const menu = {
  clear: (): void =>
    guard("Demo", () => {
      const ui = SpreadsheetApp.getUi();
      const counts = demoCounts();
      if (counts.length === 0) {
        ui.alert("Demo ma'lumot", "Demo belgili qator yo'q.", ui.ButtonSet.OK);
        return;
      }
      const list = counts.map((c) => `  - ${c.label}: ${c.count}`).join("\n");
      if (ui.alert("Demo ma'lumotni tozalash", `Faqat "Demo" belgili qatorlar o'chiriladi:\n${list}\n\nHaqiqiy qatorlarga tegilmaydi. Davom etamizmi?`, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
      const out = clearDemoData();
      ui.alert("Demo ma'lumot", `${out.deleted.reduce((n, c) => n + c.count, 0)} ta demo qator o'chirildi.`, ui.ButtonSet.OK);
    }),
};
