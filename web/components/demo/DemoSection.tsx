import type { Dict } from "@/i18n/get";
import type { Locale } from "@/i18n/locales";
import { DemoLoader } from "./DemoLoader";

export function DemoSection({ d, locale }: { d: Dict; locale: Locale }) {
  return (
    <section id="demo" aria-labelledby="demo-title" className="scroll-mt-24 py-20">
      <h2 id="demo-title" className="font-display text-2xl font-semibold sm:text-4xl">
        {d.demo.title}
      </h2>
      <p className="mt-3 max-w-2xl text-mute">{d.demo.lead}</p>
      <p className="mt-1 text-sm text-mute">{d.demo.note}</p>
      <div className="mt-8">
        <DemoLoader demo={d.demo} brand={d.brand} locale={locale} />
      </div>
    </section>
  );
}
