import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import { isValidCode } from "../src/domain/qr";
import { qrMatrix } from "../src/domain/qrcode";
import type { AttendanceRow, Entitlement, Student } from "../src/domain/types";
import * as actions from "../src/gas/actions";
import * as qr from "../src/gas/qr";
import { append, read, updateById } from "../src/gas/repo";
import { ATTENDANCE, ENROLLMENTS, ENTITLEMENTS, GROUPS, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;
type S = Student & { qrCode?: string };
const students = (): S[] => read<S>(STUDENTS);
const codeOf = (id: string): string => students().find((s) => s.id === id)!.qrCode as string;
const marks = (): AttendanceRow[] => read<AttendanceRow>(ATTENDANCE);
const scan = (code: string, groupId = "G0001", date = "2026-11-23") => qr.scanQr({ code, groupId, date });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
  const base = { status: "active", phone: "", guardianName: "Dilnoza", guardianChatId: "555", consentNotify: true };
  append(STUDENTS, [
    { id: "S0001", fullName: "Ali Valiyev", ...base },
    { id: "S0002", fullName: "Vali Aliyev", ...base },
    { id: "S0003", fullName: "Outsider", ...base },
  ]);
  append(GROUPS, [{ id: "G0001", name: "IELTS", teacherId: "", monthlyFee: 600_000, status: "active" }, { id: "G0002", name: "Math", teacherId: "", monthlyFee: 400_000, status: "active" }]);
  append(ENROLLMENTS, [
    { id: "E0001", studentId: "S0001", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
    { id: "E0002", studentId: "S0002", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
    { id: "E0003", studentId: "S0003", groupId: "G0002", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" },
  ]);
});
afterEach(() => vi.useRealTimers());

describe("QR codes", () => {
  it("issues a unique valid code to every student once", () => {
    expect(qr.ensureQrCodes()).toEqual(["S0001", "S0002", "S0003"]);
    const codes = students().map((s) => s.qrCode);
    expect(codes.every((c) => isValidCode(c as string))).toBe(true);
    expect(new Set(codes).size).toBe(3);
    expect(qr.ensureQrCodes()).toEqual([]); // nothing new
    expect(students().map((s) => s.qrCode)).toEqual(codes);
  });

  it("does not give a code to a student who left, and rotating replaces the code", () => {
    updateById(STUDENTS, "id", "S0003", { status: "left" });
    qr.ensureQrCodes();
    expect(students().find((s) => s.id === "S0003")!.qrCode).toBeFalsy();
    const old = codeOf("S0001");
    expect(qr.rotateQr("S0001")).toContain("Eski karta endi ishlamaydi");
    expect(codeOf("S0001")).not.toBe(old);
    expect(scan(old).result).toBe("unknown_code");
    expect(() => qr.rotateQr("S9999")).toThrow(/topilmadi/);
  });

  it("the code in a card decodes back to itself", () => {
    qr.ensureQrCodes();
    const code = codeOf("S0001");
    const m = qrMatrix(code);
    const scale = 6;
    const size = (m.length + 8) * scale;
    const px = new Uint8ClampedArray(size * size * 4).fill(255);
    m.forEach((row, r) => row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) { const i = (((r + 4) * scale + y) * size + (c + 4) * scale + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
    }));
    expect(jsQR(px, size, size)?.data).toBe(code);
  });
});

describe("cards", () => {
  it("builds a PDF in Drive with every active student of the group (codes issued first)", () => {
    const msg = qr.qrCards("G0001");
    expect(msg).toContain("2 ta karta tayyor (2 ta yangi kod berildi)");
    expect(msg).toContain("https://drive.google.com/file/d/");
    const [file] = [...h.drive.values()];
    expect(file!.folder).toBe("nazoratly QR kartalar");
    expect(file!.name).toBe("QR-G0001-2026-11-23.pdf");
    expect(file!.content).toContain("Ali Valiyev");
    expect(file!.content).toContain(codeOf("S0001"));
    expect(file!.content).toContain("<svg");
    expect(file!.content).not.toContain("Outsider"); // another group
    expect(file!.content).not.toContain("+998"); // no personal data besides the name on the printed card
  });

  it("refuses an unknown group and a group without students", () => {
    expect(() => qr.qrCards("G9999")).toThrow(/Guruh topilmadi/);
    append(GROUPS, [{ id: "G0003", name: "Empty", teacherId: "", monthlyFee: 1, status: "active" }]);
    expect(() => qr.qrCards("G0003")).toThrow(/faol o'quvchi yo'q/);
  });

  it("sends a card to the guardian only after a person confirms, with consent and a linked chat", () => {
    h.props.set("TELEGRAM_BOT_TOKEN", "123:abc");
    h.answers.push("NO");
    expect(() => qr.sendQrCard("S0001")).toThrow(/Bekor qilindi/);
    expect(h.fetches).toHaveLength(0);
    expect(qr.sendQrCard("S0001")).toContain("vasiyga yuborildi");
    const call = h.fetches.find((f) => f.url.includes("sendDocument"))!;
    expect(call.body.chat_id).toBe("555");
    expect(String(call.body.caption)).toContain("Ali Valiyev");
    updateById(STUDENTS, "id", "S0002", { consentNotify: false });
    expect(() => qr.sendQrCard("S0002")).toThrow(/rozilik bermagan/);
    updateById(STUDENTS, "id", "S0002", { consentNotify: true, guardianChatId: "" });
    expect(() => qr.sendQrCard("S0002")).toThrow(/ulanmagan/);
  });

  it("refuses to send without a configured bot", () => {
    expect(() => qr.sendQrCard("S0001")).toThrow(/Telegram botni sozlang/);
  });
});

describe("scanning", () => {
  beforeEach(() => qr.ensureQrCodes());

  it("marks present once and keeps the mark on a second scan", () => {
    expect(scan(codeOf("S0001"))).toMatchObject({ result: "marked", studentName: "Ali Valiyev", status: "present", previous: null });
    expect(marks()).toEqual([{ date: "2026-11-23", groupId: "G0001", studentId: "S0001", status: "present", minutesLate: 0, demo: false, branchId: "F0001" }]);
    expect(scan(codeOf("S0001"))).toMatchObject({ result: "already_present", status: "present" });
    expect(marks()).toHaveLength(1);
    expect(scan(codeOf("S0002")).result).toBe("marked");
    expect(marks().map((m) => m.studentId)).toEqual(["S0001", "S0002"]);
  });

  it("overwrites absent and excused, keeps late (and its minutes)", () => {
    actions.saveAttendance({ date: "2026-11-23", groupId: "G0001", marks: [{ studentId: "S0001", status: "absent", minutesLate: 0 }, { studentId: "S0002", status: "late", minutesLate: 12 }] });
    expect(scan(codeOf("S0001"))).toMatchObject({ result: "marked", previous: "absent" });
    expect(scan(codeOf("S0002"))).toMatchObject({ result: "already_present", status: "late" });
    const byStudent = Object.fromEntries(marks().map((m) => [m.studentId, m]));
    expect([byStudent.S0001!.status, byStudent.S0002!.status, byStudent.S0002!.minutesLate]).toEqual(["present", "late", 12]);
  });

  it("closes an excused make-up right exactly like manual marking", () => {
    for (const id of ["S0001", "S0002"]) actions.saveAttendance({ date: "2026-11-23", groupId: "G0001", marks: [...marks().filter((m) => m.date === "2026-11-23").map((m) => ({ studentId: m.studentId, status: m.status, minutesLate: 0 })), { studentId: id, status: "excused", minutesLate: 0 }] });
    const before = read<Entitlement>(ENTITLEMENTS).map((e) => [e.studentId, e.status]);
    expect(before).toEqual([["S0001", "open"], ["S0002", "open"]]);
    scan(codeOf("S0001"));
    actions.saveAttendance({ date: "2026-11-23", groupId: "G0001", marks: [{ studentId: "S0001", status: "present", minutesLate: 0 }, { studentId: "S0002", status: "present", minutesLate: 0 }] });
    const after = Object.fromEntries(read<Entitlement>(ENTITLEMENTS).map((e) => [e.studentId, e.status]));
    expect(after.S0001).toBe("cancelled");
    expect(after.S0002).toBe("cancelled"); // the same outcome for the student marked by hand
  });

  it("refusals write nothing: not in the group, unknown, malformed, frozen, inactive group, bad date", () => {
    expect(scan(codeOf("S0003"))).toMatchObject({ result: "not_in_group", studentName: "Outsider" });
    expect(scan("NZQ1-ABCDEFGHJKLMNPQRSTUV").result).toBe("unknown_code");
    expect(scan("hello").result).toBe("bad_code");
    updateById(ENROLLMENTS, "id", "E0002", { status: "frozen" });
    expect(scan(codeOf("S0002")).result).toBe("not_in_group");
    expect(marks()).toEqual([]);
    expect(() => scan(codeOf("S0001"), "G9999")).toThrow(/Guruh topilmadi/);
    expect(() => scan(codeOf("S0001"), "G0001", "23.11.2026")).toThrow(/Sana noto'g'ri/);
    updateById(GROUPS, "id", "G0001", { status: "finished" });
    expect(() => scan(codeOf("S0001"))).toThrow(/faol emas/);
  });

  it("accepts scanner noise and lowercase, and a trial student, but not a student who left", () => {
    expect(scan(`  ${codeOf("S0001").toLowerCase()}\r\n`).result).toBe("marked");
    updateById(ENROLLMENTS, "id", "E0002", { status: "trial" });
    expect(scan(codeOf("S0002")).result).toBe("marked");
    updateById(STUDENTS, "id", "S0001", { status: "left" });
    expect(scan(codeOf("S0001"), "G0001", "2026-11-24").result).toBe("not_in_group");
  });

  it("a scan before the enrollment started is not in the roll call", () => {
    updateById(ENROLLMENTS, "id", "E0001", { startedOn: "2026-12-01" });
    expect(scan(codeOf("S0001")).result).toBe("not_in_group");
  });
});
