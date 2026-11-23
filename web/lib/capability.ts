"use client";

import { useEffect, useState } from "react";

export type Tier = "full" | "lite" | "static";

export interface Env {
  reducedMotion: boolean;
  hasWebGL2: boolean;
  cores: number;
  memoryGb?: number;
  width: number;
}

/** Pure decision: `static` = no animation or WebGL, `lite` = DOM/SVG story, `full` = WebGL scene. */
export function detectTier(env: Env): Tier {
  if (env.reducedMotion || !env.hasWebGL2) return "static";
  if (env.width < 768 || env.cores <= 4 || (env.memoryGb !== undefined && env.memoryGb <= 4)) return "lite";
  return "full";
}

function hasWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

export function readEnv(): Env {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    hasWebGL2: hasWebGL2(),
    cores: navigator.hardwareConcurrency || 4,
    memoryGb: nav.deviceMemory,
    width: window.innerWidth,
  };
}

/** Server and first client render are `static`; the real tier is set after mount so HTML always matches. */
export function useMotionTier(): Tier {
  const [tier, setTier] = useState<Tier>("static");
  useEffect(() => {
    const apply = () => setTier(detectTier(readEnv()));
    apply();
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return tier;
}
