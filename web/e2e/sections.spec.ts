import { expect, test } from "@playwright/test";

const PATHS = ["/", "/uz-cyrl/", "/uz-new/", "/ru/", "/en/"];
const IDS = ["demo", "features", "how", "bot", "tech", "pricing", "faq", "contact"];

for (const path of PATHS) {
  test.describe(path, () => {
    test("every section exists and every nav link points to one", async ({ page }) => {
      await page.goto(path);
      for (const id of IDS) await expect(page.locator(`section#${id}`)).toHaveCount(1);
      const hrefs = await page.locator('header nav a[href^="#"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")!.slice(1)));
      expect(new Set(hrefs)).toEqual(new Set(IDS));
    });

    test("features section lists the ten original and eight newer capabilities and no unbuilt promises", async ({ page }) => {
      await page.goto(path);
      const items = page.locator("#features li");
      await expect(items).toHaveCount(18);
      await expect(page.locator("#features h4")).toHaveCount(8);
      const text = (await page.locator("#features").innerText()).toLowerCase();
      expect(text).not.toMatch(/github|open.?source|\bpayme\b|\bsms\b/);
    });

    test("pricing shows the agreed ranges", async ({ page }) => {
      await page.goto(path);
      const text = await page.locator("#pricing").innerText();
      for (const n of ["500 000", "1 500 000", "3 000 000", "300 000", "600 000"]) expect(text).toContain(n);
    });

    test("contacts are present and no repository or provider promises appear", async ({ page }) => {
      await page.goto(path);
      for (const href of ["https://t.me/menarzullayev", "tel:+998902336600", "https://t.me/nazoratlybot"]) {
        await expect(page.locator(`#contact a[href="${href}"]`)).toHaveCount(1);
      }
      expect(await page.locator("a[href*='github']").count()).toBe(0);
    });

    test("heading levels never skip and there is one h1", async ({ page }) => {
      await page.goto(path);
      const levels = await page.locator("h1,h2,h3,h4").evaluateAll((els) => els.map((e) => Number(e.tagName[1])));
      expect(levels.filter((l) => l === 1)).toHaveLength(1);
      for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    });

    test("no horizontal scroll at 320px", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    });
  });
}

test("FAQ items open and close with the keyboard", async ({ page }) => {
  await page.goto("/en/");
  const first = page.locator("#faq details").first();
  await first.locator("summary").focus();
  await expect(first).not.toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("open", "");
  await page.keyboard.press("Space");
  await expect(first).not.toHaveAttribute("open", "");
});

test("the demo sheet button is absent while no copy link is configured", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('a[href*="docs.google.com"]')).toHaveCount(0);
});

test("the mobile menu opens and links to the sections", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/en/");
  await page.locator("header details summary").click();
  await expect(page.locator('header details a[href="#pricing"]')).toBeVisible();
});

test("only same-origin requests on the full page", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:")) foreign.push(u);
  });
  await page.goto("/", { waitUntil: "networkidle" });
  expect(foreign).toEqual([]);
});
