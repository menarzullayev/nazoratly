import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { balanceRich, chargesTable, esc, receiptRich, reminderRich, stripHtml, tgTime } from "../src/domain/messages";
import { parseUpdate } from "../src/domain/telegramUpdates";
import * as actions from "../src/gas/actions";
import { applyBotProfile } from "../src/gas/botProfile";
import { read, updateById } from "../src/gas/repo";
import { SETTINGS_SHEET, SETTING_DEFAULTS, STUDENTS } from "../src/gas/schema";
import { loadSampleData, setupWorkbook } from "../src/gas/setup";
import { sendRich, webhookSecret } from "../src/gas/telegram";
import { handlePost } from "../src/gas/webhook";
import type { Student } from "../src/domain/types";
import { installHarness, type Harness } from "./harness";

type StudentRow = Student & { linkCode?: string; note?: string };
let h: Harness;

describe("rich message builders", () => {
  const charges = [{ month: "2026-10-01", dueDate: "2026-10-10", outstanding: 600_000 }, { month: "2026-11-01", dueDate: "2026-11-10", outstanding: 600_000 }];

  it("escapes user text and renders dates in the reader's own time zone", () => {
    expect(esc(`<b>"A&B"</b>`)).toBe("&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;");
    expect(tgTime("2026-11-10")).toBe(`<tg-time unix="${Date.UTC(2026, 10, 10, 7) / 1000}" format="D">2026-11-10</tg-time>`);
  });

  it("builds the debt table, total and the one-tap buttons", () => {
    const html = reminderRich({ text: "Salom <script>\n\nIkkinchi abzats", studentId: "S0005", charges, payInfo: "8600 1234 5678 9012" });
    expect(html).toContain("<table striped compact>");
    expect(html).toContain("<td align=\"right\">600 000</td>");
    expect(html).toContain("Jami qoldiq: 1 200 000 so'm");
    expect(html).toContain('<tg-button type="copy_text" style="primary" text="8600 1234 5678 9012">');
    expect(html).toContain('<tg-button type="callback_data" style="success" data="p:S0005">');
    expect(html).toContain("&lt;script&gt;"); // no markup injection through a human-edited text
    expect(html.match(/<p>/g)!.length).toBeGreaterThanOrEqual(3); // two paragraphs + total
    expect(reminderRich({ text: "x", studentId: "S1", charges: [], payInfo: "" })).not.toContain("copy_text");
    expect(chargesTable([])).toBe("");
  });

  it("receipt differs for paid-off and open balances; fallback text is readable", () => {
    const base = { center: "Markaz", student: "Ali", amount: 600_000, paidOn: "2026-11-20", method: "Karta", charges };
    expect(receiptRich({ ...base, outstanding: 0, charges: [] })).toContain("Qarz yo'q");
    const open = receiptRich({ ...base, outstanding: 600_000 });
    expect(open).toContain("<b>600 000 so'm</b>");
    const plain = stripHtml(open);
    expect(plain).toContain("To'lov qabul qilindi");
    expect(plain).not.toMatch(/<[a-z]/);
  });

  it("balance for several children, with and without debt", () => {
    const html = balanceRich({ center: "M", payInfo: "", students: [{ name: "A", outstanding: 0, overdue: 0, credit: 5000, charges: [] }, { name: "B", outstanding: 600_000, overdue: 600_000, charges: [charges[0]!], credit: 0 }] });
    expect(html).toContain("Qarz yo'q ✅ (kredit: 5 000 so'm)");
    expect(html).toContain("muddati o'tgan: 600 000");
    expect(balanceRich({ center: "M", payInfo: "", students: [] })).toContain("topilmadi");
  });
});

