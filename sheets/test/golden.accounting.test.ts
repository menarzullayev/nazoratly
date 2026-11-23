import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHART, accountStatement, balanceSheet, incomeStatement, matchStatement, payablesAging, pendingPostings, postedKey, postingLines, reconciliationSummary, statementFoots, trialBalance,
  type PostingEvent, type Source, type SourceType, type Totals,
} from "../src/domain/accounting";
import { fmtMoney, parseMoney } from "../src/domain/ledger";

type Rec = Record<string, unknown>;
type G = {
  chart: { code: string; name: string; type: string }[];
  posting: { name: string; event: Rec; out: string[][] }[];
  pending: { name: string; today: string; posted: string[][]; sources: Rec[]; out: { kind: string; source_type: string; source_key: string; date: string; lines: string[][] }[] }[];
  trial_balance: { name: string; totals: Record<string, string[]>; out: unknown }[];
  income_statement: { name: string; totals: Record<string, string[]>; out: unknown }[];
  balance_sheet: { name: string; totals: Record<string, string[]>; out: unknown }[];
  account_statement: { name: string; opening: string; side: "debit" | "credit"; lines: { seq: number; date: string; debit: string; credit: string }[]; out: unknown }[];
  aging: { name: string; as_of: string; bills: { id: string; due_date: string; amount: string; paid: string }[]; out: unknown }[];
  match: { name: string; tolerance: number; statement: { id: string; date: string; amount: string }[]; ledger: { seq: number; date: string; amount: string }[]; out: unknown }[];
  foots: { name: string; opening: string; closing: string; lines: { amount: string }[]; out: boolean }[];
  summary: { name: string; closing: string; ledger: string; unmatched_statement: number; unmatched_ledger: number; foots: boolean; out: unknown }[];
};
// The same file the Python suite reads (backend/tests/test_golden_accounting.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/accounting.json", import.meta.url), "utf8")) as G;

const totals = (t: Record<string, string[]>): Totals => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [parseMoney(v[0]!), parseMoney(v[1]!)] as [number, number]]));
const event = (e: Rec): PostingEvent => {
  const amount = parseMoney(String(e.amount));
  switch (e.event) {
    case "payment": return { event: "payment", method: String(e.method), amount };
    case "expense": return { event: "expense", category: String(e.category), amount, paidFrom: e.paid_from as string | undefined, bill: e.bill as boolean | undefined };
    case "bill_payment": return { event: "bill_payment", amount, paidFrom: e.paid_from as string | undefined };
    case "payroll_accrual": return { event: "payroll_accrual", amount };
    default: return { event: "payroll_payment", amount };
  }
};
const fmtLines = (l: [string, number, number][]): string[][] => l.map(([a, d, c]) => [a, fmtMoney(d), fmtMoney(c)]);

describe("golden: accounting rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(90);
  });
  it("chart template matches", () => {
    expect([...CHART]).toEqual(golden.chart);
  });
  it.each(golden.posting)("postingLines: $name", (c) => {
    expect(fmtLines(postingLines(event(c.event)))).toEqual(c.out);
  });
  it.each(golden.pending)("pendingPostings: $name", (c) => {
    const sources: Source[] = c.sources.map((s) => ({ type: s.type as SourceType, key: String(s.key), date: String(s.date), amount: parseMoney(String(s.amount)), voided: Boolean(s.voided), method: s.method as string | undefined, category: s.category as string | undefined, paidFrom: s.paid_from as string | undefined, bill: s.bill as boolean | undefined }));
    const got = pendingPostings(sources, new Set(c.posted.map(([t, k]) => postedKey(t!, k!))), c.today);
    expect(got.map((i) => ({ kind: i.kind, source_type: i.sourceType, source_key: i.sourceKey, date: i.date, lines: fmtLines(i.lines) }))).toEqual(c.out);
  });
  it.each(golden.trial_balance)("trialBalance: $name", (c) => {
    expect(trialBalance(totals(c.totals), golden.chart)).toEqual(c.out);
  });
  it.each(golden.income_statement)("incomeStatement: $name", (c) => {
    expect(incomeStatement(totals(c.totals), golden.chart)).toEqual(c.out);
  });
  it.each(golden.balance_sheet)("balanceSheet: $name", (c) => {
    expect(balanceSheet(totals(c.totals), golden.chart)).toEqual(c.out);
  });
  it.each(golden.account_statement)("accountStatement: $name", (c) => {
    expect(accountStatement(parseMoney(c.opening), c.side, c.lines.map((l) => ({ seq: l.seq, date: l.date, debit: parseMoney(l.debit), credit: parseMoney(l.credit) })))).toEqual(c.out);
  });
  it.each(golden.aging)("payablesAging: $name", (c) => {
    expect(payablesAging(c.bills.map((b) => ({ id: b.id, dueDate: b.due_date, amount: parseMoney(b.amount), paid: parseMoney(b.paid) })), c.as_of)).toEqual(c.out);
  });
  it.each(golden.match)("matchStatement: $name", (c) => {
    expect(matchStatement(c.statement.map((s) => ({ id: s.id, date: s.date, amount: parseMoney(s.amount) })), c.ledger.map((l) => ({ seq: l.seq, date: l.date, amount: parseMoney(l.amount) })), c.tolerance)).toEqual(c.out);
  });
  it.each(golden.foots)("statementFoots: $name", (c) => {
    expect(statementFoots(parseMoney(c.opening), parseMoney(c.closing), c.lines.map((l) => ({ amount: parseMoney(l.amount) })))).toBe(c.out);
  });
  it.each(golden.summary)("reconciliationSummary: $name", (c) => {
    expect(reconciliationSummary(parseMoney(c.closing), parseMoney(c.ledger), c.unmatched_statement, c.unmatched_ledger, c.foots)).toEqual(c.out);
  });
});
