import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  absenceCheck,
  codeFormatValid,
  codeState,
  linkDecision,
  makeupCheck,
  makeupOptions,
  normalizeCode,
  phoneKey,
  promiseCheck,
  promiseState,
  requestEffect,
  requestTransition,
} from "../src/domain/guardian";

// The same file the Python suite reads (backend/tests/test_golden_guardian.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/guardian.json", import.meta.url), "utf8")) as Record<string, any[]>;
const text = (x: string): string => {
  const m = /^x(\d+)$/.exec(x);
  return m ? "x".repeat(Number(m[1])) : x;
};

describe("golden: guardian cabinet rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(75);
  });
  it.each(golden.normalize_code!)("normalizeCode: $name", (c) => {
    expect(normalizeCode(c.in.text)).toBe(c.out);
  });
  it.each(golden.code_format_valid!)("codeFormatValid: $name", (c) => {
    expect(codeFormatValid(c.in.code)).toBe(c.out);
  });
  it.each(golden.code_state!)("codeState: $name", (c) => {
    expect(codeState({ expiresAt: c.in.expires_at, now: c.in.now, used: c.in.used, revoked: c.in.revoked })).toBe(c.out);
  });
  it.each(golden.link_decision!)("linkDecision: $name", (c) => {
    expect(linkDecision({ method: c.in.method, phoneVerified: c.in.phone_verified, phoneMatches: c.in.phone_matches })).toBe(c.out);
  });
  it.each(golden.phone_key!)("phoneKey: $name", (c) => {
    expect(phoneKey(c.in.phone)).toBe(c.out);
  });
  it.each(golden.absence_check!)("absenceCheck: $name", (c) => {
    expect(absenceCheck({ reason: text(c.in.reason), lessonStart: c.in.lesson_start, now: c.in.now, lessonStatus: c.in.lesson_status, inGroup: c.in.in_group, existingMark: c.in.existing_mark })).toBe(c.out);
  });
  it.each(golden.promise_check!)("promiseCheck: $name", (c) => {
    expect(promiseCheck({ today: c.in.today, promiseDate: c.in.promise_date, outstanding: Number(c.in.outstanding), amount: c.in.amount === null ? null : Number(c.in.amount), maxDays: c.in.max_days, hasActive: c.in.has_active })).toBe(c.out);
  });
  it.each(golden.promise_state!)("promiseState: $name", (c) => {
    expect(promiseState({ status: c.in.status, promiseDate: c.in.promise_date, today: c.in.today, outstanding: Number(c.in.outstanding) })).toBe(c.out);
  });
  it.each(golden.makeup_options!)("makeupOptions: $name", (c) => {
    const candidates = c.in.candidates.map((x: any) => ({ id: x.id, date: x.date, start: x.start, seatsLeft: x.seats_left }));
    expect(makeupOptions({ candidates, today: c.in.today, expiresOn: c.in.expires_on, limit: c.in.limit })).toEqual(c.out);
  });
  it.each(golden.makeup_check!)("makeupCheck: $name", (c) => {
    expect(makeupCheck({ kind: c.in.kind, status: c.in.status, expiresOn: c.in.expires_on, today: c.in.today, slot: c.in.slot, options: c.in.options })).toBe(c.out);
  });
  it.each(golden.request_transition!)("requestTransition: $name", (c) => {
    expect(requestTransition(c.in)).toBe(c.out);
  });
  it.each(golden.request_effect!)("requestEffect: $name", (c) => {
    expect(requestEffect(c.in)).toBe(c.out);
  });
});
