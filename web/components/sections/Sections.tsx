import type { ReactNode } from "react";
import { Bubble, PhoneMock } from "@/components/PhoneMock";
import { Reveal } from "@/components/Reveal";
import type { Dict } from "@/i18n/get";
import { demoSheetUrl } from "@/lib/demoSheet";

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 py-20">
      <Reveal>
        <h2 id={`${id}-title`} className="font-display text-2xl font-semibold sm:text-4xl">
          {title}
        </h2>
        {lead && <p className="mt-3 max-w-2xl text-mute">{lead}</p>}
      </Reveal>
      <div className="mt-8">{children}</div>
    </section>
  );
}

export function HowItWorks({ d }: { d: Dict }) {
  return (
    <Section id="how" title={d.how.title}>
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {d.how.steps.map((s, i) => (
          <li key={i} className="rounded-2xl border border-line bg-bg2 p-5">
            <Reveal>
              <span aria-hidden="true" className="font-display text-3xl font-semibold text-accent">
                {i + 1}
              </span>
              <h3 className="mt-2 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-mute">{s.text}</p>
            </Reveal>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function BotSection({ d }: { d: Dict }) {
  return (
    <Section id="bot" title={d.bot.title} lead={d.bot.lead}>
      <div className="grid items-center gap-8 md:grid-cols-[1fr_auto]">
        <ul className="space-y-3">
          {d.bot.points.map((p, i) => (
            <li key={i} className="flex gap-3 rounded-xl border border-line bg-bg2 p-4">
              <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-accent" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
        <PhoneMock title={d.brand}>
          <Bubble>/qarz</Bubble>
          <Bubble>
            <p className="font-semibold">Bobur Saidov</p>
            <p className="mt-1 text-mute">1 800 000</p>
          </Bubble>
        </PhoneMock>
      </div>
    </Section>
  );
}

export function Tech({ d }: { d: Dict }) {
  return (
    <Section id="tech" title={d.tech.title} lead={d.tech.lead}>
      <ul className="grid gap-4 sm:grid-cols-2">
        {d.tech.items.map((it, i) => (
          <li key={i} className="rounded-2xl border border-line bg-bg2 p-5">
            <h3 className="font-semibold">{it.title}</h3>
            <p className="mt-2 text-sm text-mute">{it.text}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Pricing({ d }: { d: Dict }) {
  return (
    <Section id="pricing" title={d.pricing.title} lead={d.pricing.lead}>
      <ul className="grid gap-4 md:grid-cols-3">
        {d.pricing.tiers.map((t, i) => (
          <li key={i} className={`rounded-2xl border p-6 ${i === 1 ? "border-accent bg-bg2" : "border-line bg-bg2"}`}>
            <h3 className="font-display text-xl font-semibold">{t.name}</h3>
            <p className="mt-1 text-sm text-mute">{t.desc}</p>
            <p className="mt-4 text-2xl font-semibold">{t.price}</p>
            <ul className="mt-4 space-y-2 text-sm">
              {t.features.map((f, k) => (
                <li key={k} className="flex gap-2">
                  <span aria-hidden="true" className="text-accent">
                    ✓
                  </span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="mt-5 font-medium">{d.pricing.monthly}</p>
      <p className="mt-1 text-sm text-mute">{d.pricing.note}</p>
    </Section>
  );
}

export function Faq({ d }: { d: Dict }) {
  return (
    <Section id="faq" title={d.faq.title}>
      <div className="divide-y divide-line rounded-2xl border border-line bg-bg2">
        {d.faq.items.map((it, i) => (
          <details key={i} className="group px-5 py-4">
            <summary className="cursor-pointer list-none font-medium marker:content-none">
              <span className="flex items-center justify-between gap-4">
                {it.q}
                <span aria-hidden="true" className="text-accent transition-transform group-open:rotate-45">
                  +
                </span>
              </span>
            </summary>
            <p className="mt-3 text-mute">{it.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

export function Contact({ d }: { d: Dict }) {
  const sheet = demoSheetUrl(process.env.NEXT_PUBLIC_DEMO_SHEET_COPY_URL);
  return (
    <Section id="contact" title={d.contact.title} lead={d.contact.lead}>
      <ul className="grid gap-3 sm:grid-cols-3">
        <li className="rounded-2xl border border-line bg-bg2 p-5">
          <p className="text-sm text-mute">{d.contact.telegramLabel}</p>
          <a className="mt-1 block text-lg font-semibold underline" href="https://t.me/menarzullayev">
            {d.contact.telegramHandle}
          </a>
        </li>
        <li className="rounded-2xl border border-line bg-bg2 p-5">
          <p className="text-sm text-mute">{d.contact.phoneLabel}</p>
          <a className="mt-1 block text-lg font-semibold underline" href="tel:+998902336600">
            {d.contact.phone}
          </a>
        </li>
        <li className="rounded-2xl border border-line bg-bg2 p-5">
          <p className="text-sm text-mute">{d.contact.botLabel}</p>
          <a className="mt-1 block text-lg font-semibold underline" href="https://t.me/nazoratlybot">
            {d.contact.botHandle}
          </a>
        </li>
      </ul>
      {sheet && (
        <a href={sheet} rel="noopener" className="mt-6 inline-block rounded-xl bg-accent px-5 py-3 font-semibold text-accent-ink">
          {d.contact.demoSheet}
        </a>
      )}
    </Section>
  );
}
