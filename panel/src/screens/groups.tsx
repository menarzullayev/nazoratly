/** Groups: the list, and one group with its weekly schedule, members, lessons, monthly attendance and QR cards. */

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { components } from "@api/schema";
import { api, idempotent, saveFile, unwrap } from "../api/client";
import type { ApiFailure } from "../api/errors";
import { useI18n } from "../i18n";
import { addDays, formatAmount, formatDate, formatTime, monthStart } from "../lib/format";
import { useStaff } from "../session/context";
import { ConfirmButton, Dialog, Form, FormButton, type Field } from "../ui/form";
import { useAction, useDebounced, useLoad } from "../ui/hooks";
import { Card, Done, ErrorNote, Facts, Loaded, Page, PAGE_SIZE, Pager, Table } from "../ui/kit";
import { options, StudentPicker, useCourses, useRooms, useTeachers, type Picked } from "../ui/pickers";
import { Resource } from "./resource";
import { EditEnrollment } from "./students";

type Group = components["schemas"]["GroupDetail"];
type GroupRow = components["schemas"]["GroupOut"];
const STATUSES = ["planned", "active", "finished", "cancelled"] as const;
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function useGroupFields(): { common: Field[]; course: Field; branch: Field[] } {
  const { t, label } = useI18n();
  const { branches, scopeBranch, can } = useStaff();
  const courses = useCourses(can("academics:write"));
  const teachers = useTeachers(can("academics:write"));
  const isPackage = (v: Record<string, string | boolean>) => v.billing_mode === "package";
  return {
    course: { name: "course_id", label: t("common.course"), type: "select", required: true, options: options(courses.data, (c) => c.name) },
    branch: !scopeBranch && branches.length > 1 ? [{ name: "branch_id", label: t("common.branch"), type: "select", options: options(branches, (b) => b.name) }] : [],
    common: [
      { name: "name", label: t("common.name"), required: true, maxLength: 200 },
      { name: "teacher_id", label: t("common.teacher"), type: "select", options: options(teachers.data, (x) => x.full_name) },
      { name: "status", label: t("common.status"), type: "select", required: true, options: STATUSES.map((s) => ({ value: s, label: label("groupStatus", s) })) },
      { name: "start_date", label: t("groups.startDate"), type: "date", required: true },
      { name: "end_date", label: t("groups.endDate"), type: "date" },
      { name: "capacity", label: t("groups.capacity"), type: "number", min: 1 },
      { name: "billing_mode", label: t("groups.billing"), type: "select", required: true, options: ["monthly", "package"].map((m) => ({ value: m, label: label("billingMode", m) })) },
      { name: "monthly_fee", label: t("groups.monthlyFee"), type: "money", hint: t("groups.monthlyFeeHint"), visible: (v) => !isPackage(v) },
      { name: "package_lessons", label: t("groups.packageLessons"), type: "number", required: true, min: 1, max: 200, visible: isPackage },
      { name: "package_price", label: t("groups.packagePrice"), type: "money", required: true, visible: isPackage },
    ],
  };
}

export function GroupsPage() {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const q = useDebounced(text.trim());
  const fields = useGroupFields();
  return (
    <Resource<GroupRow>
      heading="nav.groups"
      deps={[q, status]}
      list={(offset, limit) =>
        unwrap(api.GET("/v1/groups", { params: { query: { q: q || undefined, status: (status || undefined) as never, offset, limit } } }))
      }
      name={(g) => g.name}
      filters={
        <>
          <label>
            {t("common.search")}
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <label>
            {t("common.status")}
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t("common.all")}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label("groupStatus", s)}
                </option>
              ))}
            </select>
          </label>
        </>
      }
      columns={[
        { head: t("common.name"), cell: (g) => <Link to={`/groups/${g.id}`}>{g.name}</Link> },
        { head: t("common.course"), cell: (g) => g.course_name },
        { head: t("common.teacher"), cell: (g) => g.teacher_name ?? "—" },
        { head: t("groups.students"), cell: (g) => (g.capacity ? `${g.active_students} / ${g.capacity}` : g.active_students), className: "num" },
        { head: t("common.status"), cell: (g) => label("groupStatus", g.status) },
      ]}
      create={
        can("academics:write")
          ? {
              label: "groups.add",
              fields: [fields.course, ...fields.common, ...fields.branch],
              initial: { status: "active", billing_mode: "monthly", start_date: today },
              submit: async (body, key) => {
                const made = await unwrap(api.POST("/v1/groups", { body: body as never, ...idempotent(key) }));
                navigate(`/groups/${made.id}`);
              },
            }
          : undefined
      }
    />
  );
}

