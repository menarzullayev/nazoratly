import type { MetadataRoute } from "next";
import { LOCALES, SITE_URL, pathFor } from "@/i18n/locales";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return LOCALES.map((l) => ({ url: `${SITE_URL}${pathFor(l)}` }));
}
