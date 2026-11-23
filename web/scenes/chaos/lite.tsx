import type { CSSProperties } from "react";
import { layoutChaos } from "./data";

const N = 18;
const { chaos, order } = layoutChaos(N, 7);

/** DOM version of the chaos-to-order story. Driven only by the CSS variable --p (0..1) set on the stage. */
export function ChaosLite({ accent }: { accent: string }) {
  return (
    <div className="relative mx-auto h-full w-full max-w-4xl" aria-hidden="true" style={{ "--accent": accent } as CSSProperties}>
      {chaos.map((c, i) => {
        const o = order[i]!;
        const vars = {
          "--cx": c[0] * 18,
          "--cy": -c[1] * 18,
          "--ox": o[0] * 52,
          "--oy": -o[1] * 52,
          "--rot": ((i * 47) % 70) - 35,
        } as CSSProperties;
        return (
          <span
            key={i}
            className="absolute left-1/2 top-1/2 block h-9 w-14 rounded-md border border-line"
            style={{
              ...vars,
              background: i % 5 === 0 ? "var(--accent)" : "#e9eef3",
              transform:
                "translate(calc((var(--cx) * (1 - var(--p, 1)) + var(--ox) * var(--p, 1)) * 1px), calc((var(--cy) * (1 - var(--p, 1)) + var(--oy) * var(--p, 1)) * 1px)) rotate(calc(var(--rot) * (1 - var(--p, 1)) * 1deg))",
            }}
          />
        );
      })}
    </div>
  );
}
