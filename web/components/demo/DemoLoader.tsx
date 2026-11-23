"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import type { Dict } from "@/i18n/get";
import type { Locale } from "@/i18n/locales";

type Props = { demo: Dict["demo"]; brand: string; locale: Locale };

/** Loads and hydrates the interactive demo only when it is about to scroll into view, so first load stays light. */
export function DemoLoader(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [Demo, setDemo] = useState<ComponentType<Props> | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let done = false;
    const load = () => {
      if (done) return;
      done = true;
      void import("./Demo").then((m) => setDemo(() => m.Demo));
    };
    if (!("IntersectionObserver" in window)) {
      load();
      return;
    }
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && (load(), io.disconnect()), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={host} className="min-h-[30rem]">
      {Demo ? <Demo {...props} /> : null}
    </div>
  );
}
