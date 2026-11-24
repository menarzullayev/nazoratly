import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportCaption } from "../src/domain/results";
import { append, read } from "../src/gas/repo";
import { ATTENDANCE, CERTIFICATES, ENROLLMENTS, EXAM_RESULTS, EXAMS, GROUPS, MARKS, REPORTS, STUDENTS } from "../src/gas/schema";
import { setupWorkbook } from "../src/gas/setup";
import * as res from "../src/gas/results";
import { handleGet } from "../src/gas/webhook";
import { installHarness, type Harness } from "./harness";

let h: Harness;
const marks = () => read<res.MarkRow>(MARKS);
const reports = () => read<res.ReportRow>(REPORTS);
const certs = () => read<res.CertificateRow>(CERTIFICATES);
const html = (name: string) => [...h.drive.values()].find((f) => f.name === `${name}.pdf`)!.content;
const lastDriveFile = () => [...h.drive.values()].at(-1)!;

function setSetting(label: string, value: string): void {
  const row = h.sheets.get("Sozlamalar")!.data.find((r) => r[0] === label);
  if (!row) throw new Error(`no setting ${label}`);
  row[1] = value;
}
function student(id = "S0001", over: Record<string, unknown> = {}): void {
  append(STUDENTS, [{ id, fullName: id === "S0001" ? "Ғуломов Жасур" : `Student ${id}`, status: "active", phone: "", guardianName: "Dilnoza", guardianChatId: "555", consentNotify: true, ...over }]);
}
function group(id = "G0001", over: Record<string, unknown> = {}): void {
  append(GROUPS, [{ id, name: "Ingliz tili A1", teacherId: "", monthlyFee: 500_000, status: "active", ...over }]);
}
function enroll(id: string, studentId: string, groupId = "G0001", over: Record<string, unknown> = {}): void {
  append(ENROLLMENTS, [{ id, studentId, groupId, startedOn: "2026-01-10", endedOn: "", discountPercent: 0, status: "active", ...over }]);
}
function attend(date: string, status: string, studentId = "S0001", groupId = "G0001"): void {
  append(ATTENDANCE, [{ date, groupId, studentId, status, minutesLate: 0 }]);
}
const base = { studentId: "S0001", groupId: "G0001" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T08:00:00Z"));
  h = installHarness();
  setupWorkbook();
  setSetting("Markaz nomi", "Bilim Plus");
  setSetting("Markaz rekvizitlari (hujjatlarda)", "Toshkent, Chilonzor 9");
  h.props.set("TELEGRAM_BOT_TOKEN", "123:TOKEN");
  student();
  group();
  enroll("E0001", "S0001");
});
afterEach(() => vi.useRealTimers());

describe("notes and grades", () => {
  it("a lesson mark and a month mark are upserts", () => {
    res.saveMark({ ...base, scope: "lesson", date: "2026-11-09", grade: 5, note: "Yaxshi ishladi" });
    res.saveMark({ ...base, scope: "lesson", date: "2026-11-09", grade: 4 }); // replaces, the note goes
    res.saveMark({ ...base, scope: "month", date: "2026-11-17", grade: 4, note: "Faol" }); // any day of the month
    res.saveMark({ ...base, scope: "month", date: "2026-11-01", note: "Faqat izoh" });
    expect(marks().map((m) => [m.scope, m.date, m.grade, m.note])).toEqual([
      ["lesson", "2026-11-09", 4, ""],
      ["month", "2026-11-01", 0, "Faqat izoh"],
    ]);
  });

  it("refuses what the API refuses", () => {
    const lesson = { ...base, scope: "lesson" as const, date: "2026-11-09" };
    for (const grade of [6, -1, 2.5]) expect(() => res.saveMark({ ...lesson, grade })).toThrow("1 dan 5");
    expect(() => res.saveMark({ ...lesson })).toThrow("Baho yoki izoh kerak");
    expect(() => res.saveMark({ ...lesson, note: "   " })).toThrow("Baho yoki izoh kerak");
    expect(() => res.saveMark({ ...lesson, grade: 3, note: "x".repeat(1001) })).toThrow("1000");
    expect(() => res.saveMark({ ...lesson, date: "09.11.2026", grade: 3 })).toThrow("Noto'g'ri sana");
    expect(() => res.saveMark({ ...base, scope: "month", date: "2026-12", grade: 3 })).toThrow("Kelajakdagi oy");
    expect(() => res.saveMark({ ...base, scope: "month", date: "2026-13", grade: 3 })).toThrow("Noto'g'ri oy");
    student("S0002");
    expect(() => res.saveMark({ ...lesson, studentId: "S0002", grade: 3 })).toThrow("yozilmagan");
    expect(() => res.saveMark({ ...lesson, studentId: "S9999", grade: 3 })).toThrow("topilmadi");
    expect(() => res.saveMark({ ...lesson, groupId: "G9999", grade: 3 })).toThrow("topilmadi");
    expect(marks()).toHaveLength(0);
  });

  it("a mark can be removed once; a missing one is reported", () => {
    res.saveMark({ ...base, scope: "month", date: "2026-11-01", grade: 3 });
    res.removeMark({ ...base, scope: "month", date: "2026-11-20" });
    expect(marks()).toHaveLength(0);
    expect(() => res.removeMark({ ...base, scope: "month", date: "2026-11-01" })).toThrow("topilmadi");
  });

  it("the menu asks step by step and saves", () => {
    h.prompts.push("S0001", "G0001", "2026-11-09", "5", "A'lo");
    res.menu.mark();
    expect(marks().map((m) => [m.grade, m.note])).toEqual([[5, "A'lo"]]);
    expect(h.alerts.at(-1)!.message).toContain("baho 5");
    h.prompts.push("S0001", "G0001", "2026-11", "", "Oy izohi");
    res.menu.mark();
    expect(marks().at(-1)).toMatchObject({ scope: "month", date: "2026-11-01", grade: 0, note: "Oy izohi" });
    h.prompts.push("S0001", "G0001", "2026-11", "x", "");
    res.menu.mark(); // a bad grade is shown as a dialog, not thrown
    expect(h.alerts.at(-1)!.message).toContain("son bo'lishi kerak");
  });
});

