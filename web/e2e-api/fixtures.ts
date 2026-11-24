import { expect, test as base, type Page } from "@playwright/test";

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const control = (path: string) => `${process.env.NZ_CONTROL}${path}`;

/** Build a fresh fixture (its own center) in the stack. Every test makes its own, so tests never depend on each other. */
export async function make(kind: string, arg = ""): Promise<Json> {
  const r = await fetch(control(`/make/${kind}${arg ? `?arg=${arg}` : ""}`), { method: "POST" });
  const body = (await r.json()) as Json;
  if (!r.ok) throw new Error(`fixture ${kind} failed: ${body.error}`);
  return body;
}

/** Telegram Mini App launch data signed with the TEST bot token, as a URL fragment ready for `page.goto`. */
export async function miniAppHash(user: number, opts: { age?: number; tamper?: boolean } = {}): Promise<string> {
  const q = new URLSearchParams({ user: String(user), age: String(opts.age ?? 0), tamper: opts.tamper ? "1" : "0" });
  const { init_data } = (await (await fetch(control(`/initdata?${q}`))).json()) as { init_data: string };
  return `#tgWebAppData=${encodeURIComponent(init_data)}`;
}

/** What the fake Telegram "sent" to a chat. */
export async function botTexts(chat: number): Promise<string[]> {
  return ((await (await fetch(control(`/messages?chat=${chat}`))).json()) as { texts: string[] }).texts;
}

/** The guardian bot's webhook, as Telegram would call it. */
export async function botUpdate(update: Json): Promise<number> {
  const r = await fetch(control("/bot"), { method: "POST", body: JSON.stringify(update), headers: { "content-type": "application/json" } });
  return ((await r.json()) as { status: number }).status;
}

export const botMessage = (chat: number, text: string, extra: Json = {}): Json => ({
  message: { chat: { id: chat, type: "private" }, from: { id: chat, first_name: "Dilnoza" }, text, ...extra },
});
export const botContact = (chat: number, phone: string, userId = chat): Json => ({
  message: { chat: { id: chat, type: "private" }, from: { id: chat, first_name: "Dilnoza" }, contact: { phone_number: phone, user_id: userId } },
});

/** Staff API call as the center's owner (used to approve what a guardian asked for, like the center would). */
export async function ownerApi(owner: { email: string; password: string }, method: string, path: string, body?: Json): Promise<Json> {
  const base = process.env.NZ_API!;
  const login = (await (await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: owner.email, password: owner.password }) })).json()) as Json;
  const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${login.access_token}` }, body: body ? JSON.stringify(body) : undefined });
  return (await r.json().catch(() => ({}))) as Json;
}

export const test = base.extend<{ problems: string[] }>({
  baseURL: async ({}, use) => { // eslint-disable-line no-empty-pattern
    await use(process.env.NZ_API!);
  },
  // Every test also fails on an uncaught page error or a console error. The browser's generic "Failed to load resource"
  // line is skipped: expected 4xx answers (a wrong code, a refused request) are asserted by the tests that provoke them.
  problems: [
    async ({ page }, use) => {
      const seen: string[] = [];
      page.on("pageerror", (e) => seen.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) seen.push(`console: ${m.text()}`);
      });
      await use(seen);
      expect(seen, "console errors / uncaught exceptions").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Sign in to a staff page (calendar, import, scan, teacher) with e-mail and password. */
export async function staffLogin(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel("Email yoki telefon").fill(email);
  await page.getByLabel("Parol").fill(password);
  await page.getByRole("button", { name: "Kirish" }).click();
}

/** Text of a downloaded file's first bytes; used to prove a download is a real PDF. */
export async function pdfHead(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const b = await readFile(path);
  return `${b.subarray(0, 5).toString("latin1")}|${b.subarray(-8).toString("latin1")}|${b.length}`;
}
