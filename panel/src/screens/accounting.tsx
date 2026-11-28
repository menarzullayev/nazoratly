/** The books: chart of accounts, cash desks and banks, the journal, statements and reports, periods. Entries are never
 * edited: a mistake is corrected by its reversal. Whether an entry balances is the server's decision. */

import { useState } from "react";
import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { formatAmount, formatDate, monthStart, parseAmount } from "../lib/format";
import { useStaff } from "../session/context";
import { Dialog, Form, FormButton } from "../ui/form";
import { useAction, useLoad } from "../ui/hooks";
import { Badge, Card, Done, ErrorNote, Facts, Loaded, Page, PAGE_SIZE, Pager, Table, Tabs } from "../ui/kit";

type Account = components["schemas"]["AccountOut"];
type Entry = components["schemas"]["EntryOut"];
type Named = components["schemas"]["NamedAmount"];

const TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export const SOURCES = [
  "manual", "reversal", "payment", "payment_void", "expense", "expense_void", "bill_payment", "bill_payment_void", "payroll_accrual",
  "payroll_payment", "refund", "cash_close",
] as const;

export function useAccounts() {
  return useLoad(() => unwrap(api.GET("/v1/accounting/accounts", { params: { query: { include_inactive: true } } })), []);
}

export function AccountsPage() {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const accounts = useAccounts();
  const cash = useLoad(() => unwrap(api.GET("/v1/accounting/cash-accounts")), []);
  const writes = can("accounting:write");
  const reload = () => {
    accounts.reload();
    cash.reload();
  };
  return (
    <Page
      title={t("nav.accounts")}
      actions={
        writes ? (
          <>
            <FormButton
              label={t("accounting.addAccount")}
              className="primary"
              initial={{ type: "expense" }}
              fields={[
                { name: "code", label: t("accounting.code"), required: true, maxLength: 20 },
                { name: "name", label: t("common.name"), required: true, maxLength: 200 },
                { name: "type", label: t("accounting.type"), type: "select", required: true, options: TYPES.map((x) => ({ value: x, label: label("accountType", x) })) },
              ]}
              submit={async (body, key) => {
                await unwrap(api.POST("/v1/accounting/accounts", { body: body as never, ...idempotent(key) }));
                reload();
              }}
            />
            <FormButton
              label={t("accounting.addCash")}
              initial={{ kind: "cash" }}
              fields={[
                { name: "name", label: t("common.name"), required: true, maxLength: 200 },
                { name: "kind", label: t("accounting.cashKind"), type: "select", required: true, options: ["cash", "bank"].map((x) => ({ value: x, label: label("paidFrom", x) })) },
                { name: "code", label: t("accounting.code"), required: true, maxLength: 20, hint: t("accounting.cashCodeHint") },
              ]}
              submit={async (body, key) => {
                await unwrap(api.POST("/v1/accounting/cash-accounts", { body: body as never, ...idempotent(key) }));
                reload();
              }}
            />
          </>
        ) : null
      }
    >
      <Card title={t("accounting.cashAccounts")}>
        <Loaded load={cash}>
          {(rows) => (
            <Table
              caption={t("accounting.cashAccounts")}
              rows={rows}
              rowKey={(c) => c.id}
              columns={[
                { head: t("common.name"), cell: (c) => c.name },
                { head: t("accounting.cashKind"), cell: (c) => label("paidFrom", c.kind) },
                { head: t("accounting.code"), cell: (c) => c.account_code },
                { head: t("finance.balance"), cell: (c) => formatAmount(c.balance), className: "num" },
              ]}
            />
          )}
        </Loaded>
      </Card>
      <Card title={t("accounting.chart")}>
        <Loaded load={accounts}>
          {(rows) => (
            <Table
              caption={t("accounting.chart")}
              rows={rows}
              rowKey={(a) => a.id}
              columns={[
                { head: t("accounting.code"), cell: (a) => a.code },
                { head: t("common.name"), cell: (a) => a.name },
                { head: t("accounting.type"), cell: (a) => label("accountType", a.type) },
                { head: t("accounting.side"), cell: (a) => label("side", a.normal_side) },
                { head: t("common.status"), cell: (a) => (a.active ? <Badge tone="good">{t("accounting.active")}</Badge> : <Badge>{t("accounting.inactive")}</Badge>) },
                {
                  head: t("common.actions"),
                  cell: (a: Account) =>
                    writes ? (
                      <FormButton
                        label={t("common.edit")}
                        title={`${a.code} · ${a.name}`}
                        patch
                        initial={a}
                        fields={[
                          { name: "name", label: t("common.name"), required: true, maxLength: 200 },
                          { name: "active", label: t("accounting.active"), type: "checkbox" },
                        ]}
                        submit={async (body) => {
                          await unwrap(api.PATCH("/v1/accounting/accounts/{account_id}", { params: { path: { account_id: a.id } }, body: body as never }));
                          reload();
                        }}
                      />
                    ) : null,
                },
              ]}
            />
          )}
        </Loaded>
      </Card>
    </Page>
  );
}

