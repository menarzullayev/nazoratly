/** The center's profile, its branches and its staff. */

import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { useSession, useStaff } from "../session/context";
import { FormButton, type Field } from "../ui/form";
import { useLoad } from "../ui/hooks";
import { Card, Facts, Loaded, Page } from "../ui/kit";
import { options } from "../ui/pickers";
import { Resource } from "./resource";

type Branch = components["schemas"]["BranchOut"];
type Staff = components["schemas"]["StaffOut"];
const ROLES = ["owner", "admin", "manager", "accountant", "teacher", "viewer"] as const;

export function OrganizationPage() {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const { reload } = useSession();
  const load = useLoad(() => unwrap(api.GET("/v1/organization")), []);
  const fields: Field[] = [
    { name: "name", label: t("common.name"), required: true, maxLength: 200 },
    { name: "legal_name", label: t("org.legalName"), maxLength: 300 },
    { name: "tin", label: t("org.tin"), maxLength: 14, hint: t("org.tinHint") },
    { name: "timezone", label: t("org.timezone"), required: true, maxLength: 64 },
  ];
  return (
    <Page title={t("nav.organization")}>
      <Loaded load={load}>
        {(o) => (
          <Card
            title={o.name}
            actions={
              can("org:manage") ? (
                <FormButton
                  label={t("common.edit")}
                  fields={fields}
                  initial={o}
                  patch
                  submit={async (body) => {
                    await unwrap(api.PATCH("/v1/organization", { body: body as never }));
                    load.reload();
                    await reload();
                  }}
                />
              ) : null
            }
          >
            <Facts
              items={[
                [t("common.name"), o.name],
                [t("org.legalName"), o.legal_name],
                [t("org.tin"), o.tin],
                [t("org.timezone"), o.timezone],
                [t("org.currency"), o.currency],
                [t("common.status"), label("orgStatus", o.status)],
              ]}
            />
          </Card>
        )}
      </Loaded>
    </Page>
  );
}

export function BranchesPage() {
  const { t, label } = useI18n();
  const { can, me } = useStaff();
  const { reload } = useSession();
  // branch administration is center-wide work: staff tied to one branch cannot do it
  const manage = can("branches:manage") && !me.branch_id;
  const fields: Field[] = [
    { name: "name", label: t("common.name"), required: true, maxLength: 200 },
    { name: "address", label: t("branches.address"), maxLength: 500 },
  ];
  const changed = async <R,>(call: Promise<R>): Promise<R> => {
    const result = await call;
    void reload(); // the branch chooser in the header reads the same list
    return result;
  };
  return (
    <Resource<Branch>
      heading="nav.branches"
      list={(offset, limit) => unwrap(api.GET("/v1/branches", { params: { query: { offset, limit } } }))}
      name={(b) => b.name}
      columns={[
        { head: t("common.name"), cell: (b) => (b.is_default ? `${b.name} · ${t("branches.default")}` : b.name) },
        { head: t("branches.address"), cell: (b) => b.address ?? "—" },
        { head: t("common.status"), cell: (b) => label("branchStatus", b.status) },
      ]}
      create={manage ? { label: "branches.add", fields, submit: (body, key) => changed(unwrap(api.POST("/v1/branches", { body: body as never, ...idempotent(key) }))) } : undefined}
      edit={
        manage
          ? {
              fields: () => [...fields, { name: "status", label: t("common.status"), type: "select", required: true, options: ["active", "closed"].map((s) => ({ value: s, label: label("branchStatus", s) })) }],
              get: (id) => unwrap(api.GET("/v1/branches/{branch_id}", { params: { path: { branch_id: id } } })),
              submit: (b, body) => changed(unwrap(api.PATCH("/v1/branches/{branch_id}", { params: { path: { branch_id: b.id } }, body: body as never }))),
            }
          : undefined
      }
      remove={manage ? { text: "branches.deleteText", run: (b) => changed(unwrap(api.DELETE("/v1/branches/{branch_id}", { params: { path: { branch_id: b.id } } }))) } : undefined}
    />
  );
}

export function StaffPage() {
  const { t, label } = useI18n();
  const { can, branches, me, org } = useStaff();
  const manage = can("staff:manage");
  // only the owner may grant or change owner and admin (the server refuses it from anyone else)
  const roles = ROLES.filter((r) => org.role === "owner" || (r !== "owner" && r !== "admin"));
  const roleOptions = roles.map((r) => ({ value: r, label: label("role", r) }));
  const branchField: Field[] = me.branch_id ? [] : [{ name: "branch_id", label: t("common.branch"), type: "select", options: options(branches, (b) => b.name), hint: t("staff.branchHint") }];
  const createFields: Field[] = [
    { name: "full_name", label: t("common.fullName"), required: true, maxLength: 200 },
    { name: "email", label: t("common.email"), type: "email", hint: t("auth.emailOrPhone") },
    { name: "phone", label: t("common.phone"), type: "tel", hint: t("common.phoneHint") },
    { name: "role", label: t("staff.role"), type: "select", required: true, options: roleOptions },
    ...branchField,
    { name: "initial_password", label: t("staff.initialPassword"), type: "password", minLength: 10, maxLength: 128, autoComplete: "new-password", hint: t("staff.initialPasswordHint") },
  ];
  return (
    <Resource<Staff>
      heading="nav.staff"
      list={(offset, limit) => unwrap(api.GET("/v1/staff", { params: { query: { offset, limit } } }))}
      name={(s) => s.user.full_name}
      columns={[
        { head: t("common.fullName"), cell: (s) => s.user.full_name },
        { head: t("auth.identifier"), cell: (s) => s.user.email ?? s.user.phone ?? "—" },
        { head: t("staff.role"), cell: (s) => label("role", s.role) },
        { head: t("common.branch"), cell: (s) => branches.find((b) => b.id === s.branch_id)?.name ?? t("common.allBranches") },
        { head: t("common.status"), cell: (s) => label("membershipStatus", s.status) },
      ]}
      create={manage ? { label: "staff.add", fields: createFields, submit: (body, key) => unwrap(api.POST("/v1/staff", { body: body as never, ...idempotent(key) })) } : undefined}
      edit={
        manage
          ? {
              fields: (s) => [
                { name: "role", label: t("staff.role"), type: "select", required: true, options: roles.includes(s.role) ? roleOptions : [{ value: s.role, label: label("role", s.role) }] },
                {
                  name: "status",
                  label: t("common.status"),
                  type: "select",
                  required: true,
                  options: [...new Set([s.status, "active", "suspended"])].map((v) => ({ value: v, label: label("membershipStatus", v) })),
                },
                ...branchField,
              ],
              submit: (s, body) => unwrap(api.PATCH("/v1/staff/{membership_id}", { params: { path: { membership_id: s.id } }, body: body as never })),
            }
          : undefined
      }
    />
  );
}
