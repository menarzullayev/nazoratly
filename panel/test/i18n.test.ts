/** Dictionaries: three hand-written ones with the same keys and placeholders, two generated ones, and a lint rule that
 * keeps text out of the markup. The negative cases prove each check can fail. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { dictionary, dictionaryProblems, LOCALES, translate } from "../src/i18n/core";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { uz } from "../src/i18n/uz";

describe("dictionaries", () => {
  it.each([["ru", ru], ["en", en]] as const)("%s has every key of the source with the same placeholders", (_name, other) => {
    expect(dictionaryProblems(uz, other)).toEqual([]);
  });

  it("fails on a missing key, an empty value, a lost placeholder and an extra key", () => {
    const source = { a: "Salom {name}", b: "x" };
    expect(dictionaryProblems(source, { a: "Hi {name}" })).toEqual(["missing: b"]);
    expect(dictionaryProblems(source, { a: "Hi {name}", b: " " })).toEqual(["empty: b"]);
    expect(dictionaryProblems(source, { a: "Hi", b: "x" })).toEqual(["placeholders differ: a"]);
    expect(dictionaryProblems(source, { a: "Hi {name}", b: "x", c: "y" })).toEqual(["unknown: c"]);
  });

  it("has an Uzbek, Russian and English text for every error code the server can answer", () => {
    // the codes are read from the backend, so a new one fails here until it is translated
    const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../backend/src/nazoratly/${path}`, import.meta.url)), "utf8");
    const codes = [...`${read("errors.py")}`.matchAll(/code(?:, code)? = (?:\d+, )?"([a-z_]+)"|code = "([a-z_]+)"/g)].map((m) => m[1] ?? m[2]!);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) expect(Object.keys(uz), code).toContain(`error.${code}`);
  });

  it("converts Uzbek to Cyrillic and the new Latin without touching placeholders or values", () => {
    expect(translate("uz-cyrl", "attendance.saved", { n: 3 })).toBe("3 та белги сақланди");
    expect(translate("uz-new", "nav.students")).toBe("Öquvchilar".replace("ch", "ç"));
    // a name typed by a person is user data: it is never transliterated
    expect(translate("uz-cyrl", "students.deleteText", { name: "Shahzod G'ulomov" })).toContain("Shahzod G'ulomov");
    expect(translate("uz-new", "students.deleteText", { name: "Shahzod G'ulomov" })).toContain("Shahzod G'ulomov");
  });

  it("builds all five languages with no leftover braces from the converters", () => {
    for (const locale of LOCALES) {
      const built = dictionary(locale);
      expect(Object.keys(built)).toHaveLength(Object.keys(uz).length);
      for (const [key, text] of Object.entries(built)) {
        const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
        expect(names(text), `${locale} ${key}`).toBe(names(uz[key as keyof typeof uz]));
      }
    }
  });
});

describe("lint rules", () => {
  const lint = async (code: string) => {
    const eslint = new ESLint({ cwd: fileURLToPath(new URL("..", import.meta.url)) });
    const [result] = await eslint.lintText(code, { filePath: "src/screens/sample.tsx" });
    return result!.messages.map((m) => m.ruleId);
  };

  it("rejects text written into the markup", async () => {
    expect(await lint("export const A = () => <p>Salom</p>;\n")).toContain("react/jsx-no-literals");
    expect(await lint('export const A = () => <input aria-label="Qidiruv" />;\n')).toContain("no-restricted-syntax");
  });

  it("rejects raw HTML injection and token storage", async () => {
    expect(await lint("export const A = ({ h }: { h: string }) => <p dangerouslySetInnerHTML={{ __html: h }} />;\n")).toContain("react/no-danger");
    expect(await lint('export const save = (t: string) => localStorage.setItem("token", t);\n')).toContain("no-restricted-syntax");
    expect(await lint('export const save = (t: string) => sessionStorage.setItem("token", t);\n')).toContain("no-restricted-syntax");
  });

  it("accepts text that comes from the dictionary", async () => {
    expect(await lint("export const A = ({ t }: { t: (k: string) => string }) => <p>{t('a')} · {1}</p>;\n")).toEqual([]);
  }, 30_000);
});
