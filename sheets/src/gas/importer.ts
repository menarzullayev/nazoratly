/** Interactive import for the Sheets edition (students, groups, leads): the dialog uploads a CSV/TSV (or pasted cells),
 * `importPreview` maps the columns and checks every row, `importCommit` validates AGAIN and writes the clean rows.
 * Rules live in ../domain/imports.ts (shared with the API through tests/golden/import.json).
 *
 * Sheets has no transactions. Everything is validated before the first cell is written, each sheet is written with one
 * batch, and when a write fails the rows this run already added are removed again, so a failed import leaves nothing. */
import { directEnrollAllowed, freeSeats } from "../domain/capacity";
import { nextIds } from "../domain/ids";
import { detectColumns, duplicateKeys, FIELDS, findDuplicates, normalizePhone, parseDelimited, REQUIRED, validateRow, type Duplicate, type ImportEntity } from "../domain/imports";
import type { Enrollment, Group, Lead, Student, Teacher, WaitlistRow } from "../domain/types";
import { guard, withLock } from "./actions";
import { append, read, readIfPresent, replaceWhere, today } from "./repo";
import { ENROLLMENTS, GROUPS, LEADS, STUDENTS, TEACHERS, WAITLIST } from "./schema";

export const MAX_ROWS = 5000;
/** The Sheets edition does not store a course or a start date for groups, so they are not required here. */
const REQUIRED_HERE: Record<ImportEntity, string[]> = { students: ["full_name"], groups: ["name", "monthly_fee"], leads: ["full_name"] };
const MESSAGES: Record<string, string> = {
  required: "majburiy qiymat yo'q", invalid_phone: "telefon noto'g'ri", invalid_date: "sana noto'g'ri", future_date: "sana kelajakda",
  invalid_number: "butun son emas", out_of_range: "son chegaradan tashqarida", too_long: "matn 200 belgidan uzun",
  unknown_group: "bunday guruh yo'q", group_closed: "guruh tugagan yoki bekor qilingan", group_full: "guruh to'lgan",
  seats_reserved: "bo'sh o'rinlar navbatdagilar uchun saqlangan", unknown_teacher: "bunday o'qituvchi yo'q", ambiguous_teacher: "bir nechta shu nomli o'qituvchi bor",
};
type StudentRow = Student & { phone?: string; note?: string };
type Vals = Record<string, string | number>;

export interface ImportRowOut {
  row: number;
  status: "ok" | "error" | "duplicate";
  values: Vals;
  errors: { field: string; code: string; message: string }[];
  duplicate: { kind: "file" | "existing"; ofRow: number | null } | null;
}
export interface ImportPreview {
  entity: ImportEntity;
  columns: string[];
  mapping: Record<string, number | null>;
  fields: string[];
  required: string[];
  requiredMissing: string[];
  summary: { total: number; ok: number; errors: number; duplicates: number };
  rows: ImportRowOut[];
  truncated: boolean;
}
interface Row extends ImportRowOut {
  refs: { groupId?: string; teacherId?: string };
  dup: Duplicate | null;
}
interface Analysis {
  entity: ImportEntity;
  columns: string[];
  mapping: Record<string, number | null>;
  requiredMissing: string[];
  rows: Row[];
}

const err = (code: string, field: string): { field: string; code: string; message: string } => ({ field, code, message: MESSAGES[code] ?? code });

function resolveMapping(entity: ImportEntity, headers: string[], override?: Record<string, number | null>): Record<string, number | null> {
  const detected = detectColumns(entity, headers);
  if (!override) return detected;
  const unknown = Object.keys(override).filter((k) => !FIELDS[entity].includes(k));
  if (unknown.length) throw new Error(`Noma'lum maydonlar: ${unknown.join(", ")}`);
  const merged = { ...detected, ...override };
  const used = Object.values(merged).filter((v): v is number => v !== null && v !== undefined);
  if (used.some((i) => !Number.isInteger(i) || i < 0 || i >= headers.length)) throw new Error("Tanlangan ustun faylda yo'q.");
  if (new Set(used).size !== used.length) throw new Error("Bitta ustun ikki maydonni to'ldira olmaydi.");
  return merged;
}

