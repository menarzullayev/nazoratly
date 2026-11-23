import { expect, test } from "@playwright/test";

test("hero renders the WebGL scene on a capable desktop", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("h1")).toBeVisible();
});

test("scrolling the hero moves progress from 0 to 1", async ({ page }) => {
  await page.goto("/ru/");
  const stage = page.locator("[data-stage]");
  await expect(stage).toHaveAttribute("data-progress", "0.000");
  await page.evaluate(() => {
    const s = document.querySelector("[data-stage]")!.parentElement!;
    window.scrollTo(0, s.offsetHeight - window.innerHeight);
  });
  await expect.poll(async () => Number(await stage.getAttribute("data-progress"))).toBeGreaterThan(0.95);
});

test("reduced motion gets the finished state without a canvas", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/en/");
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("[data-stage]")).toHaveAttribute("data-progress", "1.000");
});

test("WebGL context loss keeps the page usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    c.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
  });
  await expect(page.locator("canvas")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("[data-stage]")).toBeVisible();
});

test("the lab prototype page is gone", async ({ request }) => {
  const r = await request.get("/lab/");
  expect(r.status()).toBe(404);
});
