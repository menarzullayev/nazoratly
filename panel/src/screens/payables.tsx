/** Suppliers and their bills: what the center owes, settling it, voiding a mistake, and how old the debts are. */

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { formatAmount, formatDate } from "../lib/format";
import { useStaff } from "../session/context";
import { ConfirmButton, FormButton } from "../ui/form";
import { useLoad } from "../ui/hooks";
import { Badge, Card, Facts, Loaded, Page, PAGE_SIZE, Pager, Table, Tabs } from "../ui/kit";
import { options } from "../ui/pickers";

const CATEGORIES = ["rent", "utilities", "salary", "marketing", "equipment", "tax", "other"] as const;
const BILL_STATUSES = ["open", "partial", "overdue", "paid", "voided"] as const;
const BUCKETS = ["not_due", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;

function useSuppliers() {
  return useLoad(() => unwrap(api.GET("/v1/accounting/suppliers")), []);
}

function BillState({ status }: { status: string }) {
  const { label } = useI18n();
  return <Badge tone={status === "paid" ? "good" : status === "overdue" ? "bad" : status === "voided" ? "plain" : "warn"}>{label("billStatus", status)}</Badge>;
}

export function SuppliersPage() {
  const { t } = useI18n();
  const { can } = useStaff();
  const load = useSuppliers();
  const writes = can("accounting:write");
  const fields = [
    { name: "name", label: t("common.name"), required: true, maxLength: 200 },
    { name: "phone", label: t("common.phone"), maxLength: 40 },
    { name: "note", label: t("common.notes"), type: "textarea" as const, maxLength: 1000 },
  ];
  return (
    <Page
      title={t("nav.suppliers")}
      actions={
        writes ? (
          <FormButton
            label={t("payables.addSupplier")}
            className="primary"
            fields={fields}
            submit={async (body, key) => {
              await unwrap(api.POST("/v1/accounting/suppliers", { body: body as never, ...idempotent(key) }));
              load.reload();
            }}
          />
        ) : null
      }
    >
      <Loaded load={load}>
        {(rows) => (
          <Table
            caption={t("nav.suppliers")}
            rows={rows}
            rowKey={(s) => s.id}
            columns={[
              { head: t("common.name"), cell: (s) => s.name },
              { head: t("common.phone"), cell: (s) => s.phone ?? "—" },
              { head: t("common.notes"), cell: (s) => s.note ?? "—" },
              { head: t("payables.owed"), cell: (s) => formatAmount(s.outstanding), className: "num" },
              { head: t("common.status"), cell: (s) => (s.active ? <Badge tone="good">{t("accounting.active")}</Badge> : <Badge>{t("accounting.inactive")}</Badge>) },
              {
                head: t("common.actions"),
                cell: (s) =>
                  writes ? (
                    <FormButton
                      label={t("common.edit")}
                      title={s.name}
                      patch
                      initial={s}
                      fields={[...fields, { name: "active", label: t("accounting.active"), type: "checkbox" }]}
                      submit={async (body) => {
                        await unwrap(api.PATCH("/v1/accounting/suppliers/{supplier_id}", { params: { path: { supplier_id: s.id } }, body: body as never }));
                        load.reload();
                      }}
                    />
                  ) : null,
              },
            ]}
          />
        )}
      </Loaded>
    </Page>
  );
}

function Aging() {
  const { t, label } = useI18n();
  const { today } = useStaff();
  const [asOf, setAsOf] = useState(today);
  const load = useLoad(() => unwrap(api.GET("/v1/accounting/reports/payables-aging", { params: { query: { as_of: asOf } } })), [asOf]);
  return (
    <>
      <div className="filters">
        <label>
          {t("accounting.asOf")}
          <input type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
        </label>
      </div>
      <Loaded load={load}>
        {(r) => (
          <>
            <Facts
              items={[
                ...BUCKETS.map((b): [string, string] => [label("bucket", b), formatAmount((r.buckets as Record<string, string>)[b])]),
                [t("reports.total"), formatAmount(r.total)],
              ]}
            />
            <Table
              caption={t("payables.aging")}
              rows={r.rows}
              rowKey={(x) => x.id}
              columns={[
                { head: t("payables.supplier"), cell: (x) => x.supplier_name },
                { head: t("payables.number"), cell: (x) => <Link to={`/bills/${x.id}`}>{x.number}</Link> },
                { head: t("finance.dueDate"), cell: (x) => formatDate(x.due_date) },
                { head: t("debtors.days"), cell: (x) => x.days_overdue, className: "num" },
                { head: t("payables.bucket"), cell: (x) => label("bucket", x.bucket) },
                { head: t("finance.outstanding"), cell: (x) => formatAmount(x.outstanding), className: "num" },
              ]}
            />
          </>
        )}
      </Loaded>
    </>
  );
}

function BillList() {
  const { t, label } = useI18n();
  const [supplier, setSupplier] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const suppliers = useSuppliers();
  const load = useLoad(
    () => unwrap(api.GET("/v1/accounting/bills", { params: { query: { supplier_id: supplier || undefined, status: (status || undefined) as never, offset, limit: PAGE_SIZE } } })),
    [supplier, status, offset],
  );
  return (
    <>
      <div className="filters">
        <label>
          {t("payables.supplier")}
          <select value={supplier} onChange={(e) => { setSupplier(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {(suppliers.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("common.status")}
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {BILL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label("billStatus", s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.bills")}
              rows={page.items}
              rowKey={(b) => b.id}
              columns={[
                { head: t("payables.number"), cell: (b) => <Link to={`/bills/${b.id}`}>{b.number}</Link> },
                { head: t("payables.supplier"), cell: (b) => b.supplier_name },
                { head: t("finance.dueDate"), cell: (b) => formatDate(b.due_date) },
                { head: t("finance.amount"), cell: (b) => formatAmount(b.amount), className: "num" },
                { head: t("finance.outstanding"), cell: (b) => formatAmount(b.outstanding), className: "num" },
                { head: t("common.status"), cell: (b) => <BillState status={b.status} /> },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </>
  );
}

export function BillsPage() {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const navigate = useNavigate();
  const suppliers = useSuppliers();
  const [tab, setTab] = useState<"bills" | "aging">("bills");
  return (
    <Page
      title={t("nav.bills")}
      actions={
        can("accounting:write") ? (
          <FormButton
            label={t("payables.addBill")}
            className="primary"
            initial={{ category: "other", bill_date: today, due_date: today }}
            fields={[
              { name: "supplier_id", label: t("payables.supplier"), type: "select", required: true, options: options((suppliers.data ?? []).filter((s) => s.active), (s) => s.name) },
              { name: "number", label: t("payables.number"), required: true, maxLength: 100 },
              { name: "category", label: t("expenses.category"), type: "select", required: true, options: CATEGORIES.map((c) => ({ value: c, label: label("expenseCategory", c) })) },
              { name: "amount", label: t("finance.amount"), type: "money", required: true },
              { name: "bill_date", label: t("payables.billDate"), type: "date", required: true },
              { name: "due_date", label: t("finance.dueDate"), type: "date", required: true },
              { name: "description", label: t("common.description"), maxLength: 4000 },
            ]}
            submit={async (body, key) => {
              const made = await unwrap(api.POST("/v1/accounting/bills", { body: body as never as components["schemas"]["BillIn"], ...idempotent(key) }));
              navigate(`/bills/${made.id}`);
            }}
          />
        ) : null
      }
    >
      <Tabs label={t("nav.bills")} value={tab} onChange={setTab} tabs={[{ id: "bills", label: t("nav.bills") }, { id: "aging", label: t("payables.aging") }]} />
      {tab === "bills" ? <BillList /> : <Aging />}
    </Page>
  );
}

export function BillPage() {
  const { id = "" } = useParams();
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/accounting/bills/{bill_id}", { params: { path: { bill_id: id } } })), [id]);
  const writes = can("accounting:write");
  return (
    <Page title={t("payables.bill")} back={{ to: "/bills", label: t("nav.bills") }}>
      <Loaded load={load}>
        {(b) => {
          const live = b.payments?.some((p) => !p.voided) ?? false;
          return (
            <>
              <Card
                title={`${b.supplier_name} · ${b.number}`}
                actions={
                  writes && !b.voided ? (
                    <>
                      {b.status !== "paid" ? (
                        <FormButton
                          label={t("payables.pay")}
                          className="primary"
                          initial={{ paid_from: "cash", paid_on: today, amount: b.outstanding }}
                          fields={[
                            { name: "amount", label: t("finance.amount"), type: "money", required: true },
                            { name: "paid_from", label: t("expenses.paidFrom"), type: "select", required: true, options: ["cash", "bank"].map((v) => ({ value: v, label: label("paidFrom", v) })) },
                            { name: "paid_on", label: t("common.date"), type: "date", required: true },
                            { name: "note", label: t("common.notes"), maxLength: 4000 },
                          ]}
                          submit={async (body, key) => {
                            await unwrap(api.POST("/v1/accounting/bills/{bill_id}/payments", { params: { path: { bill_id: id } }, body: body as never, ...idempotent(key) }));
                            load.reload();
                          }}
                        />
                      ) : null}
                      {!live ? (
                        <ConfirmButton
                          label={t("payables.voidBill")}
                          text={t("payables.voidBillText")}
                          reason={t("finance.voidReason")}
                          done={load.reload}
                          run={async (reason, key) => {
                            await unwrap(api.POST("/v1/accounting/bills/{bill_id}/void", { params: { path: { bill_id: id } }, body: { reason }, ...idempotent(key) }));
                          }}
                        />
                      ) : null}
                    </>
                  ) : null
                }
              >
                <Facts
                  items={[
                    [t("expenses.category"), label("expenseCategory", b.category)],
                    [t("payables.billDate"), formatDate(b.bill_date)],
                    [t("finance.dueDate"), formatDate(b.due_date)],
                    [t("finance.amount"), formatAmount(b.amount)],
                    [t("finance.paid"), formatAmount(b.paid)],
                    [t("finance.outstanding"), formatAmount(b.outstanding)],
                    [t("common.description"), b.description],
                    [t("finance.voidReason"), b.void_reason],
                  ]}
                />
                <BillState status={b.status} />
              </Card>
              <Card title={t("payables.settlements")}>
                <Table
                  caption={t("payables.settlements")}
                  rows={b.payments ?? []}
                  rowKey={(p) => p.id}
                  columns={[
                    { head: t("common.date"), cell: (p) => formatDate(p.paid_on) },
                    { head: t("expenses.paidFrom"), cell: (p) => label("paidFrom", p.paid_from) },
                    { head: t("finance.amount"), cell: (p) => formatAmount(p.amount), className: "num" },
                    { head: t("common.notes"), cell: (p) => p.note ?? "—" },
                    {
                      head: t("common.actions"),
                      cell: (p) =>
                        p.voided ? (
                          <Badge tone="bad">
                            {t("finance.voided")}: {p.void_reason}
                          </Badge>
                        ) : writes ? (
                          <ConfirmButton
                            label={t("finance.void")}
                            text={t("payables.voidPaymentText", { amount: formatAmount(p.amount) })}
                            reason={t("finance.voidReason")}
                            done={load.reload}
                            run={async (reason, key) => {
                              await unwrap(api.POST("/v1/accounting/bill-payments/{payment_id}/void", { params: { path: { payment_id: p.id } }, body: { reason }, ...idempotent(key) }));
                            }}
                          />
                        ) : null,
                    },
                  ]}
                />
              </Card>
            </>
          );
        }}
      </Loaded>
    </Page>
  );
}
