import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/locales";
import { getDict } from "@/i18n/get";
import { uz } from "@/i18n/dictionaries/uz";
import { ru } from "@/i18n/dictionaries/ru";
import { en } from "@/i18n/dictionaries/en";

function leaves(o: unknown, prefix = ""): [string, string][] {
  if (typeof o === "string") return [[prefix, o]];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe("section copy", () => {
  it("has the same keys, array lengths included, in uz, ru and en", () => {
    const keys = (d: unknown) => leaves(d).map(([k]) => k).sort();
    expect(keys(ru)).toEqual(keys(uz));
    expect(keys(en)).toEqual(keys(uz));
    expect(getDict("uz").how.steps).toHaveLength(4);
    expect(getDict("uz").pricing.tiers).toHaveLength(3);
    expect(getDict("uz").faq.items).toHaveLength(10);
    expect(getDict("uz").tech.items).toHaveLength(4);
    expect(getDict("uz").features.items).toHaveLength(10);
    expect(getDict("uz").features.more).toHaveLength(8);
  });

  it("keeps arrays as arrays after script conversion", () => {
    for (const l of LOCALES) {
      const d = getDict(l);
      expect(Array.isArray(d.faq.items)).toBe(true);
      expect(Array.isArray(d.pricing.tiers[0]!.features)).toBe(true);
    }
  });

  it("never promises payments providers, SMS or fiscalization, and never mentions the repository", () => {
    const banned = /github|open.?source|ochiq kod|открыт\w* код|очиқ код|\bpayme\b|\bclick\b|\bsms\b|fiskal|фискал/i;
    for (const l of LOCALES) {
      for (const [key, text] of leaves(getDict(l))) {
        if (key.startsWith("faq.items.2.")) continue; // the one honest "not connected yet" question and answer
        expect(text, `${l} ${key}`).not.toMatch(banned);
      }
    }
    for (const l of ["uz", "ru", "en"] as const) {
      expect(getDict(l).faq.items[2]!.q.toLowerCase()).toMatch(/payme/);
    }
  });

  it("shows the price ranges exactly as agreed", () => {
    for (const l of ["uz", "ru", "en"] as const) {
      const p = getDict(l).pricing;
      expect(p.tiers[0]!.price).toContain("500 000");
      expect(p.tiers[1]!.price).toContain("1 500 000");
      expect(p.tiers[2]!.price).toContain("3 000 000");
      expect(p.monthly).toContain("300 000");
      expect(p.monthly).toContain("600 000");
    }
  });

  it("has features and role copy in every locale, and the bot command is never converted", () => {
    for (const l of LOCALES) {
      const d = getDict(l);
      expect(d.features.items).toHaveLength(10);
      for (const it of d.features.items) {
        expect(it.title.trim()).not.toBe("");
        expect(it.text.trim().length).toBeGreaterThan(40);
      }
      expect(d.features.more).toHaveLength(8);
      for (const it of d.features.more) {
        expect(it.tag.trim()).not.toBe("");
        expect(it.title.trim()).not.toBe("");
        expect(it.text.trim().length).toBeGreaterThan(80);
      }
      for (const k of ["owner", "teacher", "guardian", "label", "teacherHint", "guardianHint", "child", "empty"] as const) {
        expect(d.demo.roles[k].trim(), `${l} ${k}`).not.toBe("");
      }
      expect(d.demo.roles.command).toBe("/qarz");
    }
  });

  it("marks API-only and owner-setup items honestly, in every locale", () => {
    for (const l of LOCALES) {
      const more = getDict(l).features.more;
      const api = /API/;
      // AI, guardian cabinet and teacher app: tagged as API product (Sheets has no AI text / no guardian cabinet)
      expect(more[4]!.tag, `${l} ai tag`).toMatch(api);
      expect(more[6]!.tag, `${l} guardian tag`).toMatch(api);
      expect(more[7]!.tag, `${l} teacher tag`).toMatch(api);
      // nothing is sent without a person, and setup is named
      expect(more[4]!.text).toMatch(/Claude/);
      expect(getDict(l).features.moreNote).toMatch(/BotFather/);
      expect(more[6]!.text).toMatch(/Mini App/);
      // no invented numbers beyond the counted rule kinds (four discounts, four refunds, four ways to link)
      for (const it of more) expect(it.text, `${l} ${it.title}`).not.toMatch(/\d+\s?%|\d+\s?(so'm|сум|сўм|UZS)/i);
    }
  });

  it("keeps the hero title and demo labels non-empty in every locale", () => {
    expect(getDict("uz").hero.title).toBe("Markazingiz to'liq nazorat ostida");
    for (const l of LOCALES) {
      const d = getDict(l);
      for (const k of ["title", "lead", "note"] as const) expect(d.demo[k].trim()).not.toBe("");
      for (const r of ["no_consent", "no_chat", "cooldown", "below_threshold", "student_inactive"] as const) {
        expect(d.demo.reminders.reasons[r].trim()).not.toBe("");
      }
    }
  });
});