interface Slot {
  weekday: number;
  start_time: string;
  end_time: string;
  room_id: string;
}

/** The weekly schedule is saved as a whole (PUT): rows are edited here and sent together. */
function ScheduleDialog({ group, onClose, done }: { group: Group; onClose: () => void; done: () => void }) {
  const { t, label } = useI18n();
  const rooms = useRooms();
  const action = useAction();
  const [slots, setSlots] = useState<Slot[]>(
    group.schedule.map((s) => ({ weekday: s.weekday, start_time: s.start_time.slice(0, 5), end_time: s.end_time.slice(0, 5), room_id: s.room_id ?? "" })),
  );
  const [saved, setSaved] = useState<components["schemas"]["ScheduleSaved"] | null>(null);
  const change = (index: number, patch: Partial<Slot>) => setSlots((all) => all.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const save = (force: boolean) =>
    void action.run(async () => {
      const result = await unwrap(
        api.PUT("/v1/groups/{group_id}/schedule", {
          params: { path: { group_id: group.id }, query: force ? { allow_conflict: true } : {} },
          body: slots.map((s) => ({ ...s, room_id: s.room_id || null })),
        }),
      );
      done();
      if (result.capacity_warnings?.length || result.conflicts?.length) setSaved(result);
      else onClose();
    });
  const conflict: ApiFailure | null = action.error?.status === 409 ? action.error : null;
  return (
    <Dialog title={t("groups.schedule")} onClose={onClose}>
      {saved ? (
        <>
          <Done text={t("groups.scheduleSaved")} />
          <p className="note">{t("groups.scheduleWarnings", { conflicts: saved.conflicts?.length ?? 0, capacity: saved.capacity_warnings?.length ?? 0 })}</p>
          <button type="button" onClick={onClose}>
            {t("common.close")}
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(false);
          }}
        >
          {slots.map((slot, i) => (
            <fieldset key={i} className="slot">
              <legend>{t("groups.slot", { n: i + 1 })}</legend>
              <label>
                {t("groups.weekday")}
                <select value={slot.weekday} onChange={(e) => change(i, { weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((d) => (
                    <option key={d} value={d}>
                      {label("weekday", String(d))}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("common.from")}
                <input type="time" required value={slot.start_time} onChange={(e) => change(i, { start_time: e.target.value })} />
              </label>
              <label>
                {t("common.to")}
                <input type="time" required value={slot.end_time} onChange={(e) => change(i, { end_time: e.target.value })} />
              </label>
              <label>
                {t("common.room")}
                <select value={slot.room_id} onChange={(e) => change(i, { room_id: e.target.value })}>
                  <option value="">—</option>
                  {rooms.data?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => setSlots((all) => all.filter((_, x) => x !== i))}>
                {t("groups.removeSlot")}
              </button>
            </fieldset>
          ))}
          <p>
            <button type="button" onClick={() => setSlots((all) => [...all, { weekday: 1, start_time: "09:00", end_time: "10:30", room_id: "" }])}>
              {t("groups.addSlot")}
            </button>
          </p>
          {action.error ? <ErrorNote error={action.error} /> : null}
          <div className="form-actions">
            <button type="submit" className="primary" disabled={action.pending}>
              {t("common.save")}
            </button>
            {conflict ? (
              <button type="button" className="danger" disabled={action.pending} onClick={() => save(true)}>
                {t("schedule.saveAnyway")}
              </button>
            ) : null}
            <button type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function Members({ group }: { group: Group }) {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const load = useLoad(
    () => unwrap(api.GET("/v1/groups/{group_id}/enrollments", { params: { path: { group_id: group.id }, query: { offset, limit: PAGE_SIZE } } })),
    [group.id, offset],
  );
  const close = () => {
    setAdding(false);
    setPicked(null);
  };
  const mayEnroll = can("academics:write", "students:read");
  return (
    <Card title={t("groups.members")} actions={mayEnroll ? <button type="button" onClick={() => setAdding(true)}>{t("enroll.addStudent")}</button> : null}>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("groups.members")}
              empty={t("enroll.noMembers")}
              rows={page.items}
              rowKey={(e) => e.id}
              columns={[
                { head: t("common.student"), cell: (e) => (can("students:read") ? <Link to={`/students/${e.student_id}`}>{e.student_name}</Link> : e.student_name) },
                { head: t("common.status"), cell: (e) => label("enrollmentStatus", e.status) },
                { head: t("enroll.startedOn"), cell: (e) => formatDate(e.started_on) },
                { head: t("enroll.effectiveFee"), cell: (e) => formatAmount(e.effective_monthly_fee), className: "num" },
                ...(mayEnroll ? [{ head: t("common.actions"), cell: (e: components["schemas"]["EnrollmentOut"]) => <EditEnrollment id={e.id} done={load.reload} /> }] : []),
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
      {adding ? (
        <Dialog title={t("enroll.addStudent")} onClose={close}>
          <StudentPicker value={picked} onPick={setPicked} />
          {picked ? (
            <Form
              initial={{ started_on: today, status: "active" }}
              fields={[
                { name: "started_on", label: t("enroll.startedOn"), type: "date", required: true },
                { name: "status", label: t("common.status"), type: "select", required: true, options: ["active", "trial"].map((s) => ({ value: s, label: label("enrollmentStatus", s) })) },
                { name: "monthly_fee_override", label: t("enroll.fee"), type: "money" },
                { name: "discount_percent", label: t("enroll.discount"), maxLength: 6 },
                { name: "ignore_waitlist", label: t("enroll.ignoreWaitlist"), type: "checkbox" },
              ]}
              submitLabel={t("common.save")}
              onCancel={close}
              submit={async (body, key) => {
                await unwrap(
                  api.POST("/v1/groups/{group_id}/enrollments", {
                    params: { path: { group_id: group.id } },
                    body: { ...(body as never as components["schemas"]["EnrollmentIn"]), student_id: picked.id },
                    ...idempotent(key),
                  }),
                );
                close();
                load.reload();
              }}
            />
          ) : null}
        </Dialog>
      ) : null}
    </Card>
  );
}

const MARK_SIGN: Record<string, string> = { present: "+", late: "K", absent: "−", excused: "S" };

function MonthAttendance({ group }: { group: Group }) {
  const { t, label } = useI18n();
  const { today } = useStaff();
  const [month, setMonth] = useState(today.slice(0, 7));
  const load = useLoad(
    () => unwrap(api.GET("/v1/groups/{group_id}/attendance", { params: { path: { group_id: group.id }, query: { month: `${month}-01` } } })),
    [group.id, month],
  );
  return (
    <Card title={t("attendance.month")}>
      <div className="filters">
        <label>
          {t("common.month")}
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>
      <p className="hint">{t("attendance.legend")}</p>
      <Loaded load={load}>
        {(report) => {
          const cells = new Map(report.cells.map((c) => [`${c.student_id}:${c.lesson_id}`, c.status]));
          return (
            <Table
              caption={t("attendance.month")}
              rows={report.students}
              rowKey={(s) => s.student_id}
              columns={[
                { head: t("common.student"), cell: (s) => s.student_name },
                ...report.lessons.map((l) => ({
                  head: `${l.lesson_date.slice(8, 10)}.${l.lesson_date.slice(5, 7)}`,
                  cell: (s: components["schemas"]["MonthStudent"]) => {
                    const status = cells.get(`${s.student_id}:${l.id}`);
                    return status ? <abbr title={label("mark", status)}>{MARK_SIGN[status] ?? status}</abbr> : "·";
                  },
                })),
                { head: t("attendance.presentCount"), cell: (s) => s.present + s.late, className: "num" },
                { head: t("attendance.absentCount"), cell: (s) => s.absent, className: "num" },
              ]}
            />
          );
        }}
      </Loaded>
    </Card>
  );
}

export function GroupPage() {
  const { id = "" } = useParams();
  const { t, label } = useI18n();
  const { can, today, branches } = useStaff();
  const navigate = useNavigate();
  const load = useLoad(() => unwrap(api.GET("/v1/groups/{group_id}", { params: { path: { group_id: id } } })), [id]);
  const rooms = useRooms();
  const fields = useGroupFields();
  const [scheduling, setScheduling] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const cards = useAction();
  const write = can("academics:write");
  return (
    <Page title={load.data?.name ?? t("common.group")} back={{ to: "/groups", label: t("nav.groups") }}>
      <Loaded load={load}>
        {(g) => (
          <>
            <Card
              title={t("groups.info")}
              actions={
                <>
                  {write ? (
                    <FormButton
                      label={t("common.edit")}
                      fields={[...fields.common, ...fields.branch]}
                      initial={g}
                      patch
                      submit={async (body) => {
                        await unwrap(api.PATCH("/v1/groups/{group_id}", { params: { path: { group_id: id } }, body: body as never }));
                        load.reload();
                      }}
                    />
                  ) : null}
                  {can("academics:read", "students:write") ? (
                    <button
                      type="button"
                      disabled={cards.pending}
                      onClick={() =>
                        void cards.run(async () => {
                          const blob = await unwrap(api.GET("/v1/groups/{group_id}/qr-cards", { params: { path: { group_id: id } }, parseAs: "blob" }));
                          saveFile(blob as unknown as Blob, "qr-cards.pdf");
                        })
                      }
                    >
                      {t("qr.groupCards")}
                    </button>
                  ) : null}
                  {write ? (
                    <ConfirmButton
                      label={t("common.delete")}
                      text={t("groups.deleteText", { name: g.name })}
                      done={() => navigate("/groups")}
                      run={async () => {
                        await unwrap(api.DELETE("/v1/groups/{group_id}", { params: { path: { group_id: id } } }));
                      }}
                    />
                  ) : null}
                </>
              }
            >
              {cards.error ? <ErrorNote error={cards.error} /> : null}
              <Facts
                items={[
                  [t("common.course"), g.course_name],
                  [t("common.teacher"), g.teacher_name],
                  [t("common.status"), label("groupStatus", g.status)],
                  [t("groups.startDate"), formatDate(g.start_date)],
                  [t("groups.endDate"), formatDate(g.end_date)],
                  [t("groups.students"), g.capacity ? `${g.active_students} / ${g.capacity}` : g.active_students],
                  [t("groups.billing"), label("billingMode", g.billing_mode)],
                  g.billing_mode === "package"
                    ? [t("groups.packagePrice"), `${formatAmount(g.package_price)} · ${g.package_lessons ?? 0} ${t("groups.lessonsUnit")}`]
                    : [t("groups.monthlyFee"), formatAmount(g.monthly_fee)],
                  [t("common.branch"), branches.find((b) => b.id === g.branch_id)?.name],
                ]}
              />
            </Card>
            <Card title={t("groups.schedule")} actions={write ? <button type="button" onClick={() => setScheduling(true)}>{t("common.edit")}</button> : null}>
              <Table
                caption={t("groups.schedule")}
                empty={t("groups.noSchedule")}
                rows={g.schedule}
                rowKey={(s) => `${s.weekday}-${s.start_time}`}
                columns={[
                  { head: t("groups.weekday"), cell: (s) => label("weekday", String(s.weekday)) },
                  { head: t("common.time"), cell: (s) => `${formatTime(s.start_time)}–${formatTime(s.end_time)}` },
                  { head: t("common.room"), cell: (s) => rooms.data?.find((r) => r.id === s.room_id)?.name ?? "—" },
                ]}
              />
              {scheduling ? <ScheduleDialog group={g} onClose={() => setScheduling(false)} done={load.reload} /> : null}
            </Card>
            {can("students:read") ? <Members group={g} /> : null}
            <Card
              title={t("nav.lessons")}
              actions={
                <>
                  <Link to={`/lessons?group=${g.id}`}>{t("lessons.open")}</Link>
                  {write ? (
                    <FormButton
                      label={t("lessons.generate")}
                      initial={{ date_from: monthStart(today), date_to: addDays(today, 30) }}
                      fields={[
                        { name: "date_from", label: t("common.from"), type: "date", required: true },
                        { name: "date_to", label: t("common.to"), type: "date", required: true },
                      ]}
                      submit={async (body, key) => {
                        const r = await unwrap(
                          api.POST("/v1/groups/{group_id}/lessons/generate", { params: { path: { group_id: id } }, body: body as never, ...idempotent(key) }),
                        );
                        setGenerated(t("lessons.generated", { created: r.created, skipped: r.skipped_existing, conflicts: r.conflicting_lessons ?? 0 }));
                      }}
                    />
                  ) : null}
                </>
              }
            >
              <Done text={generated} />
              <p className="hint">{t("lessons.generateHint")}</p>
            </Card>
            {can("attendance:read") ? <MonthAttendance group={g} /> : null}
          </>
        )}
      </Loaded>
    </Page>
  );
}
