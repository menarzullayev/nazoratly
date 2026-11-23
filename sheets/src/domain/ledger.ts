/** Hash-chained double-entry journal rules (mirror of backend/src/nazoratly/rules/ledger.py, same golden cases in
 * tests/golden/ledger.json). Money is an integer number of tiyin (1 so'm = 100), so sums are exact; `parseMoney` and
 * `fmtMoney` convert from/to the "500000.00" strings used in the hash and in the golden files. */
import { sha256Hex } from "./sha256";

export const GENESIS = "0".repeat(64);
export const FORMAT = "v1";

export function parseMoney(s: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid money: ${s}`);
  const n = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] ? -n : n;
}

export function fmtMoney(n: number): string {
  const neg = n < 0;
  const a = Math.abs(n);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

export function escapeField(t: string): string {
  return t.replace(/\\/g, "\\\\").replace(/\|/g, "\\p").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

export interface Line {
  seq: number;
  entryNo: number;
  date: string;
  account: string;
  debit: number; // tiyin
  credit: number; // tiyin
  sourceType: string;
  sourceKey: string;
  memo: string;
  prevHash: string;
  hash: string;
}
export type NewLine = Omit<Line, "prevHash" | "hash"> & { prevHash?: string; hash?: string };
export type LineSpec = [account: string, debit: number, credit: number];

export function canonicalLine(prevHash: string, l: NewLine): string {
  return [FORMAT, prevHash, String(l.seq), String(l.entryNo), l.date, l.account, fmtMoney(l.debit), fmtMoney(l.credit), escapeField(l.sourceType), escapeField(l.sourceKey), escapeField(l.memo)].join("|");
}

export const lineHash = (prevHash: string, l: NewLine): string => sha256Hex(canonicalLine(prevHash, l));

export interface Head {
  seq: number;
  entryNo: number;
  hash: string;
}
export const EMPTY_HEAD: Head = { seq: 0, entryNo: 0, hash: GENESIS };

export function sealEntry(head: Head, e: { date: string; memo: string; sourceType: string; sourceKey: string; lines: LineSpec[] }): Line[] {
  const out: Line[] = [];
  let prev = head.hash;
  e.lines.forEach(([account, debit, credit], i) => {
    const base = { seq: head.seq + i + 1, entryNo: head.entryNo + 1, date: e.date, account, debit, credit, sourceType: e.sourceType, sourceKey: e.sourceKey, memo: e.memo };
    const hash = lineHash(prev, base);
    out.push({ ...base, prevHash: prev, hash });
    prev = hash;
  });
  return out;
}

export function nextHead(sealed: Line[]): Head {
  const last = sealed[sealed.length - 1]!;
  return { seq: last.seq, entryNo: last.entryNo, hash: last.hash };
}

export function validateEntry(lines: LineSpec[], accounts: Record<string, boolean>, e: { date: string; closedMonths: ReadonlySet<string> }): string[] {
  const errors: string[] = [];
  const add = (c: string): void => {
    if (!errors.includes(c)) errors.push(c);
  };
  if (lines.length < 2) add("too_few_lines");
  for (const [account, debit, credit] of lines) {
    if (debit < 0 || credit < 0 || debit > 0 === credit > 0) add("bad_line");
    if (!(account in accounts)) add("unknown_account");
    else if (!accounts[account]) add("inactive_account");
  }
  if (lines.reduce((n, l) => n + l[1], 0) !== lines.reduce((n, l) => n + l[2], 0)) add("unbalanced");
  if (e.closedMonths.has(e.date.slice(0, 7))) add("closed_period");
  return errors;
}

export const reverseLines = (lines: LineSpec[]): LineSpec[] => lines.map(([a, d, c]) => [a, c, d]);

export interface Period {
  month: string;
  lastSeq: number;
  headHash: string;
  totalDebit: number;
  totalCredit: number;
  periodHash: string;
}

export const periodHash = (month: string, lastSeq: number, head: string, td: number, tc: number): string => sha256Hex(`period|${month}|${lastSeq}|${head}|${fmtMoney(td)}|${fmtMoney(tc)}|${lastSeq}`);

export function makePeriod(month: string, lines: Line[]): Period {
  const last = lines[lines.length - 1];
  const seq = last ? last.seq : 0;
  const head = last ? last.hash : GENESIS;
  const td = lines.reduce((n, l) => n + l.debit, 0);
  const tc = lines.reduce((n, l) => n + l.credit, 0);
  return { month, lastSeq: seq, headHash: head, totalDebit: td, totalCredit: tc, periodHash: periodHash(month, seq, head, td, tc) };
}

export interface PeriodIssue {
  month: string;
  reason: string;
  seq: number | null;
}
export interface Verdict {
  ok: boolean;
  brokenSeq: number | null;
  reason: string | null;
  periodIssues: PeriodIssue[];
}

function chainProblem(lines: Line[]): { seq: number; reason: string } | null {
  let prev = GENESIS;
  let prevEntry = 0;
  let group: Line[] = [];
  const unbalanced = (): boolean => group.length > 0 && group.reduce((n, x) => n + x.debit, 0) !== group.reduce((n, x) => n + x.credit, 0);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.seq !== i + 1) return { seq: l.seq, reason: "seq_gap" };
    if (l.prevHash !== prev) return { seq: l.seq, reason: "prev_mismatch" };
    if (l.hash !== lineHash(prev, l)) return { seq: l.seq, reason: "hash_mismatch" };
    if (l.debit < 0 || l.credit < 0 || l.debit > 0 === l.credit > 0) return { seq: l.seq, reason: "bad_line" };
    if (l.entryNo === prevEntry) group.push(l);
    else {
      if (l.entryNo !== prevEntry + 1) return { seq: l.seq, reason: "entry_order" };
      if (unbalanced()) return { seq: group[0]!.seq, reason: "unbalanced_entry" };
      group = [l];
      prevEntry = l.entryNo;
    }
    prev = l.hash;
  }
  if (unbalanced()) return { seq: group[0]!.seq, reason: "unbalanced_entry" };
  return null;
}

export function verifyChain(lines: Line[], periods: Period[]): Verdict {
  const problem = chainProblem(lines);
  const issues: PeriodIssue[] = [];
  const bySeq = new Map(lines.map((l) => [l.seq, l]));
  for (const p of [...periods].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))) {
    if (p.periodHash !== periodHash(p.month, p.lastSeq, p.headHash, p.totalDebit, p.totalCredit)) {
      issues.push({ month: p.month, reason: "period_hash_mismatch", seq: null });
      continue;
    }
    let headOk: boolean;
    let td = 0;
    let tc = 0;
    if (p.lastSeq === 0) headOk = p.headHash === GENESIS;
    else if (!bySeq.has(p.lastSeq)) {
      issues.push({ month: p.month, reason: "period_missing", seq: p.lastSeq });
      continue;
    } else {
      headOk = bySeq.get(p.lastSeq)!.hash === p.headHash;
      for (const l of lines) {
        if (l.seq <= p.lastSeq) {
          td += l.debit;
          tc += l.credit;
        }
      }
    }
    if (!headOk) issues.push({ month: p.month, reason: "period_head_mismatch", seq: p.lastSeq });
    else if (td !== p.totalDebit || tc !== p.totalCredit) issues.push({ month: p.month, reason: "period_totals_mismatch", seq: p.lastSeq });
    const late = lines.find((l) => l.seq > p.lastSeq && l.date.slice(0, 7) === p.month);
    if (late) issues.push({ month: p.month, reason: "late_entry", seq: late.seq });
  }
  return { ok: problem === null && issues.length === 0, brokenSeq: problem ? problem.seq : null, reason: problem ? problem.reason : null, periodIssues: issues };
}