describe("exams", () => {
  it("one score per student, never above the maximum, only for students of the group", () => {
    const e = res.addExam({ groupId: "G0001", title: "Oraliq test", heldOn: "2026-11-12", maxScore: 40 });
    expect(e.id).toBe("X0001");
    expect(() => res.addExam({ groupId: "G0001", title: " ORALIQ test ", heldOn: "2026-11-12", maxScore: 10 })).toThrow("shunday nomli");
    for (const maxScore of [0, -3, 2.5]) expect(() => res.addExam({ groupId: "G0001", title: "X", heldOn: "2026-11-13", maxScore })).toThrow("butun son");
    expect(() => res.addExam({ groupId: "G0001", title: "", heldOn: "2026-11-13", maxScore: 5 })).toThrow("nomi");
    expect(() => res.addExam({ groupId: "G0001", title: "Y", heldOn: "13/11", maxScore: 5 })).toThrow("sana");
    expect(() => res.addExam({ groupId: "G9999", title: "Y", heldOn: "2026-11-13", maxScore: 5 })).toThrow("Guruh topilmadi");
    res.saveExamResult({ examId: "X0001", studentId: "S0001", score: 30, note: "Yaxshi" });
    res.saveExamResult({ examId: "X0001", studentId: "S0001", score: 40 }); // replaces
    expect(read<res.ExamResultRow>(EXAM_RESULTS).map((r) => [r.studentId, r.score, r.note])).toEqual([["S0001", 40, ""]]);
    expect(() => res.saveExamResult({ examId: "X0001", studentId: "S0001", score: 41 })).toThrow("oshmasin");
    expect(() => res.saveExamResult({ examId: "X0001", studentId: "S0001", score: -1 })).toThrow("butun son");
    expect(() => res.saveExamResult({ examId: "X0001", studentId: "S0001", score: 1.5 })).toThrow("butun son");
    expect(() => res.saveExamResult({ examId: "X0009", studentId: "S0001", score: 1 })).toThrow("Imtihon topilmadi");
    student("S0002");
    expect(() => res.saveExamResult({ examId: "X0001", studentId: "S0002", score: 1 })).toThrow("yozilmagan");
    expect(res.examSummary("X0001")).toContain("Ғуломов Жасур: 40 / 40 (100%)");
  });

  it("the menu adds an exam and enters a score", () => {
    h.prompts.push("G0001", "Test 1", "2026-11-10", "60");
    res.menu.examAdd();
    expect(read<res.ExamRow>(EXAMS)[0]).toMatchObject({ id: "X0001", title: "Test 1", maxScore: 60 });
    h.prompts.push("X0001", "S0001", "45", "");
    res.menu.examScore();
    expect(h.alerts.at(-1)!.message).toContain("45 / 60 (75%)");
  });
});

