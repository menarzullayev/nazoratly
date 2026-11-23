"use client";

import { useEffect, useState } from "react";
import { useMotionTier, type Tier } from "@/lib/capability";
import { Wordmark } from "./Wordmark";
import { ScrollStage, type SceneId } from "./ScrollStage";

const SCENES: { id: SceneId; label: string; note: string }[] = [
  { id: "a", label: "A: Tartibsizlikdan tartibga", note: "Daftar varaqlari joyiga tushib, dashboardga aylanadi" },
  { id: "b", label: "B: Markaz xaritasi", note: "Izometrik markaz: to'lagan, kechikkan, qarzdor" },
  { id: "c", label: "C: Sheet → bot → telefon", note: "Ma'lumot oqimi vasiyning telefoniga yetadi" },
];
const ACCENTS = [
  { id: "emerald", hex: "#34d399" },
  { id: "cyan", hex: "#22d3ee" },
  { id: "amber", hex: "#fbbf24" },
] as const;
const TIERS: (Tier | "auto")[] = ["auto", "full", "lite", "static"];

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const scene = (["a", "b", "c"].includes(q.get("scene") ?? "") ? q.get("scene") : "a") as SceneId;
  const accent = ACCENTS.some((a) => a.id === q.get("accent")) ? (q.get("accent") as string) : "emerald";
  const tier = (TIERS as string[]).includes(q.get("tier") ?? "") ? (q.get("tier") as Tier | "auto") : "auto";
  return { scene, accent, tier };
}

/** Owner-only prototype page: pick hero concept, accent color and force a motion tier. State lives in the URL. */
export function LabClient() {
  const [state, setState] = useState<{ scene: SceneId; accent: string; tier: Tier | "auto" }>({ scene: "a", accent: "emerald", tier: "auto" });
  const [ready, setReady] = useState(false);
  const detected = useMotionTier();

  useEffect(() => {
    // The URL is only readable after hydration (static export), so state is synced from it once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(readParams());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.accent = state.accent;
    const q = new URLSearchParams({ scene: state.scene, accent: state.accent, tier: state.tier });
    window.history.replaceState(null, "", `${window.location.pathname}?${q.toString()}`);
  }, [state, ready]);

  const tier: Tier = state.tier === "auto" ? detected : state.tier;
  const hex = ACCENTS.find((a) => a.id === state.accent)!.hex;
  const btn = "rounded-lg border border-line px-3 py-1.5 text-sm text-mute hover:text-fg aria-pressed:border-accent aria-pressed:text-fg";

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-30 border-b border-line bg-bg/85 px-4 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2">
          <Wordmark name="nazoratly" />
          <div role="group" aria-label="Sahna" className="flex flex-wrap gap-2">
            {SCENES.map((s) => (
              <button key={s.id} type="button" aria-pressed={state.scene === s.id} title={s.note} className={btn} onClick={() => setState((v) => ({ ...v, scene: s.id }))}>
                {s.label}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Rang" className="flex gap-2">
            {ACCENTS.map((a) => (
              <button key={a.id} type="button" aria-pressed={state.accent === a.id} className={btn} onClick={() => setState((v) => ({ ...v, accent: a.id }))}>
                <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: a.hex }} />
                {a.id}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Daraja" className="flex gap-2">
            {TIERS.map((t) => (
              <button key={t} type="button" aria-pressed={state.tier === t} className={btn} onClick={() => setState((v) => ({ ...v, tier: t }))}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
      <ScrollStage scene={state.scene} accent={hex} tier={tier}>
        <p className="text-sm uppercase tracking-widest text-accent">O&apos;quv markazlari uchun</p>
        <h1 className="mt-3 font-display text-3xl font-semibold leading-tight break-words sm:text-6xl">Markazingiz to&apos;liq nazorat ostida</h1>
        <p className="mt-4 max-w-2xl text-mute sm:text-lg">
          Davomat, to&apos;lovlar, qarzdorlik va o&apos;qituvchi oyligi bitta joyda. Vasiylarga eslatmalar Telegram orqali, faqat siz tasdiqlagandan keyin yuboriladi.
        </p>
      </ScrollStage>
      <footer className="px-5 py-10 text-center text-sm text-mute">
        Prototip sahifa (qidiruvdan yopiq). Daraja: {tier}. Telefonda va &quot;harakatni kamaytirish&quot; yoqilganda yengil variant ishlaydi.
      </footer>
    </>
  );
}
