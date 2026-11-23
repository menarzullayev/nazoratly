import { describe, expect, it } from "vitest";
import { ANCHORS, flowPoint } from "@/scenes/flow/path";

describe("flowPoint", () => {
  it("starts at the Sheet and ends at the phone", () => {
    expect(flowPoint(0)).toEqual(ANCHORS.sheet);
    expect(flowPoint(1)).toEqual(ANCHORS.phone);
  });

  it("passes through the bot node", () => {
    const mid = flowPoint(0.5);
    expect(mid[0]).toBeCloseTo(ANCHORS.bot[0], 5);
    expect(mid[1]).toBeCloseTo(ANCHORS.bot[1], 5);
  });

  it("is continuous and moves left to right", () => {
    let prev = flowPoint(0);
    for (let i = 1; i <= 1000; i++) {
      const p = flowPoint(i / 1000);
      expect(Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2])).toBeLessThan(0.1);
      expect(p[0]).toBeGreaterThanOrEqual(prev[0] - 1e-9);
      prev = p;
    }
  });

  it("clamps out-of-range t", () => {
    expect(flowPoint(-1)).toEqual(ANCHORS.sheet);
    expect(flowPoint(2)).toEqual(ANCHORS.phone);
  });
});