describe("commands and buttons are parsed strictly", () => {
  const msg = (text: string) => ({ message: { text, chat: { id: 5, type: "private" } } });
  const cb = (data: string) => ({ callback_query: { id: "c1", data, message: { message_id: 3, chat: { id: 5, type: "private" } } } });
  it("recognises commands (also /cmd@bot) and ignores unknown ones", () => {
    expect(parseUpdate(msg("/qarz"))).toEqual({ kind: "command", chatId: "5", name: "balance" });
    expect(parseUpdate(msg("/privacy@demo_bot"))).toEqual({ kind: "command", chatId: "5", name: "privacy" });
    expect(parseUpdate(msg("/yordam"))).toEqual({ kind: "command", chatId: "5", name: "help" });
    expect(parseUpdate(msg("/hack"))).toEqual({ kind: "ignore" });
    expect(parseUpdate(msg("qarz"))).toEqual({ kind: "ignore" });
  });
  it("only accepts well-formed 'paid' callbacks", () => {
    expect(parseUpdate(cb("p:S0005"))).toEqual({ kind: "paid", chatId: "5", callbackId: "c1", studentId: "S0005" });
    expect(parseUpdate(cb("p:'; DROP"))).toEqual({ kind: "ignore" });
    expect(parseUpdate(cb("p:"))).toEqual({ kind: "ignore" });
  });
});

