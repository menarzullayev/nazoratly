import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceRow, Enrollment, Group, ReminderDraft, Student, WaitlistRow } from "../../src/domain/types";
import { handlers } from "../../src/Code";
import { read, updateById } from "../../src/gas/repo";
import { ATTENDANCE, DRAFTS, ENROLLMENTS, GROUPS, LEADS, PAYMENTS, STUDENTS, WAITLIST } from "../../src/gas/schema";
import { loadSampleData } from "../../src/gas/setup";
import * as actions from "../../src/gas/actions";
import { scanQr } from "../../src/gas/qr";
import type { Harness } from "../harness";
import { boot, drive, enrollment, group, seedClass, student, teacher } from "./support";
import { append } from "../../src/gas/repo";

let h: Harness;
beforeEach(() => {
  h = boot();
});
afterEach(() => vi.useRealTimers());

type S = Student & { phone?: string; qrCode?: string; note?: string };

describe("journey: import with bad rows (sidebar entry points)", () => {
  beforeEach(() => {
    append(GROUPS, [group({ name: "IELTS 6.5", capacity: 2 }), group({ id: "G0002", name: "Eski guruh", status: "finished" })]);
  });

  it("the menu opens the dialog; the preview flags each bad row and writes nothing", () => {
    const open = vi.fn();
    (globalThis as unknown as { HtmlService: unknown }).HtmlService = { createHtmlOutputFromFile: (f: string) => ({ f, setWidth() { return this; }, setHeight() { return this; } }) };
    const ui = SpreadsheetApp.getUi() as unknown as { showModalDialog: unknown };
    ui.showModalDialog = open;
    handlers.openImport!();
    expect(open).toHaveBeenCalledOnce();

    const text = "Ism,Telefon,Guruh\nAli Karimov,90 123 45 67,IELTS 6.5\nBad Phone,12345,\n,901234500,\nOld,,Eski guruh\nGhost,,Yo'q guruh\nVali Aliyev,93 111 22 33,IELTS 6.5\nExtra Student,,IELTS 6.5\n";
    const p = handlers.importPreview!({ entity: "students", text }) as { summary: { total: number; ok: number; errors: number }; rows: { row: number; errors: { code: string }[] }[] };
    expect(p.summary).toEqual({ total: 7, ok: 2, errors: 5, duplicates: 0 });
    expect(Object.fromEntries(p.rows.map((r) => [r.row, r.errors.map((e) => e.code)]))).toEqual({ 2: [], 3: ["invalid_phone"], 4: ["required"], 5: ["group_closed"], 6: ["unknown_group"], 7: [], 8: ["group_full"] });
    expect(read(STUDENTS)).toEqual([]);
  });

  it("commit skips bad rows and reports them; 'abort' writes nothing; a re-import skips the duplicates", () => {
    const text = "Ism,Telefon,Guruh\nAli Karimov,90 123 45 67,IELTS 6.5\nBad Phone,12345,\nVali Aliyev,93 111 22 33,IELTS 6.5\n";
    const abort = () => handlers.importCommit!({ entity: "students", text, onError: "abort" });
    expect(abort).toThrow(/Hech narsa yozilmadi/);
    expect(read(STUDENTS)).toEqual([]);
    const done = handlers.importCommit!({ entity: "students", text, onError: "skip" }) as { created: Record<string, number>; skippedErrors: number };
    expect(done.created).toEqual({ students: 2, enrollments: 2 });
    expect(done.skippedErrors).toBe(1);
    expect(read<S>(STUDENTS).map((s) => [s.id, s.fullName, s.phone])).toEqual([["S0001", "Ali Karimov", "+998901234567"], ["S0002", "Vali Aliyev", "+998931112233"]]);
    expect(read<Enrollment>(ENROLLMENTS).map((e) => [e.studentId, e.groupId, e.status])).toEqual([["S0001", "G0001", "active"], ["S0002", "G0001", "active"]]);
    // the same file again: the two good rows are duplicates now, the group is full anyway; nothing doubles
    const again = handlers.importCommit!({ entity: "students", text, onError: "skip" }) as { created: Record<string, number>; skippedDuplicates: number };
    expect(again.created).toEqual({});
    expect(again.skippedDuplicates).toBe(2);
    expect(read(STUDENTS)).toHaveLength(2);
  });

  it("groups and leads import through the same entry points", () => {
    const g = handlers.importCommit!({ entity: "groups", text: "Nomi,Narx\nMatematika,400000\nFizika,abc\n", onError: "skip" }) as { created: Record<string, number>; skippedErrors: number };
    expect(g.created).toEqual({ groups: 1 });
    expect(g.skippedErrors).toBe(1);
    const l = handlers.importCommit!({ entity: "leads", text: "Ism,Telefon,Manba\nSherzod,90 555 11 22,Instagram\n", onError: "skip" }) as { created: Record<string, number> };
    expect(l.created).toEqual({ leads: 1 });
    expect(read(LEADS)).toHaveLength(1);
  });
});

