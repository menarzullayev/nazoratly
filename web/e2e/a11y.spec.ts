import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Audit the settled page: with reduced motion nothing is mid-fade, so colour contrast is measured on final colours.
test.use({ reducedMotion: "reduce" });

const PATHS = ["/", "/uz-cyrl/", "/uz-new/", "/ru/", "/en/"];
const TABS: Record<string, string[]> = {
  "/": ["Davomat", "To'lov", "Eslatma", "Oylik"],
  "/uz-cyrl/": [],
  "/uz-new/": [],
  "/ru/": ["Посещаемость", "Оплата", "Напоминание", "Зарплата"],
  "/en/": ["Attendance", "Payment", "Reminder", "Payroll"],
};

async function audit(page: import("@playwright/test").Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

for (const path of PATHS) {
  test(`axe: no WCAG A/AA violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    expect(await audit(page)).toEqual([]);
    for (const tab of TABS[path] ?? []) {
      await page.locator("#demo").getByRole("tab", { name: tab }).click();
      expect(await audit(page), tab).toEqual([]);
    }
  });
}

test("axe: still clean with the reminder flow and the open FAQ", async ({ page }) => {
  await page.goto("/en/");
  await page.locator("#demo").getByRole("tab", { name: "Reminder" }).click();
  await page.locator("#demo").getByRole("button", { name: "Prepare drafts" }).click();
  await page.locator("#demo").getByRole("button", { name: "Approve and send" }).first().click();
  await page.locator("#faq details").first().locator("summary").click();
  expect(await audit(page)).toEqual([]);
});

test("social and SEO metadata", async ({ page }) => {
  await page.goto("/en/");
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(1);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveCount(1);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/en\/$/);
  const ld = await page.locator('script[type="application/ld+json"]').textContent();
  expect(JSON.parse(ld!).inLanguage).toBe("en");
});
