/** Money rules: lasting discounts, refunds, the daily cash close, payment plans and lesson packages. The panel only
 * shows what the server computed and asks the server before anything irreversible; it adds nothing up itself. */

import { useState, type ReactNode } from "react";
import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { formatAmount, formatDate, formatMonth, isPositive, monthStart, parseAmount } from "../lib/format";
import { useStaff } from "../session/context";
import { ConfirmButton, Dialog, Form, FormButton, type Field } from "../ui/form";
import { useAction, useLoad } from "../ui/hooks";
import { Badge, Card, ErrorNote, Facts, Loaded, Page, PAGE_SIZE, Pager, Table, Tabs } from "../ui/kit";
import { options, StudentPicker, useGroups, type Picked } from "../ui/pickers";
import { useStudentFilter } from "./finance";
import { ReminderDrafts } from "./reminders";

const DISCOUNT_KINDS = ["individual", "scholarship", "early_pay"] as const;
const REFUND_KINDS = ["wrong_payment", "leaving", "package_remainder", "to_credit"] as const;
const PACKAGE_METHODS = ["cash", "card", "bank_transfer", "other"] as const;

/** Choose a student first, then show what belongs to that student. */
function StudentDialog({ label, preset, onClose, children }: { label: string; preset?: Picked | null; onClose: () => void; children: (student: Picked) => ReactNode }) {
  const [student, setStudent] = useState<Picked | null>(preset ?? null);
  return (
    <Dialog title={label} onClose={onClose}>
      <StudentPicker value={student} onPick={setStudent} />
      {student ? <div key={student.id}>{children(student)}</div> : null}
    </Dialog>
  );
}

function StudentButton({ label, children }: { label: string; children: (student: Picked, close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="primary" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <StudentDialog label={label} onClose={() => setOpen(false)}>
          {(student) => children(student, () => setOpen(false))}
        </StudentDialog>
      ) : null}
    </>
  );
}

// ---- discounts ------------------------------------------------------------------------------------------------------
function DiscountForm({ student, done, close }: { student: Picked; done: () => void; close: () => void }) {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const enrollments = useLoad(
    async () => (can("academics:read") ? await unwrap(api.GET("/v1/students/{student_id}/enrollments", { params: { path: { student_id: student.id } } })) : []),
    [student.id],
  );
  return (
    <Loaded load={enrollments}>
      {(rows) => (
        <Form
          initial={{ kind: "individual", valid_from: today }}
          fields={[
            { name: "kind", label: t("discounts.kind"), type: "select", required: true, options: DISCOUNT_KINDS.map((k) => ({ value: k, label: label("discountKind", k) })) },
            { name: "percent", label: t("discounts.percent"), type: "money", visible: (v) => v.kind !== "individual" || !v.amount },
            { name: "amount", label: t("discounts.amount"), type: "money", hint: t("discounts.amountHint"), visible: (v) => v.kind === "individual" && !v.percent },
            { name: "pay_by_day", label: t("discounts.payByDay"), type: "number", min: 1, max: 28, visible: (v) => v.kind === "early_pay" },
            { name: "enrollment_id", label: t("discounts.enrollment"), type: "select", hint: t("discounts.enrollmentHint"), options: options(rows, (e) => e.group_name) },
            { name: "valid_from", label: t("discounts.validFrom"), type: "date" },
            { name: "valid_to", label: t("discounts.validTo"), type: "date" },
            { name: "reason", label: t("common.reason"), required: true, minLength: 3, maxLength: 500 },
          ]}
          submitLabel={t("common.save")}
          onCancel={close}
          submit={async (body, key) => {
            await unwrap(api.POST("/v1/discounts", { body: { ...(body as never as components["schemas"]["DiscountIn"]), student_id: student.id }, ...idempotent(key) }));
            done();
            close();
          }}
        />
      )}
    </Loaded>
  );
}

function DiscountReport() {
  const { t, label } = useI18n();
  const { today } = useStaff();
  const [month, setMonth] = useState(today.slice(0, 7));
  const load = useLoad(() => unwrap(api.GET("/v1/reports/discounts", { params: { query: { month: `${month}-01` } } })), [month]);
  return (
    <>
      <div className="filters">
        <label>
          {t("common.month")}
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>
      <Loaded load={load}>
        {(r) => (
          <Card title={formatMonth(r.month)}>
            <Facts
              items={[
                [t("discounts.scholarships"), formatAmount(r.scholarship_total)],
                [t("discounts.others"), formatAmount(r.other_total)],
                [t("reports.total"), formatAmount(r.total)],
              ]}
            />
            <Table
              caption={t("discounts.report")}
              rows={r.rows}
              rowKey={(x) => x.kind}
              columns={[
                { head: t("discounts.kind"), cell: (x) => label("discountLine", x.kind) },
                { head: t("discounts.students"), cell: (x) => x.students, className: "num" },
                { head: t("discounts.lines"), cell: (x) => x.lines, className: "num" },
                { head: t("finance.amount"), cell: (x) => formatAmount(x.amount), className: "num" },
              ]}
            />
          </Card>
        )}
      </Loaded>
    </>
  );
}

