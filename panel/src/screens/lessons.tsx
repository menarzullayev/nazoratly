/** Lessons: the list, one lesson with its roll call, and the actions on a planned lesson (move, cancel, substitute). */

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import type { ApiFailure } from "../api/errors";
import { useI18n } from "../i18n";
import { addDays, formatAmount, formatDate, formatDateTime, formatTime, monthStart } from "../lib/format";
import { useStaff } from "../session/context";
import { ConfirmButton, FormButton, type Field } from "../ui/form";
import { useAction, useLoad } from "../ui/hooks";
import { Card, Done, ErrorNote, Facts, Loaded, Page, PAGE_SIZE, Pager, Table } from "../ui/kit";
import { options, useGroups, useRooms, useTeachers } from "../ui/pickers";

type Lesson = components["schemas"]["nazoratly__routers__lessons__LessonOut"];
const MARKS = ["present", "late", "absent", "excused"] as const;

/** A refused clash of room or teacher can be allowed on purpose: the checkbox appears with the other fields. */
function useClashField(): Field {
  const { t } = useI18n();
  return { name: "allow_conflict", label: t("schedule.allowConflict"), type: "checkbox" };
}

const clash = (error: ApiFailure) => <ErrorNote error={error} />;

export function LessonActions({ lesson, done }: { lesson: { id: string; status: string; lesson_date: string; start_time: string; end_time: string; room_id: string | null }; done: () => void }) {
  const { t } = useI18n();
  const { can } = useStaff();
  const write = can("academics:write");
  const rooms = useRooms(write);
  const teachers = useTeachers(write);
  const allow = useClashField();
  const [result, setResult] = useState<string | null>(null);
  if (!write || lesson.status !== "planned") return null;
  const report = (r: components["schemas"]["ChangeResult"]) => {
    setResult(t("schedule.changed", { notices: r.notices_created, skipped: r.students_without_notice, payroll: r.payroll_effect.map((e) => `${e.teacher_name} ${formatAmount(e.delta)}`).join(", ") || "—" }));
    done();
  };
  const roomField: Field = { name: "room_id", label: t("common.room"), type: "select", options: options(rooms.data, (r) => r.name) };
  const reason: Field = { name: "reason", label: t("schedule.reason"), maxLength: 500 };
  const notify: Field = { name: "notify", label: t("schedule.notify"), type: "checkbox" };
  const params = { path: { lesson_id: lesson.id } };
  return (
    <>
      <div className="row-actions">
        <FormButton
          label={t("schedule.move")}
          initial={{ ...lesson, notify: true }}
          fields={[
            { name: "lesson_date", label: t("common.date"), type: "date", required: true },
            { name: "start_time", label: t("common.from"), type: "time", required: true },
            { name: "end_time", label: t("common.to"), type: "time", required: true },
            roomField,
            reason,
            notify,
            allow,
          ]}
          error={clash}
          submit={async (body, key) => report(await unwrap(api.POST("/v1/lessons/{lesson_id}/move", { params, body: body as never, ...idempotent(key) })))}
        />
        <FormButton
          label={t("schedule.cancelLesson")}
          className="danger-quiet"
          initial={{ notify: true }}
          submitLabel={t("schedule.cancelLesson")}
          danger
          extra={<p>{t("schedule.cancelText")}</p>}
          fields={[reason, notify]}
          submit={async (body, key) => report(await unwrap(api.POST("/v1/lessons/{lesson_id}/cancel", { params, body: body as never, ...idempotent(key) })))}
        />
        <FormButton
          label={t("schedule.substitute")}
          fields={[
            { name: "teacher_id", label: t("schedule.substituteTeacher"), type: "select", options: options(teachers.data, (x) => x.full_name), hint: t("schedule.substituteHint") },
            reason,
            allow,
          ]}
          error={clash}
          submit={async (body, key) =>
            report(
              await unwrap(
                api.POST("/v1/lessons/{lesson_id}/substitute", {
                  params,
                  body: { ...(body as never as components["schemas"]["SubstituteIn"]), teacher_id: (body.teacher_id as string | undefined) ?? null },
                  ...idempotent(key),
                }),
              ),
            )
          }
        />
      </div>
      <Done text={result} />
    </>
  );
}

