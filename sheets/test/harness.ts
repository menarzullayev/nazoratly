import { clearReservedIds } from "../src/domain/ids";
import { resetScope } from "../src/gas/scope";
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

/** Call counters of the sheet boundary (quota guard): reset by installHarness(). */
export const stats = { reads: 0, writes: 0, rangeCalls: 0, fetches: 0, driveFiles: 0 };

const OWNER = "owner@example.com";
type Who = string | { getEmail(): string };
const emailOf = (w: Who): string => (typeof w === "string" ? w : w.getEmail());
/** A sheet protection: the spreadsheet starts with an owner and a staff editor; the owner can never be removed. */
class FakeProtection {
  description = "";
  editors = new Set<string>([OWNER, "staff@example.com"]);
  domainEdit = true;
  constructor(private owner: { protections: FakeProtection[] }) {}
  setDescription(d: string) { this.description = d; return this; }
  getDescription() { return this.description; }
  getEditors() { return [...this.editors].map((e) => ({ getEmail: () => e })); }
  removeEditors(list: Who[]) { for (const w of list) if (emailOf(w) !== OWNER) this.editors.delete(emailOf(w)); return this; }
  addEditor(w: Who) { this.editors.add(emailOf(w)); return this; }
  addEditors(list: string[]) { for (const e of list) this.editors.add(e); return this; }
  canDomainEdit() { return this.domainEdit; }
  setDomainEdit(v: boolean) { this.domainEdit = v; return this; }
  remove() { this.owner.protections = this.owner.protections.filter((p) => p !== this); }
}

