import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as t from "../src/domain/teacher";

interface Named {
  name: string;
}
type G = {
  invite_normalize: (Named & { in: string; out: string | null })[];
  invite_state: (Named & { status: string; expires_at: string; now: string; out: string })[];
  invite_expires: (Named & { now: string; out: string })[];
  unmarked: (Named & { now: string; after_hours: number; lessons: t.LessonFact[]; out: t.Unmarked[] })[];
  reminder_text: (Named & { group: string; day: string; start: string; end: string; out: string })[];
  digest_due: (Named & { now: string; digest_after: string; today_count: number; already_sent: boolean; out: boolean })[];
  digest_text: (Named & { day: string; items: t.DigestItem[]; out: string })[];
  template: (Named & { code: string; student: string; group: string; day: string; out: string | null })[];
  signed: (Named & { text: string; teacher: string; center: string; out: string })[];
  message_check: (Named & { in: t.MessageCheckIn & { text_repeat?: { char: string; count: number } }; out: t.MessageCheck })[];
  month_summary: (Named & { minutes: number[]; pay_model: string; pay_rate: string; collected: string; out: t.MonthSummary })[];
};
// The same file the Python suite reads (backend/tests/test_golden_teacher.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/teacher.json", import.meta.url), "utf8")) as G;

describe("golden: teacher app rules", () => {
  it.each(golden.invite_normalize)("invite normalize: $name", (c) => expect(t.normalizeInviteCode(c.in)).toBe(c.out));
  it.each(golden.invite_state)("invite state: $name", (c) => expect(t.inviteState(c.status, c.expires_at, c.now)).toBe(c.out));
  it.each(golden.invite_expires)("invite expires: $name", (c) => expect(t.inviteExpiresAt(c.now)).toBe(c.out));
  it.each(golden.unmarked)("unmarked: $name", (c) => expect(t.unmarkedLessons(c.lessons, c.now, c.after_hours)).toEqual(c.out));
  it.each(golden.reminder_text)("reminder text: $name", (c) => expect(t.reminderText(c.group, c.day, c.start, c.end)).toBe(c.out));
  it.each(golden.digest_due)("digest due: $name", (c) => expect(t.digestDue(c.now, c.digest_after, c.today_count, c.already_sent)).toBe(c.out));
  it.each(golden.digest_text)("digest text: $name", (c) => expect(t.digestText(c.day, c.items)).toBe(c.out));
  it.each(golden.template)("template: $name", (c) => expect(t.renderTemplate(c.code, c.student, c.group, c.day)).toBe(c.out));
  it.each(golden.signed)("signed: $name", (c) => expect(t.signedText(c.text, c.teacher, c.center)).toBe(c.out));
  it.each(golden.message_check)("message check: $name", (c) => {
    const { text_repeat: rep, ...i } = c.in;
    if (rep) i.text = rep.char.repeat(rep.count);
    expect(t.checkMessage(i)).toEqual(c.out);
  });
  it.each(golden.month_summary)("month summary: $name", (c) =>
    expect(t.monthSummary(c.minutes, c.pay_model, c.pay_rate, c.collected)).toEqual(c.out),
  );
});
