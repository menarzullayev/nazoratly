import { expect, test } from "@playwright/test";

for (const path of ["/", "/uz-cyrl/", "/uz-new/", "/ru/", "/en/"]) {
  test(`no horizontal scroll at 320px on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(path);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w).toBeLessThanOrEqual(320);
  });

  test(`only same-origin requests on ${path}`, async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:")) foreign.push(u);
    });
    await page.goto(path, { waitUntil: "networkidle" });
    expect(foreign).toEqual([]);
  });
}

test("skip link, landmarks and a single h1", async ({ page }) => {
  await page.goto("/en/");
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.locator("footer")).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /skip to main/i })).toBeFocused();
});

test("wordmark is an accessible image or text", async ({ page }) => {
  await page.goto("/ru/");
  await expect(page.locator("header").getByText("nazoratly")).toBeVisible();
});