function prepare(): void {
  for (const [d, s] of [["2026-11-02", "present"], ["2026-11-09", "late"], ["2026-11-16", "absent"], ["2026-11-23", "excused"]] as const) attend(d, s);
  attend("2026-10-26", "absent"); // another month: not counted
  res.saveMark({ ...base, scope: "lesson", date: "2026-11-09", grade: 5, note: "Faol qatnashdi" });
  res.saveMark({ ...base, scope: "lesson", date: "2026-11-16", grade: 4 });
  res.saveMark({ ...base, scope: "month", date: "2026-11-01", grade: 3, note: "Uy vazifasiga e'tibor bering" });
  res.addExam({ groupId: "G0001", title: "Oraliq test", heldOn: "2026-11-12", maxScore: 40 });
  res.saveExamResult({ examId: "X0001", studentId: "S0001", score: 30 });
}

describe("monthly progress report", () => {
  it("carries the same numbers as the API product and is a draft that sends nothing", () => {
    prepare();
    const snap = res.reportSnapshot("S0001", "G0001", "2026-11-01");
    expect([snap.present, snap.late, snap.absent, snap.excused, snap.attendancePercent, snap.averageGrade, snap.monthGrade]).toEqual([1, 1, 1, 1, 67, "4.0", 3]);
    expect(snap.exams).toEqual([{ title: "Oraliq test", heldOn: "2026-11-12", score: 30, maxScore: 40, percent: 75 }]);
    const row = res.makeReport("S0001", "G0001", "2026-11");
    expect(row).toMatchObject({ id: "R0001", status: "draft", percent: "67", average: "4.0", month: "2026-11-01", approvedOn: "" });
    expect(row.link).toMatch(/drive\.google\.com\/file\/d\/FILE1/);
    const text = html("hisobot-2026-11-S0001-G0001");
    for (const needle of ["Bilim Plus", "Toshkent, Chilonzor 9", "OYLIK HISOBOT: 2026 yil noyabr", "Ғуломов Жасур", "Ingliz tili A1", "Davomat: 67%", "O'rtacha baho (1-5): 4.0", "Oy bahosi: 3", "Uy vazifasiga e'tibor bering", "Faol qatnashdi", "Oraliq test", "30 / 40", "75%", "Keldi: 1, kechikdi: 1, kelmadi: 1, sababli: 1"]) expect(text).toContain(needle);
    expect(h.fetches).toHaveLength(0); // making a report never sends
    expect(reports()).toHaveLength(1);
  });

  it("an empty month says so; the draft is regenerated in place", () => {
    const row = res.makeReport("S0001", "G0001", "2026-11");
    expect(row.percent).toBe("");
    expect(html("hisobot-2026-11-S0001-G0001")).toContain("Davomat: ma'lumot yo'q");
    expect(html("hisobot-2026-11-S0001-G0001")).toContain("baho qo'yilmagan");
    res.saveMark({ ...base, scope: "month", date: "2026-11-01", grade: 5 });
    const again = res.makeReport("S0001", "G0001", "2026-11");
    expect(again.id).toBe(row.id);
    expect(again.average).toBe("5.0");
    expect(reports()).toHaveLength(1);
  });

  it("validation: month in the future, student not in the group, bad month", () => {
    expect(() => res.makeReport("S0001", "G0001", "2026-12")).toThrow("Kelajakdagi oy");
    expect(() => res.makeReport("S0001", "G0001", "x")).toThrow("Noto'g'ri oy");
    student("S0002");
    expect(() => res.makeReport("S0002", "G0001", "2026-11")).toThrow("yozilmagan");
    expect(() => res.makeReport("S0001", "G9999", "2026-11")).toThrow("Guruh topilmadi");
    expect(reports()).toHaveLength(0);
  });

  it("is sent only after the confirmed dialog; then it is final", () => {
    prepare();
    const row = res.makeReport("S0001", "G0001", "2026-11");
    h.answers.push("NO");
    expect(() => res.approveReport(row.id)).toThrow("Bekor qilindi");
    expect(h.fetches).toHaveLength(0);
    expect(reports()[0]!.status).toBe("draft");
    expect(res.approveReport(row.id)).toContain("yuborildi");
    expect(h.fetches.map((f) => f.body._method)).toEqual(["sendDocument"]);
    const up = h.fetches[0]!.body;
    expect([up.chat_id, (up.document as { _blob: string })._blob]).toEqual(["555", "hisobot-2026-11-S0001-G0001.pdf"]);
    expect(up.caption).toBe(reportCaption("Bilim Plus", "Ғуломов Жасур", "2026 yil noyabr", 67, "4.0"));
    expect(reports()[0]).toMatchObject({ status: "approved", approvedOn: "2026-11-24" });
    expect(() => res.makeReport("S0001", "G0001", "2026-11")).toThrow("o'zgarmaydi");
    res.approveReport(row.id);
    expect(h.alerts.at(-1)!.message).toContain("allaqachon yuborilgan");
  });

  it("is refused without a token, consent or a linked chat, and a failed upload keeps the draft", () => {
    const row = res.makeReport("S0001", "G0001", "2026-11");
    h.props.delete("TELEGRAM_BOT_TOKEN");
    expect(() => res.approveReport(row.id)).toThrow("Telegram botni sozlang");
    h.props.set("TELEGRAM_BOT_TOKEN", "123:TOKEN");
    h.sheets.get(STUDENTS.sheet)!.data[1]![6] = "Yo'q";
    expect(() => res.approveReport(row.id)).toThrow("rozilik");
    h.sheets.get(STUDENTS.sheet)!.data[1]![6] = "Ha";
    h.sheets.get(STUDENTS.sheet)!.data[1]![5] = "";
    expect(() => res.approveReport(row.id)).toThrow("ulanmagan");
    expect(() => res.approveReport("R9999")).toThrow("topilmadi");
    h.sheets.get(STUDENTS.sheet)!.data[1]![5] = "555";
    h.telegram.handler = () => ({ status: 502, body: { ok: false, description: "bad gateway" } });
    expect(() => res.approveReport(row.id)).toThrow("Telegram xatosi");
    expect(reports()[0]!.status).toBe("draft");
  });

  it("group reports: drafts for active and trial students, approved ones are left alone", () => {
    student("S0002");
    student("S0003");
    student("S0004");
    enroll("E0002", "S0002", "G0001", { status: "trial" });
    enroll("E0003", "S0003", "G0001", { status: "finished", endedOn: "2026-10-01" });
    enroll("E0004", "S0004", "G0001", { status: "frozen" });
    expect(res.makeGroupReports("G0001", "2026-11")).toEqual({ created: 2, regenerated: 0, skippedApproved: 0 });
    res.approveReport("R0001");
    expect(res.makeGroupReports("G0001", "2026-11")).toEqual({ created: 0, regenerated: 1, skippedApproved: 1 });
    expect(reports().map((r) => r.studentId).sort()).toEqual(["S0001", "S0002"]);
    expect(() => res.makeGroupReports("G0001", "2027-01")).toThrow("Kelajakdagi oy");
  });
});