describe("Telegram adapters on the sheet runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
    h = installHarness();
    setupWorkbook();
    loadSampleData();
    h.props.set("TELEGRAM_BOT_TOKEN", "123456:TEST-TOKEN-TEST-TOKEN-TEST-TOKEN-12");
    h.props.set("BOT_USERNAME", "demo_bot");
  });
  afterEach(() => vi.useRealTimers());

  const post = (update: unknown) => handlePost({ parameter: { s: webhookSecret() }, postData: { contents: JSON.stringify(update), type: "application/json" } } as never);
  const calls = (method: string) => h.fetches.filter((f) => f.body._method === method);
  const setSetting = (label: string, value: string) => {
    const rows = h.sheet(SETTINGS_SHEET).data;
    const r = rows.findIndex((row) => row[0] === label);
    h.sheet(SETTINGS_SHEET).getRange(r + 1, 2).setValue(value);
  };
  function link(id: string, chat: number) {
    actions.generateLinkCodes();
    const code = read<StudentRow>(STUDENTS).find((s) => s.id === id)!.linkCode!;
    post({ message: { text: `/start ${code}`, chat: { id: chat, type: "private" } } });
    post({ callback_query: { id: "cb", data: `y:${code}`, message: { message_id: 1, chat: { id: chat, type: "private" } } } });
  }

  it("/qarz answers a linked guardian with a rich balance, and nobody else", () => {
    link("S0005", 8001);
    post({ message: { text: "/qarz", chat: { id: 8001, type: "private" } } });
    const rich = calls("sendRichMessage").pop()!;
    expect(rich.body.chat_id).toBe("8001");
    const html = (rich.body.rich_message as { html: string }).html;
    expect(html).toContain("Bobur Saidov");
    expect(html).toContain("1 800 000 so'm");
    expect(html).not.toContain("Madina"); // another family's child is never shown
    h.fetches.length = 0;
    post({ message: { text: "/qarz", chat: { id: 9999, type: "private" } } }); // unlinked chat
    expect((calls("sendRichMessage").pop()!.body.rich_message as { html: string }).html).toContain("topilmadi");
  });

  it("/privacy returns the configured policy; /yordam lists commands", () => {
    setSetting("Maxfiylik siyosati (bot /privacy)", "Maxfiylik: faqat to'lov xabarlari.");
    post({ message: { text: "/privacy", chat: { id: 7, type: "private" } } });
    expect(calls("sendMessage").pop()!.body.text).toBe("Maxfiylik: faqat to'lov xabarlari.");
    post({ message: { text: "/yordam", chat: { id: 7, type: "private" } } });
    expect(String(calls("sendMessage").pop()!.body.text)).toContain("/qarz");
  });

  it("'To'lov qildim' notes the claim, tells the owner, and refuses other families' children", () => {
    link("S0005", 8001);
    setSetting("Egasining Telegram chat ID si", "424242");
    h.fetches.length = 0;
    post({ callback_query: { id: "cbp", data: "p:S0005", message: { message_id: 9, chat: { id: 8001, type: "private" } } } });
    expect(read<StudentRow>(STUDENTS).find((s) => s.id === "S0005")!.note).toContain("to'lov qildim");
    expect(calls("answerCallbackQuery")[0]!.body).toMatchObject({ callback_query_id: "cbp", show_alert: true });
    const ownerMsg = calls("sendMessage").find((f) => f.body.chat_id === "424242")!;
    expect(String(ownerMsg.body.text)).toContain("Bobur Saidov");
    // the same button pressed from a chat that is not linked to S0002 is refused
    h.fetches.length = 0;
    post({ callback_query: { id: "cbq", data: "p:S0002", message: { message_id: 9, chat: { id: 8001, type: "private" } } } });
    expect(String(calls("answerCallbackQuery")[0]!.body.text)).toContain("ulanmagan");
    expect(read<StudentRow>(STUDENTS).find((s) => s.id === "S0002")!.note ?? "").not.toContain("to'lov qildim");
    expect(calls("sendMessage")).toHaveLength(0);
  });

  it("reminders carry the copy-requisites button only when requisites are set", () => {
    link("S0005", 8001);
    setSetting("To'lov rekvizitlari", "8600 1111 2222 3333");
    actions.createReminderDrafts();
    const [d] = actions.getPendingDrafts();
    actions.decideDrafts({ approve: [d!.id], reject: [], edits: {} });
    actions.sendApprovedReminders();
    const html = (calls("sendRichMessage").pop()!.body.rich_message as { html: string }).html;
    expect(html).toContain('text="8600 1111 2222 3333"');
    expect(html).toContain("2026-09"); // oldest open month listed first
  });

  it("full payoff receipt gets the 🎉 effect; a rejected effect is retried without it; HTML errors fall back to text", () => {
    const base = { studentId: "S0005", method: "Karta", paidOn: "2026-11-23", note: "", notifyGuardian: true };
    link("S0005", 8001);
    const paidAll = actions.recordPayment({ ...base, amount: 1_800_000 });
    expect(paidAll.balance.outstanding).toBe(0);
    expect(calls("sendRichMessage").pop()!.body.message_effect_id).toBe("5046509860389126442");

    h.fetches.length = 0;
    let attempt = 0;
    h.telegram.handler = (method, body) => {
      if (method !== "sendRichMessage") return { status: 200, body: { ok: true, result: {} } };
      attempt++;
      return body.message_effect_id ? { status: 400, body: { ok: false, description: "Bad Request: invalid effect" } } : { status: 200, body: { ok: true, result: {} } };
    };
    expect(sendRich("8001", "<p>Salom</p>", { message_effect_id: "x" }).ok).toBe(true);
    expect(attempt).toBe(2);
    expect(calls("sendRichMessage")[1]!.body.message_effect_id).toBeUndefined();

    h.fetches.length = 0;
    h.telegram.handler = (method) => (method === "sendRichMessage" ? { status: 400, body: { ok: false, description: "Bad Request: can't parse" } } : { status: 200, body: { ok: true, result: {} } });
    expect(sendRich("8001", "<p>Qoldiq <b>1 000</b></p>", { reply_markup: { x: 1 } }).ok).toBe(true);
    const fb = calls("sendMessage").pop()!;
    expect(fb.body.text).toBe("Qoldiq 1 000");
    expect(fb.body.reply_markup).toBeUndefined();

    h.fetches.length = 0; // blocked bot: final, no retries, no fallback spam
    h.telegram.handler = () => ({ status: 403, body: { ok: false, description: "Forbidden: bot was blocked by the user" } });
    expect(sendRich("8001", "<p>x</p>").ok).toBe(false);
    expect(h.fetches).toHaveLength(1);
  });

  it("bot profile: localized commands, descriptions and short descriptions (uz/ru/en), failures reported", () => {
    expect(applyBotProfile("Markaz")).toEqual([]);
    const cmds = calls("setMyCommands");
    expect(cmds).toHaveLength(3);
    expect(cmds.map((c) => c.body.language_code)).toEqual([undefined, "ru", "en"]);
    expect((cmds[0]!.body.commands as { command: string }[]).map((c) => c.command)).toEqual(["qarz", "privacy", "yordam", "stop"]);
    expect(cmds[0]!.body.scope).toEqual({ type: "all_private_chats" });
    for (const d of calls("setMyDescription")) expect(String(d.body.description).length).toBeLessThanOrEqual(512);
    for (const d of calls("setMyShortDescription")) expect(String(d.body.short_description).length).toBeLessThanOrEqual(120);
    h.telegram.handler = (m) => (m === "setMyDescription" ? { status: 400, body: { ok: false, description: "too long" } } : { status: 200, body: { ok: true, result: true } });
    expect(applyBotProfile("Markaz")).toHaveLength(3);
  });

  it("setup reuses a stored token and wires the profile and webhook", () => {
    h.webUrl = "https://script.google.com/macros/s/ID/exec";
    h.telegram.handler = (m) => (m === "getMe" ? { status: 200, body: { ok: true, result: { username: "demo_bot" } } } : { status: 200, body: { ok: true, result: true } });
    actions.setupTelegram(); // alert() answers YES -> keep the stored token
    expect(calls("setWebhook")).toHaveLength(1);
    expect(calls("setMyCommands")).toHaveLength(3);
    expect(h.alerts.at(-1)!.message).toContain("Bot ulandi: @demo_bot");
    expect(SETTING_DEFAULTS.map((d) => d.key)).toEqual(expect.arrayContaining(["payInfo", "ownerChatId", "policyText"]));
    void updateById;
  });

  it("webhook goes through the relay (Apps Script answers POST with a redirect Telegram cannot follow)", () => {
    h.webUrl = "https://script.google.com/macros/s/ID/exec";
    h.telegram.handler = (m) => (m === "getMe" ? { status: 200, body: { ok: true, result: { username: "demo_bot" } } } : { status: 200, body: { ok: true, result: true } });
    h.prompts.push("https://api.example.uz/hooks/telegram"); // asked once, then remembered
    actions.setupTelegram();
    const hook = calls("setWebhook")[0]!.body;
    expect(hook.url).toBe("https://api.example.uz/hooks/telegram");
    expect(hook.secret_token).toBe(webhookSecret());
    expect(hook.allowed_updates).toEqual(["message", "callback_query"]);
    expect(h.props.get("RELAY_URL")).toBe("https://api.example.uz/hooks/telegram");
    h.fetches.length = 0;
    actions.setupTelegram(); // second run: no prompt, same relay
    expect(calls("setWebhook")[0]!.body.url).toBe("https://api.example.uz/hooks/telegram");
    h.prompts.length = 0;
    h.props.delete("RELAY_URL");
    h.prompts.push("http://not-https.example");
    h.fetches.length = 0;
    actions.setupTelegram(); // an insecure/invalid relay is ignored, direct URL is used
    expect(String(calls("setWebhook")[0]!.body.url)).toContain("script.google.com");
  });
  it("shows the relay target and secret to the owner", () => {
    h.webUrl = "https://script.google.com/macros/s/ID/exec";
    actions.showWebhookInfo();
    const msg = h.alerts.at(-1)!.message;
    expect(msg).toContain("NAZORATLY_TG_RELAY_TARGET=https://script.google.com/macros/s/ID/exec");
    expect(msg).toContain(`NAZORATLY_TG_RELAY_SECRET=${webhookSecret()}`);
    h.webUrl = null;
    expect(() => actions.showWebhookInfo()).toThrow(/Web App/);
  });
});
