/** Guardians, courses, teachers and rooms. */

import { useState } from "react";
import { useSearchParams } from "react-router";
import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { formatAmount, formatDate } from "../lib/format";
import { useStaff } from "../session/context";
import type { Field } from "../ui/form";
import { useDebounced, useLoad } from "../ui/hooks";
import { options } from "../ui/pickers";
import { Resource } from "./resource";

type Guardian = components["schemas"]["GuardianOut"];
type Course = components["schemas"]["CourseOut"];
type Teacher = components["schemas"]["TeacherOut"];
type Room = components["schemas"]["RoomOut"];

export function GuardiansPage() {
  const { t } = useI18n();
  const { can } = useStaff();
  const [params] = useSearchParams();
  const only = params.get("id");
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const write = can("students:write");
  const fields: Field[] = [
    { name: "full_name", label: t("common.fullName"), required: true, maxLength: 200 },
    { name: "phone", label: t("common.phone"), type: "tel", hint: t("common.phoneHint") },
    { name: "telegram_chat_id", label: t("guardians.chatId"), type: "number", hint: t("guardians.chatIdHint") },
  ];
  const get = (id: string) => unwrap(api.GET("/v1/guardians/{guardian_id}", { params: { path: { guardian_id: id } } }));
  return (
    <Resource<Guardian>
      heading="nav.guardians"
      deps={[q, only]}
      list={async (offset, limit) =>
        only
          ? { items: [await get(only)], has_more: false }
          : unwrap(api.GET("/v1/guardians", { params: { query: { q: q || undefined, offset, limit } } }))
      }
      name={(g) => g.full_name}
      filters={
        only ? undefined : (
          <label>
            {t("common.search")}
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )
      }
      columns={[
        { head: t("common.fullName"), cell: (g) => g.full_name },
        { head: t("common.phone"), cell: (g) => g.phone ?? "—" },
        { head: t("guardians.telegram"), cell: (g) => (g.telegram_chat_id ? t("common.yes") : t("common.no")) },
      ]}
      create={write ? { label: "guardians.add", fields, submit: (body, key) => unwrap(api.POST("/v1/guardians", { body: body as never, ...idempotent(key) })) } : undefined}
      edit={
        write
          ? { fields: () => fields, get, submit: (g, body) => unwrap(api.PATCH("/v1/guardians/{guardian_id}", { params: { path: { guardian_id: g.id } }, body: body as never })) }
          : undefined
      }
      remove={write ? { text: "guardians.deleteText", run: (g) => unwrap(api.DELETE("/v1/guardians/{guardian_id}", { params: { path: { guardian_id: g.id } } })) } : undefined}
    />
  );
}

export function CoursesPage() {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const write = can("academics:write");
  const base: Field[] = [
    { name: "name", label: t("common.name"), required: true, maxLength: 200 },
    { name: "default_monthly_fee", label: t("courses.fee"), type: "money" },
    { name: "description", label: t("common.description"), type: "textarea", maxLength: 2000 },
  ];
  return (
    <Resource<Course>
      heading="nav.courses"
      list={(offset, limit) => unwrap(api.GET("/v1/courses", { params: { query: { offset, limit } } }))}
      name={(c) => c.name}
      columns={[
        { head: t("common.name"), cell: (c) => c.name },
        { head: t("courses.fee"), cell: (c) => formatAmount(c.default_monthly_fee), className: "num" },
        { head: t("common.status"), cell: (c) => label("courseStatus", c.status) },
        { head: t("common.description"), cell: (c) => c.description ?? "—" },
      ]}
      create={write ? { label: "courses.add", fields: base, submit: (body, key) => unwrap(api.POST("/v1/courses", { body: body as never, ...idempotent(key) })) } : undefined}
      edit={
        write
          ? {
              fields: () => [...base, { name: "status", label: t("common.status"), type: "select", required: true, options: ["active", "archived"].map((s) => ({ value: s, label: label("courseStatus", s) })) }],
              get: (id) => unwrap(api.GET("/v1/courses/{course_id}", { params: { path: { course_id: id } } })),
              submit: (c, body) => unwrap(api.PATCH("/v1/courses/{course_id}", { params: { path: { course_id: c.id } }, body: body as never })),
            }
          : undefined
      }
      remove={write ? { text: "courses.deleteText", run: (c) => unwrap(api.DELETE("/v1/courses/{course_id}", { params: { path: { course_id: c.id } } })) } : undefined}
    />
  );
}

