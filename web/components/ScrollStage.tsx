"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChaosLite } from "@/scenes/chaos/lite";
import type { Tier } from "@/lib/capability";
import { applyProgress, createProgress } from "@/lib/progress";
import { SceneBoundary } from "./SceneBoundary";

const ChaosScene = dynamic(() => import("@/scenes/chaos/ChaosScene"), { ssr: false });

interface Props {
  accent: string;
  tier: Tier;
  /** Text laid over the scene (the hero copy). */
  children: ReactNode;
}

/**
 * A tall section with a pinned stage. Scroll progress (0..1) is written to the `--p` CSS variable, to a `data-progress`
 * attribute and to a ref the WebGL scene reads in its render loop. The `static` tier skips all of it and shows the
 * finished state (progress 1) in a single screen.
 */
export function ScrollStage({ accent, tier, children }: Props) {
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [progress] = useState(() => createProgress(tier === "static" ? 1 : 0));
  const [lost, setLost] = useState(false);
  const effective: Tier = lost && tier === "full" ? "lite" : tier;

  const write = useCallback((p: number) => applyProgress(progress, stage.current, p), [progress]);

  useEffect(() => {
    if (effective === "static") {
      write(1);
      return;
    }
    const el = section.current;
    if (!el) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const total = r.height - window.innerHeight;
      write(total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 1);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    compute();

    // Smooth scrolling only where WebGL runs (desktop); phones keep native scrolling and load no extra library.
    let lenisStop = () => {};
    let cancelled = false;
    if (effective === "full") {
      void import("lenis").then(({ default: Lenis }) => {
        if (cancelled) return;
        const lenis = new Lenis({ lerp: 0.12 });
        let id = requestAnimationFrame(function loop(t) {
          lenis.raf(t);
          id = requestAnimationFrame(loop);
        });
        lenisStop = () => {
          cancelAnimationFrame(id);
          lenis.destroy();
        };
      });
    }
    return () => {
      cancelled = true;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
      lenisStop();
    };
  }, [effective, write]);

  const onLost = useCallback(() => setLost(true), []);
  const sceneProps = { progress, accent, onLost };
  const lite = <ChaosLite accent={accent} />;

  return (
    <section ref={section} style={{ height: effective === "static" ? "100svh" : "320svh" }} className="relative">
      <div
        ref={stage}
        data-stage="chaos"
        data-tier={effective}
        data-progress={effective === "static" ? "1.000" : "0.000"}
        style={{ "--p": effective === "static" ? 1 : 0 } as CSSProperties}
        className="sticky top-0 h-svh overflow-hidden"
      >
        <div className="absolute inset-x-0 bottom-0 top-[40%]">
          {effective === "full" ? (
            <SceneBoundary fallback={lite}>
              <ChaosScene {...sceneProps} />
            </SceneBoundary>
          ) : (
            <div className="flex h-full items-center justify-center px-4">{lite}</div>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-bg via-bg/70 to-transparent px-5 pb-16 pt-20">
          <div className="pointer-events-auto mx-auto max-w-5xl">{children}</div>
        </div>
      </div>
    </section>
  );
}
