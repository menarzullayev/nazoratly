import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Parity guard: every case section of every golden file must be read by BOTH products (a Sheets golden test and a backend
 * golden test), so a rule can never silently exist in only one of them. Where a rule has no golden file at all, the
 * waiver below says why; a new unlisted gap fails the test.
 */
const REPO = join(__dirname, "..", "..", "..");
const GOLDEN = join(REPO, "tests", "golden");
const SHEETS_TESTS = join(REPO, "sheets", "test");
const BACKEND_TESTS = join(REPO, "backend", "tests");

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
const sheetsTests = readdirSync(SHEETS_TESTS).filter((f) => f.endsWith(".test.ts"));
const backendTests = readdirSync(BACKEND_TESTS).filter((f) => f.startsWith("test_") && f.endsWith(".py"));
const camel = (s: string): string => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** golden sections that exist for one product only, with the reason */
const ONE_SIDED: Record<string, string> = {
  "guardian.json#login_code_state": "guardian-cabinet web login codes: the Sheets edition has no web login (the guardian uses the Telegram bot)",
};

/** money rules of sheets/src/domain that have no golden file, and why */
const NO_GOLDEN_WAIVER: Record<string, string> = {
  planCharges: "composes golden-covered primitives (family_percent, lasting_discounts, early_discount); the API composes them in SQL/router code",
  effectiveFee: "composition of the enrollment discount percent and the group fee",
  familyRanks: "ordering by registration inside one guardian; the API ranks in SQL",
  earlyOffer: "composition of early_discount and early_pay_by",
  computeDebts: "FIFO allocation of payments to charges: the API allocates in SQL (payment_allocations), there is no pure Python function to read a golden file",
  debtors: "filter over computeDebts",
  computePayroll: "the API computes payroll in SQL; teacher month hours/pay estimate IS golden-covered (teacher.json month_summary)",
  heldLessons: "input of computePayroll",
  heldLessonsFor: "input of computePayroll",
  collectedTuition: "input of computePayroll",
  enrollmentBalances: "composition over golden-covered package rules (packages.json balance)",
  packageProblem: "validation text of a package row",
  parseWeekdays: "covered through schedule.json parse_schedule",
  monthLessonDates: "covered through schedule.json parse_schedule / week_range",
};

describe("golden parity: both products read every section of every golden file", () => {
  const files = readdirSync(GOLDEN).filter((f) => f.endsWith(".json"));

  it("finds the golden files and both test folders", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(sheetsTests.length).toBeGreaterThan(30);
    expect(backendTests.length).toBeGreaterThan(30);
  });

  for (const file of files) {
    it(`${file}: a Sheets test and a backend test read every section`, () => {
      const sections = Object.keys(JSON.parse(readFileSync(join(GOLDEN, file), "utf8")) as Record<string, unknown>);
      const sheets = sheetsTests.filter((t) => read(SHEETS_TESTS, t).includes(`golden/${file}`) || read(SHEETS_TESTS, t).includes(`"${file}"`)).map((t) => read(SHEETS_TESTS, t)).join("\n");
      const backend = backendTests.filter((t) => t.includes("golden") || /test_(sheets_import)/.test(t)).filter((t) => read(BACKEND_TESTS, t).includes(file)).map((t) => read(BACKEND_TESTS, t)).join("\n");
      expect(sheets.length, `no Sheets test reads ${file}`).toBeGreaterThan(0);
      expect(backend.length, `no backend golden test reads ${file}`).toBeGreaterThan(0);
      const missing: string[] = [];
      for (const section of sections) {
        if (ONE_SIDED[`${file}#${section}`]) continue;
        if (!sheets.includes(section) && !sheets.includes(camel(section))) missing.push(`${section}: not read by any Sheets test`);
        if (!backend.includes(section)) missing.push(`${section}: not read by any backend golden test`);
      }
      expect(missing).toEqual([]);
    });
  }

  it("a one-sided waiver is still needed (the section really is missing on that side)", () => {
    for (const key of Object.keys(ONE_SIDED)) {
      const [file, section] = key.split("#") as [string, string];
      const sheets = sheetsTests.filter((t) => read(SHEETS_TESTS, t).includes(`golden/${file}`)).map((t) => read(SHEETS_TESTS, t)).join("\n");
      expect(sheets.includes(section) || sheets.includes(camel(section)), `${key} is read by Sheets now: drop the waiver`).toBe(false);
    }
  });

  it("every exported money rule of the Sheets domain is read by a golden test or has a documented waiver", () => {
    const domain = join(REPO, "sheets", "src", "domain");
    const goldenTests = sheetsTests.filter((t) => t.startsWith("golden.")).map((t) => read(SHEETS_TESTS, t)).join("\n");
    const unexplained: string[] = [];
    for (const f of ["money", "billing", "debt", "installments", "packages", "payroll", "entitlements", "capacity", "growth", "lifecycle"]) {
      const src = readFileSync(join(domain, `${f}.ts`), "utf8");
      for (const m of src.matchAll(/^export function (\w+)/gm)) {
        const fn = m[1]!;
        if (new RegExp(`\\b${fn}\\b`).test(goldenTests) || existsSync(join(domain, "__never__"))) continue;
        if (!NO_GOLDEN_WAIVER[fn]) unexplained.push(`${f}.ts: ${fn}`);
      }
    }
    expect(unexplained).toEqual([]);
  });

  it("every waiver names a function that still exists (no stale waivers)", () => {
    const domain = join(REPO, "sheets", "src", "domain");
    const all = readdirSync(domain).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(domain, f), "utf8")).join("\n");
    for (const fn of Object.keys(NO_GOLDEN_WAIVER)) expect(new RegExp(`export function ${fn}\\b`).test(all), `${fn} no longer exists: drop its waiver`).toBe(true);
  });
});