describe("journey: QR cards and scanning", () => {
  beforeEach(() => {
    seedClass({ students: [student("S0001", { fullName: "Aziz", guardianName: "Rahimov", guardianChatId: "55501", consentNotify: true }), student("S0002", { fullName: "Madina" })] });
    h.props.set("TELEGRAM_BOT_TOKEN", "123:abc");
  });

  it("issues codes, makes the card PDF, scans a card for attendance, and a rotated card stops working", () => {
    expect(drive(h, "menuQrIssue").last).toContain("2 ta o'quvchiga");
    const codes = read<S>(STUDENTS).map((s) => s.qrCode);
    expect(codes.every(Boolean)).toBe(true);
    expect(new Set(codes).size).toBe(2);
    expect(drive(h, "menuQrCards", "G0001").last).toMatch(/2 ta karta tayyor \(0 ta yangi kod berildi\)/);
    expect(h.drive.size).toBe(1);

    const code = read<S>(STUDENTS).find((s) => s.id === "S0001")!.qrCode!;
    const ok = scanQr({ code, groupId: "G0001", date: "2026-11-23" });
    expect(ok).toMatchObject({ result: "marked", status: "present", studentName: "Aziz" });
    expect(scanQr({ code, groupId: "G0001", date: "2026-11-23" }).result).toBe("already_present");
    expect(scanQr({ code: "garbage", groupId: "G0001", date: "2026-11-23" }).result).not.toBe("marked");
    expect(read<AttendanceRow>(ATTENDANCE).map((a) => [a.studentId, a.status])).toEqual([["S0001", "present"]]);

    // a lost card: rotating invalidates the old code at once
    expect(drive(h, "menuQrRotate", "S0001").last).toContain("Eski karta endi ishlamaydi");
    expect(scanQr({ code, groupId: "G0001", date: "2026-11-25" }).result).not.toBe("marked");
    const fresh = read<S>(STUDENTS).find((s) => s.id === "S0001")!.qrCode!;
    expect(fresh).not.toBe(code);
    expect(scanQr({ code: fresh, groupId: "G0001", date: "2026-11-25" }).result).toBe("marked");
  });

  it("sending a card to the guardian needs consent, a linked chat and the owner's yes", () => {
    drive(h, "menuQrIssue");
    expect(drive(h, "menuQrSend", "S0002").last).toMatch(/rozilik bermagan/);
    h.answers.push("NO");
    expect(drive(h, "menuQrSend", "S0001").last).toMatch(/Bekor qilindi/);
    expect(h.fetches).toHaveLength(0);
    expect(drive(h, "menuQrSend", "S0001").last).toContain("vasiyga yuborildi");
    expect(h.fetches.map((f) => [f.body._method, f.body.chat_id])).toEqual([["sendDocument", "55501"]]);
  });
});

