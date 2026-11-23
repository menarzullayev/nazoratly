import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOOTER } from "../src/domain/documents";
import * as docs from "../src/gas/documents";
import { append, read } from "../src/gas/repo";
import { CHARGES, DOCUMENTS, INSTALLMENTS, PAYMENTS, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;
type Row = { number: string; kind: string; issuedOn: string; studentId: string; paymentId: string; amount: number; link: string; sentOn: string };
const register = () => read<Row>(DOCUMENTS);
const methods = () => h.fetches.map((f) => f.body._method);

function setSetting(label: string, value: string): void {
  const row = h.sheets.get("Sozlamalar")!.data.find((r) => r[0] === label);
  if (!row) throw new Error(`no setting ${label}`);
  row[1] = value;
}
function student(over: Record<string, unknown> = {}): void {
  append(STUDENTS, [{ id: "S0001", fullName: "Ali Valiyev", status: "active", phone: "", guardianName: "Dilnoza", guardianChatId: "555", consentNotify: true, ...over }]);
}
const charge = (id: string, amount: number, dueDate: string) => append(CHARGES, [{ id, studentId: "S0001", enrollmentId: "E1", month: "2026-10-01", amount, dueDate, voided: false, note: "" }]);
const pay = (id: string, amount: number, voided = false) => append(PAYMENTS, [{ id, studentId: "S0001", paidOn: "2026-11-20", amount, method: "Naqd", note: "", voided }]);
const html = (n: string) => [...h.drive.values()].find((f) => f.name === `${n}.pdf`)!.content;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
  setSetting("Markaz nomi", "Bilim Plus");
  setSetting("Markaz rekvizitlari (hujjatlarda)", "Toshkent, Chilonzor 9\nTel: +998 90 123 45 67");
});
afterEach(() => vi.useRealTimers());

describe("issuing documents", () => {
  it("a receipt carries the center, its requisites, the number, the amount and the no-fiscal footer; one per payment", () => {
    student();
    charge("C0001", 600_000, "2026-10-10");
    pay("P0001", 150_000);
    expect(docs.issueReceipt("P0001")).toBe("KV-2026-000001");
    expect(docs.issueReceipt("P0001")).toBe("KV-2026-000001");
    expect(register()).toHaveLength(1);
    expect(h.drive.size).toBe(1);
    const text = html("KV-2026-000001");
    for (const needle of ["Bilim Plus", "Toshkent, Chilonzor 9", "+998 90 123 45 67", "KVITANSIYA", "KV-2026-000001", "Ali Valiyev", "150 000", "Qolgan qarz: 450 000", FOOTER]) expect(text).toContain(needle);
    expect(text).not.toMatch(/QQS|STIR/);
    const row = register()[0]!;
    expect([row.kind, row.paymentId, row.amount, row.sentOn]).toEqual(["receipt", "P0001", 150_000, ""]);
    expect(row.link).toMatch(/drive\.google\.com\/file\/d\/FILE1/);
    expect(h.fetches).toHaveLength(0); // issuing never sends
  });

  it("numbers count per kind, a voided or unknown payment is refused", () => {
    student();
    charge("C0001", 600_000, "2026-10-10");
    pay("P0001", 100_000);
    pay("P0002", 50_000);
    pay("P0003", 10_000, true);
    expect(docs.issueReceipt("P0001")).toBe("KV-2026-000001");
    expect(docs.issueReceipt("P0002")).toBe("KV-2026-000002");
    expect(docs.issueInvoice("S0001")).toBe("TH-2026-000001");
    expect(() => docs.issueReceipt("P0003")).toThrow("Bekor qilingan");
    expect(() => docs.issueReceipt("P0099")).toThrow("topilmadi");
  });

  it("an invoice lists the open installments with their numbers and due dates; nothing owed is refused", () => {
    student();
    expect(() => docs.issueInvoice("S0001")).toThrow("qarzi yo'q");
    charge("C0001", 900_000, "2026-09-21");
    append(INSTALLMENTS, [[300_000, "2026-09-21"], [300_000, "2026-10-21"], [300_000, "2026-12-21"]].map(([amount, dueDate], i) => ({ chargeId: "C0001", seq: i + 1, dueDate, amount })));
    charge("C0002", 200_000, "2026-11-30");
    pay("P0001", 450_000);
    const n = docs.issueInvoice("S0001");
    const text = html(n);
    for (const needle of ["TO'LOV HISOBI", "2/3-to'lov", "3/3-to'lov", "21.10.2026", "21.12.2026", "30.11.2026", "(muddati o'tgan)", "650 000", FOOTER]) expect(text).toContain(needle);
    expect(text).not.toContain("1/3-to'lov"); // already paid
    expect(register()[0]!.amount).toBe(650_000);
  });

  it("Cyrillic and Uzbek apostrophes survive into the document", () => {
    student({ fullName: "Ғуломов Жасур Oʻktam oʻgʻli" });
    charge("C0001", 100_000, "2026-11-01");
    expect(html(docs.issueInvoice("S0001"))).toContain("Ғуломов Жасур Oʻktam oʻgʻli");
  });
});

