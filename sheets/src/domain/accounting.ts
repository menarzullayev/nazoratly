/** Accounting rules around the journal (mirror of backend/src/nazoratly/rules/accounting.py; same golden cases in
 * tests/golden/accounting.json). Money is integer tiyin; results that are compared in the golden files are formatted
 * with `fmtMoney` ("500000.00"). */
import { daysBetween } from "./dates";
import { fmtMoney, parseMoney, type LineSpec } from "./ledger";

export const CASH = "1000";
export const BANK = "1010";
export const PAYABLES = "2000";
export const SALARY_PAYABLE = "2100";
export const CAPITAL = "3000";
export const TUITION_INCOME = "4000";
export const TEACHER_PAY = "5100";
export const REFUNDS = "4200"; // contra-income: money given back
export const OTHER_INCOME = "4100";
export const CASH_DIFFERENCE = "5900"; // cash short at a daily cash close

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export interface ChartAccount {
  code: string;
  name: string;
  type: AccountType | "?";
}

export const CHART: readonly ChartAccount[] = [
  { code: "1000", name: "Kassa", type: "asset" },
  { code: "1010", name: "Bank hisobi", type: "asset" },
  { code: "2000", name: "Yetkazib beruvchilarga qarz", type: "liability" },
  { code: "2100", name: "O'qituvchilarga oylik qarzi", type: "liability" },
  { code: "3000", name: "Egasi kapitali", type: "equity" },
  { code: "4000", name: "O'quv to'lovlari", type: "income" },
  { code: "4100", name: "Boshqa daromadlar", type: "income" },
  { code: "4200", name: "Qaytarilgan to'lovlar", type: "income" },
  { code: "5000", name: "Ijara", type: "expense" },
  { code: "5010", name: "Kommunal xizmatlar", type: "expense" },
  { code: "5020", name: "Boshqa xodimlar maoshi", type: "expense" },
  { code: "5030", name: "Reklama", type: "expense" },
  { code: "5040", name: "Jihoz", type: "expense" },
  { code: "5050", name: "Soliqlar", type: "expense" },
  { code: "5090", name: "Boshqa xarajatlar", type: "expense" },
  { code: "5100", name: "O'qituvchilar oyligi", type: "expense" },
  { code: "5900", name: "Kassa kamomadi", type: "expense" },
];
export const ACCOUNT_TYPES: readonly AccountType[] = ["asset", "liability", "equity", "income", "expense"];

export const EXPENSE_ACCOUNT: Record<string, string> = { rent: "5000", utilities: "5010", salary: "5020", marketing: "5030", equipment: "5040", tax: "5050", other: "5090" };

export const normalSide = (t: string): "debit" | "credit" => (t === "asset" || t === "expense" ? "debit" : "credit");
export const cashAccount = (method: string): string => (method === "cash" ? CASH : BANK);

export type PostingEvent =
  | { event: "payment"; method: string; amount: number }
  | { event: "expense"; category: string; amount: number; paidFrom?: string; bill?: boolean }
  | { event: "bill_payment"; amount: number; paidFrom?: string }
  | { event: "payroll_accrual"; amount: number }
  | { event: "payroll_payment"; amount: number }
  | { event: "refund"; payout: string; amount: number }
  | { event: "cash_close"; direction: "over" | "short"; amount: number };

export function postingLines(e: PostingEvent): LineSpec[] {
  const amount = e.amount;
  if (amount <= 0) return [];
  switch (e.event) {
    case "payment":
      return [[cashAccount(e.method), amount, 0], [TUITION_INCOME, 0, amount]];
    case "expense": {
      const credit = e.bill ? PAYABLES : (e.paidFrom ?? "cash") === "cash" ? CASH : BANK;
      const expense = EXPENSE_ACCOUNT[e.category];
      if (!expense) throw new Error(`unknown expense category ${e.category}`);
      return [[expense, amount, 0], [credit, 0, amount]];
    }
    case "bill_payment":
      return [[PAYABLES, amount, 0], [(e.paidFrom ?? "cash") === "cash" ? CASH : BANK, 0, amount]];
    case "payroll_accrual":
      return [[TEACHER_PAY, amount, 0], [SALARY_PAYABLE, 0, amount]];
    case "payroll_payment":
      return [[SALARY_PAYABLE, amount, 0], [CASH, 0, amount]];
    case "refund":
      // a refund that stays as credit moves no money, so nothing is posted
      return e.payout === "credit" ? [] : [[REFUNDS, amount, 0], [cashAccount(e.payout), 0, amount]];
    case "cash_close":
      return e.direction === "over" ? [[CASH, amount, 0], [OTHER_INCOME, 0, amount]] : [[CASH_DIFFERENCE, amount, 0], [CASH, 0, amount]];
  }
}

