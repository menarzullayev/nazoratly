/** The calendar (day or week), the schedule checks, and the guardian message drafts that schedule changes prepare. */

import { useState } from "react";
import { Link } from "react-router";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { addDays, formatDate, formatDateTime, formatTime, monthStart } from "../lib/format";
import { useStaff } from "../session/context";
import { ConfirmButton, FormButton } from "../ui/form";
import { useLoad } from "../ui/hooks";
import { Badge, Card, Loaded, Page, PAGE_SIZE, Pager, Table, Tabs } from "../ui/kit";
import { useGroups, useRooms, useTeachers } from "../ui/pickers";
import { LessonActions } from "./lessons";

function Filter({ label, value, onChange, rows }: { label: string; value: string; onChange: (v: string) => void; rows: { id: string; name: string }[] | undefined }) {
  const { t } = useI18n();
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("common.all")}</option>
        {rows?.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CalendarPage() {
  const { t, label } = useI18n();
  const { today, org } = useStaff();
  const [view, setView] = useState<"week" | "day">("week");
  const [day, setDay] = useState(today);
  const [group, setGroup] = useState("");
  const [teacher, setTeacher] = useState("");
  const [room, setRoom] = useState("");
  const groups = useGroups();
  const teachers = useTeachers(org.role !== "teacher");
  const rooms = useRooms();
  const load = useLoad(
    () =>
      unwrap(
        api.GET("/v1/calendar", {
          params: { query: { date: day, view, group_id: group || undefined, teacher_id: teacher || undefined, room_id: room || undefined } },
        }),
      ),
    [day, view, group, teacher, room],
  );
  const step = view === "week" ? 7 : 1;
  return (
    <Page title={t("nav.calendar")}>
      <Tabs
        label={t("calendar.view")}
        value={view}
        onChange={setView}
        tabs={[
          { id: "week", label: t("calendar.week") },
          { id: "day", label: t("calendar.day") },
        ]}
      />
      <div className="filters">
        <button type="button" onClick={() => setDay(addDays(day, -step))}>
          {t("common.previous")}
        </button>
        <label>
          {t("common.date")}
          <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </label>
        <button type="button" onClick={() => setDay(addDays(day, step))}>
          {t("common.next")}
        </button>
        <button type="button" onClick={() => setDay(today)}>
          {t("calendar.today")}
        </button>
        <Filter label={t("common.group")} value={group} onChange={setGroup} rows={groups.data?.map((g) => ({ id: g.id, name: g.name }))} />
        {org.role !== "teacher" ? (
          <Filter label={t("common.teacher")} value={teacher} onChange={setTeacher} rows={teachers.data?.map((x) => ({ id: x.id, name: x.full_name }))} />
        ) : null}
        <Filter label={t("common.room")} value={room} onChange={setRoom} rows={rooms.data?.map((r) => ({ id: r.id, name: r.name }))} />
      </div>
      <Loaded load={load}>
        {(calendar) => (
          <div className={`calendar calendar-${calendar.view}`}>
            {calendar.days.map((d) => (
              <section key={d.date} className={d.date === today ? "day day-today" : "day"} aria-label={formatDate(d.date)}>
                <h2>
                  {label("weekday", String(d.weekday))} · {formatDate(d.date)}
                </h2>
                {d.entries.length === 0 ? <p className="muted">{t("calendar.noLessons")}</p> : null}
                <ul>
                  {d.entries.map((e) => (
                    <li key={e.lesson_id} className={`entry entry-${e.status}`}>
                      <Link to={`/lessons/${e.lesson_id}`}>
                        {formatTime(e.start_time)}–{formatTime(e.end_time)} · {e.group_name}
                      </Link>
                      <p className="muted">
                        {e.teacher_name ?? "—"} · {e.room_name ?? "—"} · {label("lessonStatus", e.status)}
                      </p>
                      <p>
                        {e.is_substitute ? <Badge tone="warn">{t("calendar.substitute")}</Badge> : null}{" "}
                        {e.moved_from_date ? <Badge tone="warn">{t("calendar.moved", { date: formatDate(e.moved_from_date) })}</Badge> : null}{" "}
                        {e.conflicts.length ? <Badge tone="bad">{t("calendar.conflict", { groups: e.conflicts.map((c) => c.group_name).join(", ") })}</Badge> : null}{" "}
                        {e.capacity_problem !== "ok" ? <Badge tone="bad">{label("capacityProblem", e.capacity_problem)}</Badge> : null}
                      </p>
                      <LessonActions lesson={{ id: e.lesson_id, status: e.status, lesson_date: e.lesson_date, start_time: e.start_time, end_time: e.end_time, room_id: e.room_id }} done={load.reload} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Loaded>
    </Page>
  );
}

export function ScheduleChecksPage() {
  const { t, label } = useI18n();
  const { today } = useStaff();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(addDays(today, 30));
  const load = useLoad(() => unwrap(api.GET("/v1/schedule/checks", { params: { query: { date_from: from, date_to: to } } })), [from, to]);
  return (
    <Page title={t("nav.scheduleChecks")}>
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
      <Loaded load={load}>
        {(checks) => (
          <>
            <Card title={t("schedule.conflicts", { n: checks.conflicts.length })}>
              <Table
                caption={t("schedule.conflicts", { n: checks.conflicts.length })}
                empty={t("schedule.noConflicts")}
                rows={checks.conflicts}
                rowKey={(c) => `${c.lesson_a}-${c.lesson_b}-${c.kind}`}
                columns={[
                  { head: t("common.date"), cell: (c) => formatDate(c.date) },
                  { head: t("schedule.clashOf"), cell: (c) => `${label("clashKind", c.kind)}: ${c.kind === "room" ? (c.room ?? "—") : (c.teacher ?? "—")}` },
                  { head: t("common.group"), cell: (c) => <Link to={`/lessons/${c.lesson_a}`}>{c.group_a} · {formatTime(c.start_a)}</Link> },
                  { head: t("schedule.otherGroup"), cell: (c) => <Link to={`/lessons/${c.lesson_b}`}>{c.group_b} · {formatTime(c.start_b)}</Link> },
                ]}
              />
            </Card>
            <Card title={t("schedule.capacity", { n: checks.capacity.length })}>
              <Table
                caption={t("schedule.capacity", { n: checks.capacity.length })}
                empty={t("schedule.noCapacity")}
                rows={checks.capacity}
                rowKey={(c) => `${c.group_id}-${c.room_id}`}
                columns={[
                  { head: t("common.group"), cell: (c) => <Link to={`/groups/${c.group_id}`}>{c.group_name}</Link> },
                  { head: t("common.room"), cell: (c) => c.room_name },
                  { head: t("groups.students"), cell: (c) => c.enrolled, className: "num" },
                  { head: t("groups.capacity"), cell: (c) => c.group_capacity ?? "—", className: "num" },
                  { head: t("rooms.capacity"), cell: (c) => c.room_capacity ?? "—", className: "num" },
                  { head: t("common.status"), cell: (c) => label("capacityProblem", c.problem) },
                ]}
              />
            </Card>
          </>
        )}
      </Loaded>
    </Page>
  );
}

export function NoticesPage() {
  const { t, label } = useI18n();
  const { timeZone } = useStaff();
  const [status, setStatus] = useState("pending");
  const [offset, setOffset] = useState(0);
  const load = useLoad(
    () => unwrap(api.GET("/v1/schedule-notices", { params: { query: { status: (status || undefined) as never, offset, limit: PAGE_SIZE } } })),
    [status, offset],
  );
  return (
    <Page title={t("nav.notices")}>
      <p className="hint">{t("notices.hint")}</p>
      <div className="filters">
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
            {["pending", "approved", "rejected"].map((s) => (
              <option key={s} value={s}>
                {label("noticeStatus", s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Loaded load={load}>
        {(page) => (
          <>
            <Table
              caption={t("nav.notices")}
              rows={page.items}
              rowKey={(n) => n.id}
              columns={[
                { head: t("common.date"), cell: (n) => formatDateTime(n.created_at, timeZone) },
                { head: t("common.student"), cell: (n) => `${n.student_name} · ${n.group_name}` },
                { head: t("common.guardian"), cell: (n) => n.guardian_name },
                { head: t("common.message"), cell: (n) => <span className="message">{n.body}</span> },
                { head: t("common.status"), cell: (n) => label("noticeStatus", n.status) },
                {
                  head: t("common.actions"),
                  cell: (n) =>
                    n.status === "pending" ? (
                      <div className="row-actions">
                        <FormButton
                          label={t("common.approveSend")}
                          submitLabel={t("common.approveSend")}
                          extra={<p>{t("notices.approveText", { name: n.guardian_name })}</p>}
                          fields={[
                            { name: "channel", label: t("notices.channel"), type: "select", options: ["telegram", "sms"].map((c) => ({ value: c, label: label("channel", c) })) },
                          ]}
                          submit={async (body, key) => {
                            await unwrap(
                              api.POST("/v1/schedule-notices/{notice_id}/approve", { params: { path: { notice_id: n.id } }, body: body as never, ...idempotent(key) }),
                            );
                            load.reload();
                          }}
                        />
                        <ConfirmButton
                          label={t("common.reject")}
                          text={t("notices.rejectText")}
                          done={load.reload}
                          run={async (_reason, key) => {
                            await unwrap(api.POST("/v1/schedule-notices/{notice_id}/reject", { params: { path: { notice_id: n.id } }, ...idempotent(key) }));
                          }}
                        />
                      </div>
                    ) : null,
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
