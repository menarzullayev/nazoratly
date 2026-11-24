import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseUpdate } from "../src/domain/telegramUpdates";
import type { AttendanceRow, Charge, Entitlement, GuardianLink, GuardianRequest, Student } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import * as guardian from "../src/gas/guardian";
import { append, read, updateById } from "../src/gas/repo";
import { ATTENDANCE, CHARGES, ENROLLMENTS, ENTITLEMENTS, GROUPS, GUARDIAN_LINKS, GUARDIAN_REQUESTS, STUDENTS } from "../src/gas/schema";
import { readSettings } from "../src/gas/settings";
import { setupWorkbook } from "../src/gas/setup";
import { webhookSecret } from "../src/gas/telegram";
import { handlePost } from "../src/gas/webhook";
import { installHarness, type Harness } from "./harness";

type StudentRow = Student & { phone?: string; linkCode?: string; qrCode?: string };
let h: Harness;

const QR = "NZQ1-ABCDEFGHJKLMNPQRSTUV";
const post = (update: unknown) =>
  handlePost({ parameter: { s: webhookSecret() }, postData: { contents: JSON.stringify(update), type: "application/json" } } as never);
const msg = (chat: number, extra: Record<string, unknown>) => ({ message: { chat: { id: chat, type: "private" }, from: { id: chat }, ...extra } });
const texts = () => h.fetches.filter((f) => f.body._method === "sendMessage").map((f) => String(f.body.text ?? ""));

function setSetting(label: string, value: string): void {
  const row = h.sheets.get("Sozlamalar")!.data.find((r) => r[0] === label);
  if (!row) throw new Error(`no setting ${label}`);
  row[1] = value;
}