function analyse(a: { entity: ImportEntity; text: string; hasHeader: boolean; mapping?: Record<string, number | null>; duplicatesCreate: boolean }): Analysis {
  const table = parseDelimited(a.text);
  if (table.length === 0) throw new Error("Faylda qatorlar yo'q.");
  const headers = a.hasHeader ? (table[0] as string[]) : Array.from({ length: Math.max(...table.map((r) => r.length)) }, (_, i) => `Ustun ${i + 1}`);
  const data = a.hasHeader ? table.slice(1) : table;
  if (data.length > MAX_ROWS) throw new Error(`Qatorlar juda ko'p (${data.length}); bir martada ${MAX_ROWS} tagacha.`);
  const mapping = resolveMapping(a.entity, headers, a.mapping);
  const required = REQUIRED_HERE[a.entity];
  const requiredMissing = required.filter((f) => mapping[f] === null || mapping[f] === undefined);
  const out: Analysis = { entity: a.entity, columns: headers, mapping, requiredMissing, rows: [] };
  if (requiredMissing.length) return out;
  const first = a.hasHeader ? 2 : 1;
  const t = today();
  data.forEach((cells, i) => {
    const raw: Record<string, string> = {};
    for (const [f, idx] of Object.entries(mapping)) if (idx !== null && idx !== undefined) raw[f] = cells[idx] ?? "";
    const check = validateRow(a.entity, raw, t, required);
    const errors = check.errors.map((e) => err(e.code, e.field));
    out.rows.push({ row: first + i, status: errors.length ? "error" : "ok", values: check.values, errors, duplicate: null, refs: {}, dup: null });
  });
  resolveReferences(out);
  const existing = existingKeys(a.entity);
  const found = findDuplicates(a.entity, out.rows.map((r) => (r.status === "error" ? null : r.values)), existing);
  out.rows.forEach((r, i) => {
    const d = found[i];
    if (!d) return;
    r.status = "duplicate";
    r.dup = d;
    r.duplicate = { kind: d.kind, ofRow: d.of === null ? null : (out.rows[d.of] as Row).row };
  });
  if (a.entity === "students") countSeats(out, a.duplicatesCreate);
  return out;
}

function resolveReferences(a: Analysis): void {
  if (a.entity === "students") {
    const groups = new Map(read<Group>(GROUPS).map((g) => [g.name.toLowerCase(), g]));
    for (const r of a.rows) {
      const name = String(r.values.group ?? "").trim();
      if (r.status === "error" || !name) continue;
      const g = groups.get(name.toLowerCase());
      if (!g) r.errors.push(err("unknown_group", "group"));
      else if (g.status === "finished" || g.status === "cancelled") r.errors.push(err("group_closed", "group"));
      else r.refs.groupId = g.id;
    }
  } else if (a.entity === "groups") {
    const byName = new Map<string, string[]>();
    for (const t of read<Teacher>(TEACHERS)) byName.set(t.fullName.toLowerCase(), [...(byName.get(t.fullName.toLowerCase()) ?? []), t.id]);
    for (const r of a.rows) {
      const name = String(r.values.teacher ?? "").toLowerCase();
      if (r.status === "error" || !name) continue;
      const found = byName.get(name) ?? [];
      if (found.length === 0) r.errors.push(err("unknown_teacher", "teacher"));
      else if (found.length > 1) r.errors.push(err("ambiguous_teacher", "teacher"));
      else r.refs.teacherId = found[0] as string;
    }
  }
  for (const r of a.rows) if (r.errors.length) r.status = "error";
}

