import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/domain/sha256";
import type { AttendanceRow } from "../src/domain/types";
import { append, read, updateById } from "../src/gas/repo";
import { ATTENDANCE, ENROLLMENTS, GROUPS, SETTINGS_SHEET, STUDENTS, TEACHER_INVITES, TEACHER_MESSAGES, TEACHER_NOTICES, TEACHERS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { readSettings } from "../src/gas/settings";
import * as T from "../src/gas/teacher";
import { webhookSecret } from "../src/gas/telegram";
import { handlePost } from "../src/gas/webhook";
import { installHarness, type Harness } from "./harness";

let h: Harness;
const TEACHER_CHAT = "9001";
const OWNER_CHAT = "99999";
const GUARDIAN_CHAT = "555";

/** 2026-11-24 is a Tuesday ("Se"); the harness time zone is Asia/Tashkent (UTC+5). */
const at = (local: string): void => void vi.setSystemTime(new Date(`${local}:00+05:00`));
const post = (update: unknown) => handlePost({ parameter: { s: webhookSecret() }, postData: { contents: JSON.stringify(update), type: "application/json" } } as never);
const say = (chat: string, text: string, extra: Record<string, unknown> = {}) => post({ message: { text, from: { id: Number(chat) }, chat: { id: Number(chat), type: "private" }, ...extra } });
const tap = (chat: string, data: string, mid = 7) => post({ callback_query: { id: `cb${data}`, data, from: { id: Number(chat) }, message: { message_id: mid, chat: { id: Number(chat), type: "private" } } } });
const sent = () => h.fetches.filter((f) => f.body._method === "sendMessage" || f.body._method === "editMessageText");
const lastText = (): string => String(sent().at(-1)!.body.text);
const toChat = (chat: string) => sent().filter((f) => String(f.body.chat_id) === chat).map((f) => String(f.body.text));
const buttons = () => (sent().at(-1)!.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
const setSetting = (label: string, value: string): void => {
  const row = h.sheets.get(SETTINGS_SHEET)!.data.find((r) => r[0] === label);
  if (!row) throw new Error(`no setting ${label}`);
  row[1] = value;
};
const teacher = (id = "T0001") => read<T.TeacherRow>(TEACHERS).find((t) => t.id === id)!;
const invites = () => read<{ id: string; teacherId: string; codeHash: string; status: string; expiresAt: string }>(TEACHER_INVITES);

function link(chat = TEACHER_CHAT, id = "T0001"): void {
  updateById(TEACHERS, "id", id, { telegramChatId: chat });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-11-24T09:00");
  h = installHarness();
  setupWorkbook();
  setSetting("Markaz nomi", "Bilim Plus");
  setSetting("Egasining Telegram chat ID si", OWNER_CHAT);
  h.props.set("TELEGRAM_BOT_TOKEN", "123:TOKEN");
  append(TEACHERS, [{ id: "T0001", fullName: "Botir Aliyev", payModel: "per_lesson", payRate: 100_000, status: "active" }]);
  append(TEACHERS, [{ id: "T0002", fullName: "Sevara Karimova", payModel: "fixed", payRate: 3_000_000, status: "active" }]);
  append(GROUPS, [{ id: "G0001", name: "Ingliz A1", teacherId: "T0001", monthlyFee: 500_000, schedule: "Se 10:00-11:00", status: "active" }]);
  append(GROUPS, [{ id: "G0002", name: "Rus tili B2", teacherId: "T0002", monthlyFee: 400_000, schedule: "Se 12:00-13:00", status: "active" }]);
  for (const [id, name, chat] of [["S0001", "Ali Valiyev", GUARDIAN_CHAT], ["S0002", "Vali Aliyev", ""], ["S0003", "Foreign Pupil", "777"]] as const) {
    append(STUDENTS, [{ id, fullName: name, status: "active", guardianName: "Mama", guardianChatId: chat, consentNotify: !!chat }]);
  }
  for (const [id, s, g] of [["E0001", "S0001", "G0001"], ["E0002", "S0002", "G0001"], ["E0003", "S0003", "G0002"]] as const) {
    append(ENROLLMENTS, [{ id, studentId: s, groupId: g, startedOn: "2026-01-10", endedOn: "", discountPercent: 0, status: "active" }]);
  }
});
afterEach(() => vi.useRealTimers());

describe("invitations", () => {
  it("creates a one-time code, stores only its hash and replaces an older open code", () => {
    const first = T.createInvite("T0001");
    expect(first.code).toMatch(/^T-[A-HJ-NP-Z2-9]{8}$/);
    const row = invites()[0]!;
    expect(row.codeHash).toBe(sha256Hex(first.code));
    expect(JSON.stringify(h.rows("Ustoz taklifnomalari"))).not.toContain(first.code);
    expect(row.status).toBe("pending");
    expect(row.expiresAt).toBe("2026-12-01T09:00");
    const second = T.createInvite("T0001");
    expect(second.code).not.toBe(first.code);
    expect(invites().map((r) => r.status)).toEqual(["revoked", "pending"]);
    expect(T.acceptInvite(first.code, TEACHER_CHAT)).toEqual({ ok: false, reason: "revoked" });
  });

  it("refuses unknown, inactive and already linked teachers", () => {
    expect(() => T.createInvite("T0099")).toThrow(/topilmadi/);
    updateById(TEACHERS, "id", "T0002", { status: "inactive" });
    expect(() => T.createInvite("T0002")).toThrow(/Nofaol/);
    link();
    expect(() => T.createInvite("T0001")).toThrow(/ulangan/);
  });

  it("accepting links the chat once; every refusal says why", () => {
    const { code } = T.createInvite("T0001");
    expect(T.acceptInvite("hello", TEACHER_CHAT)).toEqual({ ok: false, reason: "bad_code" });
    expect(T.acceptInvite("T-ABCDEFGH", TEACHER_CHAT)).toEqual({ ok: false, reason: "unknown" });
    const ok = T.acceptInvite(code.toLowerCase().replace("-", " "), TEACHER_CHAT);
    expect(ok.ok).toBe(true);
    expect(teacher().telegramChatId).toBe(TEACHER_CHAT);
    expect(invites()[0]!.status).toBe("used");
    expect(T.acceptInvite(code, "1234")).toEqual({ ok: false, reason: "used" });
    // one chat cannot become a second teacher
    const other = T.createInvite("T0002");
    expect(T.acceptInvite(other.code, TEACHER_CHAT)).toEqual({ ok: false, reason: "chat_already_teacher" });
    expect(teacher("T0002").telegramChatId ?? "").toBe("");
    // a teacher who already has another chat
    const again = T.createInvite("T0002");
    updateById(TEACHERS, "id", "T0002", { telegramChatId: "4321" });
    expect(T.acceptInvite(again.code, "5555")).toEqual({ ok: false, reason: "teacher_already_linked" });
  });

  it("an expired code is refused", () => {
    const { code } = T.createInvite("T0001");
    at("2026-12-01T09:00");
    expect(T.acceptInvite(code, TEACHER_CHAT)).toEqual({ ok: false, reason: "expired" });
    expect(teacher().telegramChatId ?? "").toBe("");
  });

  it("the bot links the chat from /start CODE or a pasted code, and leaves guardian links alone", () => {
    const a = T.createInvite("T0001");
    say("1111", "/start hello"); // not an invitation: the guardian flow answers
    expect(toChat("1111").join()).toContain("rasmiy boti");
    say(TEACHER_CHAT, `/start ${a.code}`);
    expect(lastText()).toContain("Ulandi! O'qituvchi: Botir Aliyev");
    expect(teacher().telegramChatId).toBe(TEACHER_CHAT);
    say("2222", `/start ${a.code}`);
    expect(lastText()).toContain("allaqachon ishlatilgan");
    const b = T.createInvite("T0002");
    say("3333", b.code);
    expect(lastText()).toContain("Ulandi");
    say("4444", "/start T-ABCDEFGH");
    expect(lastText()).toContain("topilmadi");
  });
});

describe("the bot: lessons, roll call, groups, week, pay", () => {
  beforeEach(() => link());

  it("a chat that is not a teacher gets the guardian flow, a teacher gets the help", () => {
    say("3030", "/yordam");
    expect(lastText()).toContain("/qarz");
    say(TEACHER_CHAT, "/yordam");
    expect(lastText()).toContain("/bugun");
    say(TEACHER_CHAT, "salom");
    expect(lastText()).toContain("/xabar");
    say(TEACHER_CHAT, "/privacy"); // a teacher can be a guardian too
    expect(lastText()).toContain("Rozilikni");
  });

  it("roll call by buttons saves attendance and shows it back", () => {
    at("2026-11-24T10:30");
    say(TEACHER_CHAT, "/bugun");
    expect(lastText()).toContain("10:00-11:00 Ingliz A1 (belgilanmagan)");
    expect(lastText()).not.toContain("Rus tili"); // another teacher's group
    const open = buttons()[0]!;
    expect(open.callback_data).toBe("l:G0001:2026-11-24:1000");
    tap(TEACHER_CHAT, open.callback_data);
    const roster = buttons().filter((b) => b.callback_data.startsWith("a:"));
    expect(roster).toHaveLength(8);
    expect(lastText()).toContain("0/2 belgilangan");
    tap(TEACHER_CHAT, "a:G0001:2026-11-24:S0001:p:0");
    tap(TEACHER_CHAT, "a:G0001:2026-11-24:S0002:e:0");
    expect(read<AttendanceRow>(ATTENDANCE).map((a) => `${a.studentId}:${a.status}`).sort()).toEqual(["S0001:present", "S0002:excused"]);
    expect(h.fetches.filter((f) => f.body._method === "answerCallbackQuery").at(-1)!.body.text).toBe("Saqlandi");
    expect(lastText()).toContain("2/2 belgilangan");
    tap(TEACHER_CHAT, "a:G0001:2026-11-24:S0001:a:0"); // a later tap changes the mark and keeps the other student
    expect(read<AttendanceRow>(ATTENDANCE).map((a) => `${a.studentId}:${a.status}`).sort()).toEqual(["S0001:absent", "S0002:excused"]);
    say(TEACHER_CHAT, "/bugun");
    expect(lastText()).toContain("(2 belgilangan)");
  });

  it("refuses a lesson that is not the teacher's, an unknown student and noise", () => {
    at("2026-11-24T12:30");
    const before = read<AttendanceRow>(ATTENDANCE).length;
    tap(TEACHER_CHAT, "l:G0002:2026-11-24:1200");
    expect(h.fetches.filter((f) => f.body._method === "answerCallbackQuery").at(-1)!.body.text).toBe("Bu sizning darsingiz emas");
    tap(TEACHER_CHAT, "a:G0002:2026-11-24:S0003:p:0");
    tap(TEACHER_CHAT, "a:G0001:2026-11-24:S0003:p:0"); // an own lesson, but not a student of its group
    expect(h.fetches.filter((f) => f.body._method === "answerCallbackQuery").at(-1)!.body.text).toContain("topilmadi");
    tap(TEACHER_CHAT, "a:G0001:2026-11-24:S0001:x:0");
    tap(TEACHER_CHAT, "l:G0001:2026-13-24:1000");
    tap(TEACHER_CHAT, "tn");
    expect(read<AttendanceRow>(ATTENDANCE)).toHaveLength(before);
  });

  it("pages a large roster", () => {
    for (let i = 4; i < 14; i++) {
      const id = `S00${String(i).padStart(2, "0")}`;
      append(STUDENTS, [{ id, fullName: `Extra ${i}`, status: "active", guardianName: "M", guardianChatId: "", consentNotify: false }]);
      append(ENROLLMENTS, [{ id: `E01${i}`, studentId: id, groupId: "G0001", startedOn: "2026-01-10", endedOn: "", discountPercent: 0, status: "active" }]);
    }
    at("2026-11-24T10:30");
    tap(TEACHER_CHAT, "l:G0001:2026-11-24:1000");
    expect(lastText()).toContain("1/2");
    const next = buttons().find((b) => b.text === "➡️")!;
    tap(TEACHER_CHAT, next.callback_data);
    expect(lastText()).toContain("2/2");
    expect(buttons().filter((b) => b.callback_data.startsWith("a:"))).toHaveLength(4 * 4);
  });

  it("groups, week and the month's hours and pay", () => {
    say(TEACHER_CHAT, "/guruhlar");
    expect(lastText()).toContain("Ingliz A1: 2 o'quvchi");
    expect(lastText()).not.toContain("Rus tili");
    say(TEACHER_CHAT, "/jadval");
    expect(lastText()).toContain("2026-11-24:");
    expect(lastText()).toContain("10:00-11:00 Ingliz A1");
    expect(lastText()).not.toContain("12:00-13:00");
    say(TEACHER_CHAT, "/oylik");
    expect(lastText()).toContain("0 ta dars, 0.0 soat");
    expect(lastText()).toContain("Taxminiy oylik: 0 so'm");
    append(ATTENDANCE, [{ date: "2026-11-17", groupId: "G0001", studentId: "S0001", status: "present", minutesLate: 0 }, { date: "2026-11-24", groupId: "G0001", studentId: "S0001", status: "present", minutesLate: 0 }]);
    say(TEACHER_CHAT, "/oylik");
    expect(lastText()).toContain("2 ta dars, 2.0 soat");
    expect(lastText()).toContain("Taxminiy oylik: 200 000 so'm");
    // a fixed salary and a percent teacher
    link("9002", "T0002");
    say("9002", "/oylik");
    expect(lastText()).toContain("Taxminiy oylik: 3 000 000 so'm");
    expect(T.monthFor({ ...teacher(), payModel: "percent", payRate: 10 }, "2026-11-24").estimate).toBe(0);
  });
});

/** Lessons of the previous Tuesday are inside the 7-day look-back: mark them so the tests only see today's. */
const markLastWeek = (): void => void append(ATTENDANCE, [{ date: "2026-11-17", groupId: "G0001", studentId: "S0001", status: "present", minutesLate: 0 }, { date: "2026-11-17", groupId: "G0002", studentId: "S0003", status: "present", minutesLate: 0 }]);

describe("reminders (internal only)", () => {
  beforeEach(() => {
    link();
    markLastWeek();
  });

  it("reminds the teacher once after the wait and never writes to a guardian", () => {
    at("2026-11-24T12:30"); // the lesson ended at 11:00; 2 h later = 13:00
    expect(T.reminderPass()).toEqual({ teacherReminders: 0, digests: 0, skipped: [] });
    at("2026-11-24T13:00");
    const r = T.reminderPass();
    expect(r.teacherReminders).toBe(1);
    expect(toChat(TEACHER_CHAT)).toEqual(["Eslatma: Ingliz A1 guruhining 2026-11-24 10:00-11:00 darsi uchun davomat belgilanmagan. Iltimos, belgilang."]);
    expect(T.reminderPass().teacherReminders).toBe(0);
    expect(read<{ key: string }>(TEACHER_NOTICES).map((n) => n.key)).toEqual(["lesson:G0001|2026-11-24|10:00"]);
    expect(h.fetches.some((f) => String(f.body.chat_id) === GUARDIAN_CHAT)).toBe(false);
  });

  it("the other teacher's lesson (no chat) is skipped and listed; a marked lesson is not reminded", () => {
    at("2026-11-24T15:00"); // 13:00 + 2 h
    append(ATTENDANCE, [{ date: "2026-11-24", groupId: "G0001", studentId: "S0001", status: "present", minutesLate: 0 }]);
    const r = T.reminderPass();
    expect(r.teacherReminders).toBe(0);
    expect(r.skipped.join()).toContain("Rus tili B2");
    expect(toChat(TEACHER_CHAT)).toEqual([]);
  });

  it("the owner gets the end-of-day list once, after the set time", () => {
    link("9002", "T0002");
    at("2026-11-24T19:59");
    expect(T.reminderPass().digests).toBe(0);
    at("2026-11-24T20:00");
    const r = T.reminderPass();
    expect(r.digests).toBe(1);
    expect(toChat(OWNER_CHAT)).toEqual(["2026-11-24: davomat belgilanmagan darslar (2):\n1. 10:00-11:00 Ingliz A1 (Botir Aliyev)\n2. 12:00-13:00 Rus tili B2 (Sevara Karimova)"]);
    expect(T.reminderPass().digests).toBe(0);
    expect(read<{ key: string }>(TEACHER_NOTICES).map((n) => n.key)).toContain("digest:2026-11-24");
  });

  it("no digest when nothing is unmarked or the owner chat is unknown; a failed send is retried", () => {
    at("2026-11-24T21:00");
    setSetting("Egasining Telegram chat ID si", "");
    const noOwner = T.reminderPass();
    expect(noOwner.skipped.join()).toContain("chat ID");
    expect(noOwner.teacherReminders).toBe(1);
    setSetting("Egasining Telegram chat ID si", OWNER_CHAT);
    h.telegram.handler = () => ({ status: 403, body: { ok: false, description: "blocked" } });
    const failed = T.reminderPass();
    expect(failed.digests).toBe(0);
    expect(read<{ key: string }>(TEACHER_NOTICES).map((n) => n.key)).toEqual(["lesson:G0001|2026-11-24|10:00"]); // a failed send is not recorded
    h.telegram.handler = () => ({ status: 200, body: { ok: true, result: {} } });
    expect(T.reminderPass()).toMatchObject({ teacherReminders: 0, digests: 1 });
    append(ATTENDANCE, [{ date: "2026-11-24", groupId: "G0001", studentId: "S0001", status: "present", minutesLate: 0 }, { date: "2026-11-24", groupId: "G0002", studentId: "S0003", status: "present", minutesLate: 0 }]);
    expect(T.reminderPass()).toMatchObject({ teacherReminders: 0, digests: 0 });
  });

  it("settings change the wait and the digest time; the trigger menu installs and removes one trigger", () => {
    setSetting("Ustoz eslatmasi: davomat belgilanmasa (soat)", "0");
    setSetting("Egaga kun yakuni ro'yxati: soat", "11:30");
    expect(readSettings()).toMatchObject({ teacherReminderHours: 0, teacherDigestAfter: "11:30", teacherDailyLimit: 20 });
    at("2026-11-24T11:30");
    expect(T.reminderPass()).toMatchObject({ teacherReminders: 1, digests: 1 });
    setSetting("Egaga kun yakuni ro'yxati: soat", "garbage");
    expect(readSettings().teacherDigestAfter).toBe("20:00");
    T.menu.triggerOn();
    T.menu.triggerOn();
    expect(h.triggers).toEqual([{ fn: "teacherTick", everyHours: 1 }]);
    T.menu.triggerOff();
    expect(h.triggers).toEqual([]);
    expect(h.alerts.at(-1)!.message).toContain("O'chirildi");
    T.tick();
  });
});

describe("messages to guardians", () => {
  beforeEach(() => {
    link();
    at("2026-11-24T15:00");
  });
  const guardianTexts = () => toChat(GUARDIAN_CHAT);

  it("a template goes to the guardian, signed, and is logged", () => {
    say(TEACHER_CHAT, "/xabar");
    expect(buttons().map((b) => b.callback_data)).toEqual(["m1:G0001"]);
    tap(TEACHER_CHAT, "m1:G0001");
    expect(buttons().map((b) => b.callback_data)).toEqual(["m2:S0001", "m2:S0002"]);
    tap(TEACHER_CHAT, "m2:S0001");
    expect(buttons().map((b) => b.callback_data)).toEqual(["m3:S0001:absent", "m3:S0001:late", "m3:S0001:homework", "m3:S0001:praise", "m3:S0001:meeting", "m4:S0001"]);
    tap(TEACHER_CHAT, "m3:S0001:praise");
    expect(guardianTexts()).toEqual(["Ali Valiyev bugun (2026-11-24) Ingliz A1 darsida a'lo qatnashdi. Rahmat!\n\n— Botir Aliyev, Bilim Plus"]);
    expect(lastText()).toContain("Bugun yana 19 ta");
    const log = read<{ teacherId: string; studentId: string; template: string; body: string; date: string }>(TEACHER_MESSAGES);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ teacherId: "T0001", studentId: "S0001", template: "praise", date: "2026-11-24" });
    expect(log[0]!.body).toBe(guardianTexts()[0]);
  });

  it("free text is a reply to the bot's prompt", () => {
    tap(TEACHER_CHAT, "m4:S0001");
    const prompt = sent().at(-1)!.body;
    expect(prompt.reply_markup).toMatchObject({ force_reply: true });
    expect(String(prompt.text)).toContain("#S0001");
    say(TEACHER_CHAT, "Ertaga ochiq dars bor.", { reply_to_message: { text: String(prompt.text) } });
    expect(guardianTexts()[0]).toContain("Ertaga ochiq dars bor.");
    say(TEACHER_CHAT, "Ertaga ochiq dars bor."); // a text without a prompt is nothing
    expect(guardianTexts()).toHaveLength(1);
    expect(read(TEACHER_MESSAGES)).toHaveLength(1);
  });

  it("refusals: foreign student, no guardian link, switched off, limit, size; nothing is logged or sent", () => {
    const refuse = (student: string, text: string): void => {
      const before = h.fetches.filter((f) => String(f.body.chat_id) === GUARDIAN_CHAT || String(f.body.chat_id) === "777").length;
      tap(TEACHER_CHAT, `m3:${student}:praise`);
      expect(lastText()).toContain(text);
      expect(h.fetches.filter((f) => String(f.body.chat_id) === GUARDIAN_CHAT || String(f.body.chat_id) === "777").length).toBe(before);
    };
    refuse("S0003", "sizning guruhingizda emas"); // another teacher's student
    refuse("S0002", "yozib bo'lmaydi"); // no guardian chat
    tap(TEACHER_CHAT, "m3:S0001:bogus");
    expect(lastText()).toContain("Xabar bo'sh");
    say(TEACHER_CHAT, "x".repeat(1001), { reply_to_message: { text: "Matn #S0001" } });
    expect(lastText()).toContain("uzun");
    tap(TEACHER_CHAT, "m1:G0002");
    expect(h.fetches.filter((f) => f.body._method === "answerCallbackQuery").at(-1)!.body.text).toContain("sizning guruhingizda emas");
    expect(read(TEACHER_MESSAGES)).toHaveLength(0);
    // switched off by the owner
    updateById(TEACHERS, "id", "T0001", { msgOff: true });
    say(TEACHER_CHAT, "/xabar");
    expect(lastText()).toContain("o'chirilgan");
    refuse("S0001", "o'chirilgan");
    updateById(TEACHERS, "id", "T0001", { msgOff: false });
    // the daily limit counts per day
    setSetting("Ustoz: vasiyga kunlik xabar limiti", "2");
    tap(TEACHER_CHAT, "m3:S0001:late");
    tap(TEACHER_CHAT, "m3:S0001:late");
    expect(guardianTexts()).toHaveLength(2);
    refuse("S0001", "limiti tugadi");
    at("2026-11-25T09:00");
    tap(TEACHER_CHAT, "m3:S0001:late");
    expect(guardianTexts()).toHaveLength(3);
    // a Telegram failure is reported and not logged as sent
    h.telegram.handler = () => ({ status: 403, body: { ok: false, description: "blocked" } });
    const logged = read(TEACHER_MESSAGES).length;
    tap(TEACHER_CHAT, "m3:S0001:late");
    expect(lastText()).toContain("qabul qilmadi");
    expect(read(TEACHER_MESSAGES)).toHaveLength(logged);
  });

  it("the owner's switch menu flips the right for one teacher", () => {
    h.prompts.push("T0001");
    T.menu.toggleMessaging();
    expect(teacher().msgOff).toBe(true);
    expect(h.alerts.at(-1)!.message).toContain("O'CHIRILDI");
    h.prompts.push("T0001");
    T.menu.toggleMessaging();
    expect(teacher().msgOff).toBe(false);
    h.prompts.push("T9999");
    expect(() => T.menu.toggleMessaging()).toThrow(/topilmadi/);
  });
});

