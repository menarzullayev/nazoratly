/** Import of students, groups or leads: choose a file (or paste), check the preview, fix the column mapping, then write
 * the clean rows in one transaction. */

import { useState, type ChangeEvent } from "react";
import type { components } from "@api/schema";
import { api, idempotent, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { ConfirmButton } from "../ui/form";
import { useAction } from "../ui/hooks";
import { Card, Done, ErrorNote, Page, Table } from "../ui/kit";

type Preview = components["schemas"]["PreviewOut"];
type Entity = "students" | "groups" | "leads";
const MAX_CHARS = 950_000;

export function ImportPage() {
  const { t, label } = useI18n();
  const [entity, setEntity] = useState<Entity>("students");
  const [text, setText] = useState("");
  const [header, setHeader] = useState(true);
  const [mapping, setMapping] = useState<Record<string, number | null> | null>(null);
  const [onError, setOnError] = useState<"skip" | "abort">("skip");
  const [duplicates, setDuplicates] = useState<"skip" | "create">("skip");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const action = useAction();
  const forget = () => {
    setPreview(null);
    setDone(null);
    action.clear();
  };
  const body = () => ({ text, has_header: header, mapping: mapping ?? undefined });

  const check = (next: Record<string, number | null> | null = mapping) =>
    void action.run(async () => {
      setDone(null);
      setPreview(
        await unwrap(api.POST("/v1/imports/{entity}/preview", { params: { path: { entity } }, body: { text, has_header: header, mapping: next ?? undefined } })),
      );
    });

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setTooBig(content.length > MAX_CHARS);
    setText(content.length > MAX_CHARS ? "" : content);
    setMapping(null);
    forget();
  };

  return (
    <Page title={t("nav.import")}>
      <Card title={t("import.file")}>
        <div className="filters">
          <label>
            {t("import.entity")}
            <select
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value as Entity);
                setMapping(null);
                forget();
              }}
            >
              {(["students", "groups", "leads"] as const).map((x) => (
                <option key={x} value={x}>
                  {label("importEntity", x)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("import.chooseFile")}
            <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={(e) => void pickFile(e)} />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={header}
              onChange={(e) => {
                setHeader(e.target.checked);
                setMapping(null);
                forget();
              }}
            />
            {t("import.hasHeader")}
          </label>
        </div>
        {tooBig ? <p className="note note-error" role="alert">{t("import.tooBig")}</p> : null}
        <div className="field">
          <label htmlFor="import-text">{t("import.text")}</label>
          <textarea
            id="import-text"
            rows={8}
            maxLength={MAX_CHARS}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              forget();
            }}
          />
        </div>
        <p>
          <button type="button" className="primary" disabled={!text.trim() || action.pending} onClick={() => check()}>
            {t("import.preview")}
          </button>
        </p>
        {action.error ? <ErrorNote error={action.error} /> : null}
        <Done text={done} />
      </Card>
      {preview ? (
        <>
          <Card title={t("import.columns")}>
            <div className="mapping">
              {preview.fields.map((field) => (
                <label key={field}>
                  {label("importField", field)}
                  {preview.required.includes(field) ? " *" : ""}
                  <select
                    value={(preview.mapping as Record<string, number | null>)[field] ?? ""}
                    onChange={(e) => {
                      const next = { ...(preview.mapping as Record<string, number | null>), [field]: e.target.value === "" ? null : Number(e.target.value) };
                      setMapping(next);
                      check(next);
                    }}
                  >
                    <option value="">{t("import.notImported")}</option>
                    {preview.columns.map((column, i) => (
                      <option key={i} value={i}>
                        {column}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </Card>
          <Card title={t("import.result", { total: preview.summary.total, ok: preview.summary.ok, errors: preview.summary.errors, duplicates: preview.summary.duplicates })}>
            {preview.required_missing.length ? (
              <p className="note note-error" role="alert">
                {t("import.requiredMissing", { fields: preview.required_missing.map((f) => label("importField", f)).join(", ") })}
              </p>
            ) : null}
            {preview.rows_truncated ? <p className="hint">{t("import.truncated")}</p> : null}
            <Table
              caption={t("import.preview")}
              rows={preview.rows}
              rowKey={(r) => String(r.row)}
              columns={[
                { head: t("import.row"), cell: (r) => r.row },
                { head: t("common.status"), cell: (r) => label("rowStatus", r.status) },
                { head: t("import.values"), cell: (r) => Object.entries(r.values as Record<string, unknown>).filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${label("importField", k)}: ${String(v)}`).join("; ") },
                {
                  head: t("import.problems"),
                  cell: (r) =>
                    r.status === "duplicate"
                      ? label("duplicateKind", r.duplicate?.kind)
                      : r.errors.map((e) => `${label("importField", e.field)}: ${e.message}`).join("; ") || "—",
                },
              ]}
            />
            <div className="filters">
              <label>
                {t("import.onError")}
                <select value={onError} onChange={(e) => setOnError(e.target.value as "skip" | "abort")}>
                  <option value="skip">{t("import.skipBad")}</option>
                  <option value="abort">{t("import.abort")}</option>
                </select>
              </label>
              <label>
                {t("import.duplicates")}
                <select value={duplicates} onChange={(e) => setDuplicates(e.target.value as "skip" | "create")}>
                  <option value="skip">{t("import.skipDuplicates")}</option>
                  <option value="create">{t("import.createDuplicates")}</option>
                </select>
              </label>
            </div>
            <ConfirmButton
              label={t("import.commit")}
              text={t("import.commitText", { ok: preview.summary.ok })}
              danger={false}
              disabled={preview.required_missing.length > 0 || preview.summary.total === 0}
              run={async (_reason, key) => {
                const result = await unwrap(
                  api.POST("/v1/imports/{entity}/commit", { params: { path: { entity } }, body: { ...body(), on_error: onError, duplicates }, ...idempotent(key) }),
                );
                const created = Object.entries(result.created as Record<string, number>).map(([k, v]) => `${label("importEntity", k)}: ${v}`).join(", ");
                setDone(t("import.done", { created: created || "0", errors: result.skipped_errors, duplicates: result.skipped_duplicates }));
                setPreview(null);
              }}
            />
          </Card>
        </>
      ) : null}
    </Page>
  );
}
