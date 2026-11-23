import { Demo } from "@/components/demo/Demo";
import { Hero } from "@/components/Hero";
import { Nav } from "@/components/Nav";
import { BotSection, Contact, Faq, HowItWorks, Pricing, Tech } from "@/components/sections/Sections";
import { getDict } from "@/i18n/get";
import type { Locale } from "@/i18n/locales";

export function SiteHome({ locale }: { locale: Locale }) {
  const d = getDict(locale);
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-40 focus:bg-white focus:p-2 focus:text-black">
        {d.skip}
      </a>
      <Nav d={d} locale={locale} />
      <main id="main">
        <Hero d={d} />
        <div className="mx-auto max-w-6xl px-5">
          <Demo d={d} locale={locale} />
          <HowItWorks d={d} />
          <BotSection d={d} />
          <Tech d={d} />
          <Pricing d={d} />
          <Faq d={d} />
          <Contact d={d} />
        </div>
      </main>
      <footer className="mx-auto max-w-6xl px-5 pb-10 pt-6 text-sm text-mute">{d.footer.note}</footer>
    </>
  );
}
