import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { readPref, writePref } from "../lib/prefs";
import { hasKey, htmlLang, isLocale, translate, type Key, type Locale, type Values } from "./core";

export type T = (key: Key, values?: Values) => string;

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: T;
  /** The label of a server value ("active", "cash"): `<group>.<value>`, or the value itself when the panel does not
   * know it. */
  label: (group: string, value: string | null | undefined) => string;
}

const Context = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setState] = useState<Locale>(() => {
    const saved = readPref("lang");
    return isLocale(saved) ? saved : "uz";
  });
  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    writePref("lang", l);
    setState(l);
  }, []);
  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => translate(locale, key, values),
      label: (group, raw) => {
        if (raw === null || raw === undefined || raw === "") return "—";
        const key = `${group}.${raw}`;
        return hasKey(key) ? translate(locale, key) : raw;
      },
    }),
    [locale, setLocale],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error("I18nProvider is missing");
  return value;
}
