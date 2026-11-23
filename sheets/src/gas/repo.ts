/** Thin Apps Script adapter: reads/writes tables as domain objects (all I/O is batched). */
import { decodeRows, encodeRow, type Cell } from "./codec";
import type { TableDef } from "./schema";

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

export function read<T>(def: TableDef): T[] {
  const sh = sheetOf(def);
  if (sh.getLastRow() < 1) return [];
  return decodeRows<T>(def, sh.getDataRange().getValues() as Cell[][], fmtDate);
}

function header(sh: GoogleAppsScript.Spreadsheet.Sheet): Cell[] {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] as Cell[];
}

export function append(def: TableDef, rows: readonly object[]): void {
  if (rows.length === 0) return;
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
      const cell = encodeRow({ ...def, cols: [col] }, [col.header], { [key]: value }, toDate)[0];
      sh.getRange(r + 1, ci + 1).setValue(cell as never);
    }
    return true;
  }
  return false;
}

/** Replaces every row matching `predicate` (compared on decoded rows) with `rows`; used for idempotent regeneration. */
export function replaceWhere<T>(def: TableDef, predicate: (row: T) => boolean, rows: readonly object[]): void {
  const sh = sheetOf(def);
  const all = read<T>(def);
  const keep = all.filter((r) => !predicate(r));
  const head = header(sh);
  const out = [...keep, ...(rows as unknown as T[])].map((r) => encodeRow(def, head, r as Record<string, unknown>, toDate));
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, head.length).setValues(out as unknown as unknown[][]);
}
