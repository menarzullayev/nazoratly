import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "../../src/gas/actions";
import type { CertificateRow, ExamResultRow, ExamRow, MarkRow, ReportRow } from "../../src/gas/results";
import { read, updateById } from "../../src/gas/repo";
import { CERTIFICATES, ENROLLMENTS, EXAM_RESULTS, EXAMS, GROUPS, MARKS, REPORTS } from "../../src/gas/schema";
import { handleGet } from "../../src/gas/webhook";
import type { Harness } from "../harness";
import { boot, drive, enrollment, group, seedClass, student } from "./support";

let h: Harness;
beforeEach(() => {
  h = boot();
  seedClass({
    students: [student("S0001", { fullName: "Aziz Rahimov", guardianName: "Rahimov", guardianChatId: "555", consentNotify: true }), student("S0002", { fullName: "Madina Tursunova", guardianName: "Tursunov" })],
    groups: [group({ name: "IELTS 6.5" })],
  });
  for (const [d, marks] of [["2026-11-02", ["present", "absent"]], ["2026-11-04", ["present", "present"]], ["2026-11-06", ["late", "present"]], ["2026-11-09", ["present", "absent"]]] as const) {
    actions.saveAttendance({ date: d, groupId: "G0001", marks: [{ studentId: "S0001", status: marks[0], minutesLate: marks[0] === "late" ? 10 : 0 }, { studentId: "S0002", status: marks[1], minutesLate: 0 }] });
  }
});
afterEach(() => vi.useRealTimers());

