import { describe, expect, it } from "vitest";
import { demoSheetUrl } from "@/lib/demoSheet";

describe("demoSheetUrl", () => {
  it("accepts only a Google Sheets copy link", () => {
    const ok = "https://docs.google.com/spreadsheets/d/15FBYWh7tHXDrPNzSpLsMQSJ_fwV8wF-5h8hHk5iyLDU/copy";
    expect(demoSheetUrl(ok)).toBe(ok);
  });
  it.each([undefined, "", "  ", "https://docs.google.com/spreadsheets/d/ID/edit", "http://docs.google.com/spreadsheets/d/ID/copy", "https://evil.example.com/spreadsheets/d/ID/copy", "javascript:alert(1)", "https://docs.google.com/spreadsheets/d/ID/copy?x=1"])(
    "rejects %s",
    (v) => {
      expect(demoSheetUrl(v)).toBeNull();
    },
  );
});
