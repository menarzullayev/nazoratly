/**
 * Minimal in-memory stand-in for the Apps Script runtime (SpreadsheetApp, Utilities, UrlFetchApp, ...), enough to run
 * the REAL adapter code end to end. Cell storage, validation of ranges and the Telegram HTTP boundary are real logic;
 * purely cosmetic calls (colours, widths, conditional formats) are accepted and ignored.
 */
type Cell = unknown;
declare const crypto: { randomUUID(): string };
type SheetRef = string | { sheet: string };
const nameOf = (r: SheetRef): string => (typeof r === "string" ? r : r.sheet);

function chain<T extends object>(target: T): T {
  // Any method that is not implemented returns the same object so formatting chains keep working.
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop in t) return Reflect.get(t, prop, receiver);
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return () => receiver;
    },
  });
}

class FakeSheet {
  data: Cell[][] = [];
  maxRows = 1000;
  constructor(public name: string) {}
  private ensure(r: number, c: number) {
    while (this.data.length < r) this.data.push([]);
    for (let i = 0; i < r; i++) while (this.data[i]!.length < c) this.data[i]!.push("");
  }
  getLastRow() {
    let last = 0;
    this.data.forEach((row, i) => { if (row.some((v) => v !== "" && v != null)) last = i + 1; });
    return last;
  }
  getLastColumn() {
    return Math.max(1, ...this.data.map((r) => { let l = 0; r.forEach((v, i) => { if (v !== "" && v != null) l = i + 1; }); return l; }));
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_after: number, n: number) { this.maxRows += n; }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), this.getLastColumn()); }
  getRange(rr: number | string, cc = 1, nr = 1, nc = 1) {
    const sheet = this;
    let r: number;
    let c: number;
    if (typeof rr === "string") {
      const m = /^([A-Z]+)(\d+)$/.exec(rr);
      if (!m) throw new Error(`unsupported A1 range ${rr}`);
      c = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      r = Number(m[2]);
    } else {
      r = rr;
      c = cc;
    }
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${r},${c},${nr},${nc}`);
    const range: object = chain({
      getValues: () => { sheet.ensure(r + nr - 1, c + nc - 1); return Array.from({ length: nr }, (_, i) => sheet.data[r - 1 + i]!.slice(c - 1, c - 1 + nc)); },
      getValue: () => { sheet.ensure(r, c); return sheet.data[r - 1]![c - 1]; },
      setValues: (v: Cell[][]) => {
        if (v.length !== nr || v.some((row) => row.length !== nc)) throw new Error(`setValues shape ${v.length}x${v[0]?.length} != ${nr}x${nc}`);
        sheet.ensure(r + nr - 1, c + nc - 1);
        v.forEach((row, i) => row.forEach((x, j) => { sheet.data[r - 1 + i]![c - 1 + j] = x; }));
        return range;
      },
      setValue: (x: Cell) => { sheet.ensure(r, c); sheet.data[r - 1]![c - 1] = x; return range; },
      clearContent: () => { sheet.ensure(r + nr - 1, c + nc - 1); for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sheet.data[r - 1 + i]![c - 1 + j] = ""; return range; },
      protect: () => chain({ setDescription: () => chain({}), setWarningOnly: () => undefined }),
    });
    return range as { getValue(): unknown; setValue(x: unknown): unknown; getValues(): unknown[][] };
  }
  clear() { this.data = []; }
  getConditionalFormatRules() { return []; }
  getCharts() { return []; }
  newChart() { return chain({ build: () => ({}) }); }
  insertChart() {}
  removeChart() {}
  activate() {}
  setColumnWidths() {}
}

export interface Harness {
  sheets: Map<string, FakeSheet>;
  alerts: { title: string; message: string }[];
  prompts: string[];
  fetches: { url: string; body: Record<string, unknown> }[];
  telegram: { handler: (method: string, body: Record<string, unknown>) => { status: number; body: unknown } };
  props: Map<string, string>;
  webUrl: string | null;
  sheet(ref: SheetRef): FakeSheet;
  rows(ref: SheetRef): Cell[][];
}

export function installHarness(): Harness {
  const sheets = new Map<string, FakeSheet>();
  const h: Harness = {
    sheets,
    alerts: [],
    prompts: [],
    fetches: [],
    telegram: { handler: () => ({ status: 200, body: { ok: true, result: {} } }) },
    props: new Map(),
    webUrl: null,
    sheet: (ref) => sheets.get(nameOf(ref))!,
    rows: (ref) => sheets.get(nameOf(ref))!.data.slice(0, sheets.get(nameOf(ref))!.getLastRow()),
  };
  const ss = {
    getSpreadsheetTimeZone: () => "Asia/Tashkent",
    getSheetByName: (n: string) => sheets.get(n) ?? null,
    insertSheet: (n: string) => { const s = chain(new FakeSheet(n)); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()],
    deleteSheet: (s: FakeSheet) => { sheets.delete(s.name); },
    toast: () => {},
  };
  const ui = {
    ButtonSet: { OK: "OK", OK_CANCEL: "OK_CANCEL", YES_NO: "YES_NO" },
    Button: { OK: "OK", YES: "YES", CANCEL: "CANCEL" },
    alert: (title: string, message: string) => { h.alerts.push({ title, message }); return "YES"; },
    prompt: () => ({ getSelectedButton: () => "OK", getResponseText: () => h.prompts.shift() ?? "" }),
  };
  const g = globalThis as Record<string, unknown>;
  g.SpreadsheetApp = {
    getActive: () => ss,
    getUi: () => ui,
    newDataValidation: () => chain({ build: () => ({}) }),
    newConditionalFormatRule: () => chain({ build: () => ({}) }),
  };
  g.Utilities = {
    formatDate: (d: Date, tz: string, fmt: string) => {
      if (fmt !== "yyyy-MM-dd") throw new Error(`unsupported format ${fmt}`);
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    },
    getUuid: () => crypto.randomUUID(),
    sleep: () => {},
  };
  g.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  g.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k: string) => h.props.get(k) ?? null,
      setProperty: (k: string, v: string) => { h.props.set(k, v); },
      deleteProperty: (k: string) => { h.props.delete(k); },
    }),
  };
  g.UrlFetchApp = {
    fetch: (url: string, opts: { payload?: string }) => {
      const method = url.split("/").pop()!;
      const body = JSON.parse(opts.payload ?? "{}") as Record<string, unknown>;
      h.fetches.push({ url, body: { _method: method, ...body } });
      const r = h.telegram.handler(method, body);
      return { getResponseCode: () => r.status, getContentText: () => JSON.stringify(r.body) };
    },
  };
  g.ContentService = { createTextOutput: (s: string) => ({ getContent: () => s }) };
  g.ScriptApp = { getService: () => ({ getUrl: () => h.webUrl }) };
  return h;
}
