import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalLine, fmtMoney, makePeriod, parseMoney, reverseLines, sealEntry, validateEntry, verifyChain, type Line, type LineSpec, type Period } from "../src/domain/ledger";
import { sha256Hex } from "../src/domain/sha256";

interface JLine { seq: number; entry_no: number; date: string; account: string; debit: string; credit: string; source_type: string; source_key: string; memo: string; prev_hash?: string; hash?: string }
interface JPeriod { month: string; last_seq: number; head_hash: string; total_debit: string; total_credit: string; period_hash: string }
type G = {
  sha256: { text: string; hex: string }[];
  canonical: { name: string; prev: string; line: JLine; canonical: string; hash: string }[];
  seal: { name: string; head: { seq: number; entry_no: number; hash: string }; entry: { date: string; memo: string; source_type: string; source_key: string; lines: string[][] }; out: JLine[] }[];
  validate: { name: string; lines: string[][]; accounts: Record<string, boolean>; date: string; closed_months: string[]; errors: string[] }[];
  verify: { name: string; lines: JLine[]; periods: JPeriod[]; out: { ok: boolean; broken_seq: number | null; reason: string | null; period_issues: { month: string; reason: string; seq: number | null }[] } }[];
  period: { name: string; month: string; lines: JLine[]; out: JPeriod }[];
  reverse: { lines: string[][]; out: string[][] }[];
};
// The same file the Python suite reads (backend/tests/test_golden_ledger.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/ledger.json", import.meta.url), "utf8")) as G;

const GEN = "0".repeat(64);
const line = (j: JLine): Line => ({ seq: j.seq, entryNo: j.entry_no, date: j.date, account: j.account, debit: parseMoney(j.debit), credit: parseMoney(j.credit), sourceType: j.source_type, sourceKey: j.source_key, memo: j.memo, prevHash: j.prev_hash ?? GEN, hash: j.hash ?? "" });
const period = (p: JPeriod): Period => ({ month: p.month, lastSeq: p.last_seq, headHash: p.head_hash, totalDebit: parseMoney(p.total_debit), totalCredit: parseMoney(p.total_credit), periodHash: p.period_hash });
const specs = (rows: string[][]): LineSpec[] => rows.map(([a, d, c]) => [a!, parseMoney(d!), parseMoney(c!)]);
const dump = (l: Line): JLine => ({ seq: l.seq, entry_no: l.entryNo, date: l.date, account: l.account, debit: fmtMoney(l.debit), credit: fmtMoney(l.credit), source_type: l.sourceType, source_key: l.sourceKey, memo: l.memo, prev_hash: l.prevHash, hash: l.hash });
const dumpPeriod = (p: Period): JPeriod => ({ month: p.month, last_seq: p.lastSeq, head_hash: p.headHash, total_debit: fmtMoney(p.totalDebit), total_credit: fmtMoney(p.totalCredit), period_hash: p.periodHash });

describe("golden: ledger rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(60);
  });
  it.each(golden.sha256)("sha256 of $text", (c) => {
    expect(sha256Hex(c.text)).toBe(c.hex);
  });
  it.each(golden.canonical)("canonical line and hash: $name", (c) => {
    const l = line(c.line);
    expect(canonicalLine(c.prev, l)).toBe(c.canonical);
    expect(sha256Hex(canonicalLine(c.prev, l))).toBe(c.hash);
  });
  it.each(golden.seal)("sealEntry: $name", (c) => {
    const got = sealEntry({ seq: c.head.seq, entryNo: c.head.entry_no, hash: c.head.hash }, { date: c.entry.date, memo: c.entry.memo, sourceType: c.entry.source_type, sourceKey: c.entry.source_key, lines: specs(c.entry.lines) });
    expect(got.map(dump)).toEqual(c.out);
  });
  it.each(golden.validate)("validateEntry: $name", (c) => {
    expect(validateEntry(specs(c.lines), c.accounts, { date: c.date, closedMonths: new Set(c.closed_months) })).toEqual(c.errors);
  });
  it.each(golden.verify)("verifyChain: $name", (c) => {
    const v = verifyChain(c.lines.map(line), c.periods.map(period));
    expect({ ok: v.ok, broken_seq: v.brokenSeq, reason: v.reason, period_issues: v.periodIssues }).toEqual(c.out);
  });
  it.each(golden.period)("makePeriod: $name", (c) => {
    expect(dumpPeriod(makePeriod(c.month, c.lines.map(line)))).toEqual(c.out);
  });
  it.each(golden.reverse)("reverseLines", (c) => {
    expect(reverseLines(specs(c.lines))).toEqual(specs(c.out));
  });
});