class FakeSheet {
  data: Cell[][] = [];
  protections: FakeProtection[] = [];
  /** descriptions of range protections (the header row of every table is protected warning-only) */
  rangeProtections: { description: string; warningOnly: boolean; remove(): void; getDescription(): string }[] = [];
  protect() { const p = new FakeProtection(this); this.protections.push(p); return p; }
  getProtections(type: unknown) { return type === "RANGE" ? [...this.rangeProtections] : [...this.protections]; }
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
  getSheetId() { return [...this.name].reduce((n, c) => n + c.charCodeAt(0), 1000); }
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
    stats.rangeCalls++;
    const range: object = chain({
      getValues: () => { stats.reads++; sheet.ensure(r + nr - 1, c + nc - 1); return Array.from({ length: nr }, (_, i) => sheet.data[r - 1 + i]!.slice(c - 1, c - 1 + nc)); },
      getValue: () => { stats.reads++; sheet.ensure(r, c); return sheet.data[r - 1]![c - 1]; },
      setValues: (v: Cell[][]) => {
        stats.writes++;
        if (v.length !== nr || v.some((row) => row.length !== nc)) throw new Error(`setValues shape ${v.length}x${v[0]?.length} != ${nr}x${nc}`);
        sheet.ensure(r + nr - 1, c + nc - 1);
        v.forEach((row, i) => row.forEach((x, j) => { sheet.data[r - 1 + i]![c - 1 + j] = x; }));
        return range;
      },
      setValue: (x: Cell) => { stats.writes++; sheet.ensure(r, c); sheet.data[r - 1]![c - 1] = x; return range; },
      clearContent: () => { stats.writes++; sheet.ensure(r + nr - 1, c + nc - 1); for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sheet.data[r - 1 + i]![c - 1 + j] = ""; return range; },
      protect: () => {
        const rec = { description: "", warningOnly: false, getDescription: () => rec.description, remove: () => { sheet.rangeProtections = sheet.rangeProtections.filter((x) => x !== rec); } };
        sheet.rangeProtections.push(rec);
        const p: object = chain({ setDescription: (d: string) => { rec.description = d; return p; }, setWarningOnly: (v: boolean) => { rec.warningOnly = v; return p; } });
        return p;
      },
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

interface Blob { content: string; type: string; name: string; getName(): string; getBytes(): number[]; getAs(t: string): Blob; setName(n: string): Blob; getBlob(): Blob }
function makeBlob(content: string, type: string, name: string): Blob {
  const b: Blob = {
    content, type, name,
    getName: () => b.name,
    getBytes: () => [...content].map((c) => c.charCodeAt(0) & 255),
    getAs: (t: string) => makeBlob(t === "application/pdf" ? `%PDF-1.4 fake ${content}` : content, t, name),
    setName: (n: string) => { b.name = n; return b; },
    getBlob: () => b,
  };
  return b;
}

export interface Harness {
  sheets: Map<string, FakeSheet>;
  alerts: { title: string; message: string }[];
  prompts: string[];
  /** answers for the next ui.alert() calls (default "YES"); use "NO" to decline a confirmation */
  answers: string[];
  fetches: { url: string; body: Record<string, unknown> }[];
  triggers: { fn: string; everyHours: number }[];
  telegram: { handler: (method: string, body: Record<string, unknown>) => { status: number; body: unknown } };
  props: Map<string, string>;
  webUrl: string | null;
  /** files created in Drive: id -> blob content */
  drive: Map<string, { name: string; folder: string; content: string }>;
  sheet(ref: SheetRef): FakeSheet;
  rows(ref: SheetRef): Cell[][];
  /** the person running the script (Session.getActiveUser): change it to act as branch staff */
  user: string;
  /** per-user properties (the chosen view branch) */
  userProps: Map<string, string>;
  /** protections of a sheet: description and the editors that may write */
  protections(ref: SheetRef): { description: string; editors: string[] }[];
  /** warning-only range protections of a sheet (the header row) */
  rangeProtections(ref: SheetRef): { description: string; warningOnly: boolean }[];
}

export function installHarness(): Harness {
  stats.reads = stats.writes = stats.rangeCalls = stats.fetches = stats.driveFiles = 0;
  resetScope(); // module state of the script (branch scope, reserved ids) must not leak between tests
  clearReservedIds();
  const sheets = new Map<string, FakeSheet>();
  const h: Harness = {
    sheets,
    alerts: [],
    prompts: [],
    answers: [],
    fetches: [],
    triggers: [],
    telegram: { handler: () => ({ status: 200, body: { ok: true, result: {} } }) },
    props: new Map(),
    user: OWNER,
    userProps: new Map(),
    webUrl: null,
    drive: new Map(),
    sheet: (ref) => sheets.get(nameOf(ref))!,
    rows: (ref) => sheets.get(nameOf(ref))!.data.slice(0, sheets.get(nameOf(ref))!.getLastRow()),
    rangeProtections: (ref) => sheets.get(nameOf(ref))!.rangeProtections.map((p) => ({ description: p.description, warningOnly: p.warningOnly })),
    protections: (ref) => sheets.get(nameOf(ref))!.protections.map((p) => ({ description: p.description, editors: [...p.editors] })),
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
    Button: { OK: "OK", YES: "YES", NO: "NO", CANCEL: "CANCEL" },
    alert: (title: string, message: string) => { h.alerts.push({ title, message }); return h.answers.shift() ?? "YES"; },
    prompt: () => ({ getSelectedButton: () => "OK", getResponseText: () => h.prompts.shift() ?? "" }),
  };
  const g = globalThis as Record<string, unknown>;
  g.SpreadsheetApp = {
    getActive: () => ss,
    getUi: () => ui,
    ProtectionType: { SHEET: "SHEET", RANGE: "RANGE" },
    newDataValidation: () => chain({ build: () => ({}) }),
    newConditionalFormatRule: () => chain({ build: () => ({}) }),
  };
  g.Utilities = {
    formatDate: (d: Date, tz: string, fmt: string) => {
      if (fmt === "yyyy-MM-dd'T'HH:mm") {
        const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
        return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
      }
      if (fmt !== "yyyy-MM-dd") throw new Error(`unsupported format ${fmt}`);
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    },
    getUuid: () => crypto.randomUUID(),
    sleep: () => {},
    newBlob: (data: string, type: string, name: string) => makeBlob(data, type, name),
  };
  g.Session = { getEffectiveUser: () => ({ getEmail: () => OWNER }), getActiveUser: () => ({ getEmail: () => h.user }) };
  g.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  g.PropertiesService = {
    getUserProperties: () => ({
      getProperty: (k: string) => h.userProps.get(k) ?? null,
      setProperty: (k: string, v: string) => { h.userProps.set(k, v); },
      deleteProperty: (k: string) => { h.userProps.delete(k); },
    }),
    getScriptProperties: () => ({
      getProperty: (k: string) => h.props.get(k) ?? null,
      setProperty: (k: string, v: string) => { h.props.set(k, v); },
      deleteProperty: (k: string) => { h.props.delete(k); },
    }),
  };
  g.UrlFetchApp = {
    fetch: (url: string, opts: { payload?: string | Record<string, unknown> }) => {
      stats.fetches++;
      const method = url.split("/").pop()!;
      const raw = opts.payload ?? "{}";
      // an object payload is a multipart upload: blobs are reported by name and size
      const body = (typeof raw === "string"
        ? JSON.parse(raw)
        : Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v && typeof v === "object" && "getBytes" in v ? { _blob: (v as Blob).getName(), size: (v as Blob).content.length, content: (v as Blob).content } : v]))) as Record<string, unknown>;
      h.fetches.push({ url, body: { _method: method, ...body } });
      const r = h.telegram.handler(method, body);
      return { getResponseCode: () => r.status, getContentText: () => JSON.stringify(r.body) };
    },
  };
  const folders = new Map<string, { name: string }>();
  g.DriveApp = {
    getFoldersByName: (n: string) => { const f = folders.get(n); const items = f ? [f] : []; return { hasNext: () => items.length > 0, next: () => items.shift() }; },
    createFolder: (n: string) => { const f = { name: n, createFile: (b: Blob) => {
      stats.driveFiles++;
      const id = `FILE${h.drive.size + 1}`;
      h.drive.set(id, { name: b.getName(), folder: n, content: b.content });
      return { getUrl: () => `https://drive.google.com/file/d/${id}/view?usp=drivesdk` };
    } }; folders.set(n, f); return f; },
    getFileById: (id: string) => { const f = h.drive.get(id); if (!f) throw new Error("file not found"); return { getBlob: () => makeBlob(f.content, "application/pdf", f.name) }; },
  };
  g.ContentService = { createTextOutput: (s: string) => ({ getContent: () => s }) };
  g.ScriptApp = {
    getService: () => ({ getUrl: () => h.webUrl }),
    getProjectTriggers: () => h.triggers.map((t) => ({ getHandlerFunction: () => t.fn, id: t })),
    deleteTrigger: (t: { id: { fn: string } }) => {
      h.triggers = h.triggers.filter((x) => x !== t.id);
    },
    newTrigger: (fn: string) => ({ timeBased: () => ({ everyHours: (n: number) => ({ create: () => h.triggers.push({ fn, everyHours: n }) }) }) }),
  };
  return h;
}
