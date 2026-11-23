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
  if (env.reducedMotion) return "static";
  // Weak devices never run the WebGL scene, so they never pay for the (slow, software-GL on some phones) WebGL probe below.
  if (env.width < 768 || env.cores <= 4 || (env.memoryGb !== undefined && env.memoryGb <= 4)) return "lite";
  return env.hasWebGL2 ? "full" : "static";
}

export function hasWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/**
 * Cheap, synchronous facts only. WebGL2 is NOT probed here (creating a context is slow, and software GL on some devices
 * costs hundreds of ms of main-thread time during hydration): it is assumed, and `ScrollStage` probes it once the page is idle.
 */
export function readEnv(): Env {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    hasWebGL2: true,
    cores: navigator.hardwareConcurrency || 4,
    memoryGb: nav.deviceMemory,
    width: window.innerWidth,
  };
}

/**
 * Server and first client render are `static`; the real tier is set after mount so HTML always matches.
 * `resolved` turns true once the real tier is known (before that, `static` only means "not decided yet").
 */
export function useMotionTierState(): { tier: Tier; resolved: boolean } {
  const [state, setState] = useState<{ tier: Tier; resolved: boolean }>({ tier: "static", resolved: false });
  useEffect(() => {
    const apply = () => setState({ tier: detectTier(readEnv()), resolved: true });
    apply();
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return state;
}

export function useMotionTier(): Tier {
  return useMotionTierState().tier;
}
