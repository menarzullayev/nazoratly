import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Contact } from "@/components/sections/Sections";
import { getDict } from "@/i18n/get";
import { LOCALES } from "@/i18n/locales";

const COPY = "https://docs.google.com/spreadsheets/d/DEMO_SHEET_ID_123/copy";
const html = (locale: (typeof LOCALES)[number]): string => renderToStaticMarkup(<Contact d={getDict(locale)} />);

afterEach(() => vi.unstubAllEnvs());

describe("the demo Sheet button on the landing (NEXT_PUBLIC_DEMO_SHEET_COPY_URL)", () => {
  it.each(LOCALES)("%s: with the variable empty or unset there is no button and no dead link", (locale) => {
    const label = getDict(locale).contact.demoSheet;
    for (const value of [undefined, "", "   "]) {
      vi.stubEnv("NEXT_PUBLIC_DEMO_SHEET_COPY_URL", value as string);
      const out = html(locale);
      expect(out, `value ${JSON.stringify(value)}`).not.toContain(label);
      expect(out).not.toContain("docs.google.com");
      expect(out).not.toContain('href=""');
      expect(out).not.toContain('href="#"');
    }
  });

  it("a link that is not a Sheets 'make a copy' link is ignored as well (an edit link would hand out the owner's Sheet)", () => {
    for (const bad of ["https://docs.google.com/spreadsheets/d/DEMO_SHEET_ID_123/edit", "https://example.com/copy", "javascript:alert(1)"]) {
      vi.stubEnv("NEXT_PUBLIC_DEMO_SHEET_COPY_URL", bad);
      const out = html("uz");
      expect(out).not.toContain(getDict("uz").contact.demoSheet);
      expect(out).not.toContain(bad);
    }
  });

  it("with a valid copy link the button shows, pointing at exactly that link", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_SHEET_COPY_URL", COPY);
    const out = html("uz");
    expect(out).toContain(`href="${COPY}"`);
    expect(out).toContain(getDict("uz").contact.demoSheet);
  });
});
