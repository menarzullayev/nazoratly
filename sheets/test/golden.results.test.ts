import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as r from "../src/domain/results";

interface Named {
  name: string;
}
type G = {
  constants: (Named & { key: string; out: string })[];
  grade: (Named & { in: number; out: boolean })[];
  attendance: (Named & { in: string[]; out: r.AttendanceSummary })[];
  average: (Named & { in: number[]; out: string | null })[];
  exam_percent: (Named & { score: string; max: string; out: number })[];
  month_label: (Named & { in: { year: number; month: number }; out: string })[];
  report_caption: (Named & { in: { center: string; student: string; label: string; percent: number | null; average: string | null }; out: string })[];
  eligible: (Named & { enrollment: string; group: string; out: boolean })[];
  number: (Named & { in: { year: number; serial: number }; out: string })[];
  new_code: (Named & { in: number[]; out: string })[];
  parse_code: (Named & { in: string; out: string | null })[];
  mask: (Named & { in: string; out: string })[];
  certificate_caption: (Named & { in: { center: string; student: string; course: string; number: string; code: string }; out: string })[];
};
// The same file the Python suite reads (backend/tests/test_golden_results.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/results.json", import.meta.url), "utf8")) as G;
const consts: Record<string, string> = { certificate_title: r.CERTIFICATE_TITLE, report_title: r.REPORT_TITLE };

describe("golden: learning results rules", () => {
  it.each(golden.constants)("constant: $name", (c) => expect(consts[c.key]).toBe(c.out));
  it.each(golden.grade)("grade: $name", (c) => expect(r.isValidGrade(c.in)).toBe(c.out));
  it.each(golden.attendance)("attendance: $name", (c) => expect(r.attendanceSummary(c.in)).toEqual(c.out));
  it.each(golden.average)("average: $name", (c) => expect(r.averageGrade(c.in)).toBe(c.out));
  it.each(golden.exam_percent)("exam percent: $name", (c) => expect(r.examPercent(Number(c.score), Number(c.max))).toBe(c.out));
  it.each(golden.month_label)("month label: $name", (c) => expect(r.monthLabel(c.in.year, c.in.month)).toBe(c.out));
  it.each(golden.report_caption)("report caption: $name", (c) => expect(r.reportCaption(c.in.center, c.in.student, c.in.label, c.in.percent, c.in.average)).toBe(c.out));
  it.each(golden.eligible)("eligible: $name", (c) => expect(r.certificateEligible(c.enrollment, c.group)).toBe(c.out));
  it.each(golden.number)("number: $name", (c) => expect(r.certificateNumber(c.in.year, c.in.serial)).toBe(c.out));
  it.each(golden.new_code)("new code: $name", (c) => expect(r.newCertificateCode(c.in)).toBe(c.out));
  it("new code needs 12 bytes", () => expect(() => r.newCertificateCode(new Array(11).fill(0))).toThrow());
  it.each(golden.parse_code)("parse code: $name", (c) => expect(r.parseCertificateCode(c.in)).toBe(c.out));
  it.each(golden.mask)("mask: $name", (c) => expect(r.maskName(c.in)).toBe(c.out));
  it.each(golden.certificate_caption)("certificate caption: $name", (c) => expect(r.certificateCaption(c.in.center, c.in.student, c.in.course, c.in.number, c.in.code)).toBe(c.out));
});
