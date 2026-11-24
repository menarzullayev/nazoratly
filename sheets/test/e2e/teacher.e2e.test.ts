import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "../../src/gas/actions";
import { read } from "../../src/gas/repo";
import { TEACHER_INVITES, TEACHER_NOTICES, TEACHERS } from "../../src/gas/schema";
import { acceptInvite } from "../../src/gas/teacher";
import type { Harness } from "../harness";
import { boot, drive, enrollment, group, seedClass, setSetting, student, teacher } from "./support";

let h: Harness;
beforeEach(() => {
  h = boot(); // Monday 2026-11-23, 13:00 in Tashkent
  seedClass({
    teachers: [teacher(), teacher({ id: "T0002", fullName: "Sardor Aliyev" })],
    groups: [group({ schedule: "Du 09:00-10:00" }), group({ id: "G0002", name: "Matematika", teacherId: "T0002", schedule: "Du 11:00-12:00" })],
    students: [student("S0001"), student("S0002")],
    enrollments: [enrollment("E0001", "S0001"), enrollment("E0002", "S0002", { groupId: "G0002" })],
  });
  h.props.set("TELEGRAM_BOT_TOKEN", "123:abc");
});
afterEach(() => vi.useRealTimers());

const inviteCode = (run: { last: string }): string => /Kod: (\S+)/.exec(run.last)![1]!;
const chatOf = (id: string): string => read<{ id: string; telegramChatId?: string }>(TEACHERS).find((t) => t.id === id)!.telegramChatId ?? "";

describe("journey: teacher invitations, owner side", () => {
  it("shows the code once, stores only its hash, a new code revokes the old one, the code links exactly one chat", () => {
    const first = drive(h, "menuTeacherInvite", "T0001");
    const code1 = inviteCode(first);
    expect(code1).toMatch(/^[A-Z0-9-]+$/);
    const stored = JSON.stringify(h.rows("Ustoz taklifnomalari"));
    expect(stored).not.toContain(code1); // only the hash is in the sheet
    const code2 = inviteCode(drive(h, "menuTeacherInvite", "T0001"));
    expect(read<{ status: string }>(TEACHER_INVITES).map((i) => i.status)).toEqual(["revoked", "pending"]);
    // the revoked code no longer works, the new one does, once
    expect(acceptInvite(code1, "90010")).toMatchObject({ ok: false, reason: "revoked" });
    expect(acceptInvite(code2, "90010")).toMatchObject({ ok: true });
    expect(chatOf("T0001")).toBe("90010");
    expect(acceptInvite(code2, "90020")).toMatchObject({ ok: false, reason: "used" });
    // a linked teacher cannot be invited again, an unknown one neither
    expect(drive(h, "menuTeacherInvite", "T0001").last).toMatch(/allaqachon botga ulangan/);
    expect(drive(h, "menuTeacherInvite", "T0099").last).toMatch(/topilmadi/);
    // one chat is one teacher
    const code3 = inviteCode(drive(h, "menuTeacherInvite", "T0002"));
    expect(acceptInvite(code3, "90010")).toMatchObject({ ok: false, reason: "chat_already_teacher" });
    expect(acceptInvite("garbage", "90030")).toMatchObject({ ok: false, reason: "bad_code" });
  });

  it("an invitation expires", () => {
    const code = inviteCode(drive(h, "menuTeacherInvite", "T0001"));
    vi.setSystemTime(new Date("2026-12-30T08:00:00Z"));
    expect(acceptInvite(code, "90010")).toMatchObject({ ok: false, reason: "expired" });
    expect(chatOf("T0001")).toBe("");
  });
});

describe("journey: unmarked lessons, internal reminders, owner digest", () => {
  it("lists unmarked finished lessons; a pass reminds the linked teacher once, skips the unlinked, and never repeats", () => {
    const code = inviteCode(drive(h, "menuTeacherInvite", "T0001"));
    acceptInvite(code, "90010"); // T0002 stays unlinked
    const list = drive(h, "menuTeacherUnmarked").last;
    expect(list).toContain("IELTS");
    expect(list).toContain("Matematika");

    const first = drive(h, "menuTeacherRemind");
    expect(first.last).toContain("Ustozlarga: 2 ta"); // this Monday and last Monday (the list looks 7 days back)
    expect(first.last).toMatch(/Matematika.*ustoz botga ulanmagan/);
    expect(h.fetches.map((f) => [f.body._method, f.body.chat_id])).toEqual([["sendMessage", "90010"], ["sendMessage", "90010"]]);
    expect(read(TEACHER_NOTICES)).toHaveLength(2);

    h.fetches.length = 0;
    const second = drive(h, "menuTeacherRemind");
    expect(second.last).toContain("Ustozlarga: 0 ta");
    expect(h.fetches.filter((f) => f.body.chat_id === "90010")).toEqual([]); // the notice is recorded: no repeat
  });

  it("marking attendance clears the lesson from the list and from the reminders", () => {
    acceptInvite(inviteCode(drive(h, "menuTeacherInvite", "T0001")), "90010");
    actions.saveAttendance({ date: "2026-11-23", groupId: "G0001", marks: [{ studentId: "S0001", status: "present", minutesLate: 0 }] });
    expect(drive(h, "menuTeacherUnmarked").last).not.toContain("2026-11-23 09:00");
    expect(drive(h, "menuTeacherRemind").last).toContain("Ustozlarga: 1 ta"); // only last week's lesson is still unmarked
  });

  it("the day-end digest goes to the owner's chat once, only when the owner chat is set", () => {
    setSetting(h, "Egaga kun yakuni ro'yxati: soat", "12:00");
    const noChat = drive(h, "menuTeacherRemind");
    expect(noChat.last).toMatch(/egasining Telegram chat ID si Sozlamalarda yo'q/);
    setSetting(h, "Egasining Telegram chat ID si", "424242");
    const ok = drive(h, "menuTeacherRemind");
    expect(ok.last).toContain("egaga kun yakuni: 1 ta");
    expect(h.fetches.filter((f) => f.body.chat_id === "424242")).toHaveLength(1);
    h.fetches.length = 0;
    expect(drive(h, "menuTeacherRemind").last).toContain("egaga kun yakuni: 0 ta");
    expect(h.fetches).toEqual([]);
  });

  it("the messaging right toggles per teacher, and the hourly trigger is switched on and off without duplicates", () => {
    const off = drive(h, "menuTeacherMessaging", "T0001");
    expect(off.last).toContain("O'CHIRILDI");
    expect(drive(h, "menuTeacherMessaging", "T0001").last).toContain("YOQILDI");
    expect(drive(h, "menuTeacherMessaging", "T0099").last).toMatch(/topilmadi/);

    expect(drive(h, "menuTeacherTriggerOn").last).toMatch(/Yoqildi/);
    expect(drive(h, "menuTeacherTriggerOn").last).toMatch(/allaqachon yoqilgan/);
    expect(h.triggers).toEqual([{ fn: "teacherTick", everyHours: 1 }]);
    expect(drive(h, "menuTeacherTriggerOff").last).toBe("O'chirildi.");
    expect(h.triggers).toEqual([]);
    expect(drive(h, "menuTeacherTriggerOff").last).toMatch(/yoqilmagan edi/);
  });
});
