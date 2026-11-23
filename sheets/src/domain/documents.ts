/**
 * Document numbering and wording shared by both products. Pure; mirrored in Python
 * (backend/src/nazoratly/rules/documents.py) and checked against tests/golden/documents.json.
 */
export type DocumentKind = "receipt" | "invoice";

// The documents are the center's internal documents: no fiscal claim (no YaTT/MChJ yet).
export const FOOTER = "Ichki hujjat. Fiskal chek yoki soliq hisob-fakturasi emas.";
export const RECEIPT_TITLE = "KVITANSIYA";
export const INVOICE_TITLE = "TO'LOV HISOBI";

const PREFIX: Record<DocumentKind, string> = { receipt: "KV", invoice: "TH" };

export function documentNumber(kind: DocumentKind, year: number, serial: number): string {
  return `${PREFIX[kind]}-${year}-${String(serial).padStart(6, "0")}`;
}

/** Whole so'm, rounded half up, thousands separated by a space. */
export function formatSomExact(amount: number): string {
  const whole = amount < 0 ? -Math.floor(-amount + 0.5) : Math.floor(amount + 0.5);
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export interface DocLine {
  label: string;
  dueDate?: string; // ISO
  amount: number;
  overdue?: boolean;
}

/** Everything printed on a document; mirrors backend/src/nazoratly/documents.py (Snapshot). */
export interface DocSnapshot {
  kind: DocumentKind;
  number: string;
  issuedOn: string;
  centerName: string;
  requisites: string;
  studentName: string;
  payerName?: string;
  method?: string;
  paidOn?: string;
  lines: DocLine[];
  total: number;
  debtAfter?: number;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dmy = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const title = (k: DocumentKind): string => (k === "receipt" ? RECEIPT_TITLE : INVOICE_TITLE);

/** The HTML that Apps Script turns into the PDF. The footer says the document makes no fiscal claim. */
export function renderDocumentHtml(d: DocSnapshot): string {
  const withDue = d.kind === "invoice";
  const rows = d.lines
    .map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.label)}</td>${withDue ? `<td>${l.dueDate ? dmy(l.dueDate) : ""}${l.overdue ? " (muddati o'tgan)" : ""}</td>` : ""}<td class="r">${formatSomExact(l.amount)}</td></tr>`)
    .join("");
  const info = [`O'quvchi: <b>${esc(d.studentName)}</b>`];
  if (d.payerName) info.push(`To'lovchi: ${esc(d.payerName)}`);
  if (d.method && d.paidOn) info.push(`To'lov usuli: ${esc(d.method)}, sana: ${dmy(d.paidOn)}`);
  return (
    `<html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:12px;margin:24px}h1{font-size:20px;margin:14px 0 4px}` +
    `.c{font-size:17px;font-weight:bold}.s{color:#555;font-size:10px}table{border-collapse:collapse;width:100%;margin-top:12px}` +
    `td,th{border-bottom:1px solid #bbb;padding:4px;text-align:left}th{border-bottom:2px solid #000}.r{text-align:right}</style></head><body>` +
    `<div class="c">${esc(d.centerName)}</div>${d.requisites ? `<div class="s">${esc(d.requisites).replace(/\n/g, "<br>")}</div>` : ""}` +
    `<h1>${title(d.kind)} № ${esc(d.number)}</h1><div>Sana: ${dmy(d.issuedOn)}</div><p>${info.join("<br>")}</p>` +
    `<table><tr><th>№</th><th>Nomi</th>${withDue ? "<th>Muddat</th>" : ""}<th class="r">Summa, so'm</th></tr>${rows}</table>` +
    `<p class="r">Jami: <b>${formatSomExact(d.total)} so'm</b>${d.debtAfter && d.debtAfter > 0 ? `<br>Qolgan qarz: ${formatSomExact(d.debtAfter)} so'm` : ""}</p>` +
    `<p class="s" style="margin-top:36px">${esc(FOOTER)}</p></body></html>`
  );
}

/** [plain text, rich HTML] of the Telegram message that accompanies the PDF (same wording as the API product). */
export function deliveryText(d: DocSnapshot): [string, string] {
  const what = d.kind === "receipt" ? "kvitansiya" : "to'lov hisobi";
  const facts = [`O'quvchi: ${d.studentName}`, `Summa: ${formatSomExact(d.total)} so'm`];
  if (d.kind === "receipt" && d.method) facts.push(`To'lov usuli: ${d.method}`);
  if (d.debtAfter && d.debtAfter > 0) facts.push(`Qolgan qarz: ${formatSomExact(d.debtAfter)} so'm`);
  if (d.kind === "invoice") {
    const due = d.lines.map((l) => l.dueDate).filter((x): x is string => !!x).sort();
    if (due.length) facts.push(`Eng yaqin muddat: ${dmy(due[0]!)}`);
  }
  const head = `${d.centerName}: ${what} ${d.number}`;
  return [
    [head, ...facts, "PDF hujjat ilova qilingan.", FOOTER].join("\n"),
    `<b>${esc(head)}</b><br>${facts.map(esc).join("<br>")}<br><br>PDF hujjat ilova qilingan.<br><i>${esc(FOOTER)}</i>`,
  ];
}
