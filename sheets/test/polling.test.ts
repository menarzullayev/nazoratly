/** getUpdates mode: no webhook, a time trigger, the saved offset, one run at a time, and the daily quota accounting. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { botIdOfToken, dailyLimitMs, emptyUsage, projectedMs, quotaLevel, runBudgetMs, usageText } from "../src/domain/polling";
import { pollTick, readUsage } from "../src/gas/polling";
import { handlers } from "../src/Code";
import { webhookSecret } from "../src/gas/telegram";
import { boot, drive, setSetting } from "./e2e/support";
import type { Harness } from "./harness";

const TOKEN = "123456789:TEST-token-not-real-000000000000000";
const RELAY = "https://nazoratly.example/hooks/relay/0b1c2d3e-0000-4000-8000-000000000001";
const MIN = 60_000;

describe("polling rules", () => {
  it("uses Google's consumer quota for gmail and unknown owners, the Workspace quota otherwise", () => {
    expect(dailyLimitMs("owner@gmail.com")).toBe(90 * MIN);
    expect(dailyLimitMs("owner@GoogleMail.com")).toBe(90 * MIN);
    expect(dailyLimitMs("")).toBe(90 * MIN);
    expect(dailyLimitMs("owner@ziyo.uz")).toBe(360 * MIN);
  });

  it("projects a whole day from the average run only after enough runs, and warns by what is spent or projected", () => {
    const u = { ...emptyUsage("2026-11-23"), pollRuns: 11, pollMs: 11 * 3000, ms: 11 * 3000 };
    expect(projectedMs(u, 1)).toBeNull();
    expect(quotaLevel(u, 1, 90 * MIN)).toBe("ok");
    const v = { ...u, pollRuns: 12, pollMs: 12 * 3000, ms: 12 * 3000 };
    expect(projectedMs(v, 1)).toBe(1440 * 3000); // 72 minutes of 90
    expect(quotaLevel(v, 1, 90 * MIN)).toBe("near");
    expect(quotaLevel(v, 5, 90 * MIN)).toBe("ok"); // 14.4 minutes
    expect(quotaLevel({ ...emptyUsage("d"), ms: 63 * MIN }, 5, 90 * MIN)).toBe("near");
    expect(quotaLevel({ ...emptyUsage("d"), ms: 81 * MIN }, 5, 90 * MIN)).toBe("over");
    expect(usageText(v, 1, 90 * MIN)).toContain("72.0");
  });

  it("keeps a run shorter than the interval and the execution limit; the offset belongs to one bot", () => {
    expect(runBudgetMs(1)).toBeLessThan(MIN);
    expect(runBudgetMs(5)).toBeLessThan(5 * MIN);
    expect(botIdOfToken(TOKEN)).toBe("123456789");
    expect(botIdOfToken("junk")).toBe("");
  });
});

describe("getUpdates mode", () => {
  let h: Harness;
  /** updates Telegram holds; getUpdates answers from the requested offset */
  let queue: { update_id: number; message: { text: string; chat: { id: number; type: string }; from: { id: number } } }[];
  let runtimeMs: number;

  const update = (id: number, text: string) => ({ update_id: id, message: { text, chat: { id: 777, type: "private" }, from: { id: 777 } } });
  const calls = (method: string) => h.fetches.map((f) => f.body).filter((b) => b._method === method);
  const polls = () => calls("getUpdates");
  const sentTo = (chat: string) => calls("sendMessage").filter((b) => String(b.chat_id) === chat);

  beforeEach(() => {
    h = boot();
    h.props.set("TELEGRAM_BOT_TOKEN", TOKEN);
    h.props.set("RELAY_URL", RELAY);
    queue = [];
    runtimeMs = 0;
    h.telegram.handler = (method, body) => {
      if (method !== "getUpdates") return { status: 200, body: { ok: true, result: method === "getMe" ? { username: "x_bot" } : {} } };
      vi.advanceTimersByTime(runtimeMs); // the measured duration of the run
      const from = Number(body.offset ?? 0);
      queue = queue.filter((u) => u.update_id >= from); // Telegram forgets what the offset confirms
      return { status: 200, body: { ok: true, result: queue.slice(0, Number(body.limit)) } };
    };
  });
  afterEach(() => vi.useRealTimers());

  it("removes the webhook, keeps what is waiting, and makes one 5-minute trigger by default", () => {
    drive(h, "menuPollFive");
    expect(calls("deleteWebhook")).toEqual([{ _method: "deleteWebhook", drop_pending_updates: false }]);
    expect(h.triggers).toEqual([{ fn: "telegramPoll", everyMinutes: 5 }]);
    drive(h, "menuPollFive");
    expect(h.triggers).toHaveLength(1);
    expect(typeof handlers.telegramPoll).toBe("function");
  });

  it("asks before switching to 1 minute and keeps 5 minutes on refusal", () => {
    drive(h, "menuPollFive");
    h.answers.push("NO");
    const refused = drive(h, "menuPollOne");
    expect(refused.all).toContain("90 daqiqa");
    expect(h.triggers).toEqual([{ fn: "telegramPoll", everyMinutes: 5 }]);
    drive(h, "menuPollOne"); // YES
    expect(h.triggers).toEqual([{ fn: "telegramPoll", everyMinutes: 1 }]);
  });

  it("handles each update once: the offset is saved and sent back", () => {
    drive(h, "menuPollFive");
    queue = [update(10, "/privacy"), update(11, "/yordam")];
    pollTick();
    expect(sentTo("777")).toHaveLength(2);
    expect(h.props.get("TG_OFFSET_123456789")).toBe("12");
    expect(polls()[0]).not.toHaveProperty("offset");
    pollTick();
    expect(polls().at(-1)!.offset).toBe(12);
    expect(sentTo("777")).toHaveLength(2);
  });

  it("reads more than one batch, and a new bot starts with its own offset", () => {
    drive(h, "menuPollFive");
    queue = Array.from({ length: 150 }, (_, i) => update(100 + i, "salom")); // ignored texts: no replies
    pollTick();
    expect(polls()).toHaveLength(2);
    expect(h.props.get("TG_OFFSET_123456789")).toBe("250");
    h.props.set("TELEGRAM_BOT_TOKEN", "999999999:TEST-other-token-not-real-0000000000000");
    pollTick();
    expect(polls().at(-1)).not.toHaveProperty("offset");
  });

  it("does not run twice at the same time", () => {
    drive(h, "menuPollFive");
    queue = [update(1, "/privacy")];
    h.documentLockHeld = true; // another run is working
    pollTick();
    expect(polls()).toHaveLength(0);
    expect(readUsage().pollRuns).toBe(0);
    h.documentLockHeld = false;
    pollTick();
    expect(sentTo("777")).toHaveLength(1);
    expect(h.documentLockHeld).toBe(false);
  });

  it("goes on after an update that fails, and reports a Telegram refusal without losing the offset", () => {
    drive(h, "menuPollFive");
    queue = [update(5, "/privacy"), update(6, "/yordam")];
    const ok = h.telegram.handler;
    let broken = true;
    h.telegram.handler = (method, body) => {
      if (method === "sendMessage" && broken) {
        broken = false;
        throw new Error("boom");
      }
      return ok(method, body);
    };
    pollTick();
    expect(h.props.get("TG_OFFSET_123456789")).toBe("7");
    h.telegram.handler = () => ({ status: 409, body: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" } });
    pollTick();
    expect(h.props.get("TG_OFFSET_123456789")).toBe("7");
    expect(drive(h, "menuPollStatus").last).toContain("webhook is active");
  });

  it("ignores the webhook door while polling", () => {
    drive(h, "menuPollFive");
    handlers.doPost!({ parameter: { s: webhookSecret() }, postData: { contents: JSON.stringify(update(3, "/privacy")) } });
    expect(sentTo("777")).toHaveLength(0);
  });

  it("counts each day's runtime, warns the owner once per level, and starts again the next day", () => {
    setSetting(h, "Egasining Telegram chat ID si", "5550001");
    drive(h, "menuPollOne");
    runtimeMs = 5000; // at 1 minute: 120 minutes a day
    for (let i = 0; i < 11; i++) pollTick();
    expect(sentTo("5550001")).toHaveLength(0);
    pollTick();
    pollTick();
    expect(readUsage()).toMatchObject({ pollRuns: 13, pollMs: 13 * 5000, ms: 13 * 5000 });
    // the test owner is not on gmail.com: the Workspace quota (360 minutes) applies, so nothing is near yet
    expect(sentTo("5550001")).toHaveLength(0);
    runtimeMs = 20 * MIN;
    pollTick();
    expect(sentTo("5550001")).toHaveLength(1);
    pollTick();
    expect(sentTo("5550001")).toHaveLength(1);
    expect(drive(h, "menuPollStatus").last).toContain("360 daqiqa");
    vi.setSystemTime(new Date("2026-11-27T08:00:00Z"));
    expect(readUsage()).toMatchObject({ pollRuns: 0, ms: 0, warned: "" });
  });

  it("counts the teacher reminder trigger in the same day", () => {
    drive(h, "menuPollFive");
    pollTick();
    const before = readUsage().ms;
    handlers.teacherTick!();
    expect(readUsage().pollRuns).toBe(1);
    expect(readUsage().ms).toBeGreaterThanOrEqual(before);
  });

  it("goes back to the webhook without dropping waiting messages", () => {
    drive(h, "menuPollFive");
    drive(h, "menuPollOff");
    expect(h.triggers).toEqual([]);
    expect(calls("setWebhook").at(-1)).toMatchObject({ url: RELAY, drop_pending_updates: false });
    pollTick(); // a late trigger run does nothing
    expect(polls()).toHaveLength(0);
    expect(drive(h, "menuPollOff").last).toContain("yoqilmagan");
  });

  it("does not set a webhook over an active polling mode, and needs a bot first", () => {
    drive(h, "menuPollFive");
    h.answers.push("YES");
    drive(h, "menuSetupTelegram");
    expect(calls("setWebhook")).toHaveLength(0);
    h.props.delete("TELEGRAM_BOT_TOKEN");
    expect(drive(h, "menuPollFive").last).toContain("Avval Telegram botni sozlang");
  });

  it("never puts the token into a dialog", () => {
    drive(h, "menuPollFive");
    pollTick();
    drive(h, "menuPollStatus");
    expect(JSON.stringify(h.alerts)).not.toContain(TOKEN);
  });
});
