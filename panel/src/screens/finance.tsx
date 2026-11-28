/** Charges, payments, debtors and their reminders, expenses and the money reports. Every sum comes from the server; the
 * panel adds nothing up. Every POST carries an Idempotency-Key, so a double click records one thing. */

import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { formatAmount, formatDate, formatDateTime, formatMonth, isPositive, monthStart, parseAmount } from "../lib/format";
import { useStaff } from "../session/context";
import { ConfirmButton, Dialog, Form, FormButton, FormDialog, type Field } from "../ui/form";
import { useLoad } from "../ui/hooks";
import { Badge, Card, Done, Facts, Loaded, Page, PAGE_SIZE, Pager, Table, Tabs } from "../ui/kit";
import { options, StudentPicker, useGroups, type Picked } from "../ui/pickers";
import { PaymentPlan } from "./money";
import { ReminderDrafts } from "./reminders";

type Charge = components["schemas"]["ChargeOut"];
type Payment = components["schemas"]["PaymentOut"];
const METHODS = ["cash", "card", "bank_transfer", "payme", "click", "other"] as const;
const CHARGE_KINDS = ["tuition", "registration", "materials", "other"] as const;
const EXPENSE_CATEGORIES = ["rent", "utilities", "salary", "marketing", "equipment", "tax", "other"] as const;

/** The student a list is narrowed to, kept in the address (?student=) so a link from the student page works. */
export function useStudentFilter(): { id: string | null; picker: React.ReactNode } {
  const [params, setParams] = useSearchParams();
  const id = params.get("student");
  const load = useLoad(
    async () => (id ? (await unwrap(api.GET("/v1/students/{student_id}", { params: { path: { student_id: id } } }))).full_name : null),
    [id],
  );
  const picker = (
    <StudentPicker
      value={id ? { id, name: load.data ?? "…" } : null}
      onPick={(v) => setParams(v ? { student: v.id } : {}, { replace: true })}
    />
  );
  return { id, picker };
}

