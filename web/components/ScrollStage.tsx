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
    write(0);
    let cleanup = () => {};
    let cancelled = false;
    void (async () => {
      const [{ gsap }, { ScrollTrigger }, { default: Lenis }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
        import("lenis"),
      ]);
      if (cancelled || !section.current) return;
      gsap.registerPlugin(ScrollTrigger);
      const lenis = new Lenis({ lerp: 0.12 });
      lenis.on("scroll", ScrollTrigger.update);
      const tick = (time: number) => lenis.raf(time * 1000);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
      const trigger = ScrollTrigger.create({
        trigger: section.current,
        start: "top top",
        end: "bottom bottom",
        scrub: true,
        onUpdate: (self) => write(self.progress),
        onRefresh: (self) => write(self.progress),
      });
      cleanup = () => {
        trigger.kill();
        gsap.ticker.remove(tick);
        lenis.destroy();
      };
    })();
    return () => {
      cancelled = true;
      cleanup();
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
