import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Enrollment, Group, Lead, Student, Teacher, WaitlistRow } from "../src/domain/types";
import * as importer from "../src/gas/importer";
import * as repo from "../src/gas/repo";
import { append, read } from "../src/gas/repo";
import { ENROLLMENTS, GROUPS, LEADS, STUDENTS, TEACHERS, WAITLIST } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import { installHarness, type Harness } from "./harness";

let h: Harness;
type S = Student & { phone?: string; note?: string };
const students = (): S[] => read<S>(STUDENTS);
const preview = (entity: "students" | "groups" | "leads", text: string, extra: Record<string, unknown> = {}) => importer.importPreview({ entity, text, ...extra });
const commit = (entity: "students" | "groups" | "leads", text: string, extra: Record<string, unknown> = {}) => importer.importCommit({ entity, text, ...extra });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
  append(GROUPS, [{ id: "G0001", name: "IELTS 6.5", teacherId: "", monthlyFee: 600_000, status: "active", capacity: 2 }, { id: "G0002", name: "Math", teacherId: "", monthlyFee: 400_000, status: "finished" }]);
  append(TEACHERS, [{ id: "T0001", fullName: "Dilnoza Karimova", payModel: "per_lesson", payRate: 90_000, status: "active" }]);
});
afterEach(() => vi.useRealTimers());

