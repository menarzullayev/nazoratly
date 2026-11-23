import { describe, expect, it } from "vitest";
import { layoutChaos } from "@/scenes/chaos/data";

describe("layoutChaos", () => {
  it("returns n chaos points and n grid points", () => {
    const { chaos, order } = layoutChaos(24, 1);
    expect(chaos).toHaveLength(24);
    expect(order).toHaveLength(24);
  });

  it("order points lie on a regular grid", () => {
    const { order } = layoutChaos(24, 1);
    const xs = [...new Set(order.map((p) => p[0]))].sort((a, b) => a - b);
    const ys = [...new Set(order.map((p) => p[1]))].sort((a, b) => a - b);
    const dx = xs.slice(1).map((x, i) => +(x - xs[i]!).toFixed(6));
    const dy = ys.slice(1).map((y, i) => +(y - ys[i]!).toFixed(6));
    expect(new Set(dx).size).toBe(1);
    expect(new Set(dy).size).toBe(1);
    expect(xs.length * ys.length).toBe(24);
  });

  it("is deterministic per seed and the seed only moves the chaos", () => {
    const a = layoutChaos(24, 1);
    expect(layoutChaos(24, 1)).toEqual(a);
    const b = layoutChaos(24, 2);
    expect(b.order).toEqual(a.order);
    expect(b.chaos).not.toEqual(a.chaos);
  });

  it("handles tiny and non-rectangular counts", () => {
    expect(layoutChaos(1, 1).order).toHaveLength(1);
    expect(layoutChaos(0, 1).chaos).toEqual([]);
    expect(layoutChaos(7, 3).order).toHaveLength(7);
  });
});