describe("journey: grades, exams, monthly report, certificate", () => {
  it("sets, replaces and removes grades and notes; refuses a grade outside 1-5", () => {
    drive(h, "menuMarkSet", "S0001", "G0001", "2026-11-04", "5", "A'lo javob berdi");
    drive(h, "menuMarkSet", "S0001", "G0001", "2026-11", "4", "Oy baholandi");
    drive(h, "menuMarkSet", "S0001", "G0001", "2026-11-06", "", "Faqat izoh");
    expect(drive(h, "menuMarkSet", "S0001", "G0001", "2026-11-04", "6", "").last).toMatch(/1-5|baho/i);
    expect(read<MarkRow>(MARKS).map((m) => [m.scope, m.date, m.grade, m.note])).toEqual([
      ["lesson", "2026-11-04", 5, "A'lo javob berdi"],
      ["month", "2026-11-01", 4, "Oy baholandi"],
      ["lesson", "2026-11-06", 0, "Faqat izoh"],
    ]);
    // setting the same lesson again replaces it, never duplicates
    drive(h, "menuMarkSet", "S0001", "G0001", "2026-11-04", "4", "Tuzatildi");
    expect(read<MarkRow>(MARKS).filter((m) => m.date === "2026-11-04")).toHaveLength(1);
    expect(read<MarkRow>(MARKS).find((m) => m.date === "2026-11-04")!.grade).toBe(4);
    expect(drive(h, "menuMarkRemove", "S0001", "G0001", "2026-11-04").last).toBe("Olib tashlandi.");
    expect(read<MarkRow>(MARKS)).toHaveLength(2);
  });

  it("exam: add, score everyone, summary shows percent; bad score and unknown student are refused", () => {
    expect(drive(h, "menuExamAdd", "G0001", "Midterm", "2026-11-10", "50").last).toContain("X0001");
    drive(h, "menuExamScore", "X0001", "S0001", "45", "Yaxshi");
    const second = drive(h, "menuExamScore", "X0001", "S0002", "30", "");
    expect(second.last).toMatch(/Midterm/);
    expect(drive(h, "menuExamScore", "X0001", "S0002", "51", "").last).toMatch(/ball|eng yuqori/i);
    expect(drive(h, "menuExamScore", "E0001", "S0099", "10", "").last).toMatch(/topilmadi|ro'yxatda/i);
    expect(read<ExamResultRow>(EXAM_RESULTS).map((r) => [r.studentId, r.score])).toEqual([["S0001", 45], ["S0002", 30]]);
    const view = drive(h, "menuExamView", "X0001");
    expect(view.last).toContain("90"); // 45 / 50
    expect(view.last).toContain("60"); // 30 / 50
    expect(read<ExamRow>(EXAMS)).toHaveLength(1);
    // re-scoring replaces the result
    drive(h, "menuExamScore", "X0001", "S0002", "40", "Qayta");
    expect(read<ExamResultRow>(EXAM_RESULTS).filter((r) => r.studentId === "S0002")).toHaveLength(1);
  });

  it("monthly report: draft for one student and for the whole group, approve+send needs the owner's yes and a linked guardian", () => {
    h.props.set("TELEGRAM_BOT_TOKEN", "123:abc");
    drive(h, "menuMarkSet", "S0001", "G0001", "2026-11-04", "5", "A'lo");
    const one = drive(h, "menuReportMake", "S0001", "G0001", "2026-11");
    expect(one.last).toContain("Qoralama tayyor: R0001");
    const grp = drive(h, "menuReportGroup", "G0001", "2026-11");
    expect(grp.last).toMatch(/Yangi qoralamalar: 1\. Qayta yaratilgan: 1\./); // S0001 regenerated, S0002 new
    const reports = read<ReportRow>(REPORTS);
    expect(reports.map((r) => [r.studentId, r.status, r.percent])).toEqual([["S0001", "draft", "100"], ["S0002", "draft", "50"]]);
    expect(h.drive.size).toBeGreaterThanOrEqual(2); // PDFs in Drive
    expect(h.fetches).toHaveLength(0); // drafts send nothing

    // the owner declines: nothing is sent
    h.answers.push("NO");
    expect(drive(h, "menuReportSend", "R0001").last).toMatch(/Bekor qilindi/);
    expect(h.fetches).toHaveLength(0);
    // S0002 has no linked guardian: cannot be sent at all
    expect(drive(h, "menuReportSend", "R0002").last).toMatch(/Telegram|ulanmagan|rozilik/i);
    expect(h.fetches).toHaveLength(0);
    // the owner confirms for S0001: one document goes out and the report is final
    const sent = drive(h, "menuReportSend", "R0001");
    expect(sent.last).toContain("vasiyga yuborildi");
    expect(h.fetches.map((f) => f.body._method)).toEqual(["sendDocument"]);
    expect(read<ReportRow>(REPORTS)[0]!.status).toBe("approved");
    // an approved report is not regenerated by the group action
    const again = drive(h, "menuReportGroup", "G0001", "2026-11");
    expect(again.last).toMatch(/o'tkazib yuborilgan: 1/);
  });

  it("certificate: only for a finished course; one live certificate per enrollment; verify by code; void; verification after void", () => {
    const early = drive(h, "menuCertIssue", "E0001", "");
    expect(early.last).toMatch(/tugatilgan kurs/);
    updateById(ENROLLMENTS, "id", "E0001", { status: "finished", endedOn: "2026-11-20" });
    const issued = drive(h, "menuCertIssue", "E0001", "");
    const code = /Tekshirish kodi: (NZC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(issued.last)?.[1];
    expect(code).toBeTruthy();
    const number = /Raqam: (\S+)\./.exec(issued.last)![1]!;
    expect(read<CertificateRow>(CERTIFICATES)).toHaveLength(1);
    // issuing again hands back the same certificate
    const twice = drive(h, "menuCertIssue", "E0001", "");
    expect(twice.last).toContain(number);
    expect(read<CertificateRow>(CERTIFICATES)).toHaveLength(1);
    // anybody can verify by code; the holder's name is masked
    const ok = drive(h, "menuCertVerify", code!);
    expect(ok.last).toContain("HAQIQIY");
    expect(ok.last).not.toContain("Aziz Rahimov");
    const web = JSON.parse(handleGet({ parameter: { verify: code! } } as never).getContent()) as { valid: boolean; holder?: string };
    expect(web.valid).toBe(true);
    expect(web.holder).not.toContain("Rahimov");
    expect(drive(h, "menuCertVerify", "NZC-AAAA-BBBB-CCCC").last).toMatch(/topilmadi/);
    // send needs the owner's yes
    h.props.set("TELEGRAM_BOT_TOKEN", "123:abc");
    h.answers.push("NO");
    drive(h, "menuCertSend", number);
    expect(h.fetches).toHaveLength(0);
    expect(drive(h, "menuCertSend", number).last).toContain("vasiyga yuborildi");
    expect(h.fetches.map((f) => f.body._method)).toEqual(["sendDocument"]);
    // void: reason required, then the code says so, and a voided certificate is never sent
    expect(drive(h, "menuCertVoid", number, " ").last).toMatch(/Qiymat kiritilmadi|sababi/);
    drive(h, "menuCertVoid", number, "Xato berilgan");
    expect(drive(h, "menuCertVerify", code!).last).toContain("BEKOR QILINGAN");
    expect(drive(h, "menuCertSend", number).last).toMatch(/yuborilmaydi/);
    expect(JSON.parse(handleGet({ parameter: { verify: code! } } as never).getContent()).valid).toBe(false);
    void GROUPS;
  });
});
