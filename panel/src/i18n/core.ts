/** Five languages from three hand-written dictionaries: `uz` (the source of the keys), `ru` and `en`. Uzbek Cyrillic and
 * the new Uzbek Latin are generated from `uz` with the site's transliteration (web/lib/translit, not copied here).
 * User data (names, notes, message texts) is never converted: values are put into a template AFTER conversion. */

import { convert, stripMarks } from "@translit";
import { en } from "./en";
import { ru } from "./ru";
import { uz } from "./uz";

export type Key = keyof typeof uz;
export type Dictionary = Record<Key, string>;

export const LOCALES = ["uz", "uz-cyrl", "uz-new", "ru", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const NATIVE_NAME: Record<Locale, string> = {
  uz: "O'zbekcha",
  "uz-cyrl": "Ўзбекча",
  "uz-new": "Özbekça",
  ru: "Русский",
  en: "English",
};
export const htmlLang = (l: Locale): string => (l === "uz-cyrl" ? "uz-Cyrl" : l === "ru" ? "ru" : l === "en" ? "en" : "uz-Latn");
export const isLocale = (value: string | null): value is Locale => (LOCALES as readonly string[]).includes(value ?? "");

const PLACEHOLDER = /(\{\w+\})/;

/** Converts a template and leaves its {placeholders} alone. */
function converted(template: string, locale: Locale): string {
  if (locale === "ru" || locale === "en") return stripMarks(template);
  const script = locale === "uz-cyrl" ? "cyrl" : locale === "uz-new" ? "new" : "latn";
  return stripMarks(
    template
      .split(PLACEHOLDER)
      .map((part, index) => (index % 2 === 1 ? part : convert(part, script)))
      .join(""),
  );
}

const cache = new Map<Locale, Dictionary>();

export function dictionary(locale: Locale): Dictionary {
  const hit = cache.get(locale);
  if (hit) return hit;
  const source: Dictionary = locale === "ru" ? ru : locale === "en" ? en : uz;
  const built = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, converted(v, locale)])) as Dictionary;
  cache.set(locale, built);
  return built;
}

export type Values = Record<string, string | number>;

export function translate(locale: Locale, key: Key, values?: Values): string {
  const text = dictionary(locale)[key];
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

export const hasKey = (key: string): key is Key => Object.prototype.hasOwnProperty.call(uz, key);

/** What a dictionary is missing or has too much of, and placeholders that differ from the source. Used by the CI test. */
export function dictionaryProblems(source: Record<string, string>, other: Record<string, string>): string[] {
  const names = (text: string): string => (text.match(/\{\w+\}/g) ?? []).sort().join();
  const problems: string[] = [];
  for (const [key, text] of Object.entries(source)) {
    const mine = other[key];
    if (mine === undefined) problems.push(`missing: ${key}`);
    else if (!mine.trim()) problems.push(`empty: ${key}`);
    else if (names(mine) !== names(text)) problems.push(`placeholders differ: ${key}`);
  }
  for (const key of Object.keys(other)) if (!(key in source)) problems.push(`unknown: ${key}`);
  return problems;
}
