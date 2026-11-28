/** Bank and cash statement reconciliation: type in the statement, match its lines to the journal, finalize when the
 * server agrees that everything foots and matches. */

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { formatAmount, formatDate, monthStart } from "../lib/format";
import { useStaff } from "../session/context";
import { ConfirmButton, FormButton } from "../ui/form";
import { useLoad } from "../ui/hooks";
import { Badge, Card, Facts, Loaded, Page, PAGE_SIZE, Pager, Table } from "../ui/kit";
import { options } from "../ui/pickers";

type StatementOut = components["schemas"]["StatementOut"];

/** A statement amount may be negative (money out), which the shared money field does not allow. */
const signed = (text: string): string => text.replace(/\s/g, "").replace(",", ".");

export function StatementsPage() {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const navigate = useNavigate();
  const [account, setAccount] = useState("");
  const [offset, setOffset] = useState(0);
  const cash = useLoad(() => unwrap(api.GET("/v1/accounting/cash-accounts")), []);
  const load = useLoad(
    () => unwrap(api.GET("/v1/accounting/statements", { params: { query: { cash_account_id: account || undefined, offset, limit: PAGE_SIZE } } })),
    [account, offset],
  );
  return (
    <Page
      title={t("nav.reconciliation")}
      actions={
        can("accounting:write") ? (
          <FormButton
            label={t("reconcile.add")}
            className="primary"
            initial={{ period_from: monthStart(today), period_to: today }}
            fields={[
              { name: "cash_account_id", label: t("reconcile.account"), type: "select", required: true, options: options(cash.data, (c) => `${c.name} (${label("paidFrom", c.kind)})`) },
              { name: "period_from", label: t("common.from"), type: "date", required: true },
              { name: "period_to", label: t("common.to"), type: "date", required: true },
              { name: "opening_balance", label: t("accounting.opening"), required: true },
              { name: "closing_balance", label: t("accounting.closing"), required: true },
            ]}
            submit={async (body, key) => {
              const sent = { ...(body as never as components["schemas"]["StatementIn"]), opening_balance: signed(String(body.opening_balance)), closing_balance: signed(String(body.closing_balance)) };
              const made = await unwrap(api.POST("/v1/accounting/statements", { body: sent, ...idempotent(key) }));
              navigate(`/reconciliation/${made.id}`);
            }}
          />
        ) : null
      }
    >
      <div className="filters">
        <label>
          {t("reconcile.account")}
          <select value={account} onChange={(e) => { setAccount(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {(cash.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.reconciliation")}
              rows={page.items}
              rowKey={(s) => s.id}
              columns={[
                { head: t("reconcile.account"), cell: (s) => <Link to={`/reconciliation/${s.id}`}>{s.cash_account}</Link> },
                { head: t("common.from"), cell: (s) => formatDate(s.period_from) },
                { head: t("common.to"), cell: (s) => formatDate(s.period_to) },
                { head: t("accounting.opening"), cell: (s) => formatAmount(s.opening_balance), className: "num" },
                { head: t("accounting.closing"), cell: (s) => formatAmount(s.closing_balance), className: "num" },
                { head: t("common.status"), cell: (s) => <Badge tone={s.status === "finalized" ? "good" : "warn"}>{label("statementStatus", s.status)}</Badge> },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </Page>
  );
}

function Matching({ statement, reload }: { statement: StatementOut; reload: () => void }) {
  const { t } = useI18n();
  const { can } = useStaff();
  const editable = can("accounting:write") && statement.status === "open";
  const state = statement.reconciliation;
  const free = state?.unmatched_ledger ?? [];
  return (
    <>
      <Card title={t("reconcile.lines")}>
        <Table
          caption={t("reconcile.lines")}
          empty={t("reconcile.noLines")}
          rows={statement.lines ?? []}
          rowKey={(l) => l.id}
          columns={[
            { head: t("common.date"), cell: (l) => formatDate(l.date) },
            { head: t("common.description"), cell: (l) => l.description || "—" },
            { head: t("finance.amount"), cell: (l) => formatAmount(l.amount), className: "num" },
            {
              head: t("reconcile.match"),
              cell: (l) => (l.matched_seq === null ? <Badge tone="warn">{t("reconcile.unmatched")}</Badge> : <Badge tone="good">{t("reconcile.matchedTo", { seq: l.matched_seq })}</Badge>),
            },
            {
              head: t("common.actions"),
              cell: (l) => {
                if (!editable) return null;
                const path = { params: { path: { statement_id: statement.id, line_id: l.id } } };
                return l.matched_seq === null ? (
                  <FormButton
                    label={t("reconcile.matchByHand")}
                    extra={free.length ? null : <p className="empty">{t("reconcile.nothingFree")}</p>}
                    fields={[
                      {
                        name: "seq",
                        label: t("reconcile.journalLine"),
                        type: "select",
                        required: true,
                        options: free.map((x) => ({ value: String(x.seq), label: `${x.seq} · ${formatDate(x.date)} · ${formatAmount(x.amount)} · ${x.memo}` })),
                      },
                    ]}
                    submit={async (body, key) => {
                      await unwrap(api.POST("/v1/accounting/statements/{statement_id}/lines/{line_id}/match", { ...path, body: { seq: Number(body.seq) }, ...idempotent(key) }));
                      reload();
                    }}
                  />
                ) : (
                  <ConfirmButton
                    label={t("reconcile.unmatch")}
                    text={t("reconcile.unmatchText")}
                    done={reload}
                    run={async (_reason, key) => {
                      await unwrap(api.POST("/v1/accounting/statements/{statement_id}/lines/{line_id}/unmatch", { ...path, ...idempotent(key) }));
                    }}
                  />
                );
              },
            },
          ]}
        />
      </Card>
      <Card title={t("reconcile.freeLedger")}>
        <Table
          caption={t("reconcile.freeLedger")}
          rows={free}
          rowKey={(x) => String(x.seq)}
          columns={[
            { head: t("accounting.line"), cell: (x) => x.seq, className: "num" },
            { head: t("common.date"), cell: (x) => formatDate(x.date) },
            { head: t("accounting.memo"), cell: (x) => x.memo },
            { head: t("finance.amount"), cell: (x) => formatAmount(x.amount), className: "num" },
          ]}
        />
      </Card>
    </>
  );
}

export function StatementPage() {
  const { id = "" } = useParams();
  const { t, label } = useI18n();
  const { can } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/accounting/statements/{statement_id}", { params: { path: { statement_id: id } } })), [id]);
  const path = { params: { path: { statement_id: id } } };
  return (
    <Page title={t("reconcile.one")} back={{ to: "/reconciliation", label: t("nav.reconciliation") }}>
      <Loaded load={load}>
        {(s) => {
          const r = s.reconciliation;
          const editable = can("accounting:write") && s.status === "open";
          return (
            <>
              <Card
                title={`${s.cash_account} · ${formatDate(s.period_from)} – ${formatDate(s.period_to)}`}
                actions={
                  editable ? (
                    <>
                      <FormButton
                        label={t("reconcile.addLine")}
                        initial={{ date: s.period_to }}
                        fields={[
                          { name: "date", label: t("common.date"), type: "date", required: true },
                          { name: "amount", label: t("finance.amount"), required: true, hint: t("reconcile.signedHint") },
                          { name: "description", label: t("common.description"), maxLength: 500 },
                        ]}
                        submit={async (body, key) => {
                          const line = { date: String(body.date), amount: signed(String(body.amount)), description: String(body.description ?? "") };
                          await unwrap(api.POST("/v1/accounting/statements/{statement_id}/lines", { ...path, body: { lines: [line] }, ...idempotent(key) }));
                          load.reload();
                        }}
                      />
                      <FormButton
                        label={t("reconcile.auto")}
                        initial={{ tolerance_days: 3 }}
                        submitLabel={t("reconcile.auto")}
                        fields={[{ name: "tolerance_days", label: t("reconcile.tolerance"), type: "number", required: true, min: 0, max: 30 }]}
                        submit={async (body, key) => {
                          await unwrap(api.POST("/v1/accounting/statements/{statement_id}/auto-match", { ...path, body: body as never, ...idempotent(key) }));
                          load.reload();
                        }}
                      />
                      <ConfirmButton
                        label={t("reconcile.finalize")}
                        text={t("reconcile.finalizeText")}
                        done={load.reload}
                        disabled={!r?.reconciled}
                        run={async (_reason, key) => {
                          await unwrap(api.POST("/v1/accounting/statements/{statement_id}/finalize", { ...path, ...idempotent(key) }));
                        }}
                      />
                    </>
                  ) : null
                }
              >
                <Facts
                  items={[
                    [t("accounting.opening"), formatAmount(s.opening_balance)],
                    [t("accounting.closing"), formatAmount(s.closing_balance)],
                    [t("reconcile.ledgerBalance"), r ? formatAmount(r.ledger_balance) : null],
                    [t("cash.difference"), r ? formatAmount(r.difference) : null],
                    [t("reconcile.unmatchedLines"), r ? r.unmatched_statement : null],
                    [t("reconcile.foots"), r ? (r.foots ? t("common.yes") : t("common.no")) : null],
                  ]}
                />
                <Badge tone={s.status === "finalized" ? "good" : "warn"}>{label("statementStatus", s.status)}</Badge>
                {r ? <Badge tone={r.reconciled ? "good" : "warn"}>{r.reconciled ? t("reconcile.reconciled") : t("reconcile.notReconciled")}</Badge> : null}
              </Card>
              <Matching statement={s} reload={load.reload} />
            </>
          );
        }}
      </Loaded>
    </Page>
  );
}
