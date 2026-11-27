/** What a teacher sees about their own work: lessons, groups, pay, messages to guardians. Notifications are for all
 * staff. */

import { useState } from "react";
import { Link } from "react-router";
import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { addDays, formatAmount, formatDate, formatDateTime, formatMonth, formatTime } from "../lib/format";
import { useStaff } from "../session/context";
import { Dialog, Form, FormButton, type Field } from "../ui/form";
import { useLoad } from "../ui/hooks";
import { Badge, Card, Done, Facts, Loaded, Page, PAGE_SIZE, Pager, Table } from "../ui/kit";

type OwnStudent = components["schemas"]["nazoratly__routers__teacher_me__StudentOut"];

function Lessons({ from, to }: { from: string; to: string }) {
  const { t, label } = useI18n();
  const load = useLoad(() => unwrap(api.GET("/v1/teacher/lessons", { params: { query: { from, to } } })), [from, to]);
  return (
    <Loaded load={load}>
      {(rows) => (
        <Table
          caption={t("teacher.myLessons")}
          empty={t("calendar.noLessons")}
          rows={rows}
          rowKey={(l) => l.lesson_id}
          columns={[
            { head: t("common.date"), cell: (l) => <Link to={`/lessons/${l.lesson_id}`}>{formatDate(l.lesson_date)} · {formatTime(l.start_time)}</Link> },
            { head: t("common.group"), cell: (l) => l.group_name },
            { head: t("teacher.marked"), cell: (l) => `${l.marked} / ${l.enrolled}` },
            { head: t("common.status"), cell: (l) => (l.needs_roll_call ? <Badge tone="warn">{t("teacher.needsRollCall")}</Badge> : label("lessonStatus", l.status)) },
          ]}
        />
      )}
    </Loaded>
  );
}

export function TeacherHomePage() {
  const { t, label } = useI18n();
  const { today } = useStaff();
  const me = useLoad(() => unwrap(api.GET("/v1/teacher/me")), []);
  return (
    <Page title={t("nav.teacherHome")}>
      <Loaded load={me}>
        {(m) => (
          <Card title={m.full_name}>
            <Facts
              items={[
                [t("common.phone"), m.phone],
                [t("teachers.payModel"), label("payModel", m.pay_model)],
                [t("nav.myGroups"), <Link key="g" to="/teacher/groups">{m.groups}</Link>],
                [t("teacher.messagesLeft"), m.messaging_enabled ? m.messages_left_today : t("teacher.messagingOff")],
                [t("teacher.unread"), <Link key="n" to="/notifications">{m.unread_notifications}</Link>],
              ]}
            />
          </Card>
        )}
      </Loaded>
      <Card title={t("teacher.today")}>
        <Lessons from={today} to={today} />
      </Card>
    </Page>
  );
}

export function TeacherLessonsPage() {
  const { t } = useI18n();
  const { today } = useStaff();
  const [from, setFrom] = useState(addDays(today, -7));
  const [to, setTo] = useState(addDays(today, 7));
  return (
    <Page title={t("teacher.myLessons")}>
      <div className="filters">
        <label>
          {t("common.from")}
          <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label>
          {t("common.to")}
          <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
      </div>
      <Lessons from={from} to={to} />
    </Page>
  );
}

/** A message to a student's guardians. The server checks the right, the daily limit and every recipient. */
function WriteMessage({ student, groupId, done }: { student: OwnStudent; groupId: string; done: (text: string) => void }) {
  const { t, label } = useI18n();
  const [open, setOpen] = useState(false);
  const templates = useLoad(async () => (open ? await unwrap(api.GET("/v1/teacher/message-templates")) : []), [open]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {t("teacher.write")}
      </button>
      {open ? (
        <Dialog title={t("teacher.writeTo", { name: student.full_name })} onClose={() => setOpen(false)}>
          <Loaded load={templates}>
            {(rows) => {
              const fields: Field[] = [
                { name: "template", label: t("teacher.template"), type: "select", options: rows.map((r) => ({ value: r.code, label: label("template", r.code) })) },
                { name: "text", label: t("teacher.ownText"), type: "textarea", maxLength: 1000, hint: t("teacher.ownTextHint"), visible: (v) => v.template === "" },
              ];
              return (
                <>
                  <details>
                    <summary>{t("teacher.templates")}</summary>
                    <ul>
                      {rows.map((r) => (
                        <li key={r.code}>
                          <strong>{label("template", r.code)}:</strong> {r.text}
                        </li>
                      ))}
                    </ul>
                  </details>
                  <Form
                    fields={fields}
                    submitLabel={t("common.approveSend")}
                    onCancel={() => setOpen(false)}
                    submit={async (body, key) => {
                      const sent = await unwrap(
                        api.POST("/v1/teacher/guardian-messages", {
                          body: { ...(body as never as components["schemas"]["GuardianMessageIn"]), student_id: student.id, group_id: groupId },
                          ...idempotent(key),
                        }),
                      );
                      setOpen(false);
                      done(t("teacher.sent", { n: sent.sent.length, left: sent.remaining_today }));
                    }}
                  />
                </>
              );
            }}
          </Loaded>
        </Dialog>
      ) : null}
    </>
  );
}