function existingKeys(entity: ImportEntity): Set<string> {
  const keys = new Set<string>();
  if (entity === "students") {
    for (const s of read<StudentRow>(STUDENTS)) {
      const vals: Vals = { full_name: s.fullName };
      const p = s.phone ? normalizePhone(String(s.phone)) : null;
      if (p) vals.phone = p;
      for (const k of duplicateKeys("students", vals)) keys.add(k);
    }
  } else if (entity === "groups") {
    for (const g of read<Group>(GROUPS)) for (const k of duplicateKeys("groups", { name: g.name })) keys.add(k);
  } else {
    for (const l of read<Lead>(LEADS)) {
      const vals: Vals = { full_name: l.fullName };
      const p = l.phone ? normalizePhone(String(l.phone)) : null;
      if (p) vals.phone = p;
      for (const k of duplicateKeys("leads", vals)) keys.add(k);
    }
  }
  return keys;
}

/** Rows that will be written take seats in file order; a row that finds no seat is an error of its own. */
function countSeats(a: Analysis, duplicatesCreate: boolean): void {
  const groups = new Map(read<Group>(GROUPS).map((g) => [g.id, g]));
  const enrollments = read<Enrollment>(ENROLLMENTS);
  const waiting = readIfPresent<WaitlistRow>(WAITLIST);
  const state = new Map<string, { occupied: number; waiting: number; capacity: number | null }>();
  for (const r of a.rows) {
    const gid = r.refs.groupId;
    const writable = r.status === "ok" || (r.status === "duplicate" && duplicatesCreate);
    if (!gid || !writable) continue;
    if (!state.has(gid)) {
      const cap = (groups.get(gid) as Group).capacity;
      state.set(gid, {
        occupied: enrollments.filter((e) => e.groupId === gid && (e.status === "trial" || e.status === "active")).length,
        waiting: waiting.filter((w) => w.groupId === gid && w.status === "waiting").length,
        capacity: Number.isInteger(cap) && (cap as number) > 0 ? (cap as number) : null,
      });
    }
    const st = state.get(gid) as { occupied: number; waiting: number; capacity: number | null };
    if (!directEnrollAllowed({ capacity: st.capacity, occupied: st.occupied, waiting: st.waiting, ignoreWaitlist: false })) {
      r.errors.push(err(freeSeats(st.capacity, st.occupied) === 0 ? "group_full" : "seats_reserved", "group"));
      r.status = "error";
      continue;
    }
    st.occupied += 1;
  }
}

const count = (a: Analysis, status: string): number => a.rows.filter((r) => r.status === status).length;

export function importPreview(input: { entity: ImportEntity; text: string; hasHeader?: boolean; mapping?: Record<string, number | null> }): ImportPreview {
  const a = analyse({ entity: input.entity, text: input.text, hasHeader: input.hasHeader !== false, mapping: input.mapping, duplicatesCreate: false });
  return {
    entity: a.entity,
    columns: a.columns,
    mapping: a.mapping,
    fields: FIELDS[a.entity],
    required: REQUIRED_HERE[a.entity],
    requiredMissing: a.requiredMissing,
    summary: { total: a.rows.length, ok: count(a, "ok"), errors: count(a, "error"), duplicates: count(a, "duplicate") },
    rows: a.rows.slice(0, 300).map(({ row, status, values, errors, duplicate }) => ({ row, status, values, errors, duplicate })),
    truncated: a.rows.length > 300,
  };
}

export interface ImportResult {
  entity: ImportEntity;
  created: Record<string, number>;
  skippedErrors: number;
  skippedDuplicates: number;
}

export function importCommit(input: { entity: ImportEntity; text: string; hasHeader?: boolean; mapping?: Record<string, number | null>; onError?: "skip" | "abort"; duplicates?: "skip" | "create" }): ImportResult {
  return withLock(() => {
    const dupCreate = input.duplicates === "create";
    const a = analyse({ entity: input.entity, text: input.text, hasHeader: input.hasHeader !== false, mapping: input.mapping, duplicatesCreate: dupCreate });
    if (a.requiredMissing.length) throw new Error(`Majburiy ustunlar tanlanmagan: ${a.requiredMissing.join(", ")}`);
    const bad = a.rows.filter((r) => r.status === "error");
    if (input.onError === "abort" && bad.length) throw new Error(`Faylda xatoli qatorlar bor (${bad.length} ta, birinchisi: ${(bad[0] as Row).row}-qator). Hech narsa yozilmadi.`);
    const writable = a.rows.filter((r) => r.status === "ok" || (r.status === "duplicate" && dupCreate));
    const created = write(a, writable);
    return { entity: a.entity, created, skippedErrors: bad.length, skippedDuplicates: dupCreate ? 0 : count(a, "duplicate") };
  });
}

