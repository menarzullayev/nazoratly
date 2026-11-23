import { describe, expect, it } from "vitest";
import { LOCALES, hreflangOf } from "@/i18n/locales";
import { jsonLd } from "@/lib/jsonLd";

describe("jsonLd", () => {
  it.each(LOCALES)("is a valid SoftwareApplication for %s", (l) => {
    const j = jsonLd(l) as Record<string, unknown>;
    expect(j["@context"]).toBe("https://schema.org");
    expect(j["@type"]).toBe("SoftwareApplication");
    expect(j.inLanguage).toBe(hreflangOf(l));
    expect(typeof j.name).toBe("string");
    expect(() => JSON.parse(JSON.stringify(j))).not.toThrow();
  });

  it("states price ranges, never a repository, never fabricated ratings", () => {
    const text = JSON.stringify(jsonLd("en"));
    expect(text).toContain("500000");
    expect(text).toContain("UZS");
    expect(text).not.toMatch(/github|aggregateRating|review/i);
  });

  it("uses the public contact only", () => {
    const text = JSON.stringify(jsonLd("ru"));
    expect(text).toContain("+998902336600");
    expect(text).toContain("https://nazoratly.bugvector.uz");
  });
});
