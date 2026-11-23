import { beforeEach, describe, expect, it } from "vitest";
import * as actions from "../src/gas/actions";
import { read, updateById } from "../src/gas/repo";
import { ATTENDANCE, CHARGES, DASHBOARD_SHEET, DEBTORS_SHEET, DRAFTS, PAYMENTS, PAYROLL, STUDENTS, ALL_TABLES } from "../src/gas/schema";
import { loadSampleData, setupWorkbook } from "../src/gas/setup";
import { webhookSecret } from "../src/gas/telegram";
import { handlePost } from "../src/gas/webhook";
import type { AttendanceRow, Charge, Payment, ReminderDraft, Student } from "../src/domain/types";
import { installHarness, type Harness } from "./harness";

type StudentRow = Student & { linkCode?: string; consentDate?: string };
let h: Harness;

beforeEach(() => {
  h = installHarness();
  setupWorkbook();
});

const student = (id: string) => read<StudentRow>(STUDENTS).find((s) => s.id === id)!;
const lastAlert = () => h.alerts[h.alerts.length - 1]!.message;

function post(update: unknown, secret = webhookSecret()) {
  return handlePost({ parameter: { s: secret }, postData: { contents: JSON.stringify(update), type: "application/json" } } as never);
}
const sent = () => h.fetches.filter((f) => f.body._method === "sendMessage");

/** Full guardian flow: code -> /start -> "Roziman" button. */
function linkGuardian(id: string, chatId: number): void {
  h.props.set("BOT_USERNAME", "demo_bot");
  actions.generateLinkCodes();
  const code = student(id).linkCode!;
  post({ message: { text: `/start ${code}`, chat: { id: chatId, type: "private" } } });
  post({ callback_query: { id: "cb", data: `y:${code}`, message: { message_id: 1, chat: { id: chatId, type: "private" } } } });
}

