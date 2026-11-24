/** Thin Apps Script adapter: reads/writes tables as domain objects (all I/O is batched). */
import { reserveIds } from "../domain/ids";
import { rowVisible } from "../domain/branches";
import { decodeRows, encodeRow, type Cell } from "./codec";
import { ENROLLMENTS, GROUPS, STUDENTS, type TableDef } from "./schema";
import { currentScope, isMarked, stampOf } from "./scope";

const tz = (): string => SpreadsheetApp.getActive().getSpreadsheetTimeZone();

export const fmtDate = (d: Date): string => Utilities.formatDate(d, tz(), "yyyy-MM-dd");
export const toDate = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0); // noon: immune to DST/time-zone day shifts
};
export const today = (): string => fmtDate(new Date());

export function sheetOf(def: TableDef): GoogleAppsScript.Spreadsheet.Sheet {
  const sh = SpreadsheetApp.getActive().getSheetByName(def.sheet);
  if (!sh) throw new Error(`"${def.sheet}" varag'i yo'q. Menyudan: nazoratly > Boshlang'ich sozlash.`);
  return sh;
}

/** Every row of the tab, whatever the branch (for chains, id allocation and rewrites: never for what a person sees). */
export function readRaw<T>(def: TableDef): T[] {
  const sh = sheetOf(def);
  if (sh.getLastRow() < 1) return [];
  return decodeRows<T>(def, sh.getDataRange().getValues() as Cell[][], fmtDate);
}

/**
 * The rows the person may see: staff of a branch (or a center-wide person who picked a branch) get only that branch, the
 * Sheets analogue of the API's row-level security. A row with no branch mark belongs to the default branch. Ids of the
 * hidden rows stay reserved, so two branches never hand out the same S0007.
 */
export function read<T>(def: TableDef): T[] {
  const rows = readRaw<T>(def);
  if (!isMarked(def)) return rows;
  const info = currentScope();
  const out: T[] = [];
  const hidden: string[] = [];
  for (const r of rows) {
    const row = r as unknown as { branchId?: string; id?: string };
    if (!row.branchId) row.branchId = info.defaultId;
    if (rowVisible({ scope: info.scope, branch: row.branchId })) out.push(r);
    else if (typeof row.id === "string" && row.id) hidden.push(row.id);
  }
  if (hidden.length) reserveIds(hidden);
  return out;
}

/** Like `read`, but an absent sheet (workbook not yet set up for a newer feature) reads as empty. */
export function readIfPresent<T>(def: TableDef): T[] {
  return SpreadsheetApp.getActive().getSheetByName(def.sheet) ? read<T>(def) : [];
}

/** The branch of one row of a parent table (cached per call of `append`). */
function parentLookup(): (parent: TableDef, id: string) => string | null {
  const cache = new Map<string, Map<string, string>>();
  return (parent, id) => {
    let m = cache.get(parent.sheet);
    if (!m) {
      m = new Map();
      if (SpreadsheetApp.getActive().getSheetByName(parent.sheet)) {
        const info = currentScope();
        for (const r of readRaw<{ id?: string; branchId?: string }>(parent)) if (r.id) m.set(r.id, r.branchId || info.defaultId);
      }
      cache.set(parent.sheet, m);
    }
    return m.get(id) ?? null;
  };
}

/** Gives every new row its branch mark (explicit > session scope / parent row > the default branch). */
function stamped(def: TableDef, rows: readonly object[]): object[] {
  if (!isMarked(def)) return [...rows];
  const lookup = parentLookup();
  if (def === ENROLLMENTS) {
    // a live enrollment joins a student and a group of the SAME branch (a student who moves must leave the old branch's groups first)
    for (const r of rows as { studentId?: string; groupId?: string; status?: string }[]) {
      if (!["trial", "active", "frozen"].includes(String(r.status))) continue;
      const sb = lookup(STUDENTS, String(r.studentId ?? ""));
      const gb = lookup(GROUPS, String(r.groupId ?? ""));
      if (sb && gb && sb !== gb) throw new Error(`O'quvchi (${sb}) va guruh (${gb}) turli filiallarda: avval o'quvchini guruh filialiga ko'chiring (nazoratly > Filiallar > Filialga ko'chirish).`);
    }
  }
  return rows.map((r) => ({ ...(r as Record<string, unknown>), branchId: stampOf(def, r as Record<string, unknown>, lookup) }));
}