export function TeacherGroupsPage() {
  const { t, label } = useI18n();
  const groups = useLoad(() => unwrap(api.GET("/v1/teacher/groups")), []);
  const [open, setOpen] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const students = useLoad(
    async () => (open ? await unwrap(api.GET("/v1/teacher/groups/{group_id}/students", { params: { path: { group_id: open } } })) : []),
    [open],
  );
  return (
    <Page title={t("nav.myGroups")}>
      <Done text={done} />
      <Loaded load={groups}>
        {(rows) => (
          <Table
            caption={t("nav.myGroups")}
            rows={rows}
            rowKey={(g) => g.id}
            columns={[
              { head: t("common.name"), cell: (g) => g.name },
              { head: t("common.course"), cell: (g) => g.course_name },
              { head: t("groups.students"), cell: (g) => g.students, className: "num" },
              { head: t("common.status"), cell: (g) => label("groupStatus", g.status) },
              {
                head: t("common.actions"),
                cell: (g) => (
                  <button type="button" aria-pressed={open === g.id} onClick={() => setOpen(g.id)}>
                    {t("teacher.showStudents")}
                  </button>
                ),
              },
            ]}
          />
        )}
      </Loaded>
      {open ? (
        <Card title={t("groups.members")}>
          <Loaded load={students}>
            {(rows) => (
              <Table
                caption={t("groups.members")}
                empty={t("enroll.noMembers")}
                rows={rows}
                rowKey={(s) => s.id}
                columns={[
                  { head: t("common.student"), cell: (s) => s.full_name },
                  { head: t("common.guardian"), cell: (s) => (s.guardian_reachable ? t("teacher.reachable") : t("teacher.unreachable")) },
                  { head: t("common.actions"), cell: (s) => (s.guardian_reachable ? <WriteMessage student={s} groupId={open} done={setDone} /> : null) },
                ]}
              />
            )}
          </Loaded>
        </Card>
      ) : null}
    </Page>
  );
}

export function TeacherPayPage() {
  const { t, label } = useI18n();
  const { today } = useStaff();
  const [month, setMonth] = useState(today.slice(0, 7));
  const load = useLoad(() => unwrap(api.GET("/v1/teacher/pay", { params: { query: { month } } })), [month]);
  return (
    <Page title={t("nav.myPay")}>
      <div className="filters">
        <label>
          {t("common.month")}
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>
      <Loaded load={load}>
        {(p) => (
          <Card title={formatMonth(p.month)}>
            <Facts
              items={[
                [t("teachers.payModel"), label("payModel", p.pay_model)],
                [t("teachers.payRate"), formatAmount(p.pay_rate)],
                [t("teacher.lessonsHeld"), p.lessons],
                [t("teacher.hours"), p.hours],
                [t("teacher.estimate"), formatAmount(p.estimate)],
                [t("teacher.payroll"), p.payroll ? `${formatAmount(p.payroll.total)} · ${label("payrollStatus", p.payroll.status)}` : t("teacher.noPayroll")],
              ]}
            />
            <p className="hint">{t("teacher.estimateHint")}</p>
          </Card>
        )}
      </Loaded>
    </Page>
  );
}

export function TeacherMessagesPage() {
  const { t, label } = useI18n();
  const { timeZone } = useStaff();
  const [offset, setOffset] = useState(0);
  const load = useLoad(() => unwrap(api.GET("/v1/teacher/guardian-messages", { params: { query: { offset, limit: PAGE_SIZE } } })), [offset]);
  return (
    <Page title={t("nav.myMessages")}>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.myMessages")}
              rows={page.items}
              rowKey={(m) => m.id}
              columns={[
                { head: t("common.date"), cell: (m) => formatDateTime(m.created_at, timeZone) },
                { head: t("common.student"), cell: (m) => `${m.student_name} · ${m.group_name}` },
                { head: t("common.guardian"), cell: (m) => m.guardian_name },
                { head: t("common.message"), cell: (m) => <span className="message">{m.body}</span> },
                { head: t("common.status"), cell: (m) => label("delivery", m.delivery) },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </Page>
  );
}

export function NotificationsPage() {
  const { t, label } = useI18n();
  const { timeZone } = useStaff();
  const [unread, setUnread] = useState(false);
  const [offset, setOffset] = useState(0);
  const load = useLoad(() => unwrap(api.GET("/v1/notifications", { params: { query: { unread, offset, limit: PAGE_SIZE } } })), [unread, offset]);
  return (
    <Page title={t("nav.notifications")}>
      <div className="filters">
        <label className="check">
          <input
            type="checkbox"
            checked={unread}
            onChange={(e) => {
              setUnread(e.target.checked);
              setOffset(0);
            }}
          />
          {t("notifications.unreadOnly")}
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.notifications")}
              empty={t("notifications.none")}
              rows={page.items}
              rowKey={(n) => n.id}
              columns={[
                { head: t("common.date"), cell: (n) => formatDateTime(n.created_at, timeZone) },
                { head: t("notifications.kind"), cell: (n) => label("notificationKind", n.kind) },
                { head: t("common.message"), cell: (n) => <span className="message">{n.body}</span> },
                {
                  head: t("common.actions"),
                  cell: (n) =>
                    n.read_at ? (
                      <Badge>{t("notifications.read")}</Badge>
                    ) : (
                      <FormButton
                        label={t("notifications.markRead")}
                        submitLabel={t("notifications.markRead")}
                        fields={[]}
                        extra={<p>{n.body}</p>}
                        submit={async (_body, key) => {
                          await unwrap(api.POST("/v1/notifications/{notification_id}/read", { params: { path: { notification_id: n.id } }, ...idempotent(key) }));
                          load.reload();
                        }}
                      />
                    ),
                },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </Page>
  );
}
