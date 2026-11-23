import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Enrollment, ReminderDraft, WaitlistRow } from "../src/domain/types";
import * as admission from "../src/gas/admission";
import * as waitlist from "../src/gas/waitlist";
import { append, read, updateById } from "../src/gas/repo";
import { DRAFTS, ENROLLMENTS, GROUPS, LEADS, STUDENTS, WAITLIST } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;
const student = (id: string, name: string, extra: Record<string, unknown> = {}): void =>
  append(STUDENTS, [{ id, fullName: name, status: "active", phone: "", guardianName: "Dilnoza", guardianChatId: "555", consentNotify: true, ...extra }]);
const group = (id: string, capacity: number | "" = 2): void =>
  append(GROUPS, [{ id, name: `Guruh ${id}`, teacherId: "", monthlyFee: 100_000, status: "active", capacity }]);
const enroll = (id: string, studentId: string, groupId: string, status = "active"): void =>
  append(ENROLLMENTS, [{ id, studentId, groupId, startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status }]);
const queue = (): WaitlistRow[] => read<WaitlistRow>(WAITLIST);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
  group("G0001", 2);
  for (const [i, n] of ["Ali", "Vali", "Sami", "Nodir"].entries()) student(`S000${i + 1}`, n);
  enroll("E0001", "S0001", "G0001");
  enroll("E0002", "S0002", "G0001");
});
afterEach(() => vi.useRealTimers());

