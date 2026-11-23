import { readFileSync } from "node:fs";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { isValidCode, newCode, parsePayload, qrPayload, scanDecision } from "../src/domain/qr";
import { MAX_BYTES, qrMatrix, qrSvg } from "../src/domain/qrcode";

type G = {
  new_code: { name: string; in: { bytes: number[] }; out: string }[];
  parse_payload: { name: string; in: { text: string }; out: string | null }[];
  scan_decision: { name: string; in: { code_text: string; known: boolean; lesson_status: string; in_roster: boolean; existing: string | null }; out: { result: string; write: boolean; previous: string | null } }[];
  matrix: { name: string; in: { text: string }; out: string[] }[];
};
// The same file the Python suite reads (backend/tests/test_golden_qr.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/qr.json", import.meta.url), "utf8")) as G;

/** Renders a module matrix to RGBA pixels with a quiet zone, the way a camera would see a printed card. */
function render(rows: boolean[][], scale = 6): { data: Uint8ClampedArray; size: number } {
  const n = rows.length;
  const size = (n + 8) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!rows[r]![c]) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + 4) * scale + y) * size + (c + 4) * scale + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { data, size };
}
const decode = (rows: boolean[][]): string | null => {
  const { data, size } = render(rows);
  return jsQR(data, size, size)?.data ?? null;
};

describe("golden: QR attendance rules", () => {
  it("has enough cases", () => {
    expect(Object.values(golden).reduce((n, v) => n + v.length, 0)).toBeGreaterThanOrEqual(30);
  });
  it.each(golden.new_code)("newCode: $name", (c) => {
    expect(newCode(c.in.bytes)).toBe(c.out);
    expect(isValidCode(c.out)).toBe(true);
  });
  it("newCode needs 20 bytes", () => expect(() => newCode(new Array(19).fill(0))).toThrow("20 random bytes"));
  it.each(golden.parse_payload)("parsePayload: $name", (c) => expect(parsePayload(c.in.text)).toBe(c.out));
  it.each(golden.scan_decision)("scanDecision: $name", (c) => {
    expect(scanDecision({ codeText: c.in.code_text, known: c.in.known, lessonStatus: c.in.lesson_status, inRoster: c.in.in_roster, existing: c.in.existing })).toEqual(c.out);
  });
  it("payload is the bare code", () => expect(qrPayload(newCode(Array.from({ length: 20 }, (_, i) => i)))).toHaveLength(25));
});

describe("QR encoder", () => {
  // Python's reference matrices (reportlab, the encoder that prints the API cards) must decode to the text ...
  it.each(golden.matrix)("reference matrix decodes: $name", (c) => {
    expect(decode(c.out.map((row) => [...row].map((ch) => ch === "1")))).toBe(c.in.text);
  });
  // ... and the TypeScript encoder (the Sheets cards) must produce matrices a decoder reads back to the same text.
  it.each(golden.matrix)("TypeScript matrix decodes: $name", (c) => {
    expect(decode(qrMatrix(c.in.text))).toBe(c.in.text);
  });
  it("covers every supported version boundary", () => {
    for (const len of [1, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106]) {
      const text = Array.from({ length: len }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
      expect(decode(qrMatrix(text))).toBe(text);
    }
  });
  it("encodes UTF-8 text", () => expect(decode(qrMatrix("O'quvchi ʻʼ Ўқувчи"))).toBe("O'quvchi ʻʼ Ўқувчи"));
  it("rejects text that does not fit", () => expect(() => qrMatrix("x".repeat(MAX_BYTES + 1))).toThrow("too long"));
  it("svg is a self-contained image", () => {
    const svg = qrSvg("NZQ1-ABCDEFGHJKLMNPQRSTUV");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain("<path");
  });
});