export function LessonsPage() {
  const { t, label } = useI18n();
  const { can, today } = useStaff();
  const [params] = useSearchParams();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(addDays(today, 14));
  const [group, setGroup] = useState(params.get("group") ?? "");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const groups = useGroups();
  const rooms = useRooms();
  const teachers = useTeachers(can("academics:write"));
  const allow = useClashField();
  const load = useLoad(
    () =>
      unwrap(
        api.GET("/v1/lessons", {
          params: { query: { date_from: from, date_to: to, group_id: group || undefined, status: (status || undefined) as never, offset, limit: PAGE_SIZE } },
        }),
      ),
    [from, to, group, status, offset],
  );
  const reset = <V,>(set: (v: V) => void) => (value: V) => {
    set(value);
    setOffset(0);
  };
  return (
    <Page
      title={t("nav.lessons")}
      actions={
        can("academics:write") ? (
          <FormButton
            label={t("lessons.add")}
            className="primary"
            initial={{ group_id: group, lesson_date: today }}
            fields={[
              { name: "group_id", label: t("common.group"), type: "select", required: true, options: options(groups.data, (g) => g.name) },
              { name: "lesson_date", label: t("common.date"), type: "date", required: true },
              { name: "start_time", label: t("common.from"), type: "time", required: true },
              { name: "end_time", label: t("common.to"), type: "time", required: true },
              { name: "room_id", label: t("common.room"), type: "select", options: options(rooms.data, (r) => r.name) },
              { name: "teacher_id", label: t("common.teacher"), type: "select", options: options(teachers.data, (x) => x.full_name) },
              { name: "topic", label: t("lessons.topic"), maxLength: 500 },
              allow,
            ]}
            submit={async (body, key) => {
              const { allow_conflict, ...lesson } = body as Record<string, unknown>;
              await unwrap(
                api.POST("/v1/lessons", {
                  params: { query: allow_conflict ? { allow_conflict: true } : {} },
                  body: lesson as never,
                  ...idempotent(key),
                }),
              );
              load.reload();
            }}
          />
        ) : null
      }
    >
      <div className="filters">
        <label>
          {t("common.from")}
          <input type="date" value={from} onChange={(e) => e.target.value && reset(setFrom)(e.target.value)} />
        </label>
        <label>
          {t("common.to")}
          <input type="date" value={to} onChange={(e) => e.target.value && reset(setTo)(e.target.value)} />
        </label>
        <label>
          {t("common.group")}
          <select value={group} onChange={(e) => reset(setGroup)(e.target.value)}>
            <option value="">{t("common.all")}</option>
            {groups.data?.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("common.status")}
          <select value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
            <option value="">{t("common.all")}</option>
            {["planned", "held", "cancelled"].map((s) => (
              <option key={s} value={s}>
                {label("lessonStatus", s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.lessons")}
              rows={page.items}
              rowKey={(l) => l.id}
              columns={[
                { head: t("common.date"), cell: (l) => <Link to={`/lessons/${l.id}`}>{formatDate(l.lesson_date)}</Link> },
                { head: t("common.time"), cell: (l) => `${formatTime(l.start_time)}–${formatTime(l.end_time)}` },
                { head: t("common.group"), cell: (l) => l.group_name },
                { head: t("common.teacher"), cell: (l) => l.effective_teacher_name ?? "—" },
                { head: t("common.room"), cell: (l) => l.room_name ?? "—" },
                { head: t("common.status"), cell: (l) => label("lessonStatus", l.status) },
              ]}
            />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
    </Page>
  );
}

interface Draft {
  status: string;
  minutes: string;
}

export function RollCall({ lessonId, done }: { lessonId: string; done?: () => void }) {
  const { t, label } = useI18n();
  const { can, timeZone } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/lessons/{lesson_id}/attendance", { params: { path: { lesson_id: lessonId } } })), [lessonId]);
  const action = useAction();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    setDrafts(Object.fromEntries((load.data?.entries ?? []).map((e) => [e.student_id, { status: e.status ?? "", minutes: String(e.minutes_late || "") }])));
  }, [load.data]);
  const write = can("attendance:write");
  return (
    <Card title={t("attendance.rollCall")}>
      <Done text={saved} />
      <Loaded load={load}>
        {(roster) => {
          const editable = write && roster.lesson_status !== "cancelled";
          const records = roster.entries.flatMap((e) => {
            const d = drafts[e.student_id];
            return d?.status ? [{ student_id: e.student_id, status: d.status as (typeof MARKS)[number], minutes_late: d.status === "late" ? Number(d.minutes || 0) : 0 }] : [];
          });
          const set = (id: string, patch: Partial<Draft>) => {
            setSaved(null);
            setDrafts((all) => ({ ...all, [id]: { ...(all[id] ?? { status: "", minutes: "" }), ...patch } }));
          };
          return (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(async () => {
                  await unwrap(api.PUT("/v1/lessons/{lesson_id}/attendance", { params: { path: { lesson_id: lessonId } }, body: { records } }));
                  setSaved(t("attendance.saved", { n: records.length }));
                  load.reload();
                  done?.();
                });
              }}
            >
              {editable && roster.entries.length ? (
                <p>
                  <button
                    type="button"
                    onClick={() => setDrafts((all) => Object.fromEntries(roster.entries.map((e) => [e.student_id, all[e.student_id]?.status ? all[e.student_id]! : { status: "present", minutes: "" }])))}
                  >
                    {t("attendance.allPresent")}
                  </button>
                </p>
              ) : null}
              <Table
                caption={t("attendance.rollCall")}
                empty={t("attendance.noStudents")}
                rows={roster.entries}
                rowKey={(e) => e.student_id}
                columns={[
                  { head: t("common.student"), cell: (e) => e.student_name },
                  {
                    head: t("common.status"),
                    cell: (e) =>
                      editable ? (
                        <select aria-label={`${t("common.status")}: ${e.student_name}`} value={drafts[e.student_id]?.status ?? ""} onChange={(ev) => set(e.student_id, { status: ev.target.value })}>
                          <option value="">{t("attendance.unmarked")}</option>
                          {MARKS.map((m) => (
                            <option key={m} value={m}>
                              {label("mark", m)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        label("mark", e.status)
                      ),
                  },
                  {
                    head: t("attendance.minutesLate"),
                    cell: (e) =>
                      editable && drafts[e.student_id]?.status === "late" ? (
                        <input
                          type="number"
                          min={0}
                          max={600}
                          aria-label={`${t("attendance.minutesLate")}: ${e.student_name}`}
                          value={drafts[e.student_id]?.minutes ?? ""}
                          onChange={(ev) => set(e.student_id, { minutes: ev.target.value })}
                        />
                      ) : (
                        e.minutes_late || "—"
                      ),
                  },
                  { head: t("attendance.markedAt"), cell: (e) => formatDateTime(e.marked_at, timeZone) },
                  {
                    head: t("common.actions"),
                    cell: (e) =>
                      editable && e.status ? (
                        <ConfirmButton
                          label={t("attendance.removeMark")}
                          text={t("attendance.removeMarkText", { name: e.student_name })}
                          done={() => {
                            load.reload();
                            done?.();
                          }}
                          run={async () => {
                            await unwrap(
                              api.DELETE("/v1/lessons/{lesson_id}/attendance/{student_id}", { params: { path: { lesson_id: lessonId, student_id: e.student_id } } }),
                            );
                          }}
                        />
                      ) : null,
                  },
                ]}
              />
              {action.error ? <ErrorNote error={action.error} /> : null}
              {editable && roster.entries.length ? (
                <div className="form-actions">
                  <button type="submit" className="primary" disabled={action.pending || records.length === 0}>
                    {t("attendance.save")}
                  </button>
                </div>
              ) : null}
            </form>
          );
        }}
      </Loaded>
    </Card>
  );
}

function History({ lesson }: { lesson: Lesson }) {
  const { t, label } = useI18n();
  const { timeZone } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/lessons/{lesson_id}/changes", { params: { path: { lesson_id: lesson.id } } })), [lesson.id, lesson]);
  return (
    <Card title={t("schedule.history")}>
      <Loaded load={load}>
        {(rows) => (
          <Table
            caption={t("schedule.history")}
            empty={t("schedule.noHistory")}
            rows={rows}
            rowKey={(c) => c.id}
            columns={[
              { head: t("common.date"), cell: (c) => formatDateTime(c.created_at, timeZone) },
              { head: t("schedule.change"), cell: (c) => label("changeKind", c.kind) },
              { head: t("schedule.was"), cell: (c) => `${formatDate(c.old_date)} ${formatTime(c.old_start_time)} ${c.old_teacher_name ?? ""}` },
              { head: t("schedule.became"), cell: (c) => `${formatDate(c.new_date)} ${formatTime(c.new_start_time)} ${c.new_teacher_name ?? ""}` },
              { head: t("schedule.reason"), cell: (c) => c.reason ?? "—" },
            ]}
          />
        )}
      </Loaded>
    </Card>
  );
}

export function LessonPage() {
  const { id = "" } = useParams();
  const { t, label } = useI18n();
  const { can } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/lessons/{lesson_id}", { params: { path: { lesson_id: id } } })), [id]);
  const rooms = useRooms();
  const teachers = useTeachers(can("academics:write"));
  const allow = useClashField();
  // a teacher may write the topic and say the lesson was held; the rest of the record is staff work
  const editFields = (lesson: Lesson): Field[] => [
    { name: "topic", label: t("lessons.topic"), maxLength: 500 },
    { name: "status", label: t("common.status"), type: "select", required: true, options: [...new Set([lesson.status, "planned", "held"])].map((s) => ({ value: s, label: label("lessonStatus", s) })) },
    ...(can("academics:write")
      ? ([
          { name: "start_time", label: t("common.from"), type: "time", required: true },
          { name: "end_time", label: t("common.to"), type: "time", required: true },
          { name: "room_id", label: t("common.room"), type: "select", options: options(rooms.data, (r) => r.name) },
          { name: "teacher_id", label: t("common.teacher"), type: "select", options: options(teachers.data, (x) => x.full_name) },
          allow,
        ] as Field[])
      : []),
  ];
  return (
    <Page title={t("lessons.one")} back={{ to: "/lessons", label: t("nav.lessons") }}>
      <Loaded load={load}>
        {(lesson) => (
          <>
            <Card
              title={`${lesson.group_name} · ${formatDate(lesson.lesson_date)}`}
              actions={
                can("attendance:write") ? (
                  <FormButton
                    label={t("common.edit")}
                    fields={editFields(lesson)}
                    initial={lesson}
                    patch
                    submit={async (body) => {
                      const { allow_conflict, ...changes } = body as Record<string, unknown>;
                      await unwrap(
                        api.PATCH("/v1/lessons/{lesson_id}", {
                          params: { path: { lesson_id: id }, query: allow_conflict ? { allow_conflict: true } : {} },
                          body: changes as never,
                        }),
                      );
                      load.reload();
                    }}
                  />
                ) : null
              }
            >
              <Facts
                items={[
                  [t("common.time"), `${formatTime(lesson.start_time)}–${formatTime(lesson.end_time)}`],
                  [t("common.teacher"), lesson.effective_teacher_name],
                  [t("common.room"), lesson.room_name],
                  [t("common.status"), label("lessonStatus", lesson.status)],
                  [t("lessons.kind"), label("lessonKind", lesson.kind)],
                  [t("lessons.topic"), lesson.topic],
                  [t("schedule.reason"), lesson.cancel_reason],
                  [t("schedule.movedFrom"), lesson.original_date ? `${formatDate(lesson.original_date)} ${formatTime(lesson.original_start_time)}` : null],
                ]}
              />
              <LessonActions lesson={lesson} done={load.reload} />
            </Card>
            {can("attendance:read") ? <RollCall lessonId={lesson.id} /> : null}
            <History lesson={lesson} />
          </>
        )}
      </Loaded>
    </Page>
  );
}

export function AbsencesPage() {
  const { t } = useI18n();
  const { today } = useStaff();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [min, setMin] = useState("3");
  const load = useLoad(
    () => unwrap(api.GET("/v1/reports/absences", { params: { query: { date_from: from, date_to: to, min_absences: Number(min) || 1, limit: 500 } } })),
    [from, to, min],
  );
  return (
    <Page title={t("nav.absences")}>
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
          {t("absences.minimum")}
          <input type="number" min={1} value={min} onChange={(e) => setMin(e.target.value)} />
        </label>
      </div>
      <Loaded load={load}>
        {(rows) => (
          <Table
            caption={t("nav.absences")}
            rows={rows}
            rowKey={(r) => r.student_id}
            columns={[
              { head: t("common.student"), cell: (r) => <Link to={`/students/${r.student_id}`}>{r.student_name}</Link> },
              { head: t("attendance.absentCount"), cell: (r) => r.absences, className: "num" },
              { head: t("attendance.lateCount"), cell: (r) => r.lates, className: "num" },
            ]}
          />
        )}
      </Loaded>
    </Page>
  );
}
