import { expect, test } from "@playwright/test";

const CASES = [
  ["/", "uz-Latn"],
  ["/uz-cyrl/", "uz-Cyrl"],
  ["/uz-new/", "uz-Latn"],
  ["/ru/", "ru"],
  ["/en/", "en"],
] as const;

for (const [path, lang] of CASES) {
  test(`locale page ${path}`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    await expect(page.locator("h1")).toBeVisible();
    const alts = await page.locator('link[rel="alternate"][hreflang]').evaluateAll((els) => els.map((e) => e.getAttribute("hreflang")));
    for (const want of ["uz-Latn", "uz-Cyrl", "ru", "en", "x-default"]) expect(alts).toContain(want);
    await expect(page.getByRole("navigation", { name: /./ }).first()).toBeVisible();
    await expect(page.locator('a[href="https://t.me/menarzullayev"]').first()).toBeAttached();
    await expect(page.locator('a[href="tel:+998902336600"]').first()).toBeAttached();
    await expect(page.locator('a[href="https://t.me/nazoratlybot"]').first()).toBeAttached();
  });
}

test("unknown locale shows the not-found page", async ({ page }) => {
  const res = await page.goto("/de/");
  expect(res?.status()).toBe(404);
  await expect(page.locator("body")).toContainText(/404/);
});

test("hero text is in the static HTML (no JavaScript needed)", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto("/ru/");
  await expect(page.locator("h1")).toBeVisible();
  await ctx.close();
});

test("language switcher links to every locale", async ({ page }) => {
  await page.goto("/en/");
  for (const href of ["/", "/uz-cyrl/", "/uz-new/", "/ru/", "/en/"]) {
    await expect(page.locator(`nav a[href="${href}"]`).first()).toBeAttached();
  }
});