/** Today is Monday 2026-11-23. S0001 studies in G0001 (Mondays) and owes 600 000; G0002 (Tuesdays, 2 seats) holds S0002. */
function seed(): void {
  append(STUDENTS, [
    { id: "S0001", fullName: "Ali Valiyev", status: "active", phone: "+998 90 123 45 67", guardianName: "Dilnoza", guardianChatId: "", consentNotify: false, qrCode: QR } as StudentRow,
    { id: "S0002", fullName: "Vali Aliyev", status: "active", phone: "", guardianName: "Karim", guardianChatId: "", consentNotify: false } as StudentRow,
  ]);
  append(GROUPS, [
    { id: "G0001", name: "IELTS", teacherId: "T0001", monthlyFee: 600_000, schedule: "Du", status: "active" },
    { id: "G0002", name: "Math", teacherId: "T0001", monthlyFee: 500_000, schedule: "Se", status: "active", capacity: 2 },
  ]);
  append(ENROLLMENTS, [
    { id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
    { id: "E0002", studentId: "S0002", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
    { id: "E0003", studentId: "S0002", groupId: "G0002", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
  ]);
}
const debt = (studentId = "S0001", amount = 600_000) =>
  append(CHARGES, [{ id: "C0001", studentId, enrollmentId: "E0001", month: "2026-11-01", amount, dueDate: "2026-11-30", voided: false, note: "" } satisfies Charge]);
const requests = () => read<GuardianRequest>(GUARDIAN_REQUESTS);
const links = () => read<GuardianLink>(GUARDIAN_LINKS);
const student = (id: string) => read<StudentRow>(STUDENTS).find((s) => s.id === id)!;
const marks = () => read<AttendanceRow>(ATTENDANCE);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  h.props.set("TELEGRAM_BOT_TOKEN", "123:test-token");
  setupWorkbook();
});
afterEach(() => vi.useRealTimers());

describe("setup", () => {
  it("creates the two sheets and the setting, and they follow the student's branch", () => {
    expect(h.rows(GUARDIAN_REQUESTS.sheet)[0]).toContain("Sabab");
    expect(h.rows(GUARDIAN_LINKS.sheet)[0]).toContain("Telegram chat ID");
    expect(readSettings().guardianPromiseDays).toBe(14);
    setSetting("Vasiy to'lov va'dasi: eng uzoq kun", "100");
    expect(readSettings().guardianPromiseDays).toBe(14); // out of range falls back
    setSetting("Vasiy to'lov va'dasi: eng uzoq kun", "30");
    expect(readSettings().guardianPromiseDays).toBe(30);
  });
});

describe("absence reason", () => {
  it("is refused with a reason the staff can read, and changes nothing", () => {
    seed();
    const ask = (over: Partial<Parameters<typeof guardian.recordAbsence>[0]> = {}) =>
      guardian.recordAbsence({ studentId: "S0001", groupId: "G0001", date: "2026-11-30", reason: "Kasal", ...over });
    expect(() => ask({ reason: "  " })).toThrow(/Sababni/);
    expect(() => ask({ reason: "x".repeat(301) })).toThrow(/300/);
    expect(() => ask({ date: "2026-11-23" })).toThrow(/Dars kuni/); // the lesson's day is too late
    expect(() => ask({ studentId: "S0002", groupId: "G0002" })).not.toThrow(); // S0002 is in G0002
    expect(() => ask({ groupId: "G0002" })).toThrow(/guruhda emas/); // S0001 is not in G0002
    expect(() => ask({ studentId: "S9999" })).toThrow(/topilmadi/);
    expect(marks()).toEqual([]);
    expect(read<Entitlement>(ENTITLEMENTS)).toEqual([]);
  });

  it("changes the roll call only after approval, keeps the other marks and creates the make-up right", () => {
    seed();
    actions.saveAttendance({ date: "2026-11-30", groupId: "G0001", marks: [{ studentId: "S0002", status: "present", minutesLate: 0 }] });
    const id = guardian.recordAbsence({ studentId: "S0001", groupId: "G0001", date: "2026-11-30", reason: "Kasal", via: "Telefon" });
    expect(requests()[0]).toMatchObject({ id, kind: "absence_reason", status: "pending", via: "Telefon", reason: "Kasal" });
    expect(() => guardian.recordAbsence({ studentId: "S0001", groupId: "G0001", date: "2026-11-30", reason: "Yana" })).toThrow(/allaqachon/);
    expect(marks().filter((m) => m.studentId === "S0001")).toEqual([]); // nothing yet
    const done = guardian.decide(id, "approve", "Tuzalsin");
    expect(done.status).toBe("approved");
    expect(marks().find((m) => m.studentId === "S0001")?.status).toBe("excused");
    expect(marks().find((m) => m.studentId === "S0002")?.status).toBe("present"); // the rest of the roll call is untouched
    const rights = read<Entitlement>(ENTITLEMENTS);
    expect(rights).toHaveLength(1);
    expect(rights[0]).toMatchObject({ studentId: "S0001", kind: "makeup", status: "open", missedOn: "2026-11-30" });
    expect(requests()[0]).toMatchObject({ status: "approved", decidedOn: "2026-11-23", note: "Tuzalsin" });
    expect(() => guardian.decide(id, "approve")).toThrow(/allaqachon/);
  });

  it("a rejected request changes nothing and cannot be approved later", () => {
    seed();
    const id = guardian.recordAbsence({ studentId: "S0001", groupId: "G0001", date: "2026-11-30", reason: "Sayohat" });
    guardian.decide(id, "reject", "Sabab yetarli emas");
    expect(marks()).toEqual([]);
    expect(requests()[0]?.status).toBe("rejected");
    expect(() => guardian.decide(id, "approve")).toThrow(/allaqachon/);
    // a new request for the same lesson is possible again
    expect(() => guardian.recordAbsence({ studentId: "S0001", groupId: "G0001", date: "2026-11-30", reason: "Boshqa sabab" })).not.toThrow();
  });

  it("refuses to excuse a lesson the student was marked present for", () => {
    seed();
    const id = guardian.recordAbsence({ studentId: "S0001", groupId: "G0001", date: "2026-11-30", reason: "Kasal" });
    actions.saveAttendance({ date: "2026-11-30", groupId: "G0001", marks: [{ studentId: "S0001", status: "present", minutesLate: 0 }] });
    expect(() => guardian.decide(id, "approve")).toThrow(/keldi/);
    expect(requests()[0]?.status).toBe("pending");
    expect(marks()[0]?.status).toBe("present");
  });
});

describe("payment promise", () => {
  it("needs a debt, a sensible date and amount, and one open promise at a time", () => {
    seed();
    expect(() => guardian.recordPromise({ studentId: "S0001", promiseDate: "2026-11-27" })).toThrow(/Qarz yo'q/);
    debt();
    expect(() => guardian.recordPromise({ studentId: "S0001", promiseDate: "2026-11-22" })).toThrow(/o'tib/);
    expect(() => guardian.recordPromise({ studentId: "S0001", promiseDate: "2026-12-08" })).toThrow(/uzoq/); // 15 days
    expect(() => guardian.recordPromise({ studentId: "S0001", promiseDate: "2026-11-27", amount: 600_001 })).toThrow(/Summa/);
    const id = guardian.recordPromise({ studentId: "S0001", promiseDate: "2026-12-07", amount: 250_000 }); // exactly 14 days
    expect(requests()[0]).toMatchObject({ id, kind: "payment_promise", status: "pending", amount: 250_000, promiseDate: "2026-12-07" });
    expect(() => guardian.recordPromise({ studentId: "S0001", promiseDate: "2026-11-27" })).toThrow(/Kutilayotgan/);
    guardian.decide(id, "approve");
    expect(() => guardian.recordPromise({ studentId: "S0001", promiseDate: "2026-11-27" })).toThrow(/amaldagi/); // the approved one still holds
    expect(marks()).toEqual([]); // a promise moves no money and no attendance
  });

  it("the center's setting sets the horizon", () => {
    seed();
    debt();
    setSetting("Vasiy to'lov va'dasi: eng uzoq kun", "30");
    expect(() => guardian.recordPromise({ studentId: "S0001", promiseDate: "2026-12-23" })).not.toThrow();
  });
});

describe("make-up choice", () => {
  function openRight(): string {
    seed();
    const id = guardian.recordAbsence({ studentId: "S0001", groupId: "G0001", date: "2026-11-30", reason: "Kasal" });
    guardian.decide(id, "approve");
    return read<Entitlement>(ENTITLEMENTS)[0]!.id;
  }

  it("offers the next lessons of OTHER groups with a free seat, soonest first", () => {
    const right = openRight();
    const options = guardian.slotOptions(right);
    expect(options[0]).toEqual({ id: "G0002|2026-11-24", groupId: "G0002", date: "2026-11-24" });
    expect(options.every((o) => o.groupId === "G0002" && o.date > "2026-11-23")).toBe(true);
    // fill the group (capacity 2, one seat taken): no seat left, no slot
    append(STUDENTS, [{ id: "S0003", fullName: "Third", status: "active", phone: "", guardianName: "", guardianChatId: "", consentNotify: false }]);
    append(ENROLLMENTS, [{ id: "E0009", studentId: "S0003", groupId: "G0002", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" }]);
    expect(guardian.slotOptions(right)).toEqual([]);
  });

  it("schedules the right only after approval and refuses a slot that was not offered", () => {
    const right = openRight();
    expect(() => guardian.recordMakeup({ entitlementId: right, slot: "G0001|2026-12-07" })).toThrow(/mavjud emas/); // own group is not a slot
    expect(() => guardian.recordMakeup({ entitlementId: "R9999", slot: "G0002|2026-11-24" })).toThrow(/topilmadi/);
    const id = guardian.recordMakeup({ entitlementId: right, slot: "G0002|2026-11-24", via: "Telegram" });
    expect(read<Entitlement>(ENTITLEMENTS)[0]).toMatchObject({ status: "open", makeupOn: "" });
    expect(() => guardian.recordMakeup({ entitlementId: right, slot: "G0002|2026-12-01" })).toThrow(/allaqachon/);
    guardian.decide(id, "approve");
    expect(read<Entitlement>(ENTITLEMENTS)[0]).toMatchObject({ status: "scheduled", makeupOn: "2026-11-24", lastMakeupOn: "2026-11-24" });
    expect(() => guardian.recordMakeup({ entitlementId: right, slot: "G0002|2026-12-01" })).toThrow(/ochiq emas/);
  });

  it("approval re-checks the seat", () => {
    const right = openRight();
    const id = guardian.recordMakeup({ entitlementId: right, slot: "G0002|2026-11-24" });
    append(STUDENTS, [{ id: "S0003", fullName: "Third", status: "active", phone: "", guardianName: "", guardianChatId: "", consentNotify: false }]);
    append(ENROLLMENTS, [{ id: "E0009", studentId: "S0003", groupId: "G0002", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" }]);
    expect(() => guardian.decide(id, "approve")).toThrow(/mavjud emas/);
    expect(requests().find((r) => r.id === id)?.status).toBe("pending");
    expect(read<Entitlement>(ENTITLEMENTS)[0]?.status).toBe("open");
  });
});

describe("linking", () => {
  it("a QR card sent to the bot waits for the center, then needs the guardian's consent", () => {
    seed();
    post(msg(555, { text: QR.toLowerCase() }));
    expect(texts().at(-1)).toMatch(/markazga yuborildi/);
    post(msg(555, { text: QR }));
    expect(links()).toHaveLength(1); // asking twice keeps one request
    expect(links()[0]).toMatchObject({ studentId: "S0001", chatId: "555", method: "qr", status: "pending" });
    expect(student("S0001").guardianChatId).toBe(""); // nothing linked yet
    guardian.approveLink(links()[0]!.id);
    expect(student("S0001").guardianChatId).toBe("555");
    expect(student("S0001").consentNotify).toBe(false); // the guardian still has to accept
    post(msg(555, { text: "/start" }));
    const prompt = h.fetches.filter((f) => f.body._method === "sendMessage").at(-1)!;
    const code = student("S0001").linkCode!;
    expect(JSON.stringify(prompt.body.reply_markup)).toContain(`y:${code}`);
    post({ callback_query: { id: "cb", data: `y:${code}`, message: { message_id: 1, chat: { id: 555, type: "private" } } } });
    expect(student("S0001")).toMatchObject({ guardianChatId: "555", consentNotify: true });
    expect(() => guardian.approveLink(links()[0]!.id)).toThrow(/allaqachon/);
  });

  it("an unknown card is refused and a rejected request links nothing", () => {
    seed();
    post(msg(556, { text: "NZQ1-AAAAAAAAAAAAAAAAAAAA" }));
    expect(texts().at(-1)).toMatch(/topilmadi/);
    expect(links()).toEqual([]);
    post(msg(557, { text: QR }));
    guardian.rejectLink(links()[0]!.id);
    expect(student("S0001").guardianChatId).toBe("");
    expect(() => guardian.rejectLink(links()[0]!.id)).toThrow(/allaqachon/);
  });

  it("a Telegram contact links by phone only when it is the sender's own number and the center knows it", () => {
    seed();
    post(msg(600, { contact: { phone_number: "+998901234567", user_id: 601 } })); // somebody else's card
    expect(texts().at(-1)).toMatch(/topilmadi/);
    post(msg(600, { contact: { phone_number: "+998909999999", user_id: 600 } })); // his own, unknown number
    expect(texts().at(-1)).toMatch(/topilmadi/);
    expect(student("S0001").guardianChatId).toBe("");
    post(msg(600, { contact: { phone_number: "998901234567", user_id: 600 } }));
    const prompt = h.fetches.filter((f) => f.body._method === "sendMessage").at(-1)!;
    expect(String(prompt.body.text)).toContain("Ali Valiyev");
    post({ callback_query: { id: "cb", data: `y:${student("S0001").linkCode}`, message: { message_id: 1, chat: { id: 600, type: "private" } } } });
    expect(student("S0001")).toMatchObject({ guardianChatId: "600", consentNotify: true });
  });

  it("manual link records an approved row; a taken student or a bad id is refused", () => {
    seed();
    expect(() => guardian.manualLink("S0001", "abc")).toThrow(/raqamlardan/);
    guardian.manualLink("S0001", "700100");
    expect(student("S0001").guardianChatId).toBe("700100");
    expect(links()[0]).toMatchObject({ method: "manual", status: "approved", chatId: "700100" });
    expect(() => guardian.manualLink("S0001", "700200")).toThrow(/boshqa Telegram/);
    guardian.manualLink("S0001", "700100"); // the same chat again is harmless
    expect(() => guardian.manualLink("S9999", "700300")).toThrow(/topilmadi/);
  });

  it("sends nothing to a guardian by itself: only answers to his own message", () => {
    seed();
    debt();
    const id = guardian.recordPromise({ studentId: "S0001", promiseDate: "2026-11-27" });
    guardian.manualLink("S0001", "700100");
    guardian.decide(id, "approve");
    guardian.decide(guardian.recordAbsence({ studentId: "S0001", groupId: "G0001", date: "2026-11-30", reason: "Kasal" }), "reject");
    expect(h.fetches).toEqual([]);
    expect(read<{ id: string }>(GROUPS)).toHaveLength(2);
    expect(updateById).toBeTypeOf("function");
  });
});

describe("bot updates", () => {
  it("recognises a QR card code and a contact card, and whether the number is the sender's own", () => {
    expect(parseUpdate(msg(42, { text: " nzq1-abcdefghjklmnpqrstuv " }))).toEqual({ kind: "qr", chatId: "42", code: QR });
    expect(parseUpdate(msg(42, { text: "NZQ1-ABCDEFGHJKLMNPQRSTU0" }))).toEqual({ kind: "ignore" }); // 0 is not in the alphabet
    expect(parseUpdate(msg(42, { contact: { phone_number: "+998901234567", user_id: 42 } }))).toEqual({ kind: "contact", chatId: "42", phone: "+998901234567", verified: true });
    expect(parseUpdate(msg(42, { contact: { phone_number: "+998901234567", user_id: 43 } }))).toMatchObject({ kind: "contact", verified: false });
    expect(parseUpdate(msg(42, { contact: { phone_number: "+998901234567" } }))).toMatchObject({ kind: "contact", verified: false });
    const group = { message: { chat: { id: -5, type: "group" }, from: { id: 42 }, contact: { phone_number: "1", user_id: 42 } } };
    expect(parseUpdate(group)).toEqual({ kind: "ignore" });
  });
});
