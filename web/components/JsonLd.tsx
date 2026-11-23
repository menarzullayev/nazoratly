import { jsonLd } from "@/lib/jsonLd";
import type { Locale } from "@/i18n/locales";

/** Structured data for search engines. `<` is escaped so the JSON can never close the script tag. */
export function JsonLd({ locale }: { locale: Locale }) {
  const json = JSON.stringify(jsonLd(locale)).replace(/</g, "\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