interface Line {
  account: string;
  debit: string;
  credit: string;
}
const EMPTY: Line = { account: "", debit: "", credit: "" };

/** A manual entry: lines of account, debit, credit. The server checks that they balance and refuses otherwise. */
function ManualEntry({ done, onClose }: { done: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const { today } = useStaff();
  const accounts = useAccounts();
  const [date, setDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }, { ...EMPTY }]);
  const save = useAction();
  const set = (index: number, field: keyof Line, value: string) => setLines((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  // a line has exactly one side filled with an amount the API can take
  const parsed = lines.map((l) => {
    const text = l.debit || l.credit;
    const amount = parseAmount(text);
    return l.account && amount !== null && !(l.debit && l.credit) ? { account: l.account, ...(l.debit ? { debit: amount } : { credit: amount }) } : null;
  });
  const ready = date !== "" && memo.trim() !== "" && parsed.every((l) => l !== null);
  return (
    <Dialog title={t("accounting.manualEntry")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          void save.run(async (key) => {
            await unwrap(api.POST("/v1/accounting/entries", { body: { date, memo: memo.trim(), lines: parsed as components["schemas"]["EntryLineIn"][] }, ...idempotent(key) }));
            done();
            onClose();
          });
        }}
      >
        <div className="field">
          <label htmlFor="entry-date">{t("common.date")}</label>
          <input id="entry-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="entry-memo">{t("accounting.memo")}</label>
          <input id="entry-memo" maxLength={500} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
        {lines.map((l, i) => (
          <div className="filters" key={i}>
            <label>
              {t("accounting.accountOf", { n: i + 1 })}
              <select value={l.account} onChange={(e) => set(i, "account", e.target.value)}>
                <option value="">{t("common.choose")}</option>
                {(accounts.data ?? []).filter((a) => a.active).map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("accounting.debitOf", { n: i + 1 })}
              <input inputMode="decimal" value={l.debit} onChange={(e) => set(i, "debit", e.target.value)} />
            </label>
            <label>
              {t("accounting.creditOf", { n: i + 1 })}
              <input inputMode="decimal" value={l.credit} onChange={(e) => set(i, "credit", e.target.value)} />
            </label>
          </div>
        ))}
        <p className="hint">{t("accounting.entryHint")}</p>
        {save.error ? <ErrorNote error={save.error} /> : null}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={!ready || save.pending}>
            {t("accounting.post")}
          </button>
          <button type="button" disabled={lines.length >= 100} onClick={() => setLines([...lines, { ...EMPTY }])}>
            {t("accounting.addLine")}
          </button>
          <button type="button" disabled={lines.length <= 2} onClick={() => setLines(lines.slice(0, -1))}>
            {t("accounting.removeLine")}
          </button>
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EntryDialog({ id, onClose, done }: { id: string; onClose: () => void; done: () => void }) {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/accounting/entries/{entry_id}", { params: { path: { entry_id: id } } })), [id]);
  const [reversing, setReversing] = useState(false);
  return (
    <Dialog title={t("accounting.entry")} onClose={onClose}>
      <Loaded load={load}>
        {(e: Entry) => (
          <>
            <Facts
              items={[
                [t("accounting.entryNo"), e.entry_no],
                [t("common.date"), formatDate(e.date)],
                [t("accounting.source"), label("sourceType", e.source_type)],
                [t("accounting.memo"), e.memo],
              ]}
            />
            <Table
              caption={t("accounting.entry")}
              rows={e.lines}
              rowKey={(l) => String(l.seq)}
              columns={[
                { head: t("accounting.account"), cell: (l) => `${l.account_code} · ${l.account_name}` },
                { head: t("accounting.debit"), cell: (l) => formatAmount(l.debit), className: "num" },
                { head: t("accounting.credit"), cell: (l) => formatAmount(l.credit), className: "num" },
                { head: t("accounting.line"), cell: (l) => l.seq, className: "num" },
              ]}
            />
            {e.reversed_by_entry_id ? <Badge tone="warn">{t("accounting.reversed")}</Badge> : null}
            {e.reverses_entry_id ? <Badge>{t("accounting.isReversal")}</Badge> : null}
            {can("accounting:write") && !e.reversed_by_entry_id && !e.reverses_entry_id ? (
              reversing ? (
                <Form
                  initial={{ date: today }}
                  extra={<p>{t("accounting.reverseText")}</p>}
                  fields={[
                    { name: "date", label: t("common.date"), type: "date" },
                    { name: "memo", label: t("accounting.memo"), maxLength: 500 },
                  ]}
                  submitLabel={t("accounting.reverse")}
                  danger
                  onCancel={() => setReversing(false)}
                  submit={async (body, key) => {
                    await unwrap(api.POST("/v1/accounting/entries/{entry_id}/reverse", { params: { path: { entry_id: id } }, body: body as never, ...idempotent(key) }));
                    done();
                    onClose();
                  }}
                />
              ) : (
                <div className="actions">
                  <button type="button" className="danger-quiet" onClick={() => setReversing(true)}>
                    {t("accounting.reverse")}
                  </button>
                </div>
              )
            ) : null}
          </>
        )}
      </Loaded>
    </Dialog>
  );
}

function Journal() {
  const { t, label } = useI18n();
  const accounts = useAccounts();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [account, setAccount] = useState("");
  const [source, setSource] = useState("");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const { can } = useStaff();
  const load = useLoad(
    () =>
      unwrap(
        api.GET("/v1/accounting/entries", {
          params: { query: { date_from: from || undefined, date_to: to || undefined, account: account || undefined, source_type: source || undefined, offset, limit: PAGE_SIZE } },
        }),
      ),
    [from, to, account, source, offset],
  );
  return (
    <>
      {can("accounting:write") ? (
        <div className="actions">
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            {t("accounting.manualEntry")}
          </button>
        </div>
      ) : null}
      <div className="filters">
        <label>
          {t("common.from")}
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
        </label>
        <label>
          {t("common.to")}
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />
        </label>
        <label>
          {t("accounting.account")}
          <select value={account} onChange={(e) => { setAccount(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.code} value={a.code}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("accounting.source")}
          <select value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {label("sourceType", s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("accounting.journal")}
              rows={page.items}
              rowKey={(e) => e.id}
              columns={[
                { head: t("accounting.entryNo"), cell: (e) => e.entry_no, className: "num" },
                { head: t("common.date"), cell: (e) => formatDate(e.date) },
                { head: t("accounting.source"), cell: (e) => label("sourceType", e.source_type) },
                { head: t("accounting.memo"), cell: (e) => e.memo },
                { head: t("common.actions"), cell: (e) => <button type="button" onClick={() => setOpen(e.id)}>{t("common.open")}</button> },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
      {open ? <EntryDialog id={open} onClose={() => setOpen(null)} done={load.reload} /> : null}
      {adding ? <ManualEntry onClose={() => setAdding(false)} done={load.reload} /> : null}
    </>
  );
}

/** Closing months, posting what is missing and verifying the hash chain. */
function Periods() {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const periods = useLoad(() => unwrap(api.GET("/v1/accounting/periods")), []);
  const pending = useLoad(() => unwrap(api.GET("/v1/accounting/pending")), []);
  const [synced, setSynced] = useState<components["schemas"]["SyncOut"] | null>(null);
  const [checked, setChecked] = useState<components["schemas"]["nazoratly__routers__accounting__VerifyOut"] | null>(null);
  const sync = useAction();
  const verify = useAction();
  return (
    <>
      <Card
        title={t("accounting.pending")}
        actions={
          can("accounting:write") ? (
            <button
              type="button"
              className="primary"
              disabled={sync.pending}
              onClick={() =>
                void sync.run(async (key) => {
                  setSynced(await unwrap(api.POST("/v1/accounting/sync", idempotent(key))));
                  pending.reload();
                })
              }
            >
              {t("accounting.sync")}
            </button>
          ) : null
        }
      >
        {sync.error ? <ErrorNote error={sync.error} /> : null}
        <Done text={synced ? t("accounting.synced", { posted: synced.posted, reversed: synced.reversed, blocked: synced.blocked.length }) : null} />
        {synced?.blocked.length ? (
          <Table
            caption={t("accounting.blocked")}
            rows={synced.blocked}
            rowKey={(b) => `${b.source_type}-${b.source_key}`}
            columns={[
              { head: t("accounting.source"), cell: (b) => label("sourceType", b.source_type) },
              { head: t("common.date"), cell: (b) => formatDate(b.date) },
              { head: t("common.reason"), cell: (b) => b.reason },
            ]}
          />
        ) : null}
        <Loaded load={pending}>
          {(rows) => (
            <Table
              caption={t("accounting.pending")}
              empty={t("accounting.nothingPending")}
              rows={rows}
              rowKey={(r) => `${r.source_type}-${r.source_key}-${r.kind}`}
              columns={[
                { head: t("common.date"), cell: (r) => formatDate(r.date) },
                { head: t("accounting.source"), cell: (r) => label("sourceType", r.source_type) },
                { head: t("finance.kind"), cell: (r) => label("pendingKind", r.kind) },
              ]}
            />
          )}
        </Loaded>
      </Card>
      <Card
        title={t("accounting.chain")}
        actions={
          <button type="button" disabled={verify.pending} onClick={() => void verify.run(async () => setChecked(await unwrap(api.GET("/v1/accounting/verify"))))}>
            {t("accounting.verify")}
          </button>
        }
      >
        {verify.error ? <ErrorNote error={verify.error} /> : null}
        {checked ? (
          checked.ok ? (
            <p className="done" role="status">{t("accounting.chainOk", { lines: checked.lines })}</p>
          ) : (
            <div className="note note-error" role="alert">
              <p>{t("accounting.chainBroken", { seq: checked.broken_seq ?? "—" })}</p>
              <p className="detail">{checked.reason}</p>
              {checked.period_issues.map((issue, i) => (
                <p className="detail" key={i}>{JSON.stringify(issue)}</p>
              ))}
            </div>
          )
        ) : null}
      </Card>
      <Card
        title={t("accounting.periods")}
        actions={
          can("accounting:close") ? (
            <FormButton
              label={t("accounting.closeMonth")}
              danger
              submitLabel={t("accounting.closeMonth")}
              extra={<p>{t("accounting.closeText")}</p>}
              initial={{ month: today.slice(0, 7) }}
              fields={[{ name: "month", label: t("common.month"), type: "month", required: true }]}
              submit={async (body, key) => {
                await unwrap(api.POST("/v1/accounting/periods/{month}/close", { params: { path: { month: String(body.month).slice(0, 7) } }, ...idempotent(key) }));
                periods.reload();
              }}
            />
          ) : null
        }
      >
        <Loaded load={periods}>
          {(rows) => (
            <Table
              caption={t("accounting.periods")}
              empty={t("accounting.noPeriods")}
              rows={rows}
              rowKey={(p) => p.month}
              columns={[
                { head: t("common.month"), cell: (p) => p.month },
                { head: t("accounting.debit"), cell: (p) => formatAmount(p.total_debit), className: "num" },
                { head: t("accounting.credit"), cell: (p) => formatAmount(p.total_credit), className: "num" },
                { head: t("accounting.lastLine"), cell: (p) => p.last_seq, className: "num" },
              ]}
            />
          )}
        </Loaded>
      </Card>
    </>
  );
}

export function JournalPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<"journal" | "periods">("journal");
  return (
    <Page title={t("nav.journal")}>
      <Tabs label={t("nav.journal")} value={tab} onChange={setTab} tabs={[{ id: "journal", label: t("accounting.journal") }, { id: "periods", label: t("accounting.periodsTab") }]} />
      {tab === "journal" ? <Journal /> : <Periods />}
    </Page>
  );
}

function Section({ title, rows, total }: { title: string; rows: Named[]; total: string }) {
  const { t } = useI18n();
  return (
    <Card title={`${title}: ${formatAmount(total)}`}>
      <Table
        caption={title}
        rows={rows}
        rowKey={(r) => r.code}
        columns={[
          { head: t("accounting.code"), cell: (r) => r.code },
          { head: t("common.name"), cell: (r) => r.name },
          { head: t("finance.amount"), cell: (r) => formatAmount(r.amount), className: "num" },
        ]}
      />
    </Card>
  );
}

function TrialBalance({ asOf, from }: { asOf: string; from: string }) {
  const { t, label } = useI18n();
  const load = useLoad(() => unwrap(api.GET("/v1/accounting/reports/trial-balance", { params: { query: { as_of: asOf, date_from: from || undefined } } })), [asOf, from]);
  return (
    <Loaded load={load}>
      {(r) => (
        <>
          <Badge tone={r.balanced ? "good" : "bad"}>{r.balanced ? t("accounting.balanced") : t("accounting.notBalanced")}</Badge>
          <Table
            caption={t("accounting.trial")}
            rows={r.rows}
            rowKey={(x) => x.code}
            columns={[
              { head: t("accounting.account"), cell: (x) => `${x.code} · ${x.name}` },
              { head: t("accounting.type"), cell: (x) => label("accountType", x.type) },
              { head: t("accounting.debit"), cell: (x) => formatAmount(x.debit), className: "num" },
              { head: t("accounting.credit"), cell: (x) => formatAmount(x.credit), className: "num" },
              { head: t("accounting.balanceDebit"), cell: (x) => formatAmount(x.balance_debit), className: "num" },
              { head: t("accounting.balanceCredit"), cell: (x) => formatAmount(x.balance_credit), className: "num" },
            ]}
          />
          <Facts
            items={[
              [t("accounting.debit"), formatAmount(r.total_debit)],
              [t("accounting.credit"), formatAmount(r.total_credit)],
              [t("accounting.balanceDebit"), formatAmount(r.total_balance_debit)],
              [t("accounting.balanceCredit"), formatAmount(r.total_balance_credit)],
            ]}
          />
        </>
      )}
    </Loaded>
  );
}

function IncomeStatement({ from, to }: { from: string; to: string }) {
  const { t } = useI18n();
  const load = useLoad(() => unwrap(api.GET("/v1/accounting/reports/income-statement", { params: { query: { date_from: from, date_to: to } } })), [from, to]);
  return (
    <Loaded load={load}>
      {(r) => (
        <>
          <Section title={t("accounting.income")} rows={r.income} total={r.total_income} />
          <Section title={t("dashboard.expenses")} rows={r.expenses} total={r.total_expenses} />
          <Facts items={[[t("dashboard.net"), formatAmount(r.net)]]} />
        </>
      )}
    </Loaded>
  );
}

function BalanceSheet({ asOf }: { asOf: string }) {
  const { t } = useI18n();
  const load = useLoad(() => unwrap(api.GET("/v1/accounting/reports/balance-sheet", { params: { query: { as_of: asOf } } })), [asOf]);
  return (
    <Loaded load={load}>
      {(r) => (
        <>
          <Badge tone={r.balanced ? "good" : "bad"}>{r.balanced ? t("accounting.balanced") : t("accounting.notBalanced")}</Badge>
          <Section title={t("accounting.assets")} rows={r.assets} total={r.total_assets} />
          <Section title={t("accounting.liabilities")} rows={r.liabilities} total={r.total_liabilities} />
          <Section title={t("accounting.equity")} rows={r.equity} total={r.total_equity} />
          <Facts items={[[t("accounting.currentResult"), formatAmount(r.current_result)]]} />
        </>
      )}
    </Loaded>
  );
}

function Statement({ from, to }: { from: string; to: string }) {
  const { t, label } = useI18n();
  const accounts = useAccounts();
  const [account, setAccount] = useState("");
  const load = useLoad(
    async () => (account ? await unwrap(api.GET("/v1/accounting/ledger", { params: { query: { account, date_from: from || undefined, date_to: to || undefined } } })) : null),
    [account, from, to],
  );
  return (
    <>
      <div className="filters">
        <label>
          {t("accounting.account")}
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">{t("common.choose")}</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.code} value={a.code}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {account ? (
        <Loaded load={load}>
          {(r) =>
            r ? (
              <>
                <Facts
                  items={[
                    [t("accounting.account"), `${r.account} · ${r.name}`],
                    [t("accounting.side"), label("side", r.side)],
                    [t("accounting.opening"), formatAmount(r.opening)],
                    [t("accounting.closing"), formatAmount(r.closing)],
                  ]}
                />
                <Table
                  caption={t("accounting.ledger")}
                  rows={r.rows}
                  rowKey={(x) => String(x.seq)}
                  columns={[
                    { head: t("common.date"), cell: (x) => formatDate(x.date) },
                    { head: t("accounting.entryNo"), cell: (x) => x.entry_no },
                    { head: t("accounting.memo"), cell: (x) => x.memo },
                    { head: t("accounting.debit"), cell: (x) => formatAmount(x.debit), className: "num" },
                    { head: t("accounting.credit"), cell: (x) => formatAmount(x.credit), className: "num" },
                    { head: t("finance.balance"), cell: (x) => formatAmount(x.balance), className: "num" },
                  ]}
                />
              </>
            ) : null
          }
        </Loaded>
      ) : null}
    </>
  );
}

export function BookReportsPage() {
  const { t } = useI18n();
  const { today } = useStaff();
  const [tab, setTab] = useState<"trial" | "income" | "balance" | "ledger">("trial");
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  return (
    <Page title={t("nav.bookReports")}>
      <Tabs
        label={t("nav.bookReports")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "trial", label: t("accounting.trial") },
          { id: "income", label: t("accounting.incomeStatement") },
          { id: "balance", label: t("accounting.balanceSheet") },
          { id: "ledger", label: t("accounting.ledger") },
        ]}
      />
      <div className="filters">
        {tab !== "balance" ? (
          <label>
            {t("common.from")}
            <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </label>
        ) : null}
        <label>
          {tab === "balance" ? t("accounting.asOf") : t("common.to")}
          <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
      </div>
      {tab === "trial" ? <TrialBalance asOf={to} from={from} /> : null}
      {tab === "income" ? <IncomeStatement from={from} to={to} /> : null}
      {tab === "balance" ? <BalanceSheet asOf={to} /> : null}
      {tab === "ledger" ? <Statement from={from} to={to} /> : null}
    </Page>
  );
}
