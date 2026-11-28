import { describe, expect, it } from "vitest";
import { addDays, formatAmount, formatDate, formatDateTime, isPositive, monthStart, parseAmount, todayIn } from "../src/lib/format";
import { buildBody, initialValues, type Field } from "../src/ui/formBody";
import { ApiFailure, toFailure } from "../src/api/errors";

describe("money is text, never a float", () => {
  it("groups the server's decimal string without rounding it", () => {
    expect(formatAmount("1200000.00")).toBe("1 200 000");
    expect(formatAmount("999999999999.99")).toBe("999 999 999 999,99");
    expect(formatAmount("-50000.50")).toBe("-50 000,50");
    expect(formatAmount("0.10")).toBe("0,10");
    expect(formatAmount(null)).toBe("—");
  });
  it("reads what a person types and refuses what is not an amount", () => {
    expect(parseAmount("1 200 000")).toBe("1200000");
    expect(parseAmount("1200000,5")).toBe("1200000.5");
    for (const bad of ["", "-1", "1.234", "1e5", "12 so'm", "1,2,3", "1234567890123"]) expect(parseAmount(bad), bad).toBeNull();
  });
  it("tells whether there is money without adding anything", () => {
    expect([isPositive("0.00"), isPositive("0.01"), isPositive("-5"), isPositive(undefined)]).toEqual([false, true, false, false]);
  });
});

describe("dates in the center's time zone", () => {
  const instant = "2026-11-27T20:30:00Z"; // already the 28th in Tashkent
  it("formats moments in that zone and calendar dates without any zone", () => {
    expect(formatDateTime(instant, "Asia/Tashkent")).toBe("28.11.2026 01:30");
    expect(formatDateTime(instant, "UTC")).toBe("27.11.2026 20:30");
    expect(todayIn("Asia/Tashkent", new Date(instant))).toBe("2026-11-28");
    expect(formatDate("2026-03-01")).toBe("01.03.2026");
  });
  it("moves across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(monthStart("2026-11-27")).toBe("2026-11-01");
  });
});

describe("form bodies", () => {
  const fields: Field[] = [
    { name: "name", label: "n", required: true },
    { name: "phone", label: "p" },
    { name: "fee", label: "f", type: "money" },
    { name: "month", label: "m", type: "month" },
    { name: "size", label: "s", type: "number" },
    { name: "on", label: "o", type: "checkbox" },
    { name: "extra", label: "x", required: true, visible: (v) => v.on === true },
  ];
  it("leaves empty fields out of a new record", () => {
    const values = { ...initialValues(fields), name: " Ali ", fee: "1 000", month: "2026-11" };
    expect(buildBody(fields, values)).toEqual({ body: { name: "Ali", fee: "1000", month: "2026-11-01", on: false }, problems: {} });
  });
  it("sends only what an edit changed, and null for what was cleared", () => {
    const original = initialValues(fields, { name: "Ali", phone: "+998901112233", fee: "500000.00", size: 12 });
    expect(original.fee).toBe("500000");
    expect(buildBody(fields, { ...original, phone: "", size: "13" }, original)).toEqual({ body: { phone: null, size: 13 }, problems: {} });
    expect(buildBody(fields, original, original)).toEqual({ body: {}, problems: {} });
  });
  it("names each problem and ignores hidden fields", () => {
    const values = { ...initialValues(fields), fee: "abc", size: "1.5", on: true };
    expect(buildBody(fields, values).problems).toEqual({ name: "required", fee: "money", size: "number", extra: "required" });
  });
});

describe("server errors", () => {
  it("keeps the code, the request id and the field problems", () => {
    const failure = toFailure(422, { error: { code: "validation_error", message: "Request validation failed", request_id: "abc", details: { errors: [{ loc: ["body", "phone"], type: "string_pattern_mismatch" }] } } }, null);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect([failure.code, failure.requestId, failure.fields]).toEqual(["validation_error", "abc", [{ field: "phone", type: "string_pattern_mismatch" }]]);
    expect(toFailure(502, "<html>", "from-header")).toMatchObject({ code: "unknown", requestId: "from-header" });
  });
});
