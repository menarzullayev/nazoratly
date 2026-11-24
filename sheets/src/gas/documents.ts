/** Receipt and invoice PDFs. Documents are the center's INTERNAL documents (no fiscal claim). Numbering and wording live
 * in ../domain/documents (shared golden cases with the API product); this file moves data and talks to Drive/Telegram.
 * Nothing is sent to a guardian unless a person confirms it in the dialog of `sendDocumentToGuardian`. */
import { computeDebts } from "../domain/debt";
import { documentNumber, deliveryText, renderDocumentHtml, type DocLine, type DocSnapshot, type DocumentKind } from "../domain/documents";
import { installmentBalances, validatePlan } from "../domain/installments";
import type { Refund, Charge, Installment, Payment, Student } from "../domain/types";
import { guard, withLock } from "./actions";
import { pickId } from "./pick";
import { append, read, readIfPresent, today, updateById } from "./repo";
import { REFUNDS, CHARGES, DOCUMENTS, INSTALLMENTS, PAYMENTS, STUDENTS } from "./schema";
import { readSettings } from "./settings";
import { getToken, props, sendDocument, sendRich } from "./telegram";

const FOLDER = "nazoratly hujjatlari";
const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();
const KIND_LABEL: Record<string, string> = { tuition: "O'qish haqi" };

interface DocRow {
  number: string;
  kind: DocumentKind;
  issuedOn: string;
  studentId: string;
  paymentId: string;
  amount: number;
  link: string;
  sentOn: string;
}

/** Next serial per kind and calendar year, kept in Script Properties (callers hold the script lock). */
function nextSerial(kind: DocumentKind, year: number): number {
  const key = `DOC_SERIAL_${kind}_${year}`;
  const next = Number(props().getProperty(key) ?? "0") + 1;
  props().setProperty(key, String(next));
  return next;
}

function folder(): GoogleAppsScript.Drive.Folder {
  const found = DriveApp.getFoldersByName(FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER);
}

function store(snap: DocSnapshot, studentId: string, paymentId: string): DocRow {
  const html = renderDocumentHtml(snap);
  const pdf = Utilities.newBlob(html, "text/html", `${snap.number}.html`).getAs("application/pdf").setName(`${snap.number}.pdf`);
  const file = folder().createFile(pdf);
  const row: DocRow = { number: snap.number, kind: snap.kind, issuedOn: snap.issuedOn, studentId, paymentId, amount: snap.total, link: file.getUrl(), sentOn: "" };
  append(DOCUMENTS, [row]);
  return row;
}

function snapshotOf(row: DocRow, students: Map<string, Student>): DocSnapshot {
  // the register keeps the PDF; the Telegram text is rebuilt from the register row and the student
  const s = students.get(row.studentId);
  return { kind: row.kind, number: row.number, issuedOn: row.issuedOn, centerName: readSettings().center, requisites: "", studentName: s?.fullName ?? row.studentId, lines: [], total: row.amount };
}

export function issueReceipt(paymentId?: string): string {
  const id = pickId(paymentId, PAYMENTS.sheet, "Kvitansiya: to'lovni tanlang");
  return withLock(() => {
    const payment = read<Payment>(PAYMENTS).find((p) => p.id === id);
    if (!payment) throw new Error(`To'lov topilmadi: ${id}`);
    if (payment.voided) throw new Error("Bekor qilingan to'lovga kvitansiya berilmaydi.");
    const prev = read<DocRow>(DOCUMENTS).find((d) => d.kind === "receipt" && d.paymentId === id);
    if (prev) return prev.number; // one receipt per payment
    const student = read<Student>(STUDENTS).find((s) => s.id === payment.studentId);
    const charges = read<Charge>(CHARGES);
    const debt = computeDebts(charges, read<Payment>(PAYMENTS), today(), readIfPresent<Installment>(INSTALLMENTS), readIfPresent<Refund>(REFUNDS)).students.find((d) => d.studentId === payment.studentId);
    const s = readSettings();
    const t = today();
    const snap: DocSnapshot = {
      kind: "receipt", number: documentNumber("receipt", Number(t.slice(0, 4)), nextSerial("receipt", Number(t.slice(0, 4)))), issuedOn: t,
      centerName: s.center, requisites: s.requisites, studentName: student?.fullName ?? payment.studentId, method: payment.method, paidOn: payment.paidOn,
      lines: [{ label: `To'lov (${payment.method})`, amount: payment.amount }], total: payment.amount, debtAfter: debt?.outstanding ?? 0,
    };
    return store(snap, payment.studentId, id).number;
  });
}

