import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectColumns, duplicateKeys, findDuplicates, normalizePhone, parseDate, parseDelimited, parseWhole, validateRow, type ImportEntity } from "../src/domain/imports";

type Vals = Record<string, string | number>;
type G = {
  parse_delimited: { name: string; in: { text: string }; out: string[][] }[];
  detect_columns: { name: string; in: { entity: ImportEntity; headers: string[] }; out: Record<string, number | null> }[];
  normalize_phone: { name: string; in: { text: string }; out: string | null }[];
  parse_date: { name: string; in: { text: string }; out: string | null }[];
  parse_whole: { name: string; in: { text: string }; out: number | null }[];
  validate_row: { name: string; in: { entity: ImportEntity; raw: Record<string, string>; today: string }; out: { values: Vals; errors: { field: string; code: string }[] } }[];
  duplicate_keys: { name: string; in: { entity: ImportEntity; values: Vals }; out: string[] }[];
  find_duplicates: { name: string; in: { entity: ImportEntity; rows: (Vals | null)[]; existing: string[] }; out: ({ kind: string; of: number | null } | null)[] }[];
};
// The same file the Python suite reads (backend/tests/test_golden_import.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/import.json", import.meta.url), "utf8")) as G;

describe("golden: import rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(100);
  });
  it.each(golden.parse_delimited)("parseDelimited: $name", (c) => expect(parseDelimited(c.in.text)).toEqual(c.out));
  it.each(golden.detect_columns)("detectColumns: $name", (c) => expect(detectColumns(c.in.entity, c.in.headers)).toEqual(c.out));
  it.each(golden.normalize_phone)("normalizePhone: $name", (c) => expect(normalizePhone(c.in.text)).toBe(c.out));
  it.each(golden.parse_date)("parseDate: $name", (c) => expect(parseDate(c.in.text)).toBe(c.out));
  it.each(golden.parse_whole)("parseWhole: $name", (c) => expect(parseWhole(c.in.text)).toBe(c.out));
  it.each(golden.validate_row)("validateRow: $name", (c) => expect(validateRow(c.in.entity, c.in.raw, c.in.today)).toEqual(c.out));
  it.each(golden.duplicate_keys)("duplicateKeys: $name", (c) => expect(duplicateKeys(c.in.entity, c.in.values)).toEqual(c.out));
  it.each(golden.find_duplicates)("findDuplicates: $name", (c) => expect(findDuplicates(c.in.entity, c.in.rows, new Set(c.in.existing))).toEqual(c.out));
});
