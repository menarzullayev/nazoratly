import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Student } from "../../src/domain/types";
import { append, read, updateMany } from "../../src/gas/repo";
import { ENROLLMENTS, STUDENTS } from "../../src/gas/schema";
import { stats, type Harness } from "../harness";
import { boot, student } from "./support";

let h: Harness;
beforeEach(() => {
  h = boot();
  append(STUDENTS, Array.from({ length: 5 }, (_, i) => student(`S000${i + 1}`, { fullName: `Name ${i + 1}` })));
});
afterEach(() => vi.useRealTimers());

type S = Student & { qrCode?: string; linkCode?: string };

describe("updateMany (regression: per-row updateById made QR/link-code issue cost 3 sheet calls per student)", () => {
  it("patches only the matching rows and only the touched columns, in one pass", () => {
    const before = h.rows("O'quvchilar").map((r) => [...r]);
    stats.reads = stats.writes = 0;
    const n = updateMany(STUDENTS, "id", new Map([["S0002", { qrCode: "AAA" }], ["S0004", { qrCode: "BBB", linkCode: "L4" }], ["S9999", { qrCode: "ZZZ" }]]));
    expect(n).toBe(2);
    expect(stats.reads).toBe(2); // the header and the data range
    expect(stats.writes).toBe(2); // one write per touched column (qrCode, linkCode), whatever the number of rows
    const rows = read<S>(STUDENTS);
    expect(rows.map((r) => [r.id, r.qrCode ?? "", r.linkCode ?? ""])).toEqual([["S0001", "", ""], ["S0002", "AAA", ""], ["S0003", "", ""], ["S0004", "BBB", "L4"], ["S0005", "", ""]]);
    // every other cell is untouched
    const col = (key: string): number => STUDENTS.cols.findIndex((c) => c.key === key);
    const after = h.rows("O'quvchilar");
    for (let r = 0; r < after.length; r++) for (let c = 0; c < before[r]!.length; c++) if (c !== col("qrCode") && c !== col("linkCode")) expect(after[r]![c], `cell ${r},${c}`).toEqual(before[r]![c]);
  });

  it("call count does not grow with the number of rows patched", () => {
    append(STUDENTS, Array.from({ length: 500 }, (_, i) => student(`S${String(i + 100).padStart(4, "0")}`)));
    const all = new Map(read<S>(STUDENTS).map((s) => [s.id, { qrCode: `Q-${s.id}` }]));
    stats.reads = stats.writes = 0;
    expect(updateMany(STUDENTS, "id", all)).toBe(505);
    expect(stats.reads + stats.writes).toBe(3);
    expect(read<S>(STUDENTS).every((s) => s.qrCode === `Q-${s.id}`)).toBe(true);
  });

  it("an empty patch does nothing, and a column the workbook lacks is an explicit error (not a write into column 0)", () => {
    stats.reads = stats.writes = 0;
    expect(updateMany(STUDENTS, "id", new Map())).toBe(0);
    expect(stats.reads + stats.writes).toBe(0);
    const head = h.sheet("O'quvchilar").data[0]!;
    const at = head.indexOf("Holat");
    head[at] = "Eskirgan sarlavha";
    expect(() => updateMany(STUDENTS, "id", new Map([["S0001", { status: "left" }]]))).toThrow(/ustuni yo'q/);
    void ENROLLMENTS;
  });
});
