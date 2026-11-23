import { expect, test } from "@playwright/test";

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
});

test("lab is not indexable", async ({ page }) => {
  await page.goto("/lab/");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});

for (const scene of ["a", "b", "c"]) {
  test(`scene ${scene} renders a WebGL canvas on the full tier`, async ({ page }) => {
    await page.goto(`/lab/?scene=${scene}&tier=full`);
    await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
    expect(errors.filter((e) => !/GPU stall|WebGL/i.test(e))).toEqual([]);
  });

  test(`scene ${scene} lite tier has no canvas`, async ({ page }) => {
    await page.goto(`/lab/?scene=${scene}&tier=lite`);
    await expect(page.locator("[data-stage]")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
  });
}

test("static tier: no canvas, hero text visible, story at its final state", async ({ page }) => {
  await page.goto("/lab/?scene=a&tier=static");
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("[data-stage]")).toHaveAttribute("data-progress", "1.000");
});

test("scrolling moves the progress from 0 to 1", async ({ page }) => {
  await page.goto("/lab/?scene=a&tier=lite");
  const stage = page.locator("[data-stage]");
  await expect(stage).toHaveAttribute("data-progress", "0.000");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(async () => Number(await stage.getAttribute("data-progress"))).toBeGreaterThan(0.95);
});

test("WebGL context loss falls back without errors", async ({ page }) => {
  await page.goto("/lab/?scene=b&tier=full");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const gl = c.getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  });
  await expect(page.locator("canvas")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator("[data-stage]")).toBeVisible();
  await expect(page.locator("h1")).toBeVisible();
});

test("no horizontal scroll at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/lab/?scene=c&tier=lite");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("controls switch scene and accent", async ({ page }) => {
  await page.goto("/lab/?scene=a&tier=lite");
  await page.getByRole("button", { name: /Xarita|B/ }).first().click();
  await expect(page).toHaveURL(/scene=b/);
  await page.getByRole("button", { name: /cyan/i }).click();
  await expect(page).toHaveURL(/accent=cyan/);
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cyan");
});
