import type { ReactNode } from "react";

/**
 * Fades and lifts its children in as they scroll into view. Pure CSS (scroll-driven `animation-timeline: view()`):
 * no JavaScript, no client component, and browsers without support simply show the content.
 */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`nz-reveal ${className ?? ""}`}>{children}</div>;
}