describe("certificates", () => {
  const finish = (): void => {
    h.sheets.get(ENROLLMENTS.sheet)!.data[1]![6] = "Tugagan";
    h.sheets.get(ENROLLMENTS.sheet)!.data[1]![4] = "2026-11-20";
  };

  it("needs a completed course; then it has a number, a code and a PDF; one live certificate per enrollment", () => {
    expect(() => res.issueCertificate("E0001")).toThrow("tugatilgan kurs");
    finish();
    const c = res.issueCertificate("E0001");
    expect(c).toMatchObject({ number: "SR-2026-000001", enrollmentId: "E0001", completedOn: "2026-11-20", issuedOn: "2026-11-24", voided: false });
    expect(c.code).toMatch(/^NZC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const text = html("SR-2026-000001");
    for (const needle of ["Bilim Plus", "SERTIFIKAT", "SR-2026-000001", "Ғуломов Жасур", "Ingliz tili A1", c.code, "10.01.2026", "20.11.2026"]) expect(text).toContain(needle);
    expect(res.issueCertificate("E0001").number).toBe(c.number);
    expect(certs()).toHaveLength(1);
    expect(h.fetches).toHaveLength(0); // issuing sends nothing
  });

  it("eligibility: active in a finished group, never trial or frozen", () => {
    student("S0002");
    student("S0003");
    enroll("E0002", "S0002", "G0001", { status: "trial" });
    enroll("E0003", "S0003", "G0001", { status: "frozen" });
    h.sheets.get(GROUPS.sheet)!.data[1]![5] = "Tugagan";
    expect(res.issueCertificate("E0001").number).toBe("SR-2026-000001");
    expect(() => res.issueCertificate("E0002")).toThrow("tugatilgan kurs");
    expect(() => res.issueCertificate("E0003")).toThrow("tugatilgan kurs");
    expect(() => res.issueCertificate("E9999")).toThrow("topilmadi");
  });

  it("completion date rules and numbering", () => {
    finish();
    expect(() => res.issueCertificate("E0001", "2026-01-09")).toThrow("Tugatgan sana");
    expect(() => res.issueCertificate("E0001", "2026-12-01")).toThrow("Tugatgan sana");
    expect(() => res.issueCertificate("E0001", "yesterday")).toThrow("Noto'g'ri sana");
    expect(res.issueCertificate("E0001", "2026-06-30").completedOn).toBe("2026-06-30");
    student("S0002");
    enroll("E0002", "S0002", "G0001", { status: "finished", endedOn: "2026-11-01" });
    const second = res.issueCertificate("E0002");
    expect(second.number).toBe("SR-2026-000002");
    expect(second.code).not.toBe(certs()[0]!.code);
  });

  it("void needs a reason, a corrected certificate gets a new number and code", () => {
    finish();
    const c = res.issueCertificate("E0001");
    expect(() => res.voidCertificate(c.number, "  ")).toThrow("sabab");
    res.voidCertificate(c.number, "Ism xato");
    expect(certs()[0]).toMatchObject({ voided: true, voidReason: "Ism xato" });
    expect(() => res.voidCertificate(c.number, "again")).toThrow("allaqachon");
    expect(() => res.voidCertificate("SR-2026-000099", "x")).toThrow("topilmadi");
    expect(() => res.sendCertificate(c.number)).toThrow("Bekor qilingan");
    const fresh = res.issueCertificate("E0001");
    expect(fresh.number).toBe("SR-2026-000002");
    expect(fresh.code).not.toBe(c.code);
    expect(res.verifyCertificate(c.code).status).toBe("voided");
    expect(res.verifyCertificate(fresh.code).status).toBe("valid");
  });

  it("verification masks the name and tolerates how the code was typed", () => {
    finish();
    const c = res.issueCertificate("E0001");
    const v = res.verifyCertificate(c.code.toLowerCase().replace(/-/g, " "));
    expect(v).toMatchObject({ status: "valid", number: c.number, center: "Bilim Plus", course: "Ingliz tili A1", holder: "Ғ****** Ж****", completedOn: "2026-11-20" });
    for (const bad of ["", "hello", "NZC-AAAA-AAAA-AAAA", "NZC-ABCD-EFGH-JKLI"]) expect(res.verifyCertificate(bad).status).toBe("unknown");
    // the public web-app check: JSON, masked, no student id
    const out = handleGet({ parameter: { verify: c.code } } as unknown as GoogleAppsScript.Events.DoGet).getContent();
    expect(JSON.parse(out)).toMatchObject({ valid: true, status: "valid", number: c.number, holder: "Ғ****** Ж****" });
    expect(out).not.toContain("Ғуломов");
    expect(out).not.toContain("S0001");
    expect(JSON.parse(handleGet({ parameter: { verify: "NZC-AAAA-AAAA-AAAA" } } as unknown as GoogleAppsScript.Events.DoGet).getContent())).toEqual({ valid: false, status: "unknown" });
    expect(handleGet().getContent()).toBe("nazoratly webhook ishlayapti");
    // the menu shows the same
    h.prompts.push(c.code);
    res.menu.certVerify();
    expect(h.alerts.at(-1)!.message).toContain("HAQIQIY");
    expect(h.alerts.at(-1)!.message).toContain("Ғ****** Ж****");
    h.prompts.push("NZC-AAAA-AAAA-AAAA");
    res.menu.certVerify();
    expect(h.alerts.at(-1)!.message).toContain("topilmadi");
  });

  it("is sent only after the confirmed dialog", () => {
    finish();
    const c = res.issueCertificate("E0001");
    h.answers.push("NO");
    expect(() => res.sendCertificate(c.number)).toThrow("Bekor qilindi");
    expect(h.fetches).toHaveLength(0);
    expect(res.sendCertificate(c.number)).toContain("yuborildi");
    const up = h.fetches[0]!.body;
    expect([up.chat_id, (up.document as { _blob: string })._blob]).toEqual(["555", `${c.number}.pdf`]);
    expect(String(up.caption)).toContain(c.code);
    expect(certs()[0]!.sentOn).toBe("2026-11-24");
    res.sendCertificate(c.number);
    expect(h.alerts.at(-1)!.message).toContain("allaqachon yuborilgan");
    h.sheets.get(STUDENTS.sheet)!.data[1]![6] = "Yo'q";
    expect(() => res.sendCertificate(c.number)).toThrow("rozilik");
  });

  it("the menu issues a certificate", () => {
    finish();
    h.prompts.push("E0001", "");
    res.menu.certIssue();
    expect(h.alerts.at(-1)!.message).toContain("SR-2026-000001");
    expect(lastDriveFile().name).toBe("SR-2026-000001.pdf");
  });
});
