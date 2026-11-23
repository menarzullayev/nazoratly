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
          className={l === locale ? "font-semibold text-white" : "text-zinc-400 hover:text-white"}
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
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5">
        <span className="text-lg font-semibold tracking-tight">{d.brand}</span>
        <LangSwitch locale={locale} />
      </header>
      <main id="main" className="mx-auto max-w-5xl px-5 pb-24 pt-16">
        <p className="text-sm uppercase tracking-widest text-emerald-400">{d.hero.eyebrow}</p>
        <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">{d.hero.title}</h1>
        <p className="mt-5 max-w-2xl text-lg text-zinc-300">{d.hero.sub}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href="#contact" className="rounded-xl bg-emerald-400 px-5 py-3 font-semibold text-black">
            {d.hero.ctaPrimary}
          </a>
          <a href="https://t.me/nazoratlybot" className="rounded-xl border border-zinc-700 px-5 py-3 font-semibold">
            {d.hero.ctaSecondary}
          </a>
        </div>
        <section id="contact" className="mt-24" aria-labelledby="contact-title">
          <h2 id="contact-title" className="text-2xl font-semibold">{d.contact.title}</h2>
          <p className="mt-2 text-zinc-300">{d.contact.lead}</p>
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
      </main>
      <footer className="mx-auto max-w-5xl px-5 pb-10 text-sm text-zinc-500">{d.footer.note}</footer>
    </>
  );
}
