import type { MetadataRoute } from "next";
import { SITE_URL } from "@/i18n/locales";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: "/lab/" }, sitemap: `${SITE_URL}/sitemap.xml` };
}
