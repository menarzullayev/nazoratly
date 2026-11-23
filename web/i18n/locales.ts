export const LOCALES = ["uz", "uz-cyrl", "uz-new", "ru", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "uz";
export const SITE_URL = "https://nazoratly.bugvector.uz";

export function isLocale(v: string): v is Locale {
  return (LOCALES as readonly string[]).includes(v);
}

export const pathFor = (l: Locale): string => (l === "uz" ? "/" : `/${l}/`);

/** BCP-47 tag for `<html lang>` and hreflang. The 2026 new Latin is still Uzbek in Latin script. */
export function hreflangOf(l: Locale): string {
  return l === "uz-cyrl" ? "uz-Cyrl" : l === "ru" ? "ru" : l === "en" ? "en" : "uz-Latn";
}

/** Each language is named in its own script so a reader can always find theirs. */
export const NATIVE_NAME: Record<Locale, string> = {
  uz: "O'zbekcha",
  "uz-cyrl": "Ўзбекча",
  "uz-new": "Özbekça",
  ru: "Русский",
  en: "English",
};
