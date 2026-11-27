import { expect, test as base, type Page } from "@playwright/test";

export type Json = Record<string, any>;
export type Role = "owner" | "admin" | "manager" | "accountant" | "teacher" | "viewer";

const origin = () => process.env.NZ_ORIGIN!;

async function control(path: string, body?: Json): Promise<Json> {
  const r = await fetch(`${process.env.NZ_CONTROL}${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
  const data = (await r.json()) as Json;
  if (!r.ok) throw new Error(`${path} failed: ${data.error}`);
  return data;
}

/** A fresh center of its own for one test: tests never depend on each other. */
export const makeCenter = (): Promise<Json> => control("/make/panel");
export const resetLink = async (email: string, expired = false): Promise<string> => (await control("/reset-link", { email, expired })).link as string;

/** Direct requests as an account, past the panel: this is how denial is proved on the server. */
export async function directApi(account: Json) {
  const login = await fetch(`${origin()}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: account.email, password: account.password }),
  });
  if (!login.ok) throw new Error(`login failed ${login.status}`);
  const token = ((await login.json()) as Json).access_token as string;
  return async (method: string, path: string, body?: Json, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${origin()}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

export const test = base.extend<{ problems: string[] }>({
  baseURL: async ({}, use) => {
    await use(`${origin()}/app/`);
  },
  // Every test also fails on an uncaught page error, a console error or a Content-Security-Policy violation. The
  // browser's own "Failed to load resource" line is skipped: refused answers are asserted by the tests that cause them.
  problems: [
    async ({ context }, use) => {
      const seen: string[] = [];
      const watch = (page: Page) => {
        page.on("pageerror", (e) => seen.push(`pageerror: ${e.message}`));
        page.on("console", (m) => {
          if (m.type() === "error" && !/Failed to load resource/.test(m.text())) seen.push(`console: ${m.text()}`);
        });
      };
      context.on("page", watch);
      await context.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`));
      });
      await use(seen);
      expect(seen, "console errors, uncaught exceptions, CSP violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function signIn(page: Page, account: Json): Promise<void> {
  await page.goto("login");
  await page.getByLabel("Email yoki telefon").fill(account.email);
  await page.getByLabel("Parol", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Kirish", exact: true }).click();
  await expect(page.locator("nav#menu")).toBeAttached(); // on a phone it is closed, so not in the a11y tree
}

/** Follows a menu link (the app is not reloaded, as a person would use it). */
export async function open(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation", { name: "Menyu" }).getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

export const dialog = (page: Page) => page.getByRole("dialog");

/** The screen has finished loading and shows no error. */
export async function settled(page: Page): Promise<void> {
  await expect(page.getByRole("status").filter({ hasText: "Yuklanmoqda" })).toHaveCount(0);
  await expect(page.locator("main .note-error")).toHaveCount(0);
  await expect(page.getByTestId("forbidden")).toHaveCount(0);
}

/** A camera that shows the QR card of `code`: a canvas stream drawn from the server's own QR matrix. */
export async function fakeCamera(page: Page, code: string): Promise<void> {
  const { matrix } = (await (await fetch(`${process.env.NZ_CONTROL}/qr-matrix?code=${code}`)).json()) as { matrix: number[][] };
  await page.addInitScript((m: number[][]) => {
    delete (window as any).BarcodeDetector; // the bundled reader is what a browser without a detector of its own uses
    const quiet = 4;
    const px = 8;
    const size = (m.length + quiet * 2) * px;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#000";
      m.forEach((cells, r) => cells.forEach((v, c) => v && ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px)));
    };
    draw();
    setInterval(draw, 60);
    const stream = canvas.captureStream(15);
    (window as any).__tracks = stream.getTracks();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => stream }, configurable: true });
  }, matrix);
}