function header(sh: GoogleAppsScript.Spreadsheet.Sheet): Cell[] {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] as Cell[];
}

export function append(def: TableDef, input: readonly object[]): void {
  if (input.length === 0) return;
  const rows = stamped(def, input);
  const sh = sheetOf(def);
  const head = header(sh);
  const values = rows.map((r) => encodeRow(def, head, r as Record<string, unknown>, toDate));
  const first = Math.max(sh.getLastRow(), 1) + 1;
  if (first + values.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), first + values.length - 1 - sh.getMaxRows());
  sh.getRange(first, 1, values.length, head.length).setValues(values as unknown as unknown[][]);
}

/** Updates the given fields of the row whose key column equals `id`; returns false when not found. */
export function updateById(def: TableDef, keyCol: string, id: string, patch: Record<string, unknown>): boolean {
  const sh = sheetOf(def);
  const head = header(sh);
  const keyIdx = head.findIndex((h) => String(h).trim() === def.cols.find((c) => c.key === keyCol)!.header);
  const data = sh.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r]![keyIdx]).trim() !== id) continue;
    for (const [key, value] of Object.entries(patch)) {
      const col = def.cols.find((c) => c.key === key)!;
      const ci = head.findIndex((h) => String(h).trim() === col.header);
      if (ci < 0 && col.optional) continue; // a workbook set up before this column existed
      const cell = encodeRow({ ...def, cols: [col] }, [col.header], { [key]: value }, toDate)[0];
      sh.getRange(r + 1, ci + 1).setValue(cell as never);
    }
    return true;
  }
  return false;
}

/**
 * Updates many rows in one pass: ONE read of the tab and one write per touched column, whatever the number of rows
 * (updateById per row costs two sheet calls and a full-tab read EACH: 2000 students would be 6000 calls and hit Apps Script's
 * 6-minute limit). `patches` maps the key value to the fields to change. Only the touched columns are rewritten, with the
 * values read from the tab, so those columns must hold plain values (not formulas). Returns how many rows matched.
 */
export function updateMany(def: TableDef, keyCol: string, patches: ReadonlyMap<string, Record<string, unknown>>): number {
  if (patches.size === 0) return 0;
  const sh = sheetOf(def);
  const head = header(sh);
  const keyIdx = head.findIndex((h) => String(h).trim() === def.cols.find((c) => c.key === keyCol)!.header);
  const data = sh.getDataRange().getValues();
  const columns = new Map<number, Cell[]>(); // column index -> new values of rows 2..n
  let matched = 0;
  for (let r = 1; r < data.length; r++) {
    const patch = patches.get(String(data[r]![keyIdx]).trim());
    if (!patch) continue;
    matched++;
    for (const [key, value] of Object.entries(patch)) {
      const col = def.cols.find((c) => c.key === key)!;
      const ci = head.findIndex((h) => String(h).trim() === col.header);
      if (ci < 0) {
        if (col.optional) continue; // a workbook set up before this column existed
        throw new Error(`"${def.sheet}" varag'ida "${col.header}" ustuni yo'q. Menyudan: nazoratly > Boshlang'ich sozlash.`);
      }
      if (!columns.has(ci)) columns.set(ci, data.slice(1).map((row) => row[ci] as Cell));
      columns.get(ci)![r - 1] = encodeRow({ ...def, cols: [col] }, [col.header], { [key]: value }, toDate)[0] as Cell;
    }
  }
  for (const [ci, values] of columns) sh.getRange(2, ci + 1, values.length, 1).setValues(values.map((v) => [v]) as unknown as unknown[][]);
  return matched;
}

/** Replaces every row matching `predicate` (compared on decoded rows) with `rows`; used for idempotent regeneration. */
export function replaceWhere<T>(def: TableDef, predicate: (row: T) => boolean, rows: readonly object[]): void {
  const sh = sheetOf(def);
  const all = readRaw<T>(def); // the whole tab: rows of other branches must survive a rewrite
  const keep = all.filter((r) => !predicate(r));
  const head = header(sh);
  const fresh = stamped(def, rows);
  const out = [...keep, ...(fresh as unknown as T[])].map((r) => encodeRow(def, head, r as Record<string, unknown>, toDate));
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, head.length).setValues(out as unknown as unknown[][]);
}
