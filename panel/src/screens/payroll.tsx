/** Teacher payroll: the server computes every line from the lessons and the money; the panel starts the computation,
 * adds bonuses and penalties to a draft, and asks before approving or marking as paid. */

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { formatAmount, formatDateTime, formatMonth } from "../lib/format";
import { useStaff } from "../session/context";
import { ConfirmButton, FormButton } from "../ui/form";
import { useLoad } from "../ui/hooks";
import { Badge, Card, Done, Facts, Loaded, Page, PAGE_SIZE, Pager, Table } from "../ui/kit";
import { options, useTeachers } from "../ui/pickers";

const STATUSES = ["draft", "approved", "paid"] as const;

function PayrollState({ status }: { status: string }) {
  const { label } = useI18n();
  return <Badge tone={status === "paid" ? "good" : status === "approved" ? "warn" : "plain"}>{label("payrollStatus", status)}</Badge>;
}

export function PayrollPage() {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const navigate = useNavigate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [status, setStatus] = useState("");
  const [teacher, setTeacher] = useState("");
  const [offset, setOffset] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const teachers = useTeachers(can("academics:read"));
  const load = useLoad(
    () =>
      unwrap(
        api.GET("/v1/payrolls", {
          params: { query: { month: month ? `${month}-01` : undefined, status: (status || undefined) as never, teacher_id: teacher || undefined, offset, limit: PAGE_SIZE } },
        }),
      ),
    [month, status, teacher, offset],
  );
  const generate = (teacherId: string, day: string, key: string) =>
    unwrap(api.POST("/v1/payrolls/generate", { body: { teacher_id: teacherId, month: day }, ...idempotent(key) }));
  const writes = can("payroll:write", "academics:read");
  return (
    <Page
      title={t("nav.payroll")}
      actions={
        writes ? (
          <>
            <FormButton
              label={t("payroll.generateOne")}
              initial={{ month: today.slice(0, 7) }}
              submitLabel={t("payroll.generate")}
              fields={[
                { name: "teacher_id", label: t("common.teacher"), type: "select", required: true, options: options(teachers.data, (x) => x.full_name) },
                { name: "month", label: t("common.month"), type: "month", required: true },
              ]}
              submit={async (body, key) => {
                const made = await generate(String(body.teacher_id), String(body.month), key);
                navigate(`/payroll/${made.id}`);
              }}
            />
            {/* the Sheets menu item computes everybody at once: one draft per active teacher, approved ones untouched */}
            <FormButton
              label={t("payroll.generateAll")}
              className="primary"
              initial={{ month: today.slice(0, 7) }}
              submitLabel={t("payroll.generate")}
              extra={<p className="hint">{t("payroll.generateAllHint")}</p>}
              fields={[{ name: "month", label: t("common.month"), type: "month", required: true }]}
              submit={async (body, key) => {
                const day = String(body.month);
                const frozen = new Set<string>();
                for (const state of ["approved", "paid"] as const) {
                  const page = await unwrap(api.GET("/v1/payrolls", { params: { query: { month: day, status: state, limit: 200 } } }));
                  for (const row of page.items) frozen.add(row.teacher_id);
                }
                const wanted = (teachers.data ?? []).filter((x) => x.status === "active" && !frozen.has(x.id));
                for (const one of wanted) await generate(one.id, day, `${key}-${one.id.slice(0, 8)}`);
                setDone(t("payroll.generated", { made: wanted.length, frozen: frozen.size }));
                setMonth(day.slice(0, 7));
                load.reload();
              }}
            />
          </>
        ) : null
      }
    >
      <Done text={done} />
      <div className="filters">
        <label>
          {t("common.month")}
          <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setOffset(0); }} />
        </label>
        <label>
          {t("common.status")}
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">{t("common.all")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label("payrollStatus", s)}
              </option>
            ))}
          </select>
        </label>
        {can("academics:read") ? (
          <label>
            {t("common.teacher")}
            <select value={teacher} onChange={(e) => { setTeacher(e.target.value); setOffset(0); }}>
              <option value="">{t("common.all")}</option>
              {(teachers.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.full_name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.payroll")}
              rows={page.items}
              rowKey={(p) => p.id}
              columns={[
                { head: t("common.teacher"), cell: (p) => <Link to={`/payroll/${p.id}`}>{p.teacher_name}</Link> },
                { head: t("common.month"), cell: (p) => formatMonth(p.period_month) },
                { head: t("reports.total"), cell: (p) => formatAmount(p.total), className: "num" },
                { head: t("common.status"), cell: (p) => <PayrollState status={p.status} /> },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </Page>
  );
}

export function PayrollDetailPage() {
  const { id = "" } = useParams();
  const { t, label } = useI18n();
  const { can, timeZone } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/payrolls/{payroll_id}", { params: { path: { payroll_id: id } } })), [id]);
  const path = { params: { path: { payroll_id: id } } };
  return (
    <Page title={t("payroll.one")} back={{ to: "/payroll", label: t("nav.payroll") }}>
      <Loaded load={load}>
        {(p) => {
          const draft = p.status === "draft";
          return (
            <>
              <Card
                title={`${p.teacher_name} · ${formatMonth(p.period_month)}`}
                actions={
                  <>
                    {draft && can("payroll:write") ? (
                      <>
                        <FormButton
                          label={t("payroll.addLine")}
                          initial={{ kind: "bonus" }}
                          extra={<p className="hint">{t("payroll.lineHint")}</p>}
                          fields={[
                            { name: "kind", label: t("finance.kind"), type: "select", required: true, options: ["bonus", "penalty", "adjustment"].map((k) => ({ value: k, label: label("payrollItem", k) })) },
                            { name: "amount", label: t("finance.amount"), required: true, hint: t("payroll.signedHint") },
                            { name: "description", label: t("common.description"), maxLength: 4000 },
                          ]}
                          submit={async (body, key) => {
                            // only an adjustment may be negative; the server refuses anything else it cannot read
                            const amount = String(body.amount).replace(/\s/g, "").replace(",", ".");
                            await unwrap(api.POST("/v1/payrolls/{payroll_id}/items", { ...path, body: { ...(body as never as { kind: "bonus" }), amount }, ...idempotent(key) }));
                            load.reload();
                          }}
                        />
                        <FormButton
                          label={t("payroll.recompute")}
                          submitLabel={t("payroll.recompute")}
                          fields={[]}
                          extra={<p>{t("payroll.recomputeText")}</p>}
                          submit={async (_body, key) => {
                            await unwrap(api.POST("/v1/payrolls/generate", { body: { teacher_id: p.teacher_id, month: p.period_month }, ...idempotent(key) }));
                            load.reload();
                          }}
                        />
                      </>
                    ) : null}
                    {draft && can("payroll:approve") ? (
                      <ConfirmButton
                        label={t("payroll.approve")}
                        text={t("payroll.approveText", { amount: formatAmount(p.total) })}
                        danger={false}
                        done={load.reload}
                        run={async (_reason, key) => {
                          await unwrap(api.POST("/v1/payrolls/{payroll_id}/approve", { ...path, ...idempotent(key) }));
                        }}
                      />
                    ) : null}
                    {p.status === "approved" && can("payroll:write") ? (
                      <ConfirmButton
                        label={t("payroll.markPaid")}
                        text={t("payroll.paidText", { amount: formatAmount(p.total) })}
                        done={load.reload}
                        run={async (_reason, key) => {
                          await unwrap(api.POST("/v1/payrolls/{payroll_id}/pay", { ...path, ...idempotent(key) }));
                        }}
                      />
                    ) : null}
                  </>
                }
              >
                <Facts
                  items={[
                    [t("reports.total"), formatAmount(p.total)],
                    [t("payroll.approvedAt"), p.approved_at ? formatDateTime(p.approved_at, timeZone) : null],
                    [t("payroll.paidAt"), p.paid_at ? formatDateTime(p.paid_at, timeZone) : null],
                    [t("common.notes"), p.note],
                  ]}
                />
                <PayrollState status={p.status} />
              </Card>
              <Card title={t("payroll.lines")}>
                <Table
                  caption={t("payroll.lines")}
                  rows={p.items}
                  rowKey={(x) => x.id}
                  columns={[
                    { head: t("finance.kind"), cell: (x) => label("payrollItem", x.kind) },
                    { head: t("common.description"), cell: (x) => x.description ?? "—" },
                    { head: t("finance.amount"), cell: (x) => formatAmount(x.amount), className: "num" },
                    {
                      head: t("common.actions"),
                      cell: (x) =>
                        draft && can("payroll:write") ? (
                          <ConfirmButton
                            label={t("common.delete")}
                            text={t("payroll.removeText", { amount: formatAmount(x.amount) })}
                            done={load.reload}
                            run={async () => {
                              await unwrap(api.DELETE("/v1/payrolls/{payroll_id}/items/{item_id}", { params: { path: { payroll_id: id, item_id: x.id } } }));
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
