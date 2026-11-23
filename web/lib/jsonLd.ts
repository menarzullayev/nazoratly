import { getDict } from "@/i18n/get";
import { SITE_URL, hreflangOf, pathFor, type Locale } from "@/i18n/locales";

const TIER_MIN = [500_000, 1_500_000, 3_000_000] as const;

/** schema.org SoftwareApplication for a locale. Prices are "from" ranges; no ratings, reviews or repository links. */
export function jsonLd(locale: Locale): object {
  const d = getDict(locale);
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: d.brand,
    description: d.meta.description,
    url: `${SITE_URL}${pathFor(locale)}`,
    inLanguage: hreflangOf(locale),
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web, Google Sheets, Telegram",
    offers: d.pricing.tiers.map((t, i) => ({
      "@type": "Offer",
      name: t.name,
      priceCurrency: "UZS",
      priceSpecification: { "@type": "PriceSpecification", minPrice: TIER_MIN[i], priceCurrency: "UZS" },
    })),
    provider: {
      "@type": "Organization",
      name: d.brand,
      url: SITE_URL,
      contactPoint: { "@type": "ContactPoint", telephone: "+998902336600", contactType: "sales", availableLanguage: ["uz", "ru", "en"] },
    },
  };
}
