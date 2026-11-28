/** Students and their guardians, consents, enrollments, money summary and QR card. */

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { components } from "@api/schema";
import { api, idempotent, saveFile, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { formatAmount, formatDate, formatDateTime, isPositive } from "../lib/format";
import { useStaff } from "../session/context";
import { ConfirmButton, Dialog, Form, FormButton, type Field } from "../ui/form";
import { useAction, useDebounced, useLoad } from "../ui/hooks";
import { Badge, Card, Done, ErrorNote, Facts, Loaded, Page, PAGE_SIZE, Pager, Table } from "../ui/kit";
import { GuardianPicker, options, useGroups, type Picked } from "../ui/pickers";

type Student = components["schemas"]["StudentDetail"];
const STATUSES = ["lead", "active", "paused", "graduated", "left"] as const;
const PURPOSES = ["data_processing", "notifications", "ai_assistant_processing", "marketing"] as const;
const RELATIONS = ["mother", "father", "guardian", "self", "other"] as const;

export function useStudentFields(withBranch: boolean): Field[] {
  const { t, label } = useI18n();
  const { branches, scopeBranch } = useStaff();
  const fields: Field[] = [
    { name: "full_name", label: t("common.fullName"), required: true, maxLength: 200 },
    { name: "phone", label: t("common.phone"), type: "tel", hint: t("common.phoneHint") },
    { name: "birth_date", label: t("students.birthDate"), type: "date" },
    { name: "joined_on", label: t("students.joinedOn"), type: "date" },
    { name: "status", label: t("common.status"), type: "select", options: STATUSES.map((s) => ({ value: s, label: label("studentStatus", s) })) },
    { name: "notes", label: t("common.notes"), type: "textarea", maxLength: 2000 },
  ];
  if (withBranch && !scopeBranch && branches.length > 1) {
    fields.push({ name: "branch_id", label: t("common.branch"), type: "select", options: options(branches, (b) => b.name) });
  }
  return fields;
}

export function StudentsPage() {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useDebounced(text.trim());
  const load = useLoad(
    () =>
      unwrap(
        api.GET("/v1/students", { params: { query: { q: q || undefined, status: (status || undefined) as never, limit: PAGE_SIZE, offset } } }),
      ),
    [q, status, offset],
  );
  const createFields = useStudentFields(true);
  const issue = useAction();
  const [issued, setIssued] = useState<string | null>(null);
  return (
    <Page
      title={t("nav.students")}
      actions={
        can("students:write") ? (
          <>
            <FormButton
              label={t("students.add")}
              className="primary"
              fields={createFields}
              submit={async (body, key) => {
                const made = await unwrap(api.POST("/v1/students", { body: body as never, ...idempotent(key) }));
                navigate(`/students/${made.id}`);
              }}
            />
            <ConfirmButton
              label={t("qr.issueAll")}
              text={t("qr.issueAllText")}
              danger={false}
              run={async (_reason, key) => {
                await issue.run(async () => {
                  const result = await unwrap(api.POST("/v1/attendance/qr-codes/issue", idempotent(key)));
                  setIssued(t("qr.issuedCount", { n: result.issued }));
                });
              }}
            />
          </>
        ) : null
      }
    >
      <Done text={issued} />
      {issue.error ? <ErrorNote error={issue.error} /> : null}
      <div className="filters">
        <label>
          {t("common.search")}
          <input
            type="search"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          {t("common.status")}
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">{t("common.all")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label("studentStatus", s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.students")}
              rows={page.items}
              rowKey={(s) => s.id}
              columns={[
                { head: t("common.fullName"), cell: (s) => <Link to={`/students/${s.id}`}>{s.full_name}</Link> },
                { head: t("common.phone"), cell: (s) => s.phone ?? "—" },
                { head: t("common.status"), cell: (s) => label("studentStatus", s.status) },
                { head: t("students.joinedOn"), cell: (s) => formatDate(s.joined_on) },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </Page>
  );
}

function Guardians({ student, reload }: { student: Student; reload: () => void }) {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const linkFields: Field[] = [
    { name: "relation", label: t("students.relation"), type: "select", required: true, options: RELATIONS.map((r) => ({ value: r, label: label("relation", r) })) },
    { name: "is_primary", label: t("students.primary"), type: "checkbox" },
    { name: "receives_reminders", label: t("students.receivesReminders"), type: "checkbox" },
  ];
  const close = () => {
    setAdding(false);
    setPicked(null);
  };
  return (
    <Card
      title={t("nav.guardians")}
      actions={can("students:write") ? <button type="button" onClick={() => setAdding(true)}>{t("students.linkGuardian")}</button> : null}
    >
      <Table
        caption={t("nav.guardians")}
        empty={t("students.noGuardians")}
        rows={student.guardians}
        rowKey={(g) => g.guardian_id}
        columns={[
          { head: t("common.fullName"), cell: (g) => <Link to={`/guardians?id=${g.guardian_id}`}>{g.full_name}</Link> },
          { head: t("students.relation"), cell: (g) => label("relation", g.relation) },
          { head: t("common.phone"), cell: (g) => g.phone ?? "—" },
          {
            head: t("common.status"),
            cell: (g) => (
              <>
                {g.is_primary ? <Badge tone="good">{t("students.primary")}</Badge> : null} {g.receives_reminders ? <Badge>{t("students.receivesReminders")}</Badge> : null}
              </>
            ),
          },
          {
            head: t("common.actions"),
            cell: (g) =>
              can("students:write") ? (
                <div className="row-actions">
                  <FormButton
                    label={t("common.edit")}
                    fields={linkFields}
                    initial={g}
                    patch
                    submit={async (body) => {
                      await unwrap(
                        api.PATCH("/v1/students/{student_id}/guardians/{guardian_id}", {
                          params: { path: { student_id: student.id, guardian_id: g.guardian_id } },
                          body: body as never,
                        }),
                      );
                      reload();
                    }}
                  />
                  <ConfirmButton
                    label={t("students.unlink")}
                    text={t("students.unlinkText", { name: g.full_name })}
                    done={reload}
                    run={async () => {
                      await unwrap(
                        api.DELETE("/v1/students/{student_id}/guardians/{guardian_id}", {
                          params: { path: { student_id: student.id, guardian_id: g.guardian_id } },
                        }),
                      );
                    }}
                  />
                </div>
              ) : null,
          },
        ]}
      />
      {adding ? (
        <Dialog title={t("students.linkGuardian")} onClose={close}>
          <GuardianPicker value={picked} onPick={setPicked} />
          <p className="hint">
            <Link to="/guardians">{t("students.newGuardianFirst")}</Link>
          </p>
          {picked ? (
            <Form
              fields={linkFields}
              initial={{ receives_reminders: true }}
              submitLabel={t("common.save")}
              onCancel={close}
              submit={async (body, key) => {
                await unwrap(
                  api.POST("/v1/students/{student_id}/guardians", {
                    params: { path: { student_id: student.id } },
                    body: { ...(body as never as components["schemas"]["LinkIn"]), guardian_id: picked.id },
                    ...idempotent(key),
                  }),
                );
                close();
                reload();
              }}
            />
          ) : null}
        </Dialog>
      ) : null}
    </Card>
  );
}

function Consents({ student }: { student: Student }) {
  const { t, label } = useI18n();
  const { can, timeZone, today } = useStaff();
  const load = useLoad(
    () => unwrap(api.GET("/v1/students/{student_id}/consents", { params: { path: { student_id: student.id } } })),
    [student.id],
  );
  const fields: Field[] = [
    { name: "purpose", label: t("consent.purpose"), type: "select", required: true, options: PURPOSES.map((p) => ({ value: p, label: label("purpose", p) })) },
    {
      name: "given_by",
      label: t("consent.givenBy"),
      type: "select",
      required: true,
      options: [{ value: "self", label: t("consent.self") }, ...student.guardians.map((g) => ({ value: g.guardian_id, label: g.full_name }))],
    },
    { name: "policy_version", label: t("consent.policyVersion"), required: true, maxLength: 40 },
    { name: "evidence", label: t("consent.evidence"), type: "textarea", maxLength: 1000 },
  ];
  return (
    <Card
      title={t("consent.title")}
      actions={
        can("consents:write") ? (
          <FormButton
            label={t("consent.give")}
            fields={fields}
            initial={{ policy_version: today.slice(0, 7) }}
            submit={async (body, key) => {
              const { given_by, ...rest } = body as Record<string, string>;
              await unwrap(
                api.POST("/v1/students/{student_id}/consents", {
                  params: { path: { student_id: student.id } },
                  body: {
                    ...(rest as never as components["schemas"]["ConsentIn"]),
                    ...(given_by === "self" ? { given_by_self: true } : { given_by_guardian_id: given_by }),
                  },
                  ...idempotent(key),
                }),
              );
              load.reload();
            }}
          />
        ) : null
      }
    >
      <Loaded load={load}>
        {(rows) => (
          <Table
            caption={t("consent.title")}
            empty={t("consent.none")}
            rows={rows}
            rowKey={(c) => c.id}
            columns={[
              { head: t("consent.purpose"), cell: (c) => label("purpose", c.purpose) },
              { head: t("consent.grantedAt"), cell: (c) => formatDateTime(c.granted_at, timeZone) },
              { head: t("common.status"), cell: (c) => (c.revoked_at ? <Badge tone="bad">{t("consent.revoked")}</Badge> : <Badge tone="good">{t("consent.active")}</Badge>) },
              {
                head: t("common.actions"),
                cell: (c) =>
                  !c.revoked_at && can("consents:write") ? (
                    <ConfirmButton
                      label={t("consent.revoke")}
                      text={t("consent.revokeText")}
                      done={load.reload}
                      run={async (_reason, key) => {
                        await unwrap(api.POST("/v1/consents/{consent_id}/revoke", { params: { path: { consent_id: c.id } }, ...idempotent(key) }));
                      }}
                    />
                  ) : null,
              },
            ]}
          />
        )}
      </Loaded>
    </Card>
  );
}

function Enrollments({ student }: { student: Student }) {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const load = useLoad(
    () => unwrap(api.GET("/v1/students/{student_id}/enrollments", { params: { path: { student_id: student.id } } })),
    [student.id],
  );
  const mayEnroll = can("academics:write", "students:read");
  const groups = useGroups(mayEnroll);
  const fields: Field[] = [
    { name: "group_id", label: t("common.group"), type: "select", required: true, options: options(groups.data, (g) => g.name) },
    { name: "started_on", label: t("enroll.startedOn"), type: "date", required: true },
    { name: "status", label: t("common.status"), type: "select", required: true, options: ["active", "trial"].map((s) => ({ value: s, label: label("enrollmentStatus", s) })) },
    { name: "monthly_fee_override", label: t("enroll.fee"), type: "money" },
    { name: "discount_percent", label: t("enroll.discount"), maxLength: 6 },
    { name: "ignore_waitlist", label: t("enroll.ignoreWaitlist"), type: "checkbox" },
  ];
  return (
    <Card
      title={t("enroll.title")}
      actions={
        mayEnroll ? (
          <FormButton
            label={t("enroll.add")}
            fields={fields}
            initial={{ started_on: today, status: "active" }}
            submit={async (body, key) => {
              const { group_id, ...rest } = body as Record<string, string>;
              await unwrap(
                api.POST("/v1/groups/{group_id}/enrollments", {
                  params: { path: { group_id: group_id! } },
                  body: { ...(rest as never as components["schemas"]["EnrollmentIn"]), student_id: student.id },
                  ...idempotent(key),
                }),
              );
              load.reload();
            }}
          />
        ) : null
      }
    >
      <Loaded load={load}>
        {(rows) => (
          <Table
            caption={t("enroll.title")}
            empty={t("enroll.none")}
            rows={rows}
            rowKey={(e) => e.id}
            columns={[
              { head: t("common.group"), cell: (e) => <Link to={`/groups/${e.group_id}`}>{e.group_name}</Link> },
              { head: t("common.status"), cell: (e) => label("enrollmentStatus", e.status) },
              { head: t("enroll.startedOn"), cell: (e) => formatDate(e.started_on) },
              { head: t("enroll.effectiveFee"), cell: (e) => formatAmount(e.effective_monthly_fee), className: "num" },
              { head: t("common.actions"), cell: (e) => (can("academics:write", "students:read") ? <EditEnrollment id={e.id} done={load.reload} /> : null) },
            ]}
          />
        )}
      </Loaded>
    </Card>
  );
}

/** Edit one enrollment, from a fresh copy of the record. */
export function EditEnrollment({ id, done }: { id: string; done: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {t("common.edit")}
      </button>
      {open ? <EnrollmentDialog id={id} done={done} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function EnrollmentDialog({ id, done, onClose }: { id: string; done: () => void; onClose: () => void }) {
  const { t, label } = useI18n();
  const load = useLoad(() => unwrap(api.GET("/v1/enrollments/{enrollment_id}", { params: { path: { enrollment_id: id } } })), [id]);
  const statuses = (current: string) => [...new Set([current, "active", "frozen", "finished"])];
  return (
    <Dialog title={t("enroll.edit")} onClose={onClose}>
      <Loaded load={load}>
        {(e) => (
          <Form
            patch
            initial={e}
            fields={[
              { name: "status", label: t("common.status"), type: "select", required: true, options: statuses(e.status).map((s) => ({ value: s, label: label("enrollmentStatus", s) })) },
              { name: "ended_on", label: t("enroll.endedOn"), type: "date" },
              { name: "monthly_fee_override", label: t("enroll.fee"), type: "money" },
              { name: "discount_percent", label: t("enroll.discount"), required: true, maxLength: 6 },
            ]}
            submitLabel={t("common.save")}
            onCancel={onClose}
            submit={async (body) => {
              await unwrap(api.PATCH("/v1/enrollments/{enrollment_id}", { params: { path: { enrollment_id: id } }, body: body as never }));
              done();
              onClose();
            }}
          />
        )}
      </Loaded>
    </Dialog>
  );
}

function Money({ student }: { student: Student }) {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const load = useLoad(
    () => unwrap(api.GET("/v1/students/{student_id}/balance", { params: { path: { student_id: student.id } } })),
    [student.id],
  );
  const [done, setDone] = useState<string | null>(null);
  return (
    <Card
      title={t("finance.balance")}
      actions={
        <>
          <Link to={`/charges?student=${student.id}`}>{t("nav.charges")}</Link>
          <Link to={`/payments?student=${student.id}`}>{t("nav.payments")}</Link>
        </>
      }
    >
      <Done text={done} />
      <Loaded load={load}>
        {(b) => (
          <>
            <Facts
              items={[
                [t("finance.outstanding"), formatAmount(b.outstanding_total)],
                [t("finance.overdue"), formatAmount(b.overdue_total)],
                [t("finance.credit"), formatAmount(b.credit)],
              ]}
            />
            <Table
              caption={t("finance.openCharges")}
              empty={t("finance.noOpenCharges")}
              rows={b.open_charges}
              rowKey={(c) => c.id}
              columns={[
                { head: t("finance.kind"), cell: (c) => label("chargeKind", c.kind) },
                { head: t("finance.dueDate"), cell: (c) => formatDate(c.due_date) },
                { head: t("finance.outstanding"), cell: (c) => formatAmount(c.outstanding), className: "num" },
              ]}
            />
            {can("finance:write") && isPositive(b.credit) && b.open_charges.length ? (
              <ConfirmButton
                label={t("finance.applyCredit")}
                text={t("finance.applyCreditText", { amount: formatAmount(b.credit) })}
                danger={false}
                run={async (_reason, key) => {
                  const applied = await unwrap(
                    api.POST("/v1/students/{student_id}/allocate-credit", { params: { path: { student_id: student.id } }, ...idempotent(key) }),
                  );
                  setDone(t("finance.creditApplied", { n: applied.length }));
                  load.reload();
                }}
              />
            ) : null}
          </>
        )}
      </Loaded>
    </Card>
  );
}

function QrCard({ student }: { student: Student }) {
  const { t } = useI18n();
  const { timeZone } = useStaff();
  const action = useAction();
  const [code, setCode] = useState<components["schemas"]["QrOut"] | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const make = (rotate: boolean, key: string) =>
    unwrap(api.POST("/v1/students/{student_id}/qr", { params: { path: { student_id: student.id } }, body: { rotate }, ...idempotent(key) })).then(setCode);
  return (
    <Card title={t("qr.card")}>
      <Done text={sent} />
      {action.error ? <ErrorNote error={action.error} /> : null}
      {code ? (
        <Facts items={[[t("qr.code"), <code key="c">{code.code}</code>], [t("qr.issuedAt"), formatDateTime(code.issued_at, timeZone)]]} />
      ) : null}
      <div className="actions">
        <button type="button" disabled={action.pending} onClick={() => void action.run((key) => make(false, key))}>
          {t("qr.show")}
        </button>
        <button
          type="button"
          disabled={action.pending}
          onClick={() =>
            void action.run(async () => {
              const blob = await unwrap(
                api.GET("/v1/students/{student_id}/qr-card", { params: { path: { student_id: student.id } }, parseAs: "blob" }),
              );
              saveFile(blob as unknown as Blob, "qr-card.pdf");
            })
          }
        >
          {t("qr.download")}
        </button>
        <ConfirmButton label={t("qr.rotate")} text={t("qr.rotateText")} run={(_reason, key) => make(true, key)} />
        {student.guardians.length ? (
          <FormButton
            label={t("qr.send")}
            fields={[
              { name: "guardian_id", label: t("common.guardian"), type: "select", required: true, options: student.guardians.map((g) => ({ value: g.guardian_id, label: g.full_name })) },
            ]}
            submitLabel={t("common.approveSend")}
            extra={<p>{t("qr.sendText")}</p>}
            submit={async (body, key) => {
              await unwrap(
                api.POST("/v1/students/{student_id}/qr-card/send", {
                  params: { path: { student_id: student.id } },
                  body: { guardian_id: String(body.guardian_id) },
                  ...idempotent(key),
                }),
              );
              setSent(t("common.queued"));
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

export function StudentPage() {
  const { id = "" } = useParams();
  const { t, label } = useI18n();
  const { can, branches } = useStaff();
  const navigate = useNavigate();
  const load = useLoad(() => unwrap(api.GET("/v1/students/{student_id}", { params: { path: { student_id: id } } })), [id]);
  const fields = useStudentFields(false);
  return (
    <Page title={load.data?.full_name ?? t("common.student")} back={{ to: "/students", label: t("nav.students") }}>
      <Loaded load={load}>
        {(s) => (
          <>
            <Card
              title={t("students.info")}
              actions={
                can("students:write") ? (
                  <>
                    <FormButton
                      label={t("common.edit")}
                      fields={fields}
                      initial={s}
                      patch
                      submit={async (body) => {
                        await unwrap(api.PATCH("/v1/students/{student_id}", { params: { path: { student_id: id } }, body: body as never }));
                        load.reload();
                      }}
                    />
                    <ConfirmButton
                      label={t("common.delete")}
                      text={t("students.deleteText", { name: s.full_name })}
                      done={() => navigate("/students")}
                      run={async () => {
                        await unwrap(api.DELETE("/v1/students/{student_id}", { params: { path: { student_id: id } } }));
                      }}
                    />
                  </>
                ) : null
              }
            >
              <Facts
                items={[
                  [t("common.fullName"), s.full_name],
                  [t("common.phone"), s.phone],
                  [t("common.status"), label("studentStatus", s.status)],
                  [t("students.birthDate"), formatDate(s.birth_date)],
                  [t("students.joinedOn"), formatDate(s.joined_on)],
                  [t("common.branch"), branches.find((b) => b.id === s.branch_id)?.name],
                  [t("common.notes"), s.notes],
                ]}
              />
            </Card>
            <Guardians student={s} reload={load.reload} />
            <Consents student={s} />
            {can("students:read") ? <Enrollments student={s} /> : null}
            {can("finance:read") ? <Money student={s} /> : null}
            {can("students:write") ? <QrCard student={s} /> : null}
          </>
        )}
      </Loaded>
    </Page>
  );
}
