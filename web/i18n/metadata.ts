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
    icons: { icon: "/icon.svg" },
    twitter: { card: "summary_large_image", title: d.meta.title, description: d.meta.description, images: ["/og.png"] },
    openGraph: { title: d.meta.title, description: d.meta.description, type: "website", images: [{ url: "/og.png", width: 1200, height: 630 }], locale: hreflangOf(locale).replace("-", "_") },
  };
}
