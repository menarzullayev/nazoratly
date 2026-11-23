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
