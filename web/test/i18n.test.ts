import { describe, expect, it } from "vitest";
import { toNewLatin } from "@/lib/translit";
import { LOCALES, hreflangOf, pathFor } from "@/i18n/locales";
import { getDict } from "@/i18n/get";
import { uz } from "@/i18n/dictionaries/uz";
import { ru } from "@/i18n/dictionaries/ru";
import { en } from "@/i18n/dictionaries/en";

function leaves(o: unknown, prefix = ""): [string, string][] {
  if (typeof o === "string") return [[prefix, o]];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe("dictionaries", () => {
  const base = leaves(uz).map(([k]) => k).sort();
  it("ru and en have exactly the keys of uz, none empty", () => {
    expect(leaves(ru).map(([k]) => k).sort()).toEqual(base);
    expect(leaves(en).map(([k]) => k).sort()).toEqual(base);
    for (const d of [uz, ru, en]) for (const [k, v] of leaves(d)) expect(v.trim(), k).not.toBe("");
  });

  it("derived Uzbek scripts come from the Latin source", () => {
    expect(getDict("uz-new").hero.title).toBe(toNewLatin(getDict("uz").hero.title.replace(/\{\{|\}\}/g, "")));
    expect(getDict("uz-cyrl").hero.title).not.toMatch(/[A-Za-z]{4,}/);
  });

  it("never mentions open source or GitHub, in any locale", () => {
    for (const l of LOCALES) {
      const all = leaves(getDict(l)).map(([, v]) => v).join(" ").toLowerCase();
      expect(all).not.toMatch(/github|open.?source|ochiq kod|открыт\w* код|очиқ код/);
    }
  });

  it("keeps brand and contacts unconverted", () => {
    for (const l of LOCALES) {
      const d = getDict(l);
      expect(d.contact.telegramHandle).toBe("@menarzullayev");
      expect(d.contact.botHandle).toBe("@nazoratlybot");
      expect(d.contact.phone).toBe("+998902336600");
      expect(d.brand).toBe("nazoratly");
    }
  });
});

describe("locales", () => {
  it("has five locales with stable paths and language tags", () => {
    expect([...LOCALES]).toEqual(["uz", "uz-cyrl", "uz-new", "ru", "en"]);
    expect(pathFor("uz")).toBe("/");
    expect(pathFor("uz-cyrl")).toBe("/uz-cyrl/");
    expect(pathFor("en")).toBe("/en/");
    expect(hreflangOf("uz-cyrl")).toBe("uz-Cyrl");
    expect(hreflangOf("uz")).toBe("uz-Latn");
    expect(hreflangOf("ru")).toBe("ru");
  });
});
