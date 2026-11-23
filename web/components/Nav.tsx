import { Wordmark } from "@/components/Wordmark";
import type { Dict } from "@/i18n/get";
import { LOCALES, NATIVE_NAME, hreflangOf, pathFor, type Locale } from "@/i18n/locales";

const SECTIONS = ["demo", "how", "bot", "tech", "pricing", "faq", "contact"] as const;

export function LangSwitch({ d, locale }: { d: Dict; locale: Locale }) {
  return (
    <nav aria-label={d.header.langLabel} className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
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

/** Fixed header: brand, section links (inline on wide screens, a native <details> menu on phones) and the language switch. */
export function Nav({ d, locale }: { d: Dict; locale: Locale }) {
  const links = SECTIONS.map((id) => (
    <a key={id} href={`#${id}`} className="text-mute hover:text-fg">
      {d.nav[id]}
    </a>
  ));
  return (
    <header className="fixed inset-x-0 top-0 z-30 border-b border-line/60 bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
        <a href="#main" aria-label={d.brand}>
          <Wordmark name={d.brand} />
        </a>
        <nav aria-label={d.nav.label} className="hidden gap-5 text-sm lg:flex">
          {links}
        </nav>
        <div className="hidden lg:block">
          <LangSwitch d={d} locale={locale} />
        </div>
        <details className="relative lg:hidden">
          <summary className="cursor-pointer list-none rounded-lg border border-line px-3 py-2 text-sm font-medium">{d.header.menu}</summary>
          <div className="absolute right-0 mt-2 grid w-[min(20rem,calc(100vw-2.5rem))] gap-4 rounded-xl border border-line bg-bg2 p-4">
            <nav aria-label={d.nav.label} className="grid gap-3 text-sm">
              {links}
            </nav>
            <LangSwitch d={d} locale={locale} />
          </div>
        </details>
      </div>
    </header>
  );
}