describe("journey: waiting list", () => {
  beforeEach(() => {
    seedClass({
      groups: [group({ capacity: 2 })],
      students: [student("S0001"), student("S0002"), student("S0003", { guardianName: "Qodirov", guardianChatId: "66601", consentNotify: true }), student("S0004")],
      enrollments: [enrollment("E0001", "S0001"), enrollment("E0002", "S0002")],
    });
  });

  it("queue only when the group is full, in order; a freed seat is offered, drafts wait for approval; enroll takes the seat", () => {
    expect(drive(h, "menuWaitAdd", "G0001", "S0001").last).toMatch(/allaqachon bor/);
    const first = drive(h, "menuWaitAdd", "G0001", "S0003");
    expect(first.last).toContain("1-o'rin");
    drive(h, "menuWaitAdd", "G0001", "S0004");
    expect(drive(h, "menuWaitAdd", "G0001", "S0003").last).toMatch(/allaqachon turibdi/);
    // no free seat yet: enrolling the first in line is refused
    expect(drive(h, "menuWaitEnroll", "W0001").last).toMatch(/bo'sh o'rin yo'q|to'la|band/i);
    expect(drive(h, "menuWaitDrafts").last).toContain("0 ta bo'sh o'rin xabari");

    // a student leaves: one seat is free and the FIRST in line gets the offer, not the second
    updateById(ENROLLMENTS, "id", "E0002", { status: "finished", endedOn: "2026-11-22" });
    const view = drive(h, "menuWaitView");
    expect(view.alerts).toEqual([]);
    const row = h.rows("Navbat holati")[1]!;
    expect(String(row[6])).toContain("Student S0003");
    expect(String(row[6])).not.toContain("S0004");
    const drafts = drive(h, "menuWaitDrafts");
    expect(drafts.last).toContain("1 ta bo'sh o'rin xabari loyihasi yaratildi");
    expect(read<ReminderDraft>(DRAFTS).map((d) => [d.studentId, d.status])).toEqual([["S0003", "pending"]]);
    expect(h.fetches).toHaveLength(0); // never sent without approval
    expect(read<Enrollment>(ENROLLMENTS).filter((e) => e.studentId === "S0003")).toEqual([]); // nobody was enrolled by the draft

    // the second in line cannot jump the queue
    expect(drive(h, "menuWaitEnroll", "W0002").last).toBeTruthy();
    expect(read<Enrollment>(ENROLLMENTS).filter((e) => e.studentId === "S0004")).toEqual([]);
    h.answers.push("NO"); // "trial?" -> no, a full member
    expect(drive(h, "menuWaitEnroll", "W0001").last).toContain("S0003 G0001 guruhiga yozildi");
    expect(read<WaitlistRow>(WAITLIST).map((w) => [w.id, w.status])).toEqual([["W0001", "enrolled"], ["W0002", "waiting"]]);
    expect(drive(h, "menuWaitCheck").last).toContain("Hammasi joyida");
    // removing the last waiting entry
    drive(h, "menuWaitRemove", "W0002");
    expect(drive(h, "menuWaitRemove", "W0002").last).toMatch(/allaqachon yopilgan/);
  });

  it("the capacity check reports a group over its limit", () => {
    append(ENROLLMENTS, [enrollment("E0003", "S0003")]);
    const msg = drive(h, "menuWaitCheck").last;
    expect(msg).toContain("1 ta muammo");
    expect(msg).toContain("3 ta o'quvchi, sig'im 2");
  });
});

describe("journey: demo data (sample, clear, refresh)", () => {
  it("loads flagged sample data, clears only demo rows, refuses when a real row depends on demo, refresh rebuilds relative to today", () => {
    const loaded = drive(h, "menuSample");
    expect(loaded.last).toContain("8 o'quvchi");
    expect(read<Student & { demo?: boolean }>(STUDENTS).every((s) => s.demo === true)).toBe(true);
    // demo money never reaches the journal
    expect(h.rows("Jurnal")).toHaveLength(1);

    // a real student and a real payment next to the demo
    append(STUDENTS, [student("S0100", { fullName: "Haqiqiy O'quvchi" })]);
    actions.recordPayment({ studentId: "S0100", amount: 100_000, method: "Naqd", paidOn: "2026-11-20", note: "", notifyGuardian: false });
    const realPayments = read<{ id: string }>(PAYMENTS).filter((p) => !(p as { demo?: boolean }).demo).length;
    expect(realPayments).toBe(1);

    // a real enrollment points at a demo group -> clearing is refused and removes nothing
    const demoGroup = read<Group & { demo?: boolean }>(GROUPS).find((g) => g.demo)!;
    append(ENROLLMENTS, [enrollment("E0100", "S0100", { groupId: demoGroup.id })]);
    const before = read(STUDENTS).length;
    expect(drive(h, "menuDemoClear").last).toMatch(/tozalab bo'lmaydi/);
    expect(read(STUDENTS)).toHaveLength(before);
    updateById(ENROLLMENTS, "id", "E0100", { status: "finished" });
    replaceEnrollment();

    const cleared = drive(h, "menuDemoClear");
    expect(cleared.last).toMatch(/demo qator o'chirildi/);
    expect(read<Student>(STUDENTS).map((s) => s.id)).toEqual(["S0100"]);
    expect(read(PAYMENTS)).toHaveLength(1); // the real payment stays
    expect(drive(h, "menuDemoClear").last).toBe("Demo belgili qator yo'q.");

    // refresh: loads again (ids continue after the real ones) and the real student is untouched
    expect(drive(h, "menuSampleReset").last).toContain("8 o'quvchi");
    expect(read<Student>(STUDENTS).find((s) => s.id === "S0100")!.fullName).toBe("Haqiqiy O'quvchi");
    expect(read<Student>(STUDENTS)).toHaveLength(12);
    expect(() => loadSampleData()).toThrow(/allaqachon yuklangan/);
    void [ATTENDANCE, teacher];
  });

  function replaceEnrollment(): void {
    // the real enrollment is removed by the owner by hand (delete row) so the demo can go
    const sh = h.sheet("Yozilishlar");
    const idCol = 0;
    sh.data = sh.data.filter((r, i) => i === 0 || r[idCol] !== "E0100");
  }
});