describe("sending to the guardian", () => {
  function ready(): string {
    student();
    charge("C0001", 600_000, "2026-10-10");
    pay("P0001", 150_000);
    h.props.set("TELEGRAM_BOT_TOKEN", "123:TOKEN");
    return docs.issueReceipt("P0001");
  }

  it("after a confirmed dialog sends the rich text first, then the PDF, and records the date", () => {
    const n = ready();
    docs.sendDocumentToGuardian(n);
    expect(methods()).toEqual(["sendRichMessage", "sendDocument"]);
    expect(h.alerts.at(-1)!.message).toContain("Yuboraylikmi");
    const rich = (h.fetches[0]!.body.rich_message as { html: string }).html;
    expect(rich).toContain(n);
    expect(rich).toContain(FOOTER);
    const up = h.fetches[1]!.body;
    expect([up.chat_id, (up.document as { _blob: string })._blob]).toEqual(["555", `${n}.pdf`]);
    expect(register()[0]!.sentOn).toBe("2026-11-23");
  });

  it("declining the dialog sends nothing", () => {
    const n = ready();
    h.answers.push("NO");
    expect(() => docs.sendDocumentToGuardian(n)).toThrow("Bekor qilindi");
    expect(h.fetches).toHaveLength(0);
    expect(register()[0]!.sentOn).toBe("");
  });

  it("is refused without a token, without consent or without a linked chat", () => {
    const n = ready();
    h.props.delete("TELEGRAM_BOT_TOKEN");
    expect(() => docs.sendDocumentToGuardian(n)).toThrow("Telegram botni sozlang");
    h.props.set("TELEGRAM_BOT_TOKEN", "123:TOKEN");
    h.sheets.get(STUDENTS.sheet)!.data[1]![6] = "Yo'q"; // consent column
    expect(() => docs.sendDocumentToGuardian(n)).toThrow("rozilik");
    h.sheets.get(STUDENTS.sheet)!.data[1]![6] = "Ha";
    h.sheets.get(STUDENTS.sheet)!.data[1]![5] = "";
    expect(() => docs.sendDocumentToGuardian(n)).toThrow("ulanmagan");
    expect(h.fetches).toHaveLength(0);
  });

  it("a failed PDF upload is reported and the date stays empty", () => {
    const n = ready();
    h.telegram.handler = (method) => (method === "sendDocument" ? { status: 502, body: { ok: false, description: "bad gateway" } } : { status: 200, body: { ok: true } });
    expect(() => docs.sendDocumentToGuardian(n)).toThrow("PDF yuborilmadi");
    expect(register()[0]!.sentOn).toBe("");
  });

  it("warns when the document was already sent", () => {
    const n = ready();
    docs.sendDocumentToGuardian(n);
    docs.sendDocumentToGuardian(n);
    expect(h.alerts.at(-1)!.message).toContain("allaqachon yuborilgan");
  });
});
