import { describe, expect, it } from "vitest";
import { isWebAppUrl } from "@domain/urls";

describe("shared domain alias", () => {
  it("resolves the product's own domain code", () => {
    expect(isWebAppUrl("https://script.google.com/macros/s/ID/exec")).toBe(true);
    expect(isWebAppUrl("https://evil.example.com/x")).toBe(false);
  });
});