/** "New record for a student": choose the student first, then fill the form. */
function ForStudent({ label, fields, initial, submit, preset }: {
  label: string;
  fields: (student: Picked) => Field[];
  initial: Record<string, unknown>;
  submit: (student: Picked, body: Record<string, unknown>, key: string) => Promise<void>;
  preset?: Picked | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const close = () => {
    setOpen(false);
    setPicked(null);
  };
  const student = picked ?? preset ?? null;
  return (
    <>
      <button
        type="button"
        className="primary"
        onClick={() => {
          setPicked(preset ?? null);
          setOpen(true);
        }}
      >
        {label}
      </button>
      {open ? (
        <Dialog title={label} onClose={close}>
          <StudentPicker value={student} onPick={setPicked} />
          {student ? (
            <Form
              key={student.id}
              fields={fields(student)}
              initial={initial}
              submitLabel={t("common.save")}
              onCancel={close}
              submit={async (body, key) => {
                await submit(student, body, key);
                close();
              }}
            />
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}

function ChargeState({ charge }: { charge: Charge }) {
  const { t } = useI18n();
  if (charge.voided) return <Badge tone="bad">{t("finance.voided")}</Badge>;
  if (isPositive(charge.overdue)) return <Badge tone="bad">{t("finance.overdue")}</Badge>;
  if (isPositive(charge.outstanding)) return <Badge tone="warn">{t("finance.open")}</Badge>;
  return <Badge tone="good">{t("finance.settled")}</Badge>;
}

function ChargeDialog({ id, onClose, done }: { id: string; onClose: () => void; done: () => void }) {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/charges/{charge_id}", { params: { path: { charge_id: id } } })), [id]);
  const [editing, setEditing] = useState(false);
  const changed = () => {
    load.reload();
    done();
  };
  return (
    <Dialog title={t("finance.charge")} onClose={onClose}>
      <Loaded load={load}>
        {(c) => (
          <>
            <Facts
              items={[
                [t("common.student"), c.student_name],
                [t("finance.kind"), label("chargeKind", c.kind)],
                [t("finance.period"), formatMonth(c.period_month)],
                [t("finance.dueDate"), formatDate(c.due_date)],
                [t("finance.amount"), formatAmount(c.amount)],
                [t("finance.paid"), formatAmount(c.paid)],
                [t("finance.outstanding"), formatAmount(c.outstanding)],
                [t("finance.overdue"), formatAmount(c.overdue)],
                [t("common.description"), c.description],
                [t("finance.voidReason"), c.void_reason],
              ]}
            />
            <ChargeState charge={c} />
            <PaymentPlan charge={id} voided={c.voided} changed={changed} />
            {can("finance:write") && !c.voided ? (
              editing ? (
                <Form
                  patch
                  initial={c}
                  fields={[
                    { name: "amount", label: t("finance.amount"), type: "money", required: true },
                    { name: "due_date", label: t("finance.dueDate"), type: "date", required: true },
                    { name: "description", label: t("common.description"), type: "textarea", maxLength: 2000 },
                  ]}
                  submitLabel={t("common.save")}
                  onCancel={() => setEditing(false)}
                  submit={async (body) => {
                    await unwrap(api.PATCH("/v1/charges/{charge_id}", { params: { path: { charge_id: id } }, body: body as never }));
                    setEditing(false);
                    changed();
                  }}
                />
              ) : (
                <div className="actions">
                  <button type="button" onClick={() => setEditing(true)}>
                    {t("common.edit")}
                  </button>
                  <ConfirmButton
                    label={t("finance.void")}
                    text={t("finance.voidChargeText")}
                    reason={t("finance.voidReason")}
                    done={changed}
                    run={async (reason, key) => {
                      await unwrap(
                        api.POST("/v1/charges/{charge_id}/void", {
                          params: { path: { charge_id: id } },
                          body: { reason, release_allocations: isPositive(c.paid) },
                          ...idempotent(key),
                        }),
                      );
                    }}
                  />
                </div>
              )
            ) : null}
          </>
        )}
      </Loaded>
    </Dialog>
  );
}

export function ChargesPage() {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const filter = useStudentFilter();
  const [month, setMonth] = useState("");
  const [state, setState] = useState("open");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);
  const groups = useGroups(can("finance:write", "academics:read"));
  const load = useLoad(
    () =>
      unwrap(
        api.GET("/v1/charges", {
          params: { query: { student_id: filter.id ?? undefined, month: month ? `${month}-01` : undefined, state: state as never, offset, limit: PAGE_SIZE } },
        }),
      ),
    [filter.id, month, state, offset],
  );
  const writes = can("finance:write");
  return (
    <Page
      title={t("nav.charges")}
      actions={
        writes ? (
          <>
            <ForStudent
              label={t("finance.addCharge")}
              initial={{ kind: "tuition", period_month: today.slice(0, 7), due_date: today }}
              fields={() => [
                { name: "kind", label: t("finance.kind"), type: "select", required: true, options: CHARGE_KINDS.map((k) => ({ value: k, label: label("chargeKind", k) })) },
                { name: "period_month", label: t("finance.period"), type: "month", required: true },
                { name: "amount", label: t("finance.amount"), type: "money", required: true },
                { name: "due_date", label: t("finance.dueDate"), type: "date", required: true },
                { name: "description", label: t("common.description"), maxLength: 2000 },
              ]}
              submit={async (student, body, key) => {
                await unwrap(api.POST("/v1/charges", { body: { ...(body as never as components["schemas"]["ChargeIn"]), student_id: student.id }, ...idempotent(key) }));
                load.reload();
              }}
            />
            <FormButton
              label={t("finance.generate")}
              initial={{ month: today.slice(0, 7), due_day: 10 }}
              extra={<p className="hint">{t("finance.generateHint")}</p>}
              submitLabel={t("finance.generate")}
              fields={[
                { name: "month", label: t("common.month"), type: "month", required: true },
                { name: "due_day", label: t("finance.dueDay"), type: "number", required: true, min: 1, max: 28 },
                { name: "group_id", label: t("common.group"), type: "select", options: options(groups.data, (g) => g.name) },
              ]}
              submit={async (body, key) => {
                const r = await unwrap(api.POST("/v1/charges/generate", { body: body as never, ...idempotent(key) }));
                setGenerated(
                  t("finance.generated", {
                    created: r.created,
                    existing: r.skipped_existing,
                    zero: r.skipped_zero_fee,
                    free: r.skipped_free ?? 0,
                    packages: r.skipped_package_groups ?? 0,
                  }),
                );
                load.reload();
              }}
            />
          </>
        ) : null
      }
    >
      <Done text={generated} />
      <div className="filters">
        {can("students:read") ? filter.picker : null}
        <label>
          {t("common.month")}
          <input
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          {t("common.status")}
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setOffset(0);
            }}
          >
            {["open", "overdue", "settled", "voided", "all"].map((s) => (
              <option key={s} value={s}>
                {label("chargeState", s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.charges")}
              rows={page.items}
              rowKey={(c) => c.id}
              columns={[
                { head: t("common.student"), cell: (c) => c.student_name },
                { head: t("finance.kind"), cell: (c) => label("chargeKind", c.kind) },
                { head: t("finance.period"), cell: (c) => formatMonth(c.period_month) },
                { head: t("finance.dueDate"), cell: (c) => formatDate(c.due_date) },
                { head: t("finance.amount"), cell: (c) => formatAmount(c.amount), className: "num" },
                { head: t("finance.outstanding"), cell: (c) => formatAmount(c.outstanding), className: "num" },
                { head: t("common.status"), cell: (c) => <ChargeState charge={c} /> },
                {
                  head: t("common.actions"),
                  cell: (c) => (
                    <button type="button" onClick={() => setOpen(c.id)}>
                      {t("common.open")}
                    </button>
                  ),
                },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
      {open ? <ChargeDialog id={open} onClose={() => setOpen(null)} done={load.reload} /> : null}
    </Page>
  );
}

export function PaymentsPage() {
  const { t, label } = useI18n();
  const { can, timeZone } = useStaff();
  const navigate = useNavigate();
  const filter = useStudentFilter();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [method, setMethod] = useState("");
  const [voided, setVoided] = useState(false);
  const [offset, setOffset] = useState(0);
  const preset = useLoad(
    async () =>
      filter.id
        ? { id: filter.id, name: (await unwrap(api.GET("/v1/students/{student_id}", { params: { path: { student_id: filter.id } } }))).full_name }
        : null,
    [filter.id],
  );
  const load = useLoad(
    () =>
      unwrap(
        api.GET("/v1/payments", {
          params: {
            query: { student_id: filter.id ?? undefined, date_from: from || undefined, date_to: to || undefined, method: (method || undefined) as never, include_voided: voided, offset, limit: PAGE_SIZE },
          },
        }),
      ),
    [filter.id, from, to, method, voided, offset],
  );
  const methodOptions = METHODS.map((m) => ({ value: m, label: label("method", m) }));
  return (
    <Page
      title={t("nav.payments")}
      actions={
        can("finance:write", "students:read") ? (
          <ForStudent
            label={t("finance.addPayment")}
            preset={preset.data}
            initial={{ method: "cash", auto_allocate: true }}
            fields={() => [
              { name: "amount", label: t("finance.amount"), type: "money", required: true },
              { name: "method", label: t("finance.method"), type: "select", required: true, options: methodOptions },
              { name: "external_ref", label: t("finance.externalRef"), maxLength: 200, hint: t("finance.externalRefHint") },
              { name: "note", label: t("common.notes"), maxLength: 2000 },
              { name: "auto_allocate", label: t("finance.autoAllocate"), type: "checkbox" },
            ]}
            submit={async (student, body, key) => {
              const made = await unwrap(
                api.POST("/v1/payments", { body: { ...(body as never as components["schemas"]["PaymentIn"]), student_id: student.id }, ...idempotent(key) }),
              );
              load.reload();
              navigate(`/payments/${made.id}`);
            }}
          />
        ) : null
      }
    >
      <div className="filters">
        {can("students:read") ? filter.picker : null}
        <label>
          {t("common.from")}
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
        </label>
        <label>
          {t("common.to")}
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />
        </label>
        <label>
          {t("finance.method")}
          <select value={method} onChange={(e) => { setMethod(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {methodOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={voided} onChange={(e) => { setVoided(e.target.checked); setOffset(0); }} />
          {t("finance.showVoided")}
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.payments")}
              rows={page.items}
              rowKey={(p) => p.id}
              columns={[
                { head: t("common.date"), cell: (p) => <Link to={`/payments/${p.id}`}>{formatDateTime(p.paid_at, timeZone)}</Link> },
                { head: t("common.student"), cell: (p) => p.student_name },
                { head: t("finance.method"), cell: (p) => label("method", p.method) },
                { head: t("finance.amount"), cell: (p) => formatAmount(p.amount), className: "num" },
                { head: t("finance.unallocated"), cell: (p) => formatAmount(p.unallocated), className: "num" },
                { head: t("common.status"), cell: (p) => (p.voided ? <Badge tone="bad">{t("finance.voided")}</Badge> : <Badge tone="good">{t("finance.recorded")}</Badge>) },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </Page>
  );
}

/** Put a payment's free money on open charges: automatically (oldest first) or by hand. */
function Allocate({ payment, done }: { payment: Payment; done: () => void }) {
  const { t, label } = useI18n();
  const [open, setOpen] = useState(false);
  const balance = useLoad(
    async () => (open ? await unwrap(api.GET("/v1/students/{student_id}/balance", { params: { path: { student_id: payment.student_id } } })) : null),
    [open, payment.id, payment.unallocated],
  );
  const send = (body: components["schemas"]["AllocateIn"], key: string) =>
    unwrap(api.POST("/v1/payments/{payment_id}/allocate", { params: { path: { payment_id: payment.id } }, body, ...idempotent(key) }));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {t("finance.allocate")}
      </button>
      {open ? (
        <Dialog title={t("finance.allocate")} onClose={() => setOpen(false)}>
          <p>{t("finance.unallocatedNow", { amount: formatAmount(payment.unallocated) })}</p>
          <Loaded load={balance}>
            {(b) =>
              b && b.open_charges.length ? (
                <Form
                  fields={[
                    {
                      name: "charge_id",
                      label: t("finance.charge"),
                      type: "select",
                      hint: t("finance.allocateHint"),
                      options: b.open_charges.map((c) => ({ value: c.id, label: `${label("chargeKind", c.kind)} ${formatMonth(c.period_month)} · ${formatAmount(c.outstanding)}` })),
                    },
                    { name: "amount", label: t("finance.amount"), type: "money", visible: (v) => v.charge_id !== "" },
                  ]}
                  submitLabel={t("finance.allocate")}
                  onCancel={() => setOpen(false)}
                  submit={async (body, key, values) => {
                    const amount = parseAmount(String(values.amount ?? ""));
                    await send(
                      body.charge_id ? { auto: false, allocations: [{ charge_id: String(body.charge_id), amount: amount ?? "0" }] } : { auto: true },
                      key,
                    );
                    setOpen(false);
                    done();
                  }}
                />
              ) : (
                <p className="empty">{t("finance.noOpenCharges")}</p>
              )
            }
          </Loaded>
        </Dialog>
      ) : null}
    </>
  );
}

export function PaymentPage() {
  const { id = "" } = useParams();
  const { t, label } = useI18n();
  const { can, timeZone } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/payments/{payment_id}", { params: { path: { payment_id: id } } })), [id]);
  return (
    <Page title={t("finance.payment")} back={{ to: "/payments", label: t("nav.payments") }}>
      <Loaded load={load}>
        {(p) => (
          <>
            <Card
              title={`${p.student_name} · ${formatAmount(p.amount)}`}
              actions={
                can("finance:write") && !p.voided ? (
                  <>
                    {isPositive(p.unallocated) ? <Allocate payment={p} done={load.reload} /> : null}
                    <ConfirmButton
                      label={t("finance.void")}
                      text={t("finance.voidPaymentText")}
                      reason={t("finance.voidReason")}
                      done={load.reload}
                      run={async (reason, key) => {
                        await unwrap(api.POST("/v1/payments/{payment_id}/void", { params: { path: { payment_id: id } }, body: { reason, release_allocations: true }, ...idempotent(key) }));
                      }}
                    />
                  </>
                ) : null
              }
            >
              <Facts
                items={[
                  [t("common.date"), formatDateTime(p.paid_at, timeZone)],
                  [t("finance.method"), label("method", p.method)],
                  [t("finance.amount"), formatAmount(p.amount)],
                  [t("finance.allocated"), formatAmount(p.allocated)],
                  [t("finance.unallocated"), formatAmount(p.unallocated)],
                  [t("finance.refunded"), formatAmount(p.refunded)],
                  [t("finance.externalRef"), p.external_ref],
                  [t("common.notes"), p.note],
                  [t("finance.voidReason"), p.void_reason],
                ]}
              />
              {p.voided ? <Badge tone="bad">{t("finance.voided")}</Badge> : null}
            </Card>
            <Card title={t("finance.allocations")}>
              <Table
                caption={t("finance.allocations")}
                empty={t("finance.noAllocations")}
                rows={p.allocations ?? []}
                rowKey={(a) => a.charge_id}
                columns={[
                  { head: t("finance.kind"), cell: (a) => label("chargeKind", a.kind) },
                  { head: t("finance.period"), cell: (a) => formatMonth(a.period_month) },
                  { head: t("finance.amount"), cell: (a) => formatAmount(a.amount), className: "num" },
                  {
                    head: t("common.actions"),
                    cell: (a) =>
                      can("finance:write") && !p.voided ? (
                        <ConfirmButton
                          label={t("finance.removeAllocation")}
                          text={t("finance.removeAllocationText", { amount: formatAmount(a.amount) })}
                          done={load.reload}
                          run={async () => {
                            await unwrap(api.DELETE("/v1/payments/{payment_id}/allocations/{charge_id}", { params: { path: { payment_id: id, charge_id: a.charge_id } } }));
                          }}
                        />
                      ) : null,
                  },
                ]}
              />
            </Card>
          </>
        )}
      </Loaded>
    </Page>
  );
}

function Reminders({ onClose }: { onClose: () => void }) {
  const { t, label } = useI18n();
  return (
    <ReminderDrafts
      title={t("reminders.title")}
      onClose={onClose}
      load={async () => {
        const preview = await unwrap(api.GET("/v1/reports/debtors/reminders"));
        return {
          skipped: preview.skipped,
          drafts: preview.drafts.map((d) => ({ ...d, note: `${label("reminderKind", d.kind)} · ${formatAmount(d.overdue_total)}` })),
        };
      }}
      send={(messages, key) => unwrap(api.POST("/v1/reports/debtors/reminders", { body: { messages }, ...idempotent(key) }))}
    />
  );
}

export function DebtorsPage() {
  const { t } = useI18n();
  const { can } = useStaff();
  const [days, setDays] = useState("1");
  const [reminding, setReminding] = useState(false);
  const load = useLoad(
    () => unwrap(api.GET("/v1/reports/debtors", { params: { query: { min_days_overdue: Number(days) || 0, limit: 500 } } })),
    [days],
  );
  return (
    <Page
      title={t("nav.debtors")}
      actions={
        can("finance:read", "students:write") && !reminding ? (
          <button type="button" className="primary" onClick={() => setReminding(true)}>
            {t("reminders.make")}
          </button>
        ) : null
      }
    >
      {reminding ? <Reminders onClose={() => setReminding(false)} /> : null}
      <div className="filters">
        <label>
          {t("debtors.minDays")}
          <input type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
      </div>
      <Loaded load={load}>
        {(rows) => (
          <Table
            caption={t("nav.debtors")}
            empty={t("debtors.none")}
            rows={rows}
            rowKey={(r) => r.student_id}
            columns={[
              { head: t("common.student"), cell: (r) => (can("students:read") ? <Link to={`/students/${r.student_id}`}>{r.student_name}</Link> : r.student_name) },
              { head: t("common.phone"), cell: (r) => r.phone ?? "—" },
              { head: t("finance.overdue"), cell: (r) => formatAmount(r.overdue_total), className: "num" },
              { head: t("finance.outstanding"), cell: (r) => formatAmount(r.outstanding_total), className: "num" },
              { head: t("debtors.since"), cell: (r) => formatDate(r.oldest_due_date) },
              { head: t("debtors.days"), cell: (r) => r.max_days_overdue, className: "num" },
            ]}
          />
        )}
      </Loaded>
    </Page>
  );
}

export function ExpensesPage() {
  const { t, label } = useI18n();
  const { can, today, branches, scopeBranch } = useStaff();
  const [category, setCategory] = useState("");
  const [voided, setVoided] = useState(false);
  const [offset, setOffset] = useState(0);
  const [voiding, setVoiding] = useState<string | null>(null);
  const load = useLoad(
    () => unwrap(api.GET("/v1/expenses", { params: { query: { category: (category || undefined) as never, include_voided: voided, offset, limit: PAGE_SIZE } } })),
    [category, voided, offset],
  );
  const categories = EXPENSE_CATEGORIES.map((c) => ({ value: c, label: label("expenseCategory", c) }));
  const fields: Field[] = [
    { name: "category", label: t("expenses.category"), type: "select", required: true, options: categories },
    { name: "amount", label: t("finance.amount"), type: "money", required: true },
    { name: "spent_at", label: t("common.date"), type: "date", required: true },
    { name: "paid_from", label: t("expenses.paidFrom"), type: "select", required: true, options: ["cash", "bank"].map((v) => ({ value: v, label: label("paidFrom", v) })) },
    { name: "description", label: t("common.description"), maxLength: 2000 },
    ...(!scopeBranch && branches.length > 1 ? ([{ name: "branch_id", label: t("common.branch"), type: "select", options: options(branches, (b) => b.name) }] as Field[]) : []),
  ];
  return (
    <Page
      title={t("nav.expenses")}
      actions={
        can("expenses:write") ? (
          <FormButton
            label={t("expenses.add")}
            className="primary"
            fields={fields}
            initial={{ spent_at: today, paid_from: "cash" }}
            submit={async (body, key) => {
              await unwrap(api.POST("/v1/expenses", { body: body as never, ...idempotent(key) }));
              load.reload();
            }}
          />
        ) : null
      }
    >
      <div className="filters">
        <label>
          {t("expenses.category")}
          <select value={category} onChange={(e) => { setCategory(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={voided} onChange={(e) => { setVoided(e.target.checked); setOffset(0); }} />
          {t("finance.showVoided")}
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.expenses")}
              rows={page.items}
              rowKey={(x) => x.id}
              columns={[
                { head: t("common.date"), cell: (x) => formatDate(x.spent_at) },
                { head: t("expenses.category"), cell: (x) => label("expenseCategory", x.category) },
                { head: t("finance.amount"), cell: (x) => formatAmount(x.amount), className: "num" },
                { head: t("expenses.paidFrom"), cell: (x) => label("paidFrom", x.paid_from) },
                { head: t("common.description"), cell: (x) => x.description ?? "—" },
                { head: t("common.status"), cell: (x) => (x.voided ? <Badge tone="bad">
                    {t("finance.voided")}: {x.void_reason}
                  </Badge> : <Badge tone="good">{t("finance.recorded")}</Badge>) },
                {
                  head: t("common.actions"),
                  cell: (x) =>
                    can("expenses:write") && !x.voided && !x.supplier_bill_id ? (
                      <button type="button" className="danger-quiet" onClick={() => setVoiding(x.id)}>
                        {t("finance.void")}
                      </button>
                    ) : null,
                },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
      {voiding ? (
        <FormDialog
          title={t("finance.void")}
          onClose={() => setVoiding(null)}
          done={load.reload}
          danger
          extra={<p>{t("expenses.voidText")}</p>}
          submitLabel={t("finance.void")}
          fields={[{ name: "reason", label: t("finance.voidReason"), required: true, maxLength: 500 }]}
          submit={async (body, key) => {
            await unwrap(api.POST("/v1/expenses/{expense_id}/void", { params: { path: { expense_id: voiding } }, body: { reason: String(body.reason), release_allocations: false }, ...idempotent(key) }));
          }}
        />
      ) : null}
    </Page>
  );
}

export function ReportsPage() {
  const { t, label } = useI18n();
  const { today } = useStaff();
  const [tab, setTab] = useState<"summary" | "revenue">("summary");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [by, setBy] = useState<"day" | "month">("day");
  const summary = useLoad(() => unwrap(api.GET("/v1/reports/summary", { params: { query: { month: `${month}-01` } } })), [month]);
  const revenue = useLoad(() => unwrap(api.GET("/v1/reports/revenue", { params: { query: { date_from: from, date_to: to, group_by: by } } })), [from, to, by]);
  return (
    <Page title={t("nav.reports")}>
      <Tabs
        label={t("nav.reports")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "summary", label: t("reports.summary") },
          { id: "revenue", label: t("reports.revenue") },
        ]}
      />
      {tab === "summary" ? (
        <>
          <div className="filters">
            <label>
              {t("common.month")}
              <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            </label>
          </div>
          <Loaded load={summary}>
            {(s) => (
              <Card title={formatMonth(s.month)}>
                <Facts
                  items={[
                    [t("reports.charged"), formatAmount(s.charged)],
                    [t("dashboard.income"), formatAmount(s.revenue)],
                    [t("dashboard.expenses"), formatAmount(s.expenses)],
                    [t("dashboard.payroll"), formatAmount(s.payroll)],
                    [t("dashboard.net"), formatAmount(s.net)],
                    [t("reports.outstandingNow"), formatAmount(s.outstanding_now)],
                    [t("reports.overdueNow"), formatAmount(s.overdue_now)],
                  ]}
                />
              </Card>
            )}
          </Loaded>
        </>
      ) : (
        <>
          <div className="filters">
            <label>
              {t("common.from")}
              <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            </label>
            <label>
              {t("common.to")}
              <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
            </label>
            <label>
              {t("reports.groupBy")}
              <select value={by} onChange={(e) => setBy(e.target.value as "day" | "month")}>
                <option value="day">{t("calendar.day")}</option>
                <option value="month">{t("common.month")}</option>
              </select>
            </label>
          </div>
          <Loaded load={revenue}>
            {(rows) => (
              <Table
                caption={t("reports.revenue")}
                rows={rows}
                rowKey={(r) => `${r.period}-${r.method}`}
                columns={[
                  { head: t("common.date"), cell: (r) => (by === "month" ? formatMonth(r.period) : formatDate(r.period)) },
                  { head: t("finance.method"), cell: (r) => label("method", r.method) },
                  { head: t("reports.count"), cell: (r) => r.payments_count, className: "num" },
                  { head: t("reports.total"), cell: (r) => formatAmount(r.total), className: "num" },
                ]}
              />
            )}
          </Loaded>
        </>
      )}
    </Page>
  );
}
