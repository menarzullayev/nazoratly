/** Telegram rich messages (Bot API 10.1+: sendRichMessage with HTML, tables, <tg-button>, <tg-time>). Pure builders. */
import { formatSom } from "./reminders";
import type { ISODate } from "./types";

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `<tg-time>` renders the date in the reader's own language and time zone. Noon in Tashkent (UTC+5) avoids day shifts. */
export function tgTime(date: ISODate, format = "D"): string {
  const unix = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), 7) / 1000;
  return `<tg-time unix="${unix}" format="${format}">${date}</tg-time>`;
}

export interface OpenCharge {
  month: ISODate;
  dueDate: ISODate;
  outstanding: number;
}

export function chargesTable(charges: OpenCharge[]): string {
  if (!charges.length) return "";
  const rows = charges
    .map((c) => `<tr><td>${esc(c.month.slice(0, 7))}</td><td align="right">${formatSom(c.outstanding)}</td><td>${tgTime(c.dueDate)}</td></tr>`)
    .join("");
  return `<table striped compact><tr><th>Oy</th><th>Qoldiq (so'm)</th><th>Muddat</th></tr>${rows}</table>`;
}

function buttons(rows: { type: "copy_text" | "callback_data"; label: string; value: string; style?: "success" | "primary" | "danger" | "link" }[]): string {
  if (!rows.length) return "";
  const b = rows
    .map((r) => {
      const attr = r.type === "copy_text" ? `text="${esc(r.value.slice(0, 256))}"` : `data="${esc(r.value.slice(0, 64))}"`;
      return `<tg-button type="${r.type}" ${r.style ? `style="${r.style}" ` : ""}${attr}>${esc(r.label)}</tg-button>`;
    })
    .join("");
  return `<tg-button-row align="center">${b}</tg-button-row>`;
}

export interface ReminderInput {
  text: string; // the human-approved text of the draft
  studentId: string;
  charges: OpenCharge[];
  payInfo: string; // card/requisites to copy; "" hides the button
}

/** Approved draft text + a table of what is owed + one-tap actions. */
export function reminderRich(i: ReminderInput): string {
  const total = i.charges.reduce((s, c) => s + c.outstanding, 0);
  const body = i.text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const sum = total > 0 ? `<p><b>Jami qoldiq: ${formatSom(total)} so'm</b></p>` : "";
  return (
    body +
    chargesTable(i.charges) +
    sum +
    buttons([
      ...(i.payInfo ? [{ type: "copy_text" as const, label: "Rekvizitlarni nusxalash", value: i.payInfo, style: "primary" as const }] : []),
      { type: "callback_data", label: "To'lov qildim", value: `p:${i.studentId}`, style: "success" },
    ])
  );
}

export function receiptRich(i: { center: string; student: string; amount: number; paidOn: ISODate; method: string; outstanding: number; charges: OpenCharge[] }): string {
  const done = i.outstanding <= 0;
  return (
    `<h3>${done ? "✅" : "💳"} To'lov qabul qilindi</h3>` +
    `<table compact><tr><td>O'quvchi</td><td>${esc(i.student)}</td></tr><tr><td>Summa</td><td><b>${formatSom(i.amount)} so'm</b></td></tr>` +
    `<tr><td>Sana</td><td>${tgTime(i.paidOn)}</td></tr><tr><td>Usul</td><td>${esc(i.method)}</td></tr></table>` +
    (done ? "<p>Qarz yo'q. Rahmat!</p>" : `<p>Qoldiq: <b>${formatSom(i.outstanding)} so'm</b></p>${chargesTable(i.charges)}`) +
    `<p><i>${esc(i.center)}</i></p>`
  );
}

export function balanceRich(i: { center: string; students: { name: string; outstanding: number; overdue: number; credit: number; charges: OpenCharge[] }[]; payInfo: string }): string {
  if (!i.students.length) return "<p>Sizga ulangan o'quvchi topilmadi.</p>";
  const parts = i.students.map(
    (s) =>
      `<h3>${esc(s.name)}</h3>` +
      (s.outstanding > 0
        ? `<p>Qoldiq: <b>${formatSom(s.outstanding)} so'm</b>${s.overdue > 0 ? ` (muddati o'tgan: ${formatSom(s.overdue)})` : ""}</p>${chargesTable(s.charges)}`
        : `<p>Qarz yo'q ✅${s.credit > 0 ? ` (kredit: ${formatSom(s.credit)} so'm)` : ""}</p>`),
  );
  return parts.join("") + buttons(i.payInfo ? [{ type: "copy_text", label: "Rekvizitlarni nusxalash", value: i.payInfo, style: "primary" }] : []) + `<p><i>${esc(i.center)}</i></p>`;
}

/** Plain-text fallback for clients/bots where rich messages are unavailable. */
export function stripHtml(html: string): string {
  return html
    .replace(/<\/(p|h3|tr|table|tg-button-row)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/t[dh]>/g, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/[ \t]*\|[ \t]*\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const EFFECT_PARTY = "5046509860389126442"; // 🎉 message effect (private chats)
