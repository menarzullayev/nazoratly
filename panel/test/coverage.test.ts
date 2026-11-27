/** The coverage manifest: every operation of the API is bound to a screen, excluded with a reason, or waiting for a
 * later part. A new operation that nobody listed fails this test. The manifest alone does not prove an operation works
 * (the browser tests do), but this also checks that the source really calls what the manifest says it calls. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coverageProblems, type Manifest } from "./coverageRules";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const manifest = JSON.parse(readFileSync(here("../coverage.json"), "utf8")) as Manifest;
const openapi = JSON.parse(readFileSync(here("../../clients/typescript/openapi.json"), "utf8")) as { paths: Record<string, Record<string, unknown>> };

const operations = Object.entries(openapi.paths).flatMap(([path, item]) =>
  Object.keys(item)
    .filter((m) => ["get", "post", "put", "patch", "delete"].includes(m))
    .map((m) => `${m.toUpperCase()} ${path}`),
);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}
const source = files(here("../src")).map((f) => readFileSync(f, "utf8")).join("\n");
const routes = [...readFileSync(here("../src/routes.tsx"), "utf8").matchAll(/path: "([^"]+)"/g)].map((m) => m[1]!);
const screens = new Set([...routes, "/login", "/register", "/reset", "(every screen)"]);

describe("coverage manifest", () => {
  it("matches the OpenAPI document and the source", () => {
    expect(coverageProblems(manifest, operations, screens, source)).toEqual([]);
  });

  it("leaves nothing of a built part pending and keeps the 28 operations of design 6.5 outside the panel", () => {
    const entries = Object.values(manifest.operations);
    expect(entries.filter((e) => e.part !== undefined && manifest.builtParts.includes(e.part) && e.pending)).toEqual([]);
    expect(entries.filter((e) => e.part === undefined)).toHaveLength(28);
    expect(entries.filter((e) => e.part === 1 && e.screen).length).toBeGreaterThanOrEqual(110);
  });

  // negative tests: each way of cheating must be caught
  it.each([
    ["a new operation nobody listed", (m: Manifest) => m, [...operations, "GET /v1/brand-new"], /not listed: GET \/v1\/brand-new/],
    ["an entry for an operation that no longer exists", (m: Manifest) => ({ ...m, operations: { ...m.operations, "GET /v1/gone": { group: "x", excluded: "r" } } }), operations, /no longer in the API: GET \/v1\/gone/],
    ["a screen that does not exist", (m: Manifest) => ({ ...m, operations: { ...m.operations, "GET /v1/dashboard": { group: "x", part: 1, screen: "/nowhere" } } }), operations, /unknown screen/],
    ["a screen claim the source does not back", (m: Manifest) => ({ ...m, operations: { ...m.operations, "GET /v1/leads": { group: "leads", part: 1, screen: "/students" } } }), operations, /never calls/],
    ["an exclusion without a reason", (m: Manifest) => ({ ...m, operations: { ...m.operations, "GET /v1/dashboard": { group: "x", part: 1, excluded: " " } } }), operations, /without a reason/],
    ["pending work inside a built part", (m: Manifest) => ({ ...m, operations: { ...m.operations, "GET /v1/dashboard": { group: "x", part: 1, pending: true } } }), operations, /pending in a built part/],
    ["two states at once", (m: Manifest) => ({ ...m, operations: { ...m.operations, "GET /v1/dashboard": { group: "x", part: 1, screen: "/dashboard", excluded: "r" } } }), operations, /exactly one/],
  ])("fails on %s", (_name, change, ops, expected) => {
    expect(coverageProblems(change(manifest), ops, screens, source).join("\n")).toMatch(expected);
  });
});
