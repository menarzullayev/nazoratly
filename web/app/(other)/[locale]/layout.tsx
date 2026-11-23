import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { LOCALES, hreflangOf, isLocale } from "@/i18n/locales";
import "../../globals.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.filter((l) => l !== "uz").map((locale) => ({ locale }));
}

export default async function Layout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || locale === "uz") notFound();
  return (
    <html lang={hreflangOf(locale)} data-orthography={locale === "uz-new" ? "new" : undefined}>
      <body>{children}</body>
    </html>
  );
}