describe("joining the waiting list", () => {
  it("a full group takes the student into the queue, in order", () => {
    expect(waitlist.waitlistAdd("G0001", "S0003")).toContain("1-o'rin");
    expect(waitlist.waitlistAdd("G0001", "S0004")).toContain("2-o'rin");
    expect(queue().map((w) => [w.id, w.studentId, w.status, w.joinedOn])).toEqual([["W0001", "S0003", "waiting", "2026-11-23"], ["W0002", "S0004", "waiting", "2026-11-23"]]);
  });

  it("refuses: free seats and nobody waiting, no capacity limit, already in the group, already waiting, unknown ids", () => {
    group("G0002", 5);
    expect(() => waitlist.waitlistAdd("G0002", "S0003")).toThrow(/bo'sh o'rin bor/);
    group("G0003", "");
    expect(() => waitlist.waitlistAdd("G0003", "S0003")).toThrow(/sig'im chegarasi yo'q/);
    expect(() => waitlist.waitlistAdd("G0001", "S0001")).toThrow(/allaqachon bor/);
    waitlist.waitlistAdd("G0001", "S0003");
    expect(() => waitlist.waitlistAdd("G0001", "S0003")).toThrow(/navbatida allaqachon/);
    expect(() => waitlist.waitlistAdd("G9999", "S0003")).toThrow(/Guruh topilmadi/);
    expect(() => waitlist.waitlistAdd("G0001", "S9999")).toThrow(/O'quvchi topilmadi/);
    expect(queue()).toHaveLength(1);
  });

  it("a finished group takes no queue; a free seat with somebody waiting still lets new students queue behind", () => {
    waitlist.waitlistAdd("G0001", "S0003");
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished" }); // one seat frees
    expect(waitlist.waitlistAdd("G0001", "S0004")).toContain("2-o'rin");
    updateById(GROUPS, "id", "G0001", { status: "finished" });
    student("S0005", "Zafar");
    expect(() => waitlist.waitlistAdd("G0001", "S0005")).toThrow(/tugagan/);
  });
});

describe("seats freed up", () => {
  it("offers the first in line, never enrolls anybody by itself, and lists the offer for the dashboard", () => {
    waitlist.waitlistAdd("G0001", "S0003");
    waitlist.waitlistAdd("G0001", "S0004");
    expect(waitlist.loadOffers().offers).toEqual([]);
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished" });
    const { offers } = waitlist.loadOffers();
    expect(offers.map((o) => [o.entryId, o.position, o.freeSeats])).toEqual([["W0001", 1, 1]]);
    expect(read<Enrollment>(ENROLLMENTS).filter((e) => e.status === "active")).toHaveLength(1); // nobody was enrolled
  });

  it("the queue sheet shows capacity, taken seats, the line and who is offered", () => {
    waitlist.waitlistAdd("G0001", "S0003");
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished" });
    waitlist.openWaitlistView();
    const rows = h.rows(waitlist.VIEW_SHEET);
    expect(rows[0]).toEqual(["Guruh", "Sig'im", "Band", "Bo'sh", "Navbatda", "Navbat (tartib bilan)", "Bo'sh o'rin taklifi"]);
    expect(rows[1]).toEqual(["G0001 Guruh G0001", 2, 1, 1, 1, "1. Sami (W0001)", "Sami"]);
  });

  it("the dashboard lists the freed seat", async () => {
    const { refreshDashboard } = await import("../src/gas/dashboard");
    waitlist.waitlistAdd("G0001", "S0003");
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished" });
    refreshDashboard();
    const cells = h.rows("Boshqaruv").map((r) => r.map(String));
    const title = cells.find((r) => r[0]!.startsWith("Qaror kutayotganlar"))!;
    expect(title[0]).toContain("jami 1 ");
    expect(cells.some((r) => r[0] === "Bo'shagan o'rinlar: navbatdagi o'quvchi")).toBe(true);
    expect(cells.some((r) => r[0]!.includes("Sami") && r[2] === "1" && r[3] === "1")).toBe(true);
  });
});

describe("enrolling from the queue", () => {
  beforeEach(() => {
    waitlist.waitlistAdd("G0001", "S0003");
    waitlist.waitlistAdd("G0001", "S0004");
  });

  it("only the first in line may take the one free seat; the entry closes; a second click is refused", () => {
    expect(() => waitlist.waitlistEnroll("W0001", false)).toThrow(/hali bo'sh o'rin yo'q/); // full
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished" });
    expect(() => waitlist.waitlistEnroll("W0002", false)).toThrow(/hali bo'sh o'rin yo'q/); // second in line, one seat
    expect(waitlist.waitlistEnroll("W0001", false)).toContain("faol");
    expect(queue().map((w) => w.status)).toEqual(["enrolled", "waiting"]);
    const mine = read<Enrollment>(ENROLLMENTS).find((e) => e.studentId === "S0003")!;
    expect([mine.groupId, mine.status, mine.startedOn]).toEqual(["G0001", "active", "2026-11-23"]);
    expect(() => waitlist.waitlistEnroll("W0001", false)).toThrow(/allaqachon yopilgan/);
    expect(() => waitlist.waitlistEnroll("W0002", false)).toThrow(/hali bo'sh o'rin yo'q/); // full again
  });

  it("can start the student as a trial, and asks when not told", () => {
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished" });
    h.answers.push("YES");
    waitlist.waitlistEnroll("W0001");
    expect(read<Enrollment>(ENROLLMENTS).find((e) => e.studentId === "S0003")!.status).toBe("trial");
  });

  it("removing an entry moves the line up", () => {
    expect(waitlist.waitlistRemove("W0001")).toContain("olib tashlandi");
    expect(() => waitlist.waitlistRemove("W0001")).toThrow(/yopilgan/);
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished" });
    expect(waitlist.loadOffers().offers.map((o) => o.entryId)).toEqual(["W0002"]);
    expect(() => waitlist.waitlistRemove("W7777")).toThrow(/topilmadi/);
  });
});

describe("capacity rules around the queue", () => {
  it("trials hold a seat; a frozen student does not", () => {
    enroll("E0003", "S0003", "G0001", "trial");
    updateById(ENROLLMENTS, "id", "E0001", { status: "frozen" });
    expect(waitlist.seatState("G0001")).toEqual({ capacity: 2, occupied: 2, waiting: 0 }); // E0002 + the trial
  });

  it("a direct enrollment respects the queue, a lead cannot jump a full group", () => {
    waitlist.waitlistAdd("G0001", "S0003");
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished" });
    expect(() => waitlist.assertSeat("G0001", "S0004")).toThrow(/saqlangan/); // the seat is reserved for S0003
    expect(() => waitlist.assertSeat("G0001", "S0004", { ignoreWaitlist: true })).not.toThrow();
    expect(() => waitlist.assertSeat("G0001", "S0003")).not.toThrow();
    append(LEADS, [{ id: "L0001", fullName: "Lead One", phone: "", source: "", stage: "new", nextFollowUpOn: "", note: "", createdOn: "2026-11-01", studentId: "" }]);
    expect(() => admission.enrollLeadInTrial("L0001", "G0001")).toThrow(/saqlangan|to'lgan/);
    expect(read<Enrollment>(ENROLLMENTS)).toHaveLength(2);
  });

  it("check reports an over-full group, a bad capacity and broken queue rows", () => {
    expect(waitlist.checkCapacity()).toContain("Hammasi joyida");
    enroll("E0003", "S0003", "G0001");
    group("G0002", 0);
    append(WAITLIST, [{ id: "W0009", groupId: "G9999", studentId: "S0001", joinedOn: "2026-11-01", status: "waiting", note: "" }, { id: "W0010", groupId: "G0001", studentId: "S0001", joinedOn: "2026-11-01", status: "waiting", note: "" }]);
    const msg = waitlist.checkCapacity();
    expect(msg).toContain("3 ta o'quvchi, sig'im 2");
    expect(msg).toContain("W0009: guruh topilmadi");
    expect(msg).toContain("W0010: o'quvchi allaqachon guruhda");
  });
});

describe("guardian message drafts for the next in line", () => {
  beforeEach(() => {
    waitlist.waitlistAdd("G0001", "S0003");
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished" });
  });

  it("creates a pending draft with the offer text and sends nothing", () => {
    const msg = waitlist.createSeatDrafts();
    expect(msg).toContain("1 ta bo'sh o'rin xabari loyihasi");
    const d = read<ReminderDraft>(DRAFTS);
    expect(d).toHaveLength(1);
    expect([d[0]!.studentId, d[0]!.status]).toEqual(["S0003", "pending"]);
    expect(d[0]!.text).toContain("Guruh G0001 guruhida 1 ta o'rin bo'shadi");
    expect(h.fetches).toHaveLength(0);
    expect(read<Enrollment>(ENROLLMENTS).filter((e) => e.studentId === "S0003")).toHaveLength(0);
  });

  it("respects consent, the Telegram link and the cooldown", () => {
    updateById(STUDENTS, "id", "S0003", { consentNotify: false });
    expect(waitlist.createSeatDrafts()).toContain("vasiy roziligi yo'q");
    updateById(STUDENTS, "id", "S0003", { consentNotify: true, guardianChatId: "" });
    expect(waitlist.createSeatDrafts()).toContain("Telegramga ulanmagan");
    updateById(STUDENTS, "id", "S0003", { guardianChatId: "555" });
    waitlist.createSeatDrafts();
    expect(waitlist.createSeatDrafts()).toContain("yaqinda eslatma");
    expect(read<ReminderDraft>(DRAFTS)).toHaveLength(1);
  });
});