describe("students: preview", () => {
  it("maps the columns by header and reports each row", () => {
    const p = preview("students", "Ism,Telefon,Tug'ilgan sana,Guruh\nAli Karimov,90 123 45 67,17.05.2010,IELTS 6.5\nBad Phone,12345,,\n,901234500,,\nFuture,,2999-01-01,\nOld School,,,Math\nNoGroup,,,Nowhere\n");
    expect(p.mapping).toMatchObject({ full_name: 0, phone: 1, birth_date: 2, group: 3 });
    expect(p.summary).toEqual({ total: 6, ok: 1, errors: 5, duplicates: 0 });
    const codes = Object.fromEntries(p.rows.map((r) => [r.row, r.errors.map((e) => e.code)]));
    expect(codes).toEqual({ 2: [], 3: ["invalid_phone"], 4: ["required"], 5: ["future_date"], 6: ["group_closed"], 7: ["unknown_group"] });
    expect(p.rows[0]!.values).toEqual({ full_name: "Ali Karimov", phone: "+998901234567", birth_date: "2010-05-17", group: "IELTS 6.5" });
    expect(students()).toHaveLength(0); // a preview writes nothing
  });

  it("detects duplicates inside the file and against the sheet", () => {
    append(STUDENTS, [{ id: "S0001", fullName: "Existing Phone", status: "active", phone: "+998901234567", guardianName: "", guardianChatId: "", consentNotify: false }, { id: "S0002", fullName: "Bare Name", status: "active", phone: "", guardianName: "", guardianChatId: "", consentNotify: false }]);
    const p = preview("students", "name,phone\nNew Person,90 123 45 67\nbare  name,\nTwin,931112233\nTwin Again,93 111 22 33\n");
    expect(p.rows.map((r) => [r.row, r.status, r.duplicate])).toEqual([
      [2, "duplicate", { kind: "existing", ofRow: null }],
      [3, "duplicate", { kind: "existing", ofRow: null }],
      [4, "ok", null],
      [5, "duplicate", { kind: "file", ofRow: 4 }],
    ]);
  });

  it("a full group, and seats reserved for the queue, are row errors", () => {
    append(ENROLLMENTS, [{ id: "E0001", studentId: "S1", groupId: "G0001", startedOn: "2026-01-01", endedOn: "", discountPercent: 0, status: "active" }]);
    const text = "ism,guruh\nA,IELTS 6.5\nB,ielts 6.5\nC,IELTS 6.5\n";
    expect(preview("students", text).rows.map((r) => r.errors.map((e) => e.code))).toEqual([[], ["group_full"], ["group_full"]]);
    append(WAITLIST, [{ id: "W0001", groupId: "G0001", studentId: "S9", joinedOn: "2026-11-01", status: "waiting", note: "" } as WaitlistRow]);
    expect(preview("students", "ism,guruh\nA,IELTS 6.5\n").rows[0]!.errors.map((e) => e.code)).toEqual(["seats_reserved"]);
  });

  it("explains missing required columns, accepts a manual mapping, rejects a broken one", () => {
    const text = "col a;col b\nAli Karimov;90 123 45 67\n";
    const guess = preview("students", text);
    expect(guess.requiredMissing).toEqual(["full_name"]);
    expect(guess.rows).toEqual([]);
    expect(preview("students", text, { mapping: { full_name: 0, phone: 1 } }).summary.ok).toBe(1);
    expect(() => preview("students", text, { mapping: { full_name: 0, phone: 0 } })).toThrow(/ikki maydon/);
    expect(() => preview("students", text, { mapping: { full_name: 9 } })).toThrow(/ustun faylda yo'q/);
    expect(() => preview("students", text, { mapping: { nope: 0 } })).toThrow(/Noma'lum/);
    expect(preview("students", "Ali Karimov;90 123 45 67\n", { hasHeader: false, mapping: { full_name: 0, phone: 1 } }).rows[0]!.row).toBe(1);
  });

  it("limits and formats: empty, too many rows, BOM and CRLF", () => {
    expect(() => preview("students", "")).toThrow(/qatorlar yo'q/);
    expect(() => preview("students", "ism\n" + Array.from({ length: 5001 }, (_, i) => `Kid ${i}`).join("\n"))).toThrow(/5000/);
    expect(preview("students", "﻿ism;telefon\r\nAli;901234567\r\n").summary.ok).toBe(1);
  });
});

describe("students: commit", () => {
  const FILE = "Ism,Telefon,Tug'ilgan sana,Guruh,Ota-ona,Ota-ona telefoni\nAli Karimov,90 123 45 67,17.05.2010,IELTS 6.5,Dilnoza opa,+998 93 111 22 33\nVali Aliyev,+998 91 000 11 22,,,,\n";

  it("writes students and enrollments, keeps birth date and guardian phone in the note", () => {
    const r = commit("students", FILE);
    expect(r).toMatchObject({ created: { students: 2, enrollments: 1 }, skippedErrors: 0, skippedDuplicates: 0 });
    const ali = students().find((s) => s.fullName === "Ali Karimov")!;
    expect([ali.id, ali.phone, ali.guardianName, ali.status, ali.note]).toEqual(["S0001", "+998901234567", "Dilnoza opa", "active", "Tug'ilgan sana: 2010-05-17; Vasiy telefoni: +998931112233"]);
    const e = read<Enrollment>(ENROLLMENTS);
    expect(e).toHaveLength(1);
    expect([e[0]!.studentId, e[0]!.groupId, e[0]!.status, e[0]!.startedOn]).toEqual(["S0001", "G0001", "active", "2026-11-23"]);
    const again = commit("students", FILE);
    expect(again.created).toEqual({}); // every row is a duplicate now
    expect(again.skippedDuplicates).toBe(2);
    expect(students()).toHaveLength(2);
  });

  it("skips error rows, or aborts everything", () => {
    const text = "ism,telefon\nGood,901234567\nBad,12345\nGood Two,931112233\n";
    expect(() => commit("students", text, { onError: "abort" })).toThrow(/Hech narsa yozilmadi/);
    expect(students()).toHaveLength(0);
    const r = commit("students", text);
    expect(r.created).toEqual({ students: 2 });
    expect(r.skippedErrors).toBe(1);
  });

  it("creates duplicates only on request", () => {
    append(STUDENTS, [{ id: "S0001", fullName: "Same", status: "active", phone: "+998901234567", guardianName: "", guardianChatId: "", consentNotify: false }]);
    expect(commit("students", "ism,telefon\nSame,901234567\n").created).toEqual({});
    expect(commit("students", "ism,telefon\nSame,901234567\n", { duplicates: "create" }).created).toEqual({ students: 1 });
    expect(students()).toHaveLength(2);
  });

  it("never overfills a group", () => {
    const r = commit("students", "ism,guruh\nA,IELTS 6.5\nB,IELTS 6.5\nC,IELTS 6.5\nD,IELTS 6.5\n");
    expect(r.created).toEqual({ students: 2, enrollments: 2 });
    expect(r.skippedErrors).toBe(2);
    expect(read<Enrollment>(ENROLLMENTS)).toHaveLength(2);
  });

  it("a failed write removes what this run already wrote", () => {
    const spy = vi.spyOn(repo, "append");
    let calls = 0;
    const real = repo.append;
    spy.mockImplementation((def, rows) => {
      calls++;
      if (def.sheet === ENROLLMENTS.sheet) throw new Error("disk on fire");
      real(def, rows);
    });
    expect(() => commit("students", "ism,guruh\nA,IELTS 6.5\n")).toThrow(/qaytarib olindi/);
    spy.mockRestore();
    expect(calls).toBeGreaterThan(1);
    expect(students()).toHaveLength(0); // the student written before the failure is gone
  });
});

describe("groups and leads", () => {
  it("groups: teacher by name, fee and capacity; course and start date are not stored here", () => {
    const text = "Guruh nomi;O'qituvchi;Oylik to'lov;Sig'im\nIELTS 7;dilnoza karimova;700 000;12\nPlain;;400000;\nGhost;Nobody;1;\nIELTS 6.5;;1;\n";
    const p = preview("groups", text);
    expect(p.requiredMissing).toEqual([]);
    expect(p.rows.map((r) => [r.status, r.errors.map((e) => e.code)])).toEqual([["ok", []], ["ok", []], ["error", ["unknown_teacher"]], ["duplicate", []]]);
    const r = commit("groups", text);
    expect(r.created).toEqual({ groups: 2 });
    const g = read<Group>(GROUPS).find((x) => x.name === "IELTS 7")!;
    expect([g.id, g.teacherId, g.monthlyFee, g.capacity, g.status]).toEqual(["G0003", "T0001", 700_000, 12, "planned"]);
  });

  it("groups: ambiguous teacher names are not guessed", () => {
    append(TEACHERS, [{ id: "T0002", fullName: "Dilnoza Karimova", payModel: "fixed", payRate: 1, status: "active" } as Teacher]);
    expect(preview("groups", "name,teacher,monthly_fee\nG,Dilnoza Karimova,1\n").rows[0]!.errors.map((e) => e.code)).toEqual(["ambiguous_teacher"]);
  });

  it("leads: source text, stage new, duplicates by phone", () => {
    append(LEADS, [{ id: "L0001", fullName: "Old Lead", phone: "+998931112233", source: "", stage: "new", nextFollowUpOn: "", note: "", createdOn: "2026-11-01", studentId: "" }]);
    const text = "Ism,Telefon,Manba,Izoh\nNew Lead,901234567,Instagram,call back\nOld Again,93 111 22 33,Instagram,\n";
    const r = commit("leads", text);
    expect(r).toMatchObject({ created: { leads: 1 }, skippedDuplicates: 1 });
    const l = read<Lead>(LEADS).find((x) => x.fullName === "New Lead")!;
    expect([l.id, l.phone, l.source, l.stage, l.note, l.createdOn]).toEqual(["L0002", "+998901234567", "Instagram", "new", "call back", "2026-11-23"]);
  });
});
