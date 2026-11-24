import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlers } from "../../src/Code";
import { ALL_TABLES, LEDGER_TABLES, SETTINGS_SHEET } from "../../src/gas/schema";
import { setupWorkbook } from "../../src/gas/setup";
import { installHarness, type Harness } from "../harness";

const ROOT = join(__dirname, "..", "..");
const codeTs = readFileSync(join(ROOT, "src", "Code.ts"), "utf8");
const uiDir = join(ROOT, "src", "ui");
const htmlFiles = readdirSync(uiDir).filter((f) => f.endsWith(".html"));

describe("entry points", () => {
  it("every menu item (addItem) points to a registered global handler", () => {
    const items = [...codeTs.matchAll(/\.addItem\(\s*"([^"]+)"\s*,\s*"(\w+)"\s*\)/g)].map((m) => ({ label: m[1]!, fn: m[2]! }));
    expect(items.length).toBeGreaterThan(100);
    const broken = items.filter((i) => typeof handlers[i.fn] !== "function").map((i) => `${i.label} -> ${i.fn}`);
    expect(broken).toEqual([]);
    // a handler wired to two labels is fine, but the same label twice in one menu is a copy-paste slip
    const labels = items.map((i) => i.label);
    expect(labels.filter((l, i) => labels.indexOf(l) !== i)).toEqual([]);
  });

  it("every handler is declared as g.<name> in Code.ts (build.mjs turns those into top-level functions)", () => {
    const declared = new Set([...codeTs.matchAll(/^g\.(\w+) =/gm)].map((m) => m[1]!));
    expect([...declared].sort()).toEqual(Object.keys(handlers).sort());
  });

  it("every menu handler runs as a function (no undefined export slipped into the table)", () => {
    for (const [name, fn] of Object.entries(handlers)) expect(typeof fn, name).toBe("function");
  });

  it("every google.script.run target used by a sidebar exists as a handler", () => {
    const targets = new Set<string>();
    for (const f of htmlFiles) for (const m of readFileSync(join(uiDir, f), "utf8").matchAll(/\brun\("(\w+)"/g)) targets.add(m[1]!);
    expect(targets.size).toBeGreaterThan(8);
    expect([...targets].filter((t) => typeof handlers[t] !== "function")).toEqual([]);
  });

  it("every HTML file opened with HtmlService exists, has the style placeholder and is built by build.mjs", () => {
    const opened = new Set<string>();
    for (const m of codeTs.matchAll(/html\("(\w+)"/g)) opened.add(m[1]!);
    const importerSrc = readFileSync(join(ROOT, "src", "gas", "importer.ts"), "utf8");
    for (const m of importerSrc.matchAll(/createHtmlOutputFromFile\("(\w+)"/g)) opened.add(m[1]!);
    expect(opened.size).toBeGreaterThanOrEqual(5);
    const build = readFileSync(join(ROOT, "build.mjs"), "utf8");
    const built = new Set([...(/for \(const f of \[([^\]]+)\]/.exec(build)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]!));
    for (const f of opened) {
      expect(existsSync(join(uiDir, `${f}.html`)), `${f}.html exists`).toBe(true);
      expect(readFileSync(join(uiDir, `${f}.html`), "utf8")).toContain("/*STYLE*/");
      expect(built.has(f), `${f} is built by build.mjs`).toBe(true);
    }
    // and nothing is built that nothing opens
    expect([...built].filter((b) => !opened.has(b))).toEqual([]);
  });

  it("the entry points Apps Script itself calls exist", () => {
    for (const fn of ["onOpen", "doGet", "doPost", "teacherTick"]) expect(typeof handlers[fn], fn).toBe("function");
  });
});

describe("setup", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
    h = installHarness();
  });

  const snapshot = (): string =>
    JSON.stringify({
      sheets: [...h.sheets.keys()].sort().map((n) => ({ n, data: h.sheet(n).data, prot: h.protections(n), range: h.rangeProtections(n) })),
      props: [...h.props.entries()].sort(),
      userProps: [...h.userProps.entries()].sort(),
      triggers: h.triggers,
      fetches: h.fetches.length,
    });

  it("creates every table of ALL_TABLES with its header row, frozen header protection, and nothing twice", () => {
    expect(new Set(ALL_TABLES.map((t) => t.sheet)).size).toBe(ALL_TABLES.length); // no duplicate sheet name
    setupWorkbook();
    for (const t of ALL_TABLES) {
      expect(h.sheets.has(t.sheet), `${t.sheet} exists`).toBe(true);
      expect(h.rows(t.sheet)[0], `${t.sheet} header`).toEqual(t.cols.map((c) => c.header));
      expect(new Set(t.cols.map((c) => c.key)).size, `${t.sheet} column keys unique`).toBe(t.cols.length);
      expect(new Set(t.cols.map((c) => c.header)).size, `${t.sheet} headers unique`).toBe(t.cols.length);
      const prot = h.rangeProtections(t.sheet);
      expect(prot, `${t.sheet} header protection`).toEqual([{ description: "nazoratly: sarlavha qatori", warningOnly: true }]);
    }
    expect(h.sheets.has(SETTINGS_SHEET)).toBe(true);
  });

  it("the ledger tables get script-only sheet protection, no other table gets a sheet lock", () => {
    setupWorkbook();
    const ledger = new Set(LEDGER_TABLES.map((t) => t.sheet));
    for (const t of ALL_TABLES) {
      const p = h.protections(t.sheet);
      if (ledger.has(t.sheet)) {
        expect(p, t.sheet).toHaveLength(1);
        expect(p[0]!.editors).toEqual(["owner@example.com"]);
      } else {
        expect(p, t.sheet).toEqual([]);
      }
    }
  });

  it("running setup twice changes nothing: cells, protections, triggers, properties", () => {
    setupWorkbook();
    const once = snapshot();
    setupWorkbook();
    expect(snapshot()).toBe(once);
    setupWorkbook();
    expect(snapshot()).toBe(once);
  });

  it("setup does not erase existing data and keeps edited settings out of harm only for non-settings tables", () => {
    setupWorkbook();
    const students = h.sheet("O'quvchilar");
    students.data.push(["S0001", "Ali Valiyev"]);
    const before = JSON.stringify(students.data);
    setupWorkbook();
    expect(JSON.stringify(h.sheet("O'quvchilar").data)).toBe(before);
  });
});
