import { describe, expect, it } from "vitest";
import { buildCenter } from "@/scenes/map/layout";

describe("buildCenter", () => {
  const c = buildCenter(6, 8);

  it("creates the requested rooms and students", () => {
    expect(c.rooms).toHaveLength(6);
    expect(c.students).toHaveLength(48);
  });

  it("is deterministic", () => {
    expect(buildCenter(6, 8)).toEqual(c);
  });

  it("has a realistic share of debtors and no overlapping students", () => {
    const debt = c.students.filter((s) => s.status === "debt").length / c.students.length;
    expect(debt).toBeGreaterThanOrEqual(0.1);
    expect(debt).toBeLessThanOrEqual(0.25);
    expect(new Set(c.students.map((s) => `${s.x},${s.z}`)).size).toBe(c.students.length);
  });

  it("keeps every student inside their room", () => {
    for (const s of c.students) {
      const r = c.rooms[s.room]!;
      expect(Math.abs(s.x - r.x)).toBeLessThanOrEqual(r.size / 2);
      expect(Math.abs(s.z - r.z)).toBeLessThanOrEqual(r.size / 2);
    }
  });

  it("handles an empty center", () => {
    expect(buildCenter(0, 0)).toEqual({ rooms: [], students: [] });
  });
});