describe("owner menus", () => {
  beforeEach(markLastWeek);

  it("shows the code once and lists unmarked lessons", () => {
    h.prompts.push("T0001");
    T.menu.invite();
    const alert = h.alerts.at(-1)!;
    expect(alert.message).toMatch(/Kod: T-[A-Z2-9]{8}/);
    expect(JSON.stringify(h.rows("Ustoz taklifnomalari"))).not.toContain(/Kod: (T-[A-Z2-9]{8})/.exec(alert.message)![1]!);
    at("2026-11-24T14:00");
    T.menu.unmarked();
    expect(h.alerts.at(-1)!.message).toContain("2026-11-24 10:00-11:00 Ingliz A1 (Botir Aliyev): eslatma kerak");
    T.menu.remind();
    expect(h.alerts.at(-1)!.message).toContain("Ustozlarga: 0 ta");
    expect(h.alerts.at(-1)!.message).toContain("ulanmagan");
  });

  it("the workbook has the new sheets and settings", () => {
    for (const name of ["Ustoz taklifnomalari", "Ustoz xabarlari", "Ustoz eslatmalari"]) expect(h.sheets.has(name)).toBe(true);
    expect(h.rows("O'qituvchilar")[0]).toEqual(expect.arrayContaining(["Telegram chat ID", "Vasiyga yozish o'chirilgan"]));
  });
});