export function issueInvoice(studentId?: string): string {
  const id = pickId(studentId, STUDENTS.sheet, "To'lov hisobi: o'quvchini tanlang");
  return withLock(() => {
    const student = read<Student>(STUDENTS).find((s) => s.id === id);
    if (!student) throw new Error(`O'quvchi topilmadi: ${id}`);
    const t = today();
    const charges = read<Charge>(CHARGES);
    const installments = readIfPresent<Installment>(INSTALLMENTS);
    const { balances } = computeDebts(charges, read<Payment>(PAYMENTS), t, installments, readIfPresent<Refund>(REFUNDS));
    const lines: DocLine[] = [];
    for (const b of balances.filter((x) => x.studentId === id && x.outstanding > 0).sort((a, c) => (a.dueDate < c.dueDate ? -1 : 1))) {
      const name = `${KIND_LABEL.tuition} ${b.month.slice(0, 7)}`;
      const plan = installments.filter((i) => i.chargeId === b.id).sort((x, y) => x.seq - y.seq);
      if (plan.length && validatePlan(b.amount, plan) === null) {
        installmentBalances(plan, b.paid, t).forEach((r, k) => {
          if (r.outstanding > 0) lines.push({ label: `${name}, ${k + 1}/${plan.length}-to'lov`, dueDate: r.dueDate, amount: r.outstanding, overdue: r.overdue });
        });
      } else lines.push({ label: name, dueDate: b.dueDate, amount: b.outstanding, overdue: b.dueDate < t });
    }
    if (lines.length === 0) throw new Error("O'quvchining qarzi yo'q: to'lov hisobi kerak emas.");
    const s = readSettings();
    const year = Number(t.slice(0, 4));
    const snap: DocSnapshot = {
      kind: "invoice", number: documentNumber("invoice", year, nextSerial("invoice", year)), issuedOn: t, centerName: s.center, requisites: s.requisites,
      studentName: student.fullName, lines, total: lines.reduce((n, l) => n + l.amount, 0),
    };
    return store(snap, id, "").number;
  });
}

/** Rich text + PDF to the guardian's Telegram, only after the person confirms the dialog. */
export function sendDocumentToGuardian(number?: string): void {
  const id = pickId(number, DOCUMENTS.sheet, "Hujjatni vasiyga yuborish");
  const msg = withLock(() => {
    if (!getToken()) throw new Error("Avval Telegram botni sozlang: nazoratly > Telegram sozlash.");
    const row = read<DocRow>(DOCUMENTS).find((d) => d.number === id);
    if (!row) throw new Error(`Hujjat topilmadi: ${id}`);
    const students = new Map(read<Student>(STUDENTS).map((s) => [s.id, s]));
    const student = students.get(row.studentId);
    if (!student) throw new Error("O'quvchi topilmadi.");
    if (!student.consentNotify) throw new Error("Vasiy Telegram xabarlariga rozilik bermagan.");
    if (!student.guardianChatId) throw new Error("Vasiy Telegram botga ulanmagan.");
    const ans = ui().alert("Hujjatni yuborish", `${row.number} (${row.amount} so'm) ${student.guardianName || "vasiy"} ga (o'quvchi: ${student.fullName}) Telegramda yuboriladi${row.sentOn ? `\n\nDiqqat: bu hujjat ${row.sentOn} da allaqachon yuborilgan.` : ""}\n\nYuboraylikmi?`, ui().ButtonSet.YES_NO);
    if (ans !== ui().Button.YES) throw new Error("Bekor qilindi.");
    const fileId = /\/d\/([\w-]+)/.exec(row.link)?.[1];
    if (!fileId) throw new Error("PDF havolasi noto'g'ri.");
    const [plain, rich] = deliveryText(snapshotOf(row, students));
    void plain;
    const text = sendRich(student.guardianChatId, rich);
    if (!text.ok) throw new Error(`Telegram xatosi: ${text.description ?? "noma'lum"}`);
    const doc = sendDocument(student.guardianChatId, DriveApp.getFileById(fileId).getBlob());
    if (!doc.ok) throw new Error(`Xabar yuborildi, lekin PDF yuborilmadi: ${doc.description ?? "noma'lum xato"}. Qayta yuborsangiz xabar takrorlanadi.`);
    updateById(DOCUMENTS, "number", row.number, { sentOn: today() });
    return `${row.number} vasiyga yuborildi.`;
  });
  SpreadsheetApp.getActive().toast(msg, "nazoratly", 8);
}

export const menu = {
  receipt: (): void => guard("Kvitansiya", () => ui().alert("Kvitansiya", `Hujjat raqami: ${issueReceipt()}. PDF "${FOLDER}" papkasida, havola "Hujjatlar" varag'ida.`, ui().ButtonSet.OK)),
  invoice: (): void => guard("To'lov hisobi", () => ui().alert("To'lov hisobi", `Hujjat raqami: ${issueInvoice()}. PDF "${FOLDER}" papkasida, havola "Hujjatlar" varag'ida.`, ui().ButtonSet.OK)),
  send: (): void => guard("Hujjat", () => sendDocumentToGuardian()),
};
