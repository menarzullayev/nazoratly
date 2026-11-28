/** The pure part of the form engine: field descriptions and how typed values become an API body. */

import { parseAmount } from "../lib/format";

export interface Option {
  value: string;
  label: string;
}

export type FieldType = "text" | "textarea" | "email" | "tel" | "password" | "date" | "month" | "time" | "number" | "money" | "select" | "checkbox";

export interface Field {
  name: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  options?: Option[];
  hint?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  minLength?: number;
  autoComplete?: string;
  visible?: (values: Values) => boolean;
}

export type Values = Record<string, string | boolean>;
export type Body = Record<string, string | number | boolean | null>;

export function initialValues(fields: Field[], source: Record<string, unknown> = {}): Values {
  return Object.fromEntries(
    fields.map((f) => {
      const raw = source[f.name];
      if (f.type === "checkbox") return [f.name, Boolean(raw)];
      let text = raw === null || raw === undefined ? "" : String(raw);
      if (f.type === "time") text = text.slice(0, 5);
      if (f.type === "month") text = text.slice(0, 7);
      if (f.type === "money" && /\.00$/.test(text)) text = text.slice(0, -3);
      return [f.name, text];
    }),
  );
}

/** The API value of one field; `undefined` = leave the field out, `"invalid"` problems are reported by name. */
function apiValue(field: Field, value: string | boolean): { value?: string | number | boolean | null; problem?: "required" | "money" | "number" } {
  if (field.type === "checkbox") return { value: value === true };
  const text = String(value).trim();
  if (!text) return field.required ? { problem: "required" } : { value: null };
  if (field.type === "money") {
    const amount = parseAmount(text);
    return amount === null ? { problem: "money" } : { value: amount };
  }
  if (field.type === "number") {
    const number = Number(text);
    return Number.isInteger(number) ? { value: number } : { problem: "number" };
  }
  if (field.type === "month") return { value: `${text}-01` };
  if (field.type === "password") return { value: String(value) };
  return { value: text };
}

/** Builds the request body. With `original` (an edit) only changed fields are sent, and a cleared field is sent as
 * null; without it (a new record) empty fields are left out. */
export function buildBody(fields: Field[], values: Values, original?: Values): { body: Body; problems: Record<string, string> } {
  const body: Body = {};
  const problems: Record<string, string> = {};
  for (const field of fields) {
    if (field.visible && !field.visible(values)) continue;
    const { value, problem } = apiValue(field, values[field.name] ?? "");
    if (problem) problems[field.name] = problem;
    else if (original) {
      if (values[field.name] !== original[field.name]) body[field.name] = value ?? null;
    } else if (value !== null && value !== undefined) body[field.name] = value;
  }
  return { body, problems };
}
