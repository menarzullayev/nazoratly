import { notFound } from "next/navigation";
import { SiteHome } from "@/components/SiteHome";
import { LOCALES, isLocale } from "@/i18n/locales";
import { metadataFor } from "@/i18n/metadata";

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.filter((l) => l !== "uz").map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return isLocale(locale) ? metadataFor(locale) : {};
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || locale === "uz") notFound();
  return <SiteHome locale={locale} />;
}
