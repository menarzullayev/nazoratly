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

describe("changeRelayUrl", () => {
  const RELAY = "https://nazoratly.example/hooks/relay/0b1c2d3e-0000-4000-8000-000000000001";
  let h: Harness;
  beforeEach(() => {
    h = installHarness();
    h.props.clear();
  });

  it("stores a new https address, points the webhook at it with the Sheet's secret, and can clear it", () => {
    h.props.set("TELEGRAM_BOT_TOKEN", "123456789:TEST-token-not-real-000000000000000");
    h.props.set("RELAY_URL", "https://old.example/hooks/telegram");
    h.telegram.handler = (method) => ({ status: 200, body: { ok: true, result: method === "getMe" ? { username: "x_bot" } : {} } });
    h.prompts.push(RELAY);
    actions.changeRelayUrl();
    expect(h.props.get("RELAY_URL")).toBe(RELAY);
    const hook = h.fetches.map((f) => f.body).find((b) => b._method === "setWebhook")!;
    expect(hook.url).toBe(RELAY);
    expect(hook.secret_token).toBe(webhookSecret());

    h.prompts.push("", "");
    actions.changeRelayUrl();
    expect(h.props.has("RELAY_URL")).toBe(false);
  });

  it("refuses an address that is not https", () => {
    h.prompts.push("http://nazoratly.example/hooks/relay/x");
    expect(() => actions.changeRelayUrl()).toThrow(/https/);
    expect(h.props.has("RELAY_URL")).toBe(false);
  });
});
