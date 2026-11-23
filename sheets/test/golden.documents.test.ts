import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as docs from "../src/domain/documents";

type G = {
  constants: { name: string; key: string; out: string }[];
  number: { name: string; in: { kind: docs.DocumentKind; year: number; serial: number }; out: string }[];
  format_som: { name: string; in: string; out: string }[];
};
// The same file the Python suite reads (backend/tests/test_golden_documents.py): both implementations must agree.
const golden = JSON.parse(readFileSync(new URL("../../tests/golden/documents.json", import.meta.url), "utf8")) as G;
const consts: Record<string, string> = { footer: docs.FOOTER, receipt_title: docs.RECEIPT_TITLE, invoice_title: docs.INVOICE_TITLE };

describe("golden: document rules", () => {
  it.each(golden.constants)("constant: $name", (c) => {
    expect(consts[c.key]).toBe(c.out);
  });
  it.each(golden.number)("number: $name", (c) => {
    expect(docs.documentNumber(c.in.kind, c.in.year, c.in.serial)).toBe(c.out);
  });
  it.each(golden.format_som)("formatSomExact: $name", (c) => {
    expect(docs.formatSomExact(Number(c.in))).toBe(c.out);
  });
});