function DiscountList() {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const filter = useStudentFilter();
  const [kind, setKind] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const load = useLoad(
    () => unwrap(api.GET("/v1/discounts", { params: { query: { student_id: filter.id ?? undefined, kind: (kind || undefined) as never, active_only: activeOnly, offset, limit: PAGE_SIZE } } })),
    [filter.id, kind, activeOnly, offset],
  );
  const writes = can("finance:write", "students:read");
  return (
    <>
      {writes ? (
        <div className="actions">
          <StudentButton label={t("discounts.add")}>{(student, close) => <DiscountForm student={student} done={load.reload} close={close} />}</StudentButton>
        </div>
      ) : null}
      <div className="filters">
        {can("students:read") ? filter.picker : null}
        <label>
          {t("discounts.kind")}
          <select value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {DISCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {label("discountKind", k)}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={activeOnly} onChange={(e) => { setActiveOnly(e.target.checked); setOffset(0); }} />
          {t("discounts.activeOnly")}
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.discounts")}
              rows={page.items}
              rowKey={(d) => d.id}
              columns={[
                { head: t("common.student"), cell: (d) => d.student_name },
                { head: t("discounts.kind"), cell: (d) => label("discountKind", d.kind) },
                { head: t("discounts.value"), cell: (d) => (d.percent ? `${formatAmount(d.percent)} %` : formatAmount(d.amount)), className: "num" },
                { head: t("discounts.payByDay"), cell: (d) => d.pay_by_day ?? "—" },
                { head: t("discounts.validFrom"), cell: (d) => formatDate(d.valid_from) },
                { head: t("discounts.validTo"), cell: (d) => formatDate(d.valid_to) },
                { head: t("common.reason"), cell: (d) => d.reason },
                { head: t("common.status"), cell: (d) => (d.active ? <Badge tone="good">{t("discounts.active")}</Badge> : <Badge>{t("discounts.inactive")}</Badge>) },
                {
                  head: t("common.actions"),
                  cell: (d) =>
                    writes ? (
                      <FormButton
                        label={t("discounts.end")}
                        patch
                        initial={d.valid_to ? d : { ...d, valid_to: today }}
                        extra={<p className="hint">{t("discounts.endHint")}</p>}
                        fields={[
                          { name: "valid_to", label: t("discounts.lastDay"), type: "date" },
                          { name: "reason", label: t("common.reason"), required: true, minLength: 3, maxLength: 500 },
                        ]}
                        submit={async (body) => {
                          // an end date proposed by the dialog counts as chosen, even when it was not retyped
                          const patch = d.valid_to ? body : { valid_to: today, ...body };
                          await unwrap(api.PATCH("/v1/discounts/{discount_id}", { params: { path: { discount_id: d.id } }, body: patch as never }));
                          load.reload();
                        }}
                      />
                    ) : null,
                },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </>
  );
}

export function DiscountsPage() {
  const { t } = useI18n();
  const { can } = useStaff();
  const [tab, setTab] = useState<"rules" | "report">("rules");
  return (
    <Page title={t("nav.discounts")}>
      {can("reports:read") ? (
        <Tabs label={t("nav.discounts")} value={tab} onChange={setTab} tabs={[{ id: "rules", label: t("discounts.rules") }, { id: "report", label: t("discounts.report") }]} />
      ) : null}
      {tab === "rules" ? <DiscountList /> : <DiscountReport />}
    </Page>
  );
}

// ---- refunds --------------------------------------------------------------------------------------------------------
type RefundIn = components["schemas"]["RefundIn"];

/** Two steps: the server says what a refund would do (nothing is written), and only that exact request can be made. */
function RefundForm({ student, done, close }: { student: Picked; done: () => void; close: () => void }) {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const [asked, setAsked] = useState<{ body: RefundIn; preview: components["schemas"]["RefundPreview"] } | null>(null);
  const make = useAction();
  const path = { student_id: student.id, limit: 200 };
  const payments = useLoad(async () => (await unwrap(api.GET("/v1/payments", { params: { query: path } }))).items, [student.id]);
  const charges = useLoad(async () => (await unwrap(api.GET("/v1/charges", { params: { query: { ...path, state: "all" as never } } }))).items.filter((c) => c.kind === "tuition" && !c.voided), [student.id]);
  const packages = useLoad(async () => (await unwrap(api.GET("/v1/packages", { params: { query: path } }))).items, [student.id]);
  if (asked) {
    const { body, preview } = asked;
    const blocked = preview.errors.length > 0;
    return (
      <>
        <Facts
          items={[
            [t("refunds.kind"), label("refundKind", preview.kind)],
            [t("refunds.payout"), label("payout", preview.payout)],
            [t("finance.amount"), formatAmount(preview.amount)],
            [t("refunds.available"), formatAmount(preview.available)],
            [t("refunds.chargeReduction"), formatAmount(preview.charge_reduction)],
          ]}
        />
        {blocked ? (
          <div className="note note-error" role="alert">
            {preview.errors.map((code) => (
              <p key={code}>{label("refundError", code)}</p>
            ))}
          </div>
        ) : (
          <p>{t("refunds.confirmText", { name: student.name, amount: formatAmount(preview.amount) })}</p>
        )}
        {make.error ? <ErrorNote error={make.error} /> : null}
        <div className="form-actions">
          <button
            type="button"
            className="danger"
            disabled={blocked || make.pending || !can("finance:write")}
            onClick={() =>
              void make.run(async (key) => {
                await unwrap(api.POST("/v1/refunds", { body, ...idempotent(key) }));
                done();
                close();
              })
            }
          >
            {t("refunds.make")}
          </button>
          <button type="button" onClick={() => setAsked(null)} disabled={make.pending}>
            {t("common.change")}
          </button>
        </div>
      </>
    );
  }
  const fields: Field[] = [
    { name: "kind", label: t("refunds.kind"), type: "select", required: true, options: REFUND_KINDS.map((k) => ({ value: k, label: label("refundKind", k) })) },
    { name: "payout", label: t("refunds.payout"), type: "select", required: true, hint: t("refunds.payoutHint"), options: ["cash", "bank", "credit"].map((v) => ({ value: v, label: label("payout", v) })) },
    {
      name: "payment_id",
      label: t("finance.payment"),
      type: "select",
      required: true,
      visible: (v) => v.kind === "wrong_payment",
      options: options(payments.data, (p) => `${formatDate(p.paid_at)} · ${formatAmount(p.amount)} · ${label("method", p.method)}`),
    },
    {
      name: "charge_id",
      label: t("finance.charge"),
      type: "select",
      required: true,
      visible: (v) => v.kind === "leaving" || v.kind === "to_credit",
      options: options(charges.data, (c) => `${formatMonth(c.period_month)} · ${formatAmount(c.amount)}`),
    },
    {
      name: "package_id",
      label: t("packages.one"),
      type: "select",
      required: true,
      visible: (v) => v.kind === "package_remainder",
      options: options(packages.data, (p) => `${p.group_name} · ${formatDate(p.purchased_on)} · ${formatAmount(p.price)}`),
    },
    { name: "left_on", label: t("refunds.leftOn"), type: "date", visible: (v) => v.kind === "leaving" },
    { name: "amount", label: t("finance.amount"), type: "money", hint: t("refunds.amountHint"), visible: (v) => v.kind === "wrong_payment" || v.kind === "to_credit" },
    { name: "reason", label: t("common.reason"), required: true, minLength: 3, maxLength: 500 },
  ];
  return (
    <Form
      fields={fields}
      initial={{ kind: "wrong_payment", payout: "cash", left_on: today }}
      submitLabel={t("refunds.preview")}
      onCancel={close}
      submit={async (typed) => {
        // the fields of the other kinds are hidden, so they are not part of the request
        const body = { ...(typed as unknown as RefundIn), student_id: student.id };
        if (body.kind === "to_credit") body.payout = "credit";
        const preview = await unwrap(api.POST("/v1/refunds/preview", { body }));
        setAsked({ body, preview });
      }}
    />
  );
}

function RefundDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, label } = useI18n();
  const load = useLoad(() => unwrap(api.GET("/v1/refunds/{refund_id}", { params: { path: { refund_id: id } } })), [id]);
  return (
    <Dialog title={t("refunds.one")} onClose={onClose}>
      <Loaded load={load}>
        {(r) => (
          <>
            <Facts
              items={[
                [t("common.student"), r.student_name],
                [t("common.date"), formatDate(r.refunded_on)],
                [t("refunds.kind"), label("refundKind", r.kind)],
                [t("refunds.payout"), label("payout", r.payout)],
                [t("finance.amount"), formatAmount(r.amount)],
                [t("refunds.chargeReduction"), formatAmount(r.charge_reduction)],
                [t("refunds.leftOn"), r.left_on ? formatDate(r.left_on) : null],
                [t("common.reason"), r.reason],
              ]}
            />
            {r.payments?.length ? (
              <Table
                caption={t("refunds.fromPayments")}
                rows={r.payments}
                rowKey={(p) => p.payment_id}
                columns={[
                  { head: t("refunds.fromPayments"), cell: (p) => p.payment_id.slice(0, 8) },
                  { head: t("finance.amount"), cell: (p) => formatAmount(p.amount), className: "num" },
                ]}
              />
            ) : null}
          </>
        )}
      </Loaded>
    </Dialog>
  );
}

export function RefundsPage() {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const filter = useStudentFilter();
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const load = useLoad(
    () =>
      unwrap(
        api.GET("/v1/refunds", {
          params: { query: { student_id: filter.id ?? undefined, kind: (kind || undefined) as never, date_from: from || undefined, date_to: to || undefined, offset, limit: PAGE_SIZE } },
        }),
      ),
    [filter.id, kind, from, to, offset],
  );
  return (
    <Page
      title={t("nav.refunds")}
      actions={
        can("finance:write", "students:read") ? (
          <StudentButton label={t("refunds.add")}>{(student, close) => <RefundForm student={student} done={load.reload} close={close} />}</StudentButton>
        ) : null
      }
    >
      <div className="filters">
        {can("students:read") ? filter.picker : null}
        <label>
          {t("refunds.kind")}
          <select value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {REFUND_KINDS.map((k) => (
              <option key={k} value={k}>
                {label("refundKind", k)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("common.from")}
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
        </label>
        <label>
          {t("common.to")}
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.refunds")}
              rows={page.items}
              rowKey={(r) => r.id}
              columns={[
                { head: t("common.date"), cell: (r) => formatDate(r.refunded_on) },
                { head: t("common.student"), cell: (r) => r.student_name },
                { head: t("refunds.kind"), cell: (r) => label("refundKind", r.kind) },
                { head: t("refunds.payout"), cell: (r) => label("payout", r.payout) },
                { head: t("finance.amount"), cell: (r) => formatAmount(r.amount), className: "num" },
                { head: t("common.actions"), cell: (r) => <button type="button" onClick={() => setOpen(r.id)}>{t("common.open")}</button> },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
      {open ? <RefundDialog id={open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

// ---- cash close -----------------------------------------------------------------------------------------------------
function CashDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, label } = useI18n();
  const load = useLoad(() => unwrap(api.GET("/v1/cash-close/{close_id}", { params: { path: { close_id: id } } })), [id]);
  return (
    <Dialog title={t("cash.one")} onClose={onClose}>
      <Loaded load={load}>
        {(c) => (
          <Facts
            items={[
              [t("common.date"), formatDate(c.close_date)],
              [t("cash.shift"), c.shift_no],
              [t("cash.book"), formatAmount(c.book_balance)],
              [t("cash.counted"), formatAmount(c.counted)],
              [t("cash.difference"), formatAmount(c.difference)],
              [t("common.status"), label("cashStatus", c.status)],
              [t("common.notes"), c.note],
              [t("cash.entry"), c.adjustment_entry_no],
              [t("cash.journalLine"), c.journal_seq],
            ]}
          />
        )}
      </Loaded>
    </Dialog>
  );
}

export function CashClosePage() {
  const { t, label } = useI18n();
  const { can, today, branches, scopeBranch } = useStaff();
  const [day, setDay] = useState(today);
  const [branch, setBranch] = useState("");
  const [from, setFrom] = useState(monthStart(today));
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  // a center with several branches has several cash desks: the main one is shown until another is chosen
  const chosen = scopeBranch ?? (branch || branches.find((b) => b.is_default)?.id);
  const several = !scopeBranch && branches.length > 1;
  const preview = useLoad(() => unwrap(api.GET("/v1/cash-close/preview", { params: { query: { close_date: day, branch_id: chosen } } })), [day, chosen]);
  const history = useLoad(() => unwrap(api.GET("/v1/cash-close", { params: { query: { date_from: from || undefined, offset, limit: PAGE_SIZE } } })), [from, offset]);
  return (
    <Page title={t("nav.cashClose")}>
      <div className="filters">
        <label>
          {t("common.date")}
          <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </label>
        {several ? (
          <label>
            {t("common.branch")}
            <select value={chosen ?? ""} onChange={(e) => setBranch(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <Loaded load={preview}>
        {(p) => (
          <Card
            title={t("cash.state")}
            actions={
              can("finance:write") ? (
                <FormButton
                  key={`${p.branch_id}-${p.close_date}-${p.journal_seq}`}
                  label={t("cash.close")}
                  className="primary"
                  submitLabel={t("cash.close")}
                  danger
                  extra={<p className="hint">{t("cash.closeHint", { amount: formatAmount(p.book_balance) })}</p>}
                  fields={[
                    { name: "counted", label: t("cash.counted"), type: "money", required: true },
                    { name: "note", label: t("common.notes"), type: "textarea", maxLength: 500, hint: t("cash.noteHint") },
                    ...(can("accounting:write") ? ([{ name: "post_difference", label: t("cash.postDifference"), type: "checkbox" }] as Field[]) : []),
                  ]}
                  submit={async (body, key) => {
                    await unwrap(api.POST("/v1/cash-close", { body: { ...(body as never as components["schemas"]["CashCloseIn"]), close_date: p.close_date, branch_id: p.branch_id }, ...idempotent(key) }));
                    preview.reload();
                    history.reload();
                  }}
                />
              ) : null
            }
          >
            <Facts
              items={[
                [t("common.date"), formatDate(p.close_date)],
                [t("cash.book"), formatAmount(p.book_balance)],
                [t("cash.in"), formatAmount(p.cash_in)],
                [t("cash.out"), formatAmount(p.cash_out)],
                [t("cash.shift"), p.next_shift_no],
              ]}
            />
          </Card>
        )}
      </Loaded>
      <div className="filters">
        <label>
          {t("common.from")}
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
        </label>
      </div>
      <Loaded load={history}>
        {(page) => (
          <>
            <Table
              caption={t("cash.history")}
              rows={page.items}
              rowKey={(c) => c.id}
              columns={[
                { head: t("common.date"), cell: (c) => formatDate(c.close_date) },
                { head: t("cash.shift"), cell: (c) => c.shift_no },
                { head: t("cash.book"), cell: (c) => formatAmount(c.book_balance), className: "num" },
                { head: t("cash.counted"), cell: (c) => formatAmount(c.counted), className: "num" },
                { head: t("cash.difference"), cell: (c) => formatAmount(c.difference), className: "num" },
                { head: t("common.status"), cell: (c) => <Badge tone={c.status === "ok" ? "good" : "warn"}>{label("cashStatus", c.status)}</Badge> },
                { head: t("common.actions"), cell: (c) => <button type="button" onClick={() => setOpen(c.id)}>{t("common.open")}</button> },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
      {open ? <CashDialog id={open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

// ---- payment plans --------------------------------------------------------------------------------------------------
type Plan = components["schemas"]["PlanOut"];

/** The installments of one charge. `planned` is null while the charge has no plan (the server answers 404 then). */
function PlanEditor({ charge, planned, changed }: { charge: string; planned: Plan | null; changed: () => void }) {
  const { t } = useI18n();
  const { today } = useStaff();
  const [manual, setManual] = useState<{ amount: string; due_date: string }[] | null>(null);
  const save = useAction();
  const put = (body: components["schemas"]["PlanIn"]) => unwrap(api.PUT("/v1/charges/{charge_id}/plan", { params: { path: { charge_id: charge } }, body }));
  const set = (index: number, field: "amount" | "due_date", value: string) => setManual((rows) => rows!.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  if (manual) {
    const rows = manual.map((r) => ({ amount: parseAmount(r.amount), due_date: r.due_date }));
    const ready = rows.every((r) => r.amount !== null && r.due_date !== "");
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void save.run(async () => {
            await put({ installments: rows as { amount: string; due_date: string }[] });
            setManual(null);
            changed();
          });
        }}
      >
        {manual.map((r, i) => (
          <div className="filters" key={i}>
            <label>
              {t("plans.amountOf", { n: i + 1 })}
              <input inputMode="decimal" value={r.amount} onChange={(e) => set(i, "amount", e.target.value)} />
            </label>
            <label>
              {t("plans.dueOf", { n: i + 1 })}
              <input type="date" value={r.due_date} onChange={(e) => set(i, "due_date", e.target.value)} />
            </label>
          </div>
        ))}
        <p className="hint">{t("plans.sumHint")}</p>
        {save.error ? <ErrorNote error={save.error} /> : null}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={!ready || save.pending}>
            {t("common.save")}
          </button>
          <button type="button" disabled={manual.length >= 24} onClick={() => setManual([...manual, { amount: "", due_date: "" }])}>
            {t("plans.addRow")}
          </button>
          <button type="button" disabled={manual.length <= 2} onClick={() => setManual(manual.slice(0, -1))}>
            {t("plans.removeRow")}
          </button>
          <button type="button" onClick={() => setManual(null)}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="actions">
      <FormButton
        label={planned ? t("plans.replaceEqual") : t("plans.equal")}
        initial={{ count: 2, first_due: today }}
        fields={[
          { name: "count", label: t("plans.count"), type: "number", required: true, min: 2, max: 24 },
          { name: "first_due", label: t("plans.firstDue"), type: "date", required: true },
        ]}
        submit={async (body) => {
          await put({ equal: body as never });
          changed();
        }}
      />
      <button
        type="button"
        onClick={() => setManual(planned ? planned.installments.map((i) => ({ amount: i.amount, due_date: i.due_date })) : [{ amount: "", due_date: today }, { amount: "", due_date: "" }])}
      >
        {t("plans.manual")}
      </button>
      {planned ? (
        <ConfirmButton
          label={t("plans.remove")}
          text={t("plans.removeText")}
          done={changed}
          run={async () => {
            await unwrap(api.DELETE("/v1/charges/{charge_id}/plan", { params: { path: { charge_id: charge } } }));
          }}
        />
      ) : null}
    </div>
  );
}

export function PaymentPlan({ charge, voided, changed }: { charge: string; voided: boolean; changed: () => void }) {
  const { t } = useI18n();
  const { can } = useStaff();
  const load = useLoad(async () => {
    try {
      return await unwrap(api.GET("/v1/charges/{charge_id}/plan", { params: { path: { charge_id: charge } } }));
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }, [charge]);
  const reload = () => {
    load.reload();
    changed();
  };
  return (
    <section aria-label={t("plans.title")}>
      <h3>{t("plans.title")}</h3>
      <Loaded load={load}>
        {(plan) => (
          <>
            {plan ? (
              <Table
                caption={t("plans.title")}
                rows={plan.installments}
                rowKey={(i) => String(i.seq)}
                columns={[
                  { head: t("plans.number"), cell: (i) => i.seq },
                  { head: t("finance.dueDate"), cell: (i) => formatDate(i.due_date) },
                  { head: t("finance.amount"), cell: (i) => formatAmount(i.amount), className: "num" },
                  { head: t("finance.outstanding"), cell: (i) => formatAmount(i.outstanding), className: "num" },
                  {
                    head: t("common.status"),
                    cell: (i) =>
                      i.overdue ? <Badge tone="bad">{t("finance.overdue")}</Badge> : isPositive(i.outstanding) ? <Badge tone="warn">{t("finance.open")}</Badge> : <Badge tone="good">{t("finance.settled")}</Badge>,
                  },
                ]}
              />
            ) : (
              <p className="empty">{t("plans.none")}</p>
            )}
            {can("finance:write") && !voided ? <PlanEditor charge={charge} planned={plan} changed={reload} /> : null}
          </>
        )}
      </Loaded>
    </section>
  );
}

export function InstallmentsPage() {
  const { t } = useI18n();
  const [days, setDays] = useState("7");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const load = useLoad(
    () => unwrap(api.GET("/v1/reports/installments", { params: { query: { days_ahead: Math.min(365, Math.max(0, Number(days) || 0)), only_overdue: overdueOnly, limit: 500 } } })),
    [days, overdueOnly],
  );
  return (
    <Page title={t("nav.installments")}>
      <p className="hint">{t("plans.reportHint")}</p>
      <div className="filters">
        <label>
          {t("plans.daysAhead")}
          <input type="number" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          {t("plans.onlyOverdue")}
        </label>
      </div>
      <Loaded load={load}>
        {(rows) => (
          <Table
            caption={t("nav.installments")}
            rows={rows}
            rowKey={(r) => `${r.charge_id}-${r.seq}`}
            columns={[
              { head: t("common.student"), cell: (r) => r.student_name },
              { head: t("common.phone"), cell: (r) => r.phone ?? "—" },
              { head: t("plans.number"), cell: (r) => `${r.seq}/${r.installments_count}` },
              { head: t("finance.dueDate"), cell: (r) => formatDate(r.due_date) },
              { head: t("finance.outstanding"), cell: (r) => formatAmount(r.outstanding), className: "num" },
              {
                head: t("common.status"),
                cell: (r) => (r.days_overdue > 0 ? <Badge tone="bad">{t("plans.lateDays", { n: r.days_overdue })}</Badge> : <Badge tone="warn">{t("plans.dueInDays", { n: -r.days_overdue })}</Badge>),
              },
            ]}
          />
        )}
      </Loaded>
    </Page>
  );
}

// ---- lesson packages ------------------------------------------------------------------------------------------------
function SellPackage({ student, done, close }: { student: Picked; done: () => void; close: () => void }) {
  const { t, label } = useI18n();
  const { today } = useStaff();
  const groups = useGroups();
  const enrollments = useLoad(() => unwrap(api.GET("/v1/students/{student_id}/enrollments", { params: { path: { student_id: student.id } } })), [student.id]);
  const packaged = new Set((groups.data ?? []).filter((g) => g.billing_mode === "package").map((g) => g.id));
  const open = (enrollments.data ?? []).filter((e) => packaged.has(e.group_id) && !e.ended_on);
  if (!groups.data || !enrollments.data) return <Loaded load={enrollments}>{() => <p className="muted" role="status">{t("common.loading")}</p>}</Loaded>;
  if (!open.length) return <p className="empty">{t("packages.noEnrollment")}</p>;
  return (
    <Form
      initial={{ purchased_on: today, enrollment_id: open.length === 1 ? open[0]!.id : "", pay_method: "cash" }}
      fields={[
        { name: "enrollment_id", label: t("common.group"), type: "select", required: true, options: options(open, (e) => e.group_name) },
        { name: "purchased_on", label: t("packages.purchasedOn"), type: "date" },
        { name: "pay_now", label: t("packages.payNow"), type: "checkbox" },
        { name: "pay_amount", label: t("finance.amount"), type: "money", required: true, visible: (v) => v.pay_now === true },
        { name: "pay_method", label: t("finance.method"), type: "select", required: true, visible: (v) => v.pay_now === true, options: PACKAGE_METHODS.map((m) => ({ value: m, label: label("method", m) })) },
      ]}
      submitLabel={t("packages.sell")}
      onCancel={close}
      submit={async (body, key) => {
        const sale = {
          enrollment_id: String(body.enrollment_id),
          purchased_on: body.purchased_on ? String(body.purchased_on) : undefined,
          pay: body.pay_now ? { amount: String(body.pay_amount), method: String(body.pay_method) as (typeof PACKAGE_METHODS)[number] } : undefined,
        };
        await unwrap(api.POST("/v1/packages", { body: sale, ...idempotent(key) }));
        done();
        close();
      }}
    />
  );
}

function LessonBalance({ student }: { student: Picked }) {
  const { t, label } = useI18n();
  const load = useLoad(() => unwrap(api.GET("/v1/students/{student_id}/lesson-balance", { params: { path: { student_id: student.id } } })), [student.id]);
  return (
    <Card title={`${t("packages.balance")}: ${student.name}`}>
      <Loaded load={load}>
        {(rows) => (
          <Table
            caption={t("packages.balance")}
            empty={t("packages.noBalance")}
            rows={rows}
            rowKey={(r) => r.enrollment_id}
            columns={[
              { head: t("common.group"), cell: (r) => r.group_name },
              { head: t("packages.lessonsLeft"), cell: (r) => r.balance_lessons, className: "num" },
              { head: t("packages.burned"), cell: (r) => r.burned, className: "num" },
              { head: t("packages.debt"), cell: (r) => formatAmount(r.debt_amount), className: "num" },
              { head: t("packages.nextExpiry"), cell: (r) => formatDate(r.next_expiry) },
              { head: t("common.status"), cell: (r) => <Badge tone={r.need === "ok" ? "good" : "warn"}>{label("packageNeed", r.need)}</Badge> },
            ]}
          />
        )}
      </Loaded>
    </Card>
  );
}

function PackageList() {
  const { t } = useI18n();
  const { can, today } = useStaff();
  const filter = useStudentFilter();
  const [state, setState] = useState("true");
  const [offset, setOffset] = useState(0);
  const load = useLoad(
    () => unwrap(api.GET("/v1/packages", { params: { query: { student_id: filter.id ?? undefined, active: state === "" ? undefined : state === "true", offset, limit: PAGE_SIZE } } })),
    [filter.id, state, offset],
  );
  const name = useLoad(
    async () => (filter.id && can("students:read") ? (await unwrap(api.GET("/v1/students/{student_id}", { params: { path: { student_id: filter.id } } }))).full_name : null),
    [filter.id],
  );
  const writes = can("finance:write", "students:read", "academics:read");
  return (
    <>
      {writes ? (
        <div className="actions">
          <StudentButton label={t("packages.sell")}>{(student, close) => <SellPackage student={student} done={load.reload} close={close} />}</StudentButton>
        </div>
      ) : null}
      <div className="filters">
        {can("students:read") ? filter.picker : null}
        <label>
          {t("common.status")}
          <select value={state} onChange={(e) => { setState(e.target.value); setOffset(0); }}>
            <option value="true">{t("packages.valid")}</option>
            <option value="false">{t("packages.expired")}</option>
            <option value="">{t("common.all")}</option>
          </select>
        </label>
      </div>
      {filter.id && name.data ? <LessonBalance student={{ id: filter.id, name: name.data }} /> : null}
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.packages")}
              rows={page.items}
              rowKey={(p) => p.id}
              columns={[
                { head: t("common.student"), cell: (p) => p.student_name },
                { head: t("common.group"), cell: (p) => p.group_name },
                { head: t("packages.lessons"), cell: (p) => p.lessons, className: "num" },
                { head: t("packages.price"), cell: (p) => formatAmount(p.price), className: "num" },
                { head: t("finance.paid"), cell: (p) => formatAmount(p.paid), className: "num" },
                { head: t("packages.purchasedOn"), cell: (p) => formatDate(p.purchased_on) },
                { head: t("packages.expiresOn"), cell: (p) => formatDate(p.expires_on) },
                {
                  head: t("common.actions"),
                  cell: (p) =>
                    can("finance:write") ? (
                      <FormButton
                        label={t("packages.extend")}
                        initial={{ expires_on: p.expires_on < today ? today : p.expires_on }}
                        fields={[{ name: "expires_on", label: t("packages.newExpiry"), type: "date", required: true }]}
                        submit={async (body, key) => {
                          await unwrap(api.POST("/v1/packages/{package_id}/extend", { params: { path: { package_id: p.id } }, body: body as never, ...idempotent(key) }));
                          load.reload();
                        }}
                      />
                    ) : null,
                },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </>
  );
}

function PaymentNeeded() {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const [need, setNeed] = useState("");
  const [reminding, setReminding] = useState(false);
  const load = useLoad(() => unwrap(api.GET("/v1/reports/packages/payment-needed", { params: { query: { need: (need || undefined) as never } } })), [need]);
  return (
    <>
      {can("finance:read", "students:write") && !reminding ? (
        <div className="actions">
          <button type="button" className="primary" onClick={() => setReminding(true)}>
            {t("reminders.make")}
          </button>
        </div>
      ) : null}
      {reminding ? (
        <ReminderDrafts
          title={t("packages.reminders")}
          onClose={() => setReminding(false)}
          load={async () => {
            const preview = await unwrap(api.GET("/v1/reports/packages/payment-needed/reminders"));
            return { skipped: preview.skipped, drafts: preview.drafts.map((d) => ({ ...d, note: label("packageNeed", d.need) })) };
          }}
          send={(messages, key) => unwrap(api.POST("/v1/reports/packages/payment-needed/reminders", { body: { messages }, ...idempotent(key) }))}
        />
      ) : null}
      <div className="filters">
        <label>
          {t("packages.need")}
          <select value={need} onChange={(e) => setNeed(e.target.value)}>
            <option value="">{t("common.all")}</option>
            {["low", "exhausted", "debt"].map((n) => (
              <option key={n} value={n}>
                {label("packageNeed", n)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Loaded load={load}>
        {(rows) => (
          <Table
            caption={t("packages.paymentNeeded")}
            rows={rows}
            rowKey={(r) => r.enrollment_id}
            columns={[
              { head: t("common.student"), cell: (r) => r.student_name },
              { head: t("common.group"), cell: (r) => r.group_name },
              { head: t("common.guardian"), cell: (r) => r.guardian_name },
              { head: t("packages.lessonsLeft"), cell: (r) => r.balance_lessons, className: "num" },
              { head: t("packages.debt"), cell: (r) => formatAmount(r.debt_amount), className: "num" },
              { head: t("packages.need"), cell: (r) => <Badge tone="warn">{label("packageNeed", r.need)}</Badge> },
            ]}
          />
        )}
      </Loaded>
    </>
  );
}

export function PackagesPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<"list" | "need">("list");
  return (
    <Page title={t("nav.packages")}>
      <Tabs label={t("nav.packages")} value={tab} onChange={setTab} tabs={[{ id: "list", label: t("packages.sold") }, { id: "need", label: t("packages.paymentNeeded") }]} />
      {tab === "list" ? <PackageList /> : <PaymentNeeded />}
    </Page>
  );
}
