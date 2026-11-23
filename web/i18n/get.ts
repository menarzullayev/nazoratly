import { convert, stripMarks } from "@/lib/translit";
import { en } from "./dictionaries/en";
import { ru } from "./dictionaries/ru";
import { uz } from "./dictionaries/uz";
import type { Locale } from "./locales";

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Dict = Widen<typeof uz>;

function mapStrings<T>(o: T, fn: (s: string) => string): T {
  if (typeof o === "string") return fn(o) as T;
  return Object.fromEntries(Object.entries(o as object).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
}

const cache = new Map<Locale, Dict>();

/** The dictionary for a locale. Cyrillic and new Latin are generated from the Uzbek Latin source. */
export function getDict(locale: Locale): Dict {
  const hit = cache.get(locale);
  if (hit) return hit;
  const dict =
    locale === "ru"
      ? mapStrings(ru, stripMarks)
      : locale === "en"
        ? mapStrings(en, stripMarks)
        : mapStrings(uz as Dict, (s) => stripMarks(convert(s, locale === "uz-cyrl" ? "cyrl" : locale === "uz-new" ? "new" : "latn")));
  cache.set(locale, dict);
  return dict;
}
