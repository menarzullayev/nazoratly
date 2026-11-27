/** One form engine: field list in, API body out. The server's validation answer is shown next to the field it is about,
 * a second click does nothing while a request runs, and every attempt carries an Idempotency-Key. */

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ApiFailure } from "../api/errors";
import { useI18n, type T } from "../i18n";
import { hasKey } from "../i18n/core";
import { buildBody, initialValues, type Body, type Field, type Values } from "./formBody";
import { ErrorNote } from "./kit";
import { useAction } from "./hooks";

export type { Body, Field, Option, Values } from "./formBody";

function problemText(t: T, type: string): string {
  const key = `field.${type}`;
  return hasKey(key) ? t(key) : t("field.invalid");
}

export function FieldInput({ field, value, onChange, problem }: { field: Field; value: string | boolean; onChange: (v: string | boolean) => void; problem?: string }) {
  const { t } = useI18n();
  const id = useId();
  const type = field.type ?? "text";
  const common = {
    id,
    name: field.name,
    required: field.required,
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": problem || field.hint ? `${id}-note` : undefined,
  };
  let control: ReactNode;
  if (type === "checkbox") {
    return (
      <div className="field field-check">
        <input {...common} required={false} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <label htmlFor={id}>{field.label}</label>
        {problem ? <p id={`${id}-note`} className="field-error">{problemText(t, problem)}</p> : null}
      </div>
    );
  }
  if (type === "select") {
    control = (
      <select {...common} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.required ? t("common.choose") : "—"}</option>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (type === "textarea") {
    control = <textarea {...common} rows={4} maxLength={field.maxLength} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
  } else {
    control = (
      <input
        {...common}
        type={type === "money" ? "text" : type === "number" ? "number" : type}
        inputMode={type === "money" ? "decimal" : undefined}
        min={field.min}
        max={field.max}
        minLength={field.minLength}
        maxLength={field.maxLength}
        autoComplete={field.autoComplete ?? "off"}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>
        {field.label}
        {field.required ? null : <span className="optional"> ({t("common.optional")})</span>}
      </label>
      {control}
      {problem ? (
        <p id={`${id}-note`} className="field-error">{problemText(t, problem)}</p>
      ) : field.hint ? (
        <p id={`${id}-note`} className="hint">{field.hint}</p>
      ) : null}
    </div>
  );
}

export interface FormProps {
  fields: Field[];
  initial?: Record<string, unknown>;
  /** An edit: send only what changed. */
  patch?: boolean;
  submitLabel: string;
  submit: (body: Body, idempotencyKey: string, values: Values) => Promise<void>;
  onCancel?: () => void;
  extra?: ReactNode;
  error?: (error: ApiFailure) => ReactNode;
  danger?: boolean;
}

export function Form({ fields, initial, patch, submitLabel, submit, onCancel, extra, danger, error: renderError }: FormProps) {
  const { t } = useI18n();
  const [original] = useState(() => initialValues(fields, initial));
  const [values, setValues] = useState(original);
  const [local, setLocal] = useState<Record<string, string>>({});
  const action = useAction();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    // a dialog can be opened from inside another form (a roll call row): its submit must not submit that form too.
    // React bubbles events through portals, so the portal alone is not enough.
    event.stopPropagation();
    const { body, problems } = buildBody(fields, values, patch ? original : undefined);
    setLocal(problems);
    if (Object.keys(problems).length) return;
    void action.run((key) => submit(body, key, values));
  };

  const server = Object.fromEntries((action.error?.fields ?? []).map((p) => [p.field, p.type]));
  const unplaced = action.error && !(action.error.code === "validation_error" && fields.some((f) => server[f.name]));
  return (
    <form onSubmit={onSubmit} noValidate>
      {fields
        .filter((f) => !f.visible || f.visible(values))
        .map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={values[field.name] ?? ""}
            problem={local[field.name] ?? server[field.name]}
            onChange={(v) => setValues((current) => ({ ...current, [field.name]: v }))}
          />
        ))}
      {extra}
      {unplaced && action.error ? (renderError?.(action.error) ?? <ErrorNote error={action.error} />) : null}
      <div className="form-actions">
        <button type="submit" className={danger ? "danger" : "primary"} disabled={action.pending}>
          {action.pending ? t("common.saving") : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} disabled={action.pending}>
            {t("common.cancel")}
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const { t } = useI18n();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  // rendered at the top of the document: a form inside another form is not valid HTML
  return createPortal(
    <dialog ref={ref} aria-labelledby={id} onClose={onClose} onCancel={onClose}>
      <header className="dialog-head">
        <h2 id={id}>{title}</h2>
        <button type="button" className="icon" aria-label={t("common.close")} onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>,
    document.body,
  );
}

export function FormDialog({ title, onClose, done, submit, ...form }: Omit<FormProps, "onCancel"> & { title: string; onClose: () => void; done?: () => void }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <Form
        {...form}
        onCancel={onClose}
        submit={async (body, key, values) => {
          await submit(body, key, values);
          done?.();
          onClose();
        }}
      />
    </Dialog>
  );
}

/** A button for an action that cannot be taken back: it always asks first, optionally for a reason. */
export function ConfirmButton({ label, title, text, reason, danger = true, run, done, disabled }: {
  label: string;
  title?: string;
  text: string;
  reason?: string;
  danger?: boolean;
  run: (reason: string, idempotencyKey: string) => Promise<void>;
  done?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const fields: Field[] = reason ? [{ name: "reason", label: reason, required: true, maxLength: 500 }] : [];
  return (
    <>
      <button type="button" className={danger ? "danger-quiet" : undefined} onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </button>
      {open ? (
        <FormDialog
          title={title ?? label}
          onClose={() => setOpen(false)}
          done={done}
          fields={fields}
          extra={<p>{text}</p>}
          danger={danger}
          submitLabel={label}
          submit={(body, key) => run(String(body.reason ?? ""), key)}
        />
      ) : null}
    </>
  );
}

/** A button that opens a form in a dialog. */
export function FormButton({ label, title, className, ...form }: Omit<FormProps, "onCancel" | "submitLabel"> & { label: string; title?: string; className?: string; submitLabel?: string; done?: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? <FormDialog title={title ?? label} onClose={() => setOpen(false)} {...form} submitLabel={form.submitLabel ?? t("common.save")} /> : null}
    </>
  );
}
