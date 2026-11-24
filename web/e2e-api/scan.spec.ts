import { expect, make, staffLogin, test, type Json } from "./fixtures";
import type { Page } from "@playwright/test";

async function matrixOf(code: string): Promise<number[][]> {
  const r = await fetch(`${process.env.NZ_CONTROL}/qr-matrix?code=${encodeURIComponent(code)}`);
  return ((await r.json()) as { matrix: number[][] }).matrix;
}

/** A fake camera: getUserMedia returns a canvas stream that keeps drawing the QR code of a student card. */
async function fakeCamera(page: Page, code: string) {
  const matrix = await matrixOf(code);
  await page.addInitScript((m: number[][]) => {
    const quiet = 4, px = 8, n = m.length, size = (n + quiet * 2) * px;
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#000";
      m.forEach((row, r) => row.forEach((v, c) => { if (v) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px); }));
    };
    draw();
    setInterval(draw, 60);
    const stream = canvas.captureStream(15);
    (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks = stream.getTracks();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => stream }, configurable: true });
  }, matrix);
}

async function openScan(page: Page, c: Json) {
  await page.goto("/ui/scan");
  await staffLogin(page, c.owner.email, c.owner.password);
  await expect(page.getByRole("heading", { name: "1. Darsni tanlang" })).toBeVisible();
  await expect(page.getByText("1 ta dars")).toBeVisible();
}

test.describe("QR attendance page", () => {
  test("a typed or hardware-scanned code marks the student present", async ({ page }) => {
    const c = await make("teacher");
    await openScan(page, c);
    const input = page.getByLabel(/Skaner qurilmasi/);
    await input.fill(c.students[0].qr);
    await input.press("Enter");
    await expect(page.locator("#result")).toContainText(`${c.students[0].name}: keldi`);
    await expect(page.locator("#count")).toHaveText("1");
    await expect(page.locator("#log li")).toHaveCount(1);
    await expect(input).toHaveValue("");
  });

  test("the same card again is reported as already marked", async ({ page }) => {
    const c = await make("teacher");
    await openScan(page, c);
    const input = page.getByLabel(/Skaner qurilmasi/);
    await input.fill(c.students[1].qr);
    await input.press("Enter");
    await expect(page.locator("#result")).toContainText("keldi");
    await page.waitForTimeout(3200); // the page ignores one card seen again within 3 s (a camera sees it for many frames)
    await input.fill(c.students[1].qr);
    await input.press("Enter");
    await expect(page.locator("#result")).toContainText("allaqachon belgilangan");
    await expect(page.locator("#count")).toHaveText("1");
  });

  test("a foreign or garbage code is explained, not marked", async ({ page }) => {
    const c = await make("teacher");
    await openScan(page, c);
    const input = page.getByLabel(/Skaner qurilmasi/);
    await input.fill("hello");
    await input.press("Enter");
    await expect(page.locator("#result")).toContainText("bu nazoratly QR kodi emas");
    await input.fill("NZQ1-AAAAAAAAAAAAAAAAAAAA");
    await input.press("Enter");
    await expect(page.locator("#result")).toContainText("noma'lum kod");
    await expect(page.locator("#count")).toHaveText("0");
  });

  test("a card of a student from another center is refused", async ({ page }) => {
    const mine = await make("teacher");
    const other = await make("teacher");
    await openScan(page, mine);
    const input = page.getByLabel(/Skaner qurilmasi/);
    await input.fill(other.students[0].qr);
    await input.press("Enter");
    await expect(page.locator("#result")).toHaveClass(/bad/);
    await expect(page.locator("#count")).toHaveText("0");
  });

  test("the fake camera stream is read and the card is marked", async ({ page }) => {
    const c = await make("teacher");
    await fakeCamera(page, c.students[2].qr);
    await openScan(page, c);
    await page.getByRole("button", { name: "Kamerani yoqish" }).click();
    await expect(page.locator("#viewport")).toBeVisible();
    await expect(page.locator("#result")).toContainText(`${c.students[2].name}: keldi`, { timeout: 20_000 });
    await expect(page.locator("#count")).toHaveText("1");
    await page.getByRole("button", { name: "Kamerani o'chirish" }).click();
    await expect(page.locator("#viewport")).toBeHidden();
    await expect(page.getByRole("button", { name: "Kamerani yoqish" })).toBeVisible();
  });

  test("a refused camera permission points at manual entry", async ({ page }) => {
    const c = await make("teacher");
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } },
        configurable: true,
      });
    });
    await openScan(page, c);
    await page.getByRole("button", { name: "Kamerani yoqish" }).click();
    await expect(page.locator("#cam-msg")).toContainText("Kameraga ruxsat berilmadi: NotAllowedError");
  });

  test("without a lesson selected the scan asks to pick one", async ({ page }) => {
    const c = await make("teacher");
    await openScan(page, c);
    await page.getByLabel("Sana").fill("2030-01-01");
    await expect(page.getByText("Bu kunda dars yo'q")).toBeVisible();
    const input = page.getByLabel(/Skaner qurilmasi/);
    await input.fill(c.students[0].qr);
    await input.press("Enter");
    await expect(page.locator("#result")).toContainText("Avval darsni tanlang");
  });

  test("the page asks for the camera only on this page (Permissions-Policy)", async ({ request }) => {
    const scan = await request.get("/ui/scan");
    expect(scan.headers()["permissions-policy"]).toContain("camera=(self)");
    const cal = await request.get("/ui/calendar");
    expect(cal.headers()["permissions-policy"]).toContain("camera=()");
  });
});
