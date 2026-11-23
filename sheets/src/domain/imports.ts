/**
 * Interactive import rules: delimited-text parsing, column detection, per-row validation, duplicate keys. Pure
 * functions, mirrored in Python (backend/src/nazoratly/rules/imports.py); both are checked against the same cases in
 * tests/golden/import.json.
 */
import type { ISODate } from "./types";

export type ImportEntity = "students" | "groups" | "leads";

export const FIELDS: Record<ImportEntity, string[]> = {
  students: ["full_name", "phone", "birth_date", "guardian_name", "guardian_phone", "group", "notes"],
  groups: ["name", "course", "teacher", "monthly_fee", "capacity", "start_date"],
  leads: ["full_name", "phone", "source", "note"],
};
export const REQUIRED: Record<ImportEntity, string[]> = {
  students: ["full_name"],
  groups: ["name", "course", "monthly_fee", "start_date"],
  leads: ["full_name"],
};
const PHONE = ["phone", "telefon", "tel", "raqam", "telefon raqam", "telefon raqami", "phone number", "телефон", "номер"];
const ALIASES: Record<ImportEntity, Record<string, string[]>> = {
  students: {
    full_name: ["full name", "fullname", "name", "ism", "ismi", "ism familiya", "familiya ism", "fio", "f i o", "oquvchi", "o'quvchi", "student", "имя", "фио", "ф и о", "ученик", "o'quvchi ismi"],
    phone: PHONE,
    birth_date: ["birth date", "birthdate", "birthday", "dob", "tugilgan sana", "tug'ilgan sana", "tug'ilgan kun", "tugilgan kun", "дата рождения", "рождения"],
    guardian_name: ["guardian", "guardian name", "vasiy", "vasiy ismi", "ota ona", "ota onasi", "parent", "parent name", "родитель", "опекун"],
    guardian_phone: ["guardian phone", "vasiy telefon", "vasiy telefoni", "ota ona telefon", "ota ona telefoni", "parent phone", "телефон родителя"],
    group: ["group", "guruh", "группа"],
    notes: ["notes", "note", "izoh", "izohlar", "комментарий", "примечание"],
  },
  groups: {
    name: ["name", "group", "group name", "guruh", "guruh nomi", "nomi", "название", "группа"],
    course: ["course", "kurs", "fan", "курс", "subject"],
    teacher: ["teacher", "oqituvchi", "o'qituvchi", "ustoz", "учитель", "преподаватель"],
    monthly_fee: ["monthly fee", "fee", "price", "narx", "oylik", "oylik to'lov", "oylik tolov", "tolov", "to'lov", "цена", "стоимость"],
    capacity: ["capacity", "sigim", "sig'im", "max", "limit", "o'rinlar", "orinlar", "вместимость"],
    start_date: ["start date", "start", "boshlanish", "boshlanish sanasi", "boshlanadi", "дата начала"],
  },
  leads: {
    full_name: ["full name", "fullname", "name", "ism", "ismi", "ism familiya", "fio", "имя", "фио"],
    phone: PHONE,
    source: ["source", "manba", "qayerdan", "источник", "channel", "kanal"],
    note: ["note", "notes", "izoh", "izohlar", "комментарий", "примечание"],
  },
};
const MAX_TEXT = 200;
const QUOTES = /[ʻʼ’‘`´]/g;

export function normHeader(text: string): string {
  return text.replace(QUOTES, "'").toLowerCase().trim().replace(/[\s_\-.]+/g, " ").trim();
}
export function normName(text: string): string {
  return text.replace(QUOTES, "'").toLowerCase().replace(/[.\-_]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Rows of cells. Delimiter = the most frequent of , ; TAB in the first line outside quotes. Handles a BOM, quoted cells
 * with doubled quotes and newlines, CRLF. Rows with only empty cells are dropped.
 */
export function parseDelimited(input: string): string[][] {
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inq = false;
  for (const ch of text) {
    if (ch === '"') inq = !inq;
    else if (!inq && (ch === "\r" || ch === "\n")) break;
    else if (!inq && ch in counts) counts[ch] = (counts[ch] as number) + 1;
  }
  let delim = ",";
  if (counts[","]! + counts[";"]! + counts["\t"]! > 0) {
    for (const k of [",", ";", "\t"]) if ((counts[k] as number) > (counts[delim] as number)) delim = k;
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let started = false; // cell has content (python: `cell` list non-empty)
  inq = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i] as string;
    if (inq) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          cell += '"';
          started = true;
          i++;
        } else inq = false;
      } else {
        cell += ch;
        started = true;
      }
    } else if (ch === '"' && !started) {
      inq = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = "";
      started = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && i + 1 < n && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      started = false;
      rows.push(row);
      row = [];
    } else {
      cell += ch;
      started = true;
    }
  }
  if (started || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

/** field -> column index. Exact alias match wins over a partial one; every column serves at most one field. */
export function detectColumns(entity: ImportEntity, headers: string[]): Record<string, number | null> {
  const hs = headers.map(normHeader);
  const scored: { score: number; ci: number; fi: number; fld: string }[] = [];
  FIELDS[entity].forEach((fld, fi) => {
    const al = [...(ALIASES[entity][fld] as string[]).map(normHeader), normHeader(fld)];
    hs.forEach((h, ci) => {
      if (!h) return;
      if (al.includes(h)) scored.push({ score: 1, ci, fi, fld });
      else if (al.some((a) => a.length >= 4 && h.includes(a))) scored.push({ score: 0.6, ci, fi, fld });
    });
  });
  scored.sort((a, b) => b.score - a.score || a.fi - b.fi || a.ci - b.ci);
  const out: Record<string, number | null> = {};
  for (const f of FIELDS[entity]) out[f] = null;
  const used = new Set<number>();
  for (const s of scored) {
    if (out[s.fld] === null && !used.has(s.ci)) {
      out[s.fld] = s.ci;
      used.add(s.ci);
    }
  }
  return out;
}

/** E.164 or null when the text is not a plausible number. Nine digits are Uzbek local numbers (+998). */
export function normalizePhone(text: string): string | null {
  let t = text.replace(/[\s().\-]/g, "");
  if (!t) return null;
  if (t.startsWith("00")) t = "+" + t.slice(2);
  if (t.startsWith("+")) {
    const digits = t.slice(1);
    return /^\d+$/.test(digits) && digits.length >= 8 && digits.length <= 15 && digits[0] !== "0" ? "+" + digits : null;
  }
  if (!/^\d+$/.test(t)) return null;
  if (t.length === 9) return "+998" + t;
  if (t.length === 12 && t.startsWith("998")) return "+" + t;
  return null;
}

export function parseDate(text: string): ISODate | null {
  const t = text.trim();
  let y: number;
  let m: number;
  let d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else {
    r = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
    if (!r) return null;
    [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseWhole(text: string): number | null {
  const t = text.replace(/[\s' ]/g, "");
  if (/^\d+(\.0+)?$/.test(t)) return Number(t.split(".")[0]);
  if (/^\d{1,3}(,\d{3})+(\.0+)?$/.test(t)) return Number((t.split(".")[0] as string).replace(/,/g, ""));
  return null;
}

export interface RowError {
  field: string;
  code: string;
}
export interface RowCheck {
  values: Record<string, string | number>;
  errors: RowError[];
}

/** Normalises one row. `raw` holds the cell text per field (missing = empty). Errors are per field and coded. */
export function validateRow(entity: ImportEntity, raw: Record<string, string>, today: ISODate): RowCheck {
  const out: RowCheck = { values: {}, errors: [] };
  const get = (f: string): string => (raw[f] ?? "").trim();
  const text = (f: string, required = false): void => {
    const v = get(f);
    if (!v) {
      if (required) out.errors.push({ field: f, code: "required" });
    } else if (v.length > MAX_TEXT) out.errors.push({ field: f, code: "too_long" });
    else out.values[f] = v;
  };
  const phone = (f: string): void => {
    const v = get(f);
    if (!v) return;
    const p = normalizePhone(v);
    if (p === null) out.errors.push({ field: f, code: "invalid_phone" });
    else out.values[f] = p;
  };
  const day = (f: string, required = false, past = false): void => {
    const v = get(f);
    if (!v) {
      if (required) out.errors.push({ field: f, code: "required" });
      return;
    }
    const d = parseDate(v);
    if (d === null) out.errors.push({ field: f, code: "invalid_date" });
    else if (past && d > today) out.errors.push({ field: f, code: "future_date" });
    else if (past && d < "1900-01-01") out.errors.push({ field: f, code: "invalid_date" });
    else out.values[f] = d;
  };
  const whole = (f: string, lo: number, hi: number, required = false): void => {
    const v = get(f);
    if (!v) {
      if (required) out.errors.push({ field: f, code: "required" });
      return;
    }
    const n = parseWhole(v);
    if (n === null) out.errors.push({ field: f, code: "invalid_number" });
    else if (n < lo || n > hi) out.errors.push({ field: f, code: "out_of_range" });
    else out.values[f] = n;
  };
  if (entity === "students") {
    text("full_name", true);
    phone("phone");
    day("birth_date", false, true);
    text("guardian_name");
    phone("guardian_phone");
    text("group");
    text("notes");
  } else if (entity === "groups") {
    text("name", true);
    text("course", true);
    text("teacher");
    whole("monthly_fee", 0, 999_999_999_999, true);
    whole("capacity", 1, 10_000);
    day("start_date", true);
  } else {
    text("full_name", true);
    phone("phone");
    text("source");
    text("note");
  }
  return out;
}

/** Identity keys of a normalised row (see the Python twin). */
export function duplicateKeys(entity: ImportEntity, values: Record<string, string | number>): string[] {
  if (entity === "groups") {
    const n = normName(String(values.name ?? ""));
    return n ? [`name:${n}`] : [];
  }
  const keys: string[] = [];
  const phone = values.phone;
  const name = normName(String(values.full_name ?? ""));
  const birth = values.birth_date;
  if (phone) keys.push(`phone:${phone}`);
  if (name && birth) keys.push(`name:${name}|${birth}`);
  if (name && !phone && !birth) keys.push(`name:${name}`);
  return keys;
}

export interface Duplicate {
  kind: "file" | "existing";
  /** row index of the first occurrence in the file */
  of: number | null;
}

/** Per row: null, or how it duplicates something. Rows with errors (null) neither count nor claim a key. */
export function findDuplicates(entity: ImportEntity, rows: (Record<string, string | number> | null)[], existing: Set<string>): (Duplicate | null)[] {
  const seen = new Map<string, number>();
  const out: (Duplicate | null)[] = [];
  rows.forEach((values, i) => {
    if (values === null) {
      out.push(null);
      return;
    }
    const keys = duplicateKeys(entity, values);
    let hit: Duplicate | null = null;
    if (keys.some((k) => existing.has(k))) hit = { kind: "existing", of: null };
    if (!hit) {
      const k = keys.find((x) => seen.has(x));
      if (k !== undefined) hit = { kind: "file", of: seen.get(k) as number };
    }
    if (!hit) for (const k of keys) if (!seen.has(k)) seen.set(k, i);
    out.push(hit);
  });
  return out;
}
