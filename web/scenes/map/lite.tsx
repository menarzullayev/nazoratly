import type { CSSProperties } from "react";
import { buildCenter } from "./layout";

const center = buildCenter(6, 8);
const S = 34; // px per unit

const colorOf = (status: string, accent: string) => (status === "paid" ? accent : status === "debt" ? "#ff5d5d" : "#fbbf24");

/** Flat isometric SVG of the center. Zooms with the CSS variable --p. */
export function MapLite({ accent }: { accent: string }) {
  const iso = (x: number, z: number): [number, number] => [(x - z) * S, (x + z) * S * 0.5];
  const poly = (r: { x: number; z: number; size: number }) => {
    const h = r.size / 2;
    return [iso(r.x - h, r.z - h), iso(r.x + h, r.z - h), iso(r.x + h, r.z + h), iso(r.x - h, r.z + h)].map((p) => p.join(",")).join(" ");
  };
  return (
    <svg
      viewBox="-300 -130 600 300"
      className="mx-auto h-full w-full max-w-3xl"
      aria-hidden="true"
      style={{ transform: "scale(calc(1 + var(--p, 1) * 0.25))", transformOrigin: "center" } as CSSProperties}
    >
      {center.rooms.map((r, i) => (
        <polygon key={i} points={poly(r)} fill="#14202b" stroke="#1d2a36" />
      ))}
      {center.students.map((s, i) => {
        const [x, y] = iso(s.x, s.z);
        return <circle key={i} cx={x} cy={y} r={5} fill={colorOf(s.status, accent)} className={s.status === "debt" ? "nz-pulse" : undefined} />;
      })}
    </svg>
  );
}