function write(a: Analysis, rows: Row[]): Record<string, number> {
  if (rows.length === 0) return {};
  const t = today();
  const added: { remove: () => void }[] = [];
  const created: Record<string, number> = {};
  const rollback = (): void => {
    for (const x of added.reverse()) {
      try {
        x.remove();
      } catch {
        /* best effort: report the original failure */
      }
    }
  };
  try {
    if (a.entity === "students") {
      const students = read<StudentRow>(STUDENTS);
      const sids = nextIds("S", students.map((s) => s.id), rows.length);
      const enrolls = rows.filter((r) => r.refs.groupId);
      const eids = nextIds("E", read<Enrollment>(ENROLLMENTS).map((e) => e.id), enrolls.length);
      const studentRows = rows.map((r, i) => {
        const v = r.values;
        const note = [v.notes, v.birth_date ? `Tug'ilgan sana: ${v.birth_date}` : "", v.guardian_phone ? `Vasiy telefoni: ${v.guardian_phone}` : ""].filter(Boolean).join("; ");
        return { id: sids[i] as string, fullName: String(v.full_name), status: "active", phone: String(v.phone ?? ""), guardianName: String(v.guardian_name ?? ""), guardianChatId: "", consentNotify: false, note };
      });
      append(STUDENTS, studentRows);
      added.push({ remove: () => replaceWhere<StudentRow>(STUDENTS, (s) => sids.includes(s.id), []) });
      created.students = studentRows.length;
      if (enrolls.length) {
        const enrollmentRows = enrolls.map((r, i) => ({ id: eids[i] as string, studentId: sids[rows.indexOf(r)] as string, groupId: r.refs.groupId as string, startedOn: t, endedOn: "", discountPercent: 0, status: "active" }));
        append(ENROLLMENTS, enrollmentRows);
        added.push({ remove: () => replaceWhere<Enrollment>(ENROLLMENTS, (e) => eids.includes(e.id), []) });
        created.enrollments = enrollmentRows.length;
      }
    } else if (a.entity === "groups") {
      const ids = nextIds("G", read<Group>(GROUPS).map((g) => g.id), rows.length);
      append(GROUPS, rows.map((r, i) => ({ id: ids[i] as string, name: String(r.values.name), teacherId: r.refs.teacherId ?? "", monthlyFee: Number(r.values.monthly_fee), capacity: r.values.capacity === undefined ? "" : Number(r.values.capacity), schedule: "", status: "planned", billingMode: "monthly" })));
      added.push({ remove: () => replaceWhere<Group>(GROUPS, (g) => ids.includes(g.id), []) });
      created.groups = rows.length;
    } else {
      const ids = nextIds("L", read<Lead>(LEADS).map((l) => l.id), rows.length);
      append(LEADS, rows.map((r, i) => ({ id: ids[i] as string, fullName: String(r.values.full_name), phone: String(r.values.phone ?? ""), source: String(r.values.source ?? ""), stage: "new", nextFollowUpOn: "", note: String(r.values.note ?? ""), createdOn: t, studentId: "" })));
      added.push({ remove: () => replaceWhere<Lead>(LEADS, (l) => ids.includes(l.id), []) });
      created.leads = rows.length;
    }
  } catch (e) {
    rollback();
    throw new Error(`Yozishda xato, bu import yozganlari qaytarib olindi: ${e instanceof Error ? e.message : String(e)}`);
  }
  return created;
}

export const menu = {
  open: (): void => guard("Import", () => SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutputFromFile("Import").setWidth(900).setHeight(640), "Import")),
};