export function TeachersPage() {
  const { t, label } = useI18n();
  const { can, branches, scopeBranch } = useStaff();
  const write = can("academics:write");
  const seesStaff = can("staff:read");
  const staff = useLoad(
    async () => (write && seesStaff ? (await unwrap(api.GET("/v1/staff", { params: { query: { limit: 200 } } }))).items : []),
    [write, seesStaff],
  );
  const base: Field[] = [
    { name: "full_name", label: t("common.fullName"), required: true, maxLength: 200 },
    { name: "phone", label: t("common.phone"), type: "tel", hint: t("common.phoneHint") },
    { name: "hired_on", label: t("teachers.hiredOn"), type: "date" },
    { name: "pay_model", label: t("teachers.payModel"), type: "select", required: true, options: ["fixed", "per_lesson", "percent"].map((m) => ({ value: m, label: label("payModel", m) })) },
    { name: "pay_rate", label: t("teachers.payRate"), type: "money", required: true, hint: t("teachers.payRateHint") },
  ];
  if (staff.data?.length) {
    base.push({ name: "staff_id", label: t("teachers.login"), type: "select", options: staff.data.filter((s) => s.role === "teacher").map((s) => ({ value: s.id, label: s.user.full_name })) });
  }
  const createFields: Field[] =
    !scopeBranch && branches.length > 1 ? [...base, { name: "branch_id", label: t("common.branch"), type: "select", options: options(branches, (b) => b.name) }] : base;
  return (
    <Resource<Teacher>
      heading="nav.teachers"
      list={(offset, limit) => unwrap(api.GET("/v1/teachers", { params: { query: { offset, limit } } }))}
      name={(row) => row.full_name}
      columns={[
        { head: t("common.fullName"), cell: (r) => r.full_name },
        { head: t("common.phone"), cell: (r) => r.phone ?? "—" },
        { head: t("teachers.payModel"), cell: (r) => label("payModel", r.pay_model) },
        { head: t("teachers.payRate"), cell: (r) => formatAmount(r.pay_rate), className: "num" },
        { head: t("teachers.hiredOn"), cell: (r) => formatDate(r.hired_on) },
        { head: t("teachers.hasLogin"), cell: (r) => (r.has_login ? t("common.yes") : t("common.no")) },
        { head: t("common.status"), cell: (r) => label("teacherStatus", r.status) },
      ]}
      create={write ? { label: "teachers.add", fields: createFields, initial: { pay_model: "per_lesson" }, submit: (body, key) => unwrap(api.POST("/v1/teachers", { body: body as never, ...idempotent(key) })) } : undefined}
      edit={
        write
          ? {
              // `staff_id` is not part of the record the API returns: it is sent only when a person picks one
              fields: () => [...base, { name: "status", label: t("common.status"), type: "select", required: true, options: ["active", "inactive"].map((s) => ({ value: s, label: label("teacherStatus", s) })) }],
              get: (id) => unwrap(api.GET("/v1/teachers/{teacher_id}", { params: { path: { teacher_id: id } } })),
              submit: (r, body) => unwrap(api.PATCH("/v1/teachers/{teacher_id}", { params: { path: { teacher_id: r.id } }, body: body as never })),
            }
          : undefined
      }
      remove={write ? { text: "teachers.deleteText", run: (r) => unwrap(api.DELETE("/v1/teachers/{teacher_id}", { params: { path: { teacher_id: r.id } } })) } : undefined}
    />
  );
}

export function RoomsPage() {
  const { t } = useI18n();
  const { can, branches, scopeBranch } = useStaff();
  const write = can("academics:write");
  const base: Field[] = [
    { name: "name", label: t("common.name"), required: true, maxLength: 200 },
    { name: "capacity", label: t("rooms.capacity"), type: "number", min: 1 },
  ];
  const createFields: Field[] = [...base, { name: "branch_id", label: t("common.branch"), type: "select", required: true, options: options(branches, (b) => b.name) }];
  return (
    <Resource<Room>
      heading="nav.rooms"
      list={(offset, limit) => unwrap(api.GET("/v1/rooms", { params: { query: { offset, limit } } }))}
      name={(r) => r.name}
      columns={[
        { head: t("common.name"), cell: (r) => r.name },
        { head: t("rooms.capacity"), cell: (r) => r.capacity ?? "—" },
        { head: t("common.branch"), cell: (r) => branches.find((b) => b.id === r.branch_id)?.name ?? "—" },
      ]}
      create={
        write
          ? {
              label: "rooms.add",
              fields: createFields,
              initial: { branch_id: scopeBranch ?? branches.find((b) => b.is_default)?.id ?? "" },
              submit: (body, key) => unwrap(api.POST("/v1/rooms", { body: body as never, ...idempotent(key) })),
            }
          : undefined
      }
      edit={write ? { fields: () => base, submit: (r, body) => unwrap(api.PATCH("/v1/rooms/{room_id}", { params: { path: { room_id: r.id } }, body: body as never })) } : undefined}
      remove={write ? { text: "rooms.deleteText", run: (r) => unwrap(api.DELETE("/v1/rooms/{room_id}", { params: { path: { room_id: r.id } } })) } : undefined}
    />
  );
}
