"use client";

import { useMotionTier } from "@/lib/capability";
import type { Dict } from "@/i18n/get";
import { ScrollStage } from "./ScrollStage";

const ACCENT = "#34d399";

/** Pinned cinematic hero (chaos to order). The copy is in the static HTML whatever the motion tier. */
export function Hero({ hero }: { hero: Dict["hero"] }) {
  const tier = useMotionTier();
  return (
    <ScrollStage accent={ACCENT} tier={tier}>
      <p className="text-sm uppercase tracking-widest text-accent">{hero.eyebrow}</p>
      <h1 className="mt-3 font-display text-3xl font-semibold leading-tight break-words sm:text-6xl">{hero.title}</h1>
      <p className="mt-4 max-w-2xl text-mute sm:text-lg">{hero.sub}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <a href="#contact" className="rounded-xl bg-accent px-5 py-3 font-semibold text-accent-ink">
          {hero.ctaPrimary}
        </a>
        <a href="https://t.me/nazoratlybot" className="rounded-xl border border-line bg-bg/60 px-5 py-3 font-semibold">
          {hero.ctaSecondary}
        </a>
      </div>
    </ScrollStage>
  );
}