export const SOURCE_TYPES = ["payment", "expense", "bill_payment", "payroll_accrual", "payroll_payment", "refund", "cash_close"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface Source {
  type: SourceType;
  key: string;
  date: string;
  amount: number; // tiyin
  voided: boolean;
  method?: string;
  category?: string;
  paidFrom?: string;
  bill?: boolean;
  payout?: string; // refund: cash | bank | credit
  direction?: "over" | "short"; // cash_close
}
export interface PendingItem {
  kind: "post" | "reverse";
  sourceType: string;
  sourceKey: string;
  date: string;
  lines: LineSpec[];
}

function eventOf(s: Source): PostingEvent {
  switch (s.type) {
    case "payment":
      return { event: "payment", method: s.method ?? "cash", amount: s.amount };
    case "expense":
      return { event: "expense", category: s.category ?? "other", amount: s.amount, paidFrom: s.paidFrom, bill: s.bill };
    case "bill_payment":
      return { event: "bill_payment", amount: s.amount, paidFrom: s.paidFrom };
    case "payroll_accrual":
      return { event: "payroll_accrual", amount: s.amount };
    case "payroll_payment":
      return { event: "payroll_payment", amount: s.amount };
    case "refund":
      return { event: "refund", payout: s.payout ?? "cash", amount: s.amount };
    case "cash_close":
      return { event: "cash_close", direction: s.direction ?? "over", amount: s.amount };
  }
}

/** `posted` holds `"<source_type>\u0000<source_key>"` strings; use `postedKey`. */
export const postedKey = (type: string, key: string): string => `${type}\u0000${key}`;

export function pendingPostings(sources: Source[], posted: ReadonlySet<string>, today: string): PendingItem[] {
  const out: PendingItem[] = [];
  for (const s of sources) {
    const lines = postingLines(eventOf(s));
    if (lines.length === 0) continue;
    if (!posted.has(postedKey(s.type, s.key))) {
      if (!s.voided) out.push({ kind: "post", sourceType: s.type, sourceKey: s.key, date: s.date, lines });
    } else if (s.voided && !posted.has(postedKey(`${s.type}_void`, s.key))) {
      out.push({ kind: "reverse", sourceType: `${s.type}_void`, sourceKey: s.key, date: today, lines: [] });
    }
  }
  const order = (t: string): number => SOURCE_TYPES.indexOf(t.replace(/_void$/, "") as SourceType);
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => cmp(a.date, b.date) || order(a.sourceType) - order(b.sourceType) || cmp(a.sourceKey, b.sourceKey) || cmp(a.kind, b.kind));
}

// ---- reports -------------------------------------------------------------------------------------------------------
export type Totals = Record<string, [debit: number, credit: number]>;
export interface ChartInfo {
  code: string;
  name: string;
  type: string;
}

export function trialBalance(totals: Totals, chart: readonly ChartInfo[]) {
  const info = new Map(chart.map((a) => [a.code, a]));
  const rows: Record<string, string>[] = [];
  let sd = 0;
  let sc = 0;
  let sbd = 0;
  let sbc = 0;
  for (const code of Object.keys(totals).sort()) {
    const [d, c] = totals[code]!;
    if (d === 0 && c === 0) continue;
    const net = d - c;
    const bd = net > 0 ? net : 0;
    const bc = net > 0 ? 0 : -net;
    const a = info.get(code) ?? { name: code, type: "?" };
    rows.push({ code, name: a.name, type: a.type, debit: fmtMoney(d), credit: fmtMoney(c), balance_debit: fmtMoney(bd), balance_credit: fmtMoney(bc) });
    sd += d;
    sc += c;
    sbd += bd;
    sbc += bc;
  }
  return { rows, total_debit: fmtMoney(sd), total_credit: fmtMoney(sc), total_balance_debit: fmtMoney(sbd), total_balance_credit: fmtMoney(sbc), balanced: sd === sc };
}

const natural = (totals: Totals, code: string, type: string): number => {
  const [d, c] = totals[code] ?? [0, 0];
  return normalSide(type) === "debit" ? d - c : c - d;
};
const byCode = (chart: readonly ChartInfo[]): ChartInfo[] => [...chart].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

export function incomeStatement(totals: Totals, chart: readonly ChartInfo[]) {
  const income: { code: string; name: string; amount: string }[] = [];
  const expenses: { code: string; name: string; amount: string }[] = [];
  let ti = 0;
  let te = 0;
  for (const a of byCode(chart)) {
    if (a.type !== "income" && a.type !== "expense") continue;
    const amount = natural(totals, a.code, a.type);
    if (amount === 0) continue;
    const row = { code: a.code, name: a.name, amount: fmtMoney(amount) };
    if (a.type === "income") {
      income.push(row);
      ti += amount;
    } else {
      expenses.push(row);
      te += amount;
    }
  }
  return { income, expenses, total_income: fmtMoney(ti), total_expenses: fmtMoney(te), net: fmtMoney(ti - te) };
}

