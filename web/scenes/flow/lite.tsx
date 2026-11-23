import type { CSSProperties } from "react";

/** SVG version of Sheet -> bot -> phone. The path draws itself with the CSS variable --p. */
export function FlowLite({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 600 240" className="mx-auto h-full w-full max-w-3xl" aria-hidden="true" style={{ "--accent": accent } as CSSProperties}>
      <rect x="20" y="60" width="90" height="120" rx="8" fill="#e9eef3" />
      {[0, 1, 2, 3, 4].map((r) => (
        <rect key={r} x="34" y={80 + r * 20} width="62" height="4" rx="2" fill="#9fb0c0" />
      ))}
      <path
        d="M110 120 C 180 70, 240 70, 300 90 S 420 150, 490 120"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="100"
        style={{ strokeDashoffset: "calc((1 - var(--p, 1)) * 100)" }}
      />
      <circle cx="300" cy="90" r="22" fill="none" stroke="var(--accent)" strokeWidth="3" />
      <rect x="490" y="50" width="70" height="140" rx="12" fill="#0d141c" stroke="#1d2a36" />
      <rect x="500" y="80" width="50" height="40" rx="6" fill="var(--accent)" style={{ opacity: "var(--p, 1)" }} />
    </svg>
  );
}
