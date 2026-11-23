import { beforeEach, describe, expect, it } from "vitest";
import { isWebAppUrl, pickWebAppUrl } from "../src/domain/urls";
import * as actions from "../src/gas/actions";
import { webhookSecret } from "../src/gas/telegram";
import { installHarness, type Harness } from "./harness";

const GOOD = "https://script.google.com/macros/s/AKfycbzZv1AbBkrQ6ZXJR9XEWgcbJbYdqG03l0CmRQ1k6AyLDMtjz39isT-FDDgF-60G1ubM/exec";

describe("web app url", () => {
  it("accepts only a deployed /exec endpoint", () => {
    expect(isWebAppUrl(GOOD)).toBe(true);
    for (const bad of [
      "",
      "https://script.google.com/macros/s/ID/dev",
      "https://script.google.com/a/macros/x.com/s/ID/exec/extra",
      "http://script.google.com/macros/s/ID/exec",
      "https://evil.example.com/macros/s/ID/exec",
      "https://script.google.com/macros/s/ID/exec?x=1",
      "<html>",
    ]) {
      expect(isWebAppUrl(bad), bad).toBe(false);
    }
  });

  it("prefers the stored url, ignores a bogus reported one", () => {
    expect(pickWebAppUrl(GOOD, "https://docs.google.com/whatever")).toBe(GOOD);
    expect(pickWebAppUrl(null, GOOD)).toBe(GOOD);
    expect(pickWebAppUrl("junk", "https://docs.google.com/whatever")).toBe("");
    expect(pickWebAppUrl(undefined, undefined)).toBe("");
  });
});

describe("showWebhookInfo", () => {
  let h: Harness;
  beforeEach(() => {
    h = installHarness();
    h.props.clear();
  });

  it("asks for the url when getUrl is wrong, validates it, stores it and reuses it", () => {
    h.webUrl = "https://docs.google.com/spreadsheets/d/xyz/edit"; // what getUrl() really returned
    h.prompts.push("not a url");
    expect(() => actions.showWebhookInfo()).toThrow(/script\.google\.com/);
    expect(h.props.has("WEBAPP_URL")).toBe(false);

    h.prompts.push(GOOD);
    actions.showWebhookInfo();
    expect(h.props.get("WEBAPP_URL")).toBe(GOOD);
    expect(JSON.stringify(h.alerts ?? [])).toContain(`NAZORATLY_TG_RELAY_TARGET=${GOOD}`);

    h.prompts.length = 0; // second call must not prompt again
    actions.showWebhookInfo();
    expect(JSON.stringify(h.alerts ?? [])).toContain(webhookSecret());
  });

  it("uses getUrl() directly when it is a valid /exec url", () => {
    h.webUrl = GOOD;
    actions.showWebhookInfo();
    expect(h.prompts.length).toBe(0);
  });
});
