import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handlers } from "../../src/Code";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const tsFiles = walk(SRC).filter((f) => f.endsWith(".ts"));

/** Source without comments (a service named in a comment is not a use). Strings are kept: URLs are audited too. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
const code = new Map(tsFiles.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));

export const SC = {
  sheets: "https://www.googleapis.com/auth/spreadsheets",
  sheetsCurrent: "https://www.googleapis.com/auth/spreadsheets.currentonly",
  ui: "https://www.googleapis.com/auth/script.container.ui",
  fetch: "https://www.googleapis.com/auth/script.external_request",
  trigger: "https://www.googleapis.com/auth/script.scriptapp",
  drive: "https://www.googleapis.com/auth/drive",
  driveFile: "https://www.googleapis.com/auth/drive.file",
  email: "https://www.googleapis.com/auth/userinfo.email",
} as const;

/**
 * Which OAuth scope satisfies which Apps Script call (Google's documented authorization per method). Each entry is a list
 * of ALTERNATIVES (any one is enough); [] means the call needs no scope. Anything that is not here fails the audit, so a
 * new service or method cannot ship without a scope decision.
 */
const NEEDS: Record<string, Record<string, string[]>> = {
  SpreadsheetApp: {
    getActive: [SC.sheetsCurrent, SC.sheets],
    getActiveSheet: [SC.sheetsCurrent, SC.sheets],
    getActiveRange: [SC.sheetsCurrent, SC.sheets],
    getUi: [SC.ui],
    newDataValidation: [],
    newConditionalFormatRule: [],
    ProtectionType: [],
  },
  UrlFetchApp: { fetch: [SC.fetch] },
  // DriveApp: the manifest carries the narrowest scope that works for files this script itself creates.
  DriveApp: { getFoldersByName: [SC.driveFile, SC.drive], createFolder: [SC.driveFile, SC.drive], getFileById: [SC.driveFile, SC.drive] },
  ScriptApp: { getService: [], getProjectTriggers: [SC.trigger], newTrigger: [SC.trigger], deleteTrigger: [SC.trigger] },
  Session: { getActiveUser: [SC.email], getEffectiveUser: [SC.email] },
  HtmlService: { createHtmlOutputFromFile: [] },
  LockService: { getScriptLock: [], getDocumentLock: [] },
  PropertiesService: { getUserProperties: [], getScriptProperties: [] },
  Utilities: { getUuid: [], formatDate: [], newBlob: [], sleep: [] },
  ContentService: { createTextOutput: [] },
};
const SERVICE_NAME = /(?<![\w.$])((?:[A-Z][A-Za-z]*(?:App|Service))|Utilities|Session|Logger|Drive|Sheets|Gmail|Calendar|Docs)\.(\w+)/g;

interface Use { service: string; member: string; file: string }
const uses: Use[] = [];
for (const [file, src] of code) for (const m of src.matchAll(SERVICE_NAME)) uses.push({ service: m[1]!, member: m[2]!, file: file.slice(SRC.length + 1) });

const manifest = JSON.parse(readFileSync(join(ROOT, "appsscript.json"), "utf8")) as { oauthScopes: string[]; urlFetchWhitelist: string[]; webapp?: unknown };
const declared = new Set(manifest.oauthScopes);

describe("manifest: OAuth scopes", () => {
  it("scans a meaningful amount of code and finds the known services", () => {
    expect(tsFiles.length).toBeGreaterThan(40);
    const services = new Set(uses.map((u) => u.service));
    for (const s of ["SpreadsheetApp", "UrlFetchApp", "DriveApp", "ScriptApp", "Session", "HtmlService", "LockService", "PropertiesService", "Utilities", "ContentService"]) expect(services, s).toContain(s);
  });

  it("every service/method used is classified (an unknown one needs a scope decision)", () => {
    const unknown = uses.filter((u) => !(NEEDS[u.service] && u.member in NEEDS[u.service]!)).map((u) => `${u.service}.${u.member} in ${u.file}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  const missingFor = (scopes: Set<string>): string[] => {
    const missing: string[] = [];
    for (const u of uses) {
      const alts = NEEDS[u.service]?.[u.member];
      if (alts && alts.length && !alts.some((s) => scopes.has(s))) missing.push(`${u.service}.${u.member} (${u.file}) needs one of: ${alts.join(" | ")}`);
    }
    return [...new Set(missing)];
  };
  const superfluousIn = (scopes: Set<string>): string[] => {
    const used = new Set<string>();
    for (const u of uses) for (const s of NEEDS[u.service]?.[u.member] ?? []) used.add(s);
    return [...scopes].filter((s) => !used.has(s));
  };

  it("every needed scope is declared in appsscript.json", () => {
    expect(missingFor(declared)).toEqual([]);
  });

  it("nothing superfluous is declared: every declared scope is used by some call", () => {
    expect(superfluousIn(declared)).toEqual([]);
    expect(declared.size).toBe(manifest.oauthScopes.length); // no duplicates
  });

  it("the audit itself works: removing any declared scope is caught, adding an unused one is caught", () => {
    for (const s of declared) {
      const without = new Set([...declared].filter((x) => x !== s));
      expect(missingFor(without), `dropping ${s} must be detected`).not.toEqual([]);
    }
    expect(superfluousIn(new Set([...declared, "https://www.googleapis.com/auth/gmail.send"]))).toEqual(["https://www.googleapis.com/auth/gmail.send"]);
  });

  it("a broad scope is never declared on top of its narrow alternative", () => {
    expect(declared.has(SC.drive) && declared.has(SC.driveFile)).toBe(false);
    expect(declared.has(SC.sheets) && declared.has(SC.sheetsCurrent)).toBe(false);
  });

  it("the web app entry points exist for the declared web app", () => {
    expect(manifest.webapp).toBeTruthy();
    expect(typeof handlers.doPost).toBe("function");
    expect(typeof handlers.doGet).toBe("function");
  });

  it("every fetched host is whitelisted and every whitelist entry is used", () => {
    const hosts = (s: string): string[] => [...s.matchAll(/https:\/\/[A-Za-z0-9.-]+\//g)].map((m) => m[0]);
    const all = new Set([...code.values()].flatMap(hosts));
    const fetched = new Set([...code.values()].filter((s) => /UrlFetchApp\.fetch/.test(s)).flatMap(hosts));
    for (const host of fetched) expect(manifest.urlFetchWhitelist, host).toContain(host);
    for (const w of manifest.urlFetchWhitelist) expect(all.has(w), `whitelist entry ${w} is not used`).toBe(true);
  });
});