export function balanceSheet(totals: Totals, chart: readonly ChartInfo[]) {
  const groups: Record<string, { code: string; name: string; amount: string }[]> = { asset: [], liability: [], equity: [] };
  const sums: Record<string, number> = { asset: 0, liability: 0, equity: 0 };
  let result = 0;
  for (const a of byCode(chart)) {
    const amount = natural(totals, a.code, a.type);
    const g = groups[a.type];
    if (g) {
      if (amount === 0) continue;
      g.push({ code: a.code, name: a.name, amount: fmtMoney(amount) });
      sums[a.type] = sums[a.type]! + amount;
    } else result += a.type === "income" ? amount : -amount;
  }
  const equityTotal = sums.equity! + result;
  return {
    assets: groups.asset!,
    liabilities: groups.liability!,
    equity: groups.equity!,
    current_result: fmtMoney(result),
    total_assets: fmtMoney(sums.asset!),
    total_liabilities: fmtMoney(sums.liability!),
    total_equity: fmtMoney(equityTotal),
    balanced: sums.asset === sums.liability! + equityTotal,
  };
}

export function accountStatement(opening: number, side: "debit" | "credit", lines: { seq: number; date: string; debit: number; credit: number }[]) {
  let bal = opening;
  const rows = [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((l) => {
      bal += side === "debit" ? l.debit - l.credit : l.credit - l.debit;
      return { seq: l.seq, date: l.date, debit: fmtMoney(l.debit), credit: fmtMoney(l.credit), balance: fmtMoney(bal) };
    });
  return { opening: fmtMoney(opening), rows, closing: fmtMoney(bal) };
}

// ---- payables aging ------------------------------------------------------------------------------------------------
export const BUCKETS = ["not_due", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
const bucketOf = (days: number): (typeof BUCKETS)[number] => (days <= 0 ? "not_due" : days <= 30 ? "d1_30" : days <= 60 ? "d31_60" : days <= 90 ? "d61_90" : "d90_plus");

export function payablesAging(bills: { id: string; dueDate: string; amount: number; paid: number }[], asOf: string) {
  const totals: Record<string, number> = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const rows: { id: string; due_date: string; outstanding: string; days_overdue: number; bucket: string }[] = [];
  const sorted = [...bills].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const b of sorted) {
    const left = b.amount - b.paid;
    if (left <= 0) continue;
    const days = daysBetween(b.dueDate, asOf);
    const bucket = bucketOf(days);
    totals[bucket] = totals[bucket]! + left;
    rows.push({ id: b.id, due_date: b.dueDate, outstanding: fmtMoney(left), days_overdue: Math.max(days, 0), bucket });
  }
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, fmtMoney(totals[b]!)]));
  return { rows, buckets, total: fmtMoney(BUCKETS.reduce((n, b) => n + totals[b]!, 0)) };
}

// ---- bank statement reconciliation -----------------------------------------------------------------------------------
export const statementFoots = (opening: number, closing: number, lines: { amount: number }[]): boolean => opening + lines.reduce((n, l) => n + l.amount, 0) === closing;

export function matchStatement(statement: { id: string; date: string; amount: number }[], ledger: { seq: number; date: string; amount: number }[], toleranceDays: number) {
  const used = new Set<number>();
  const matches: { statement_line: string; seq: number }[] = [];
  const unmatchedStatement: string[] = [];
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  for (const s of [...statement].sort((a, b) => cmp(a.date, b.date) || cmp(a.id, b.id))) {
    let best: { dist: number; date: string; seq: number } | null = null;
    for (const l of ledger) {
      if (used.has(l.seq) || l.amount !== s.amount) continue;
      const dist = Math.abs(daysBetween(s.date, l.date));
      if (dist > toleranceDays) continue;
      if (best === null || dist < best.dist || (dist === best.dist && (l.date < best.date || (l.date === best.date && l.seq < best.seq)))) best = { dist, date: l.date, seq: l.seq };
    }
    if (best === null) unmatchedStatement.push(s.id);
    else {
      used.add(best.seq);
      matches.push({ statement_line: s.id, seq: best.seq });
    }
  }
  return { matches, unmatched_statement: unmatchedStatement, unmatched_ledger: ledger.filter((l) => !used.has(l.seq)).map((l) => l.seq).sort((a, b) => a - b) };
}

export function reconciliationSummary(closing: number, ledgerBalance: number, unmatchedStatement: number, unmatchedLedger: number, foots: boolean) {
  const diff = closing - ledgerBalance;
  return { difference: fmtMoney(diff), reconciled: foots && diff === 0 && unmatchedStatement === 0 && unmatchedLedger === 0 };
}

export { parseMoney };