describe("workbook setup", () => {
  it("creates every sheet with its headers, and is safe to run twice", () => {
    for (const t of ALL_TABLES) expect(h.rows(t.sheet)[0]).toEqual(t.cols.map((c) => c.header));
    expect(h.rows("Sozlamalar")).toHaveLength(1 + 6);
    setupWorkbook();
    expect(h.rows("O'quvchilar")[0]).toContain("Telegram chat ID");
  });

  it("loads demo data once and refuses to mix it into real data", () => {
    expect(loadSampleData()).toContain("8 o'quvchi");
    expect(read<StudentRow>(STUDENTS)).toHaveLength(8);
    expect(() => loadSampleData()).toThrow(/bo'sh emas/);
  });
});

describe("with demo data", () => {
  beforeEach(() => loadSampleData());

  it("debtors report and dashboard reflect the FIFO balances", () => {
    actions.refreshDebtors();
    const rows = h.rows(DEBTORS_SHEET).slice(1);
    expect(rows.map((r) => [r[0], r[5]])).toEqual([["S0005", 1_800_000], ["S0002", 800_000], ["S0006", 400_000]]);
    actions.refreshDashboard();
    const dash = h.sheet(DASHBOARD_SHEET);
    expect(dash.getRange(5, 1).getValue()).toBe(8); // active students
    expect(dash.getRange(5, 4).getValue()).toBe(3_000_000); // outstanding
  });

  it("monthly charges are idempotent and write real dates", () => {
    h.prompts.push("2026-04");
    actions.generateMonthlyCharges();
    expect(lastAlert()).toContain("8 ta yangi hisob");
    const april = read<Charge>(CHARGES).filter((c) => c.month === "2026-04-01");
    expect(april).toHaveLength(8);
    expect(april.every((c) => c.dueDate === "2026-04-10")).toBe(true);
    expect(new Set(read<Charge>(CHARGES).map((c) => c.id)).size).toBe(read<Charge>(CHARGES).length);
    h.prompts.push("2026-04");
    actions.generateMonthlyCharges();
    expect(lastAlert()).toContain("0 ta yangi hisob");
    expect(lastAlert()).toContain("Avval yaratilgan: 8");
    h.prompts.push("2026-4x");
    expect(() => actions.generateMonthlyCharges()).toThrow(/Noto'g'ri oy/);
  });

  it("attendance: roster, validation, upsert without duplicates", () => {
    expect(actions.getAttendanceGroups().map((g) => g.id)).toEqual(["G0001", "G0002"]);
    const roster = actions.getRoster("G0001", "2026-03-16");
    expect(roster.map((r) => r.studentId)).toEqual(["S0005", "S0001", "S0003", "S0007"].sort((a, b) => roster.find((r) => r.studentId === a)!.fullName.localeCompare(roster.find((r) => r.studentId === b)!.fullName)));
    expect(roster.every((r) => r.status === "")).toBe(true);
    const marks = roster.map((r, i) => ({ studentId: r.studentId, status: (i === 0 ? "late" : "present") as AttendanceRow["status"], minutesLate: i === 0 ? 12 : 0 }));
    expect(actions.saveAttendance({ date: "2026-03-16", groupId: "G0001", marks }).saved).toBe(4);
    expect(read<AttendanceRow>(ATTENDANCE).filter((a) => a.date === "2026-03-16")).toHaveLength(4);
    marks[1]!.status = "absent";
    actions.saveAttendance({ date: "2026-03-16", groupId: "G0001", marks });
    const saved = read<AttendanceRow>(ATTENDANCE).filter((a) => a.date === "2026-03-16");
    expect(saved).toHaveLength(4); // replaced, not appended
    expect(saved.filter((a) => a.status === "absent")).toHaveLength(1);
    expect(actions.getRoster("G0001", "2026-03-16").find((r) => r.status === "late")!.minutesLate).toBe(12);
    // other groups' and other days' rows are untouched
    expect(read<AttendanceRow>(ATTENDANCE).filter((a) => a.date === "2026-03-02")).toHaveLength(8);
    // negative cases
    expect(() => actions.saveAttendance({ date: "2026-03-16", groupId: "G0001", marks: [{ studentId: "S0002", status: "present", minutesLate: 0 }] })).toThrow(/ro'yxatida yo'q/);
    expect(() => actions.saveAttendance({ date: "2026-03-16", groupId: "G0001", marks: [{ studentId: "S0001", status: "present", minutesLate: 5 }] })).toThrow(/faqat/);
    expect(() => actions.saveAttendance({ date: "2026-03-16", groupId: "G0001", marks: [marks[0]!, marks[0]!] })).toThrow(/ikki marta/);
    expect(() => actions.saveAttendance({ date: "16.03.2026", groupId: "G0001", marks: [] })).toThrow(/Sana/);
    expect(() => actions.saveAttendance({ date: "2026-03-16", groupId: "G9999", marks: [] })).toThrow(/Guruh/);
    expect(() => actions.getRoster("G0001", "nope")).toThrow();
  });

  it("payments: validation, balance, FIFO effect and optional Telegram receipt", () => {
    const base = { studentId: "S0005", method: "Naqd", paidOn: "2026-11-20", note: "", notifyGuardian: false };
    for (const amount of [0, -5, 1.5, 2_000_000_000]) expect(() => actions.recordPayment({ ...base, amount })).toThrow(/Summa/);
    expect(() => actions.recordPayment({ ...base, amount: 1000, paidOn: "bad" })).toThrow(/Sana/);
    expect(() => actions.recordPayment({ ...base, studentId: "S9999", amount: 1000 })).toThrow(/topilmadi/);
    expect(actions.searchStudents("bobur").map((s) => s.id)).toEqual(["S0005"]);
    expect(actions.searchStudents("s0002").map((s) => s.id)).toEqual(["S0002"]);

    const before = actions.getBalance("S0005");
    expect(before.outstanding).toBe(1_800_000);
    const r = actions.recordPayment({ ...base, amount: 600_000 });
    expect(r.balance.outstanding).toBe(1_200_000);
    expect(read<Payment>(PAYMENTS).some((p) => p.id === r.id && p.amount === 600_000 && p.paidOn === "2026-11-20")).toBe(true);
    expect(r.telegram).toBe("");
    expect(actions.recordPayment({ ...base, amount: 100_000, notifyGuardian: true }).telegram).toContain("yuborilmadi"); // no consent yet
    expect(sent()).toHaveLength(0);

    h.props.set("TELEGRAM_BOT_TOKEN", "123456:TEST-TOKEN-TEST-TOKEN-TEST-TOKEN-12");
    linkGuardian("S0005", 7001);
    const n = sent().length;
    const paid = actions.recordPayment({ ...base, amount: 100_000, notifyGuardian: true });
    expect(paid.telegram).toBe("Vasiyga chek yuborildi");
    const msg = sent()[sent().length - 1]!;
    expect(sent().length).toBe(n + 1);
    expect(msg.body.chat_id).toBe("7001");
    expect(String(msg.body.text)).toContain("100 000 so'm");
    expect(String(msg.body.text)).toContain("Qoldiq: 1 000 000");
  });

  it("payroll: lessons and percent, bonus survives recalculation, approved rows are frozen", () => {
    h.prompts.push("2026-03");
    actions.calculatePayroll();
    const get = () => h.rows(PAYROLL).slice(1).map((r) => ({ month: r[0], teacher: r[1], lessons: r[3], collected: r[4], bonus: r[5], total: r[6], status: r[7] }));
    const [t1, t2] = get();
    expect(t1).toMatchObject({ teacher: "T0001", lessons: 3, bonus: 0, total: 270_000, status: "Qoralama" });
    expect(t2!.teacher).toBe("T0002");
    expect(t2!.total).toBe(Math.round(Number(t2!.collected) * 0.4));
    expect(Number(t2!.collected)).toBeGreaterThan(0);

    const row = h.rows(PAYROLL).findIndex((r) => r[1] === "T0001"); // 0-based row in sheet = row-1
    h.sheet(PAYROLL).getRange(row + 1, 6).setValue(-20_000); // penalty typed by hand
    h.prompts.push("2026-03");
    actions.calculatePayroll();
    expect(get()[0]).toMatchObject({ bonus: -20_000, total: 250_000 });

    h.sheet(PAYROLL).getRange(row + 1, 8).setValue("Tasdiqlangan");
    h.sheet(PAYROLL).getRange(row + 1, 7).setValue(111);
    h.prompts.push("2026-03");
    actions.calculatePayroll();
    expect(lastAlert()).toContain("(o'zgartirilmadi): 1");
    expect(get().find((r) => r.teacher === "T0001")).toMatchObject({ total: 111, status: "Tasdiqlangan" });
    expect(get().filter((r) => r.teacher === "T0001")).toHaveLength(1);
  });
});

describe("Telegram reminders and guardian consent (Model B)", () => {
  beforeEach(() => {
    loadSampleData();
    h.props.set("TELEGRAM_BOT_TOKEN", "123456:TEST-TOKEN-TEST-TOKEN-TEST-TOKEN-12");
  });

  it("no consent, no draft: debtors without a linked chat are skipped with a reason", () => {
    actions.createReminderDrafts();
    expect(lastAlert()).toContain("0 ta eslatma loyihasi");
    expect(lastAlert()).toContain("3 ta: roziligi yo'q");
    expect(read<ReminderDraft>(DRAFTS)).toHaveLength(0);
  });

  it("link requires explicit consent; wrong secret and replayed codes do nothing", () => {
    h.props.set("BOT_USERNAME", "demo_bot");
    actions.generateLinkCodes();
    const s = student("S0005");
    expect(s.linkCode).toMatch(/^[A-Z0-9]{10}$/);
    expect(h.rows("O'quvchilar").some((row) => row.includes(`https://t.me/demo_bot?start=${s.linkCode}`))).toBe(true);

    post({ message: { text: `/start ${s.linkCode}`, chat: { id: 9, type: "private" } } }, "wrong-secret");
    expect(sent()).toHaveLength(0); // wrong secret: ignored entirely
    post({ message: { text: `/start ${s.linkCode}`, chat: { id: 9, type: "private" } } });
    expect(String(sent()[0]!.body.text)).toContain("rozilik");
    expect(student("S0005").consentNotify).toBe(false); // asking is not consenting
    post({ callback_query: { id: "c", data: "n", message: { message_id: 2, chat: { id: 9, type: "private" } } } });
    expect(student("S0005").guardianChatId).toBe("");

    post({ callback_query: { id: "c", data: `y:${s.linkCode}`, message: { message_id: 2, chat: { id: 9, type: "private" } } } });
    const linked = student("S0005");
    expect(linked).toMatchObject({ guardianChatId: "9", consentNotify: true, linkCode: "" });
    expect(linked.consentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    post({ callback_query: { id: "c", data: `y:${s.linkCode}`, message: { message_id: 3, chat: { id: 77, type: "private" } } } }); // replay from another chat
    expect(student("S0005").guardianChatId).toBe("9");
    post({ message: { text: "/start BADCODE12", chat: { id: 5, type: "private" } } });
    expect(String(sent()[sent().length - 1]!.body.text)).toContain("rasmiy boti"); // unknown code reveals nothing
  });

  it("draft -> human approval (with edit) -> send, and /stop blocks sending", () => {
    linkGuardian("S0005", 7001);
    linkGuardian("S0002", 7002);
    actions.createReminderDrafts();
    expect(lastAlert()).toContain("2 ta eslatma loyihasi");
    expect(lastAlert()).toContain("1 ta: roziligi yo'q"); // S0006 never linked
    const pending = actions.getPendingDrafts();
    expect(pending.map((d) => d.studentName).sort()).toEqual(["Bobur Saidov", "Madina Tursunova"]);
    expect(pending.find((d) => d.studentName === "Bobur Saidov")!.overdue).toBe(1_800_000);
    const before = sent().length;
    actions.sendApprovedReminders();
    expect(sent().length).toBe(before); // drafts alone send nothing

    // second run within the cooldown does not duplicate
    actions.createReminderDrafts();
    expect(lastAlert()).toContain("0 ta eslatma loyihasi");
    expect(read<ReminderDraft>(DRAFTS)).toHaveLength(2);

    const [a, b] = pending;
    const aStudent = read<ReminderDraft>(DRAFTS).find((d) => d.id === a!.id)!.studentId;
    expect(actions.decideDrafts({ approve: [a!.id, b!.id], reject: [], edits: { [a!.id]: "Tahrirlangan matn" } })).toEqual({ approved: 2, rejected: 0 });
    expect(() => actions.decideDrafts({ approve: [a!.id], reject: [], edits: { [a!.id]: "x".repeat(4001) } })).not.toThrow(); // already approved: ignored
    // the guardian of Madina withdraws consent before the human presses "send"
    post({ message: { text: "/stop", chat: { id: 7002, type: "private" } } });
    expect(student("S0002")).toMatchObject({ consentNotify: false, guardianChatId: "" });

    const n = sent().length;
    actions.sendApprovedReminders();
    expect(lastAlert()).toContain("Yuborildi: 1");
    expect(lastAlert()).toContain("Xato: 1");
    const drafts = read<ReminderDraft>(DRAFTS);
    const byStudent = Object.fromEntries(drafts.map((d) => [d.studentId, d]));
    expect(byStudent.S0005).toMatchObject({ status: "sent" });
    expect(byStudent.S0002).toMatchObject({ status: "failed" });
    expect(byStudent.S0002!.error).toContain("Rozilik");
    const delivered = sent().slice(n);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.body.chat_id).toBe("7001");
    // the human's edit is exactly what was sent when the edited draft belongs to the still-consenting guardian
    if (aStudent === "S0005") expect(delivered[0]!.body.text).toBe("Tahrirlangan matn");
    else expect(String(delivered[0]!.body.text)).toContain("Bobur Saidov");
  });

  it("rejected drafts are never sent; Telegram errors are recorded without leaking the token", () => {
    linkGuardian("S0005", 7001);
    actions.createReminderDrafts();
    const [d] = actions.getPendingDrafts();
    expect(actions.decideDrafts({ approve: [], reject: [d!.id], edits: {} })).toEqual({ approved: 0, rejected: 1 });
    const n = sent().length;
    actions.sendApprovedReminders();
    expect(sent().length).toBe(n);

    // a fresh approved draft whose delivery fails
    updateById(DRAFTS, "id", d!.id, { status: "approved" });
    h.telegram.handler = () => ({ status: 403, body: { ok: false, description: "Forbidden: bot was blocked by the user" } });
    actions.sendApprovedReminders();
    const failed = read<ReminderDraft>(DRAFTS)[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("blocked");
    expect(JSON.stringify(h.rows("Eslatmalar"))).not.toContain("TEST-TOKEN");
  });

  it("Telegram setup validates the token and never writes it to a sheet", () => {
    h.props.clear();
    h.prompts.push("not-a-token");
    expect(() => actions.setupTelegram()).toThrow(/format/);
    h.prompts.push("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1");
    h.telegram.handler = (m) => (m === "getMe" ? { status: 200, body: { ok: true, result: { username: "demo_bot" } } } : { status: 200, body: { ok: true, result: true } });
    h.webUrl = "https://script.google.com/macros/s/ID/exec";
    actions.setupTelegram();
    expect(h.props.get("BOT_USERNAME")).toBe("demo_bot");
    const hook = h.fetches.find((f) => f.body._method === "setWebhook")!;
    expect(String(hook.body.url)).toBe(`https://script.google.com/macros/s/ID/exec?s=${webhookSecret()}`);
    expect(JSON.stringify([...h.sheets.values()].map((s) => s.data))).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1");

    h.props.clear();
    h.prompts.push("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1");
    h.telegram.handler = () => ({ status: 401, body: { ok: false, description: "Unauthorized" } });
    expect(() => actions.setupTelegram()).toThrow(/tekshiruvdan o'tmadi/);
    expect(h.props.has("TELEGRAM_BOT_TOKEN")).toBe(false); // a rejected token is not kept
  });
});
