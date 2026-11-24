/** Pure (no Google APIs) conversion between sheet cell values and domain objects, so it is unit-tested. */
import { isIsoDate } from "../domain/dates";
import type { ColDef, TableDef } from "./schema";

export type Cell = string | number | boolean | Date | null | undefined;
export type Row = Record<string, string | number | boolean>;

const YES = new Set(["ha", "yes", "true", "1", "+"]);

export function decodeCell(col: ColDef, cell: Cell, fmtDate: (d: Date) => string): string | number | boolean {
  switch (col.kind) {
    case "date": {
      if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? "" : fmtDate(cell);
      const s = String(cell ?? "").trim();
      return isIsoDate(s) ? s : "";
    }
    case "int": {
      if (cell === "" || cell == null) return 0;
      const n = typeof cell === "number" ? cell : Number(String(cell).replace(/[\s,]/g, ""));
      return Number.isFinite(n) ? Math.round(n) : 0;
    }
    case "num": {
      if (cell === "" || cell == null) return 0;
      const n = typeof cell === "number" ? cell : Number(String(cell).replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    }
    case "bool":
      return typeof cell === "boolean" ? cell : YES.has(String(cell ?? "").trim().toLowerCase());
    case "enum": {
      const s = String(cell ?? "").trim().toLowerCase();
      const entries = Object.entries(col.labels ?? {});
      for (const [value, label] of entries) if (label.toLowerCase() === s || value.toLowerCase() === s) return value;
      return entries[0]?.[0] ?? "";
    }
    default:
      return cell == null ? "" : String(cell).trim();
  }
}

export function encodeCell(col: ColDef, value: unknown, toDate?: (iso: string) => Date): string | number | boolean | Date {
  switch (col.kind) {
    case "date":
      return value && toDate && isIsoDate(String(value)) ? toDate(String(value)) : String(value ?? "");
    case "bool":
      return value === true ? "Ha" : "Yo'q";
    case "enum":
      return col.labels?.[String(value)] ?? String(value ?? "");
    case "int":
    case "num":
      return typeof value === "number" ? value : Number(value ?? 0) || 0;
    default:
      return value == null ? "" : String(value);
  }
}

/** Rows keyed by header text, so users may reorder/insert columns without breaking the script. */
export function decodeRows<T>(def: TableDef, values: Cell[][], fmtDate: (d: Date) => string): T[] {
  const [head, ...body] = values;
  if (!head) return [];
  const index = new Map<string, number>();
  head.forEach((h, i) => index.set(String(h).trim(), i));
  const missing = def.cols.filter((c) => !c.optional && !index.has(c.header)).map((c) => c.header);
  if (missing.length) throw new Error(`"${def.sheet}" varag'ida ustun topilmadi: ${missing.join(", ")}`);
  const out: T[] = [];
  for (const row of body) {
    if (row.every((c) => c === "" || c == null)) continue;
    const obj: Row = {};
    for (const col of def.cols) obj[col.key] = decodeCell(col, row[index.get(col.header) ?? -1], fmtDate);
    out.push(obj as unknown as T);
  }
  return out;
}

export function encodeRow(def: TableDef, header: Cell[], obj: Record<string, unknown>, toDate?: (iso: string) => Date): Cell[] {
  const byHeader = new Map(def.cols.map((c) => [c.header, c]));
  return header.map((h) => {
    const col = byHeader.get(String(h).trim());
    return col ? encodeCell(col, obj[col.key], toDate) : "";
  });
}
