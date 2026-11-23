import type { Metadata } from "next";
import { getDict } from "./get";
import { SITE_URL, hreflangOf, pathFor, type Locale } from "./locales";

export function metadataFor(locale: Locale): Metadata {
  const d = getDict(locale);
  return {
    metadataBase: new URL(SITE_URL),
    title: d.meta.title,
    description: d.meta.description,
    alternates: {
      canonical: pathFor(locale),
      languages: {
        "uz-Latn": pathFor("uz"),
        "uz-Cyrl": pathFor("uz-cyrl"),
        ru: pathFor("ru"),
        en: pathFor("en"),
        "x-default": pathFor("uz"),
      },
    },
    openGraph: { title: d.meta.title, description: d.meta.description, type: "website", locale: hreflangOf(locale).replace("-", "_") },
  };
}
