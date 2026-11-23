import { Hero } from "@/components/Hero";
import { Wordmark } from "@/components/Wordmark";
import { getDict } from "@/i18n/get";
import { LOCALES, NATIVE_NAME, hreflangOf, pathFor, type Locale } from "@/i18n/locales";

export function LangSwitch({ locale }: { locale: Locale }) {
  const d = getDict(locale);
  return (
    <nav aria-label={d.header.langLabel} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {LOCALES.map((l) => (
        <a
          key={l}
          href={pathFor(l)}
          lang={hreflangOf(l)}
          aria-current={l === locale ? "page" : undefined}
          className={l === locale ? "font-semibold text-fg" : "text-mute hover:text-fg"}
        >
          {NATIVE_NAME[l]}
        </a>
      ))}
    </nav>
  );
}

export function SiteHome({ locale }: { locale: Locale }) {
  const d = getDict(locale);
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-white focus:p-2 focus:text-black">
        {d.skip}
      </a>
      <header className="absolute inset-x-0 top-0 z-20 mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-5">
        <Wordmark name={d.brand} />
        <LangSwitch locale={locale} />
      </header>
      <main id="main">
        <Hero d={d} />
        <div className="mx-auto max-w-5xl px-5 pb-24">
        <section id="contact" className="mt-24" aria-labelledby="contact-title">
          <h2 id="contact-title" className="text-2xl font-semibold">{d.contact.title}</h2>
          <p className="mt-2 text-mute">{d.contact.lead}</p>
          <ul className="mt-4 space-y-2">
            <li>
              {d.contact.telegramLabel}: <a className="underline" href="https://t.me/menarzullayev">{d.contact.telegramHandle}</a>
            </li>
            <li>
              {d.contact.phoneLabel}: <a className="underline" href="tel:+998902336600">{d.contact.phone}</a>
            </li>
            <li>
              {d.contact.botLabel}: <a className="underline" href="https://t.me/nazoratlybot">{d.contact.botHandle}</a>
            </li>
          </ul>
        </section>
        </div>
      </main>
      <footer className="mx-auto max-w-5xl px-5 pb-10 text-sm text-mute">{d.footer.note}</footer>
    </>
  );
}
