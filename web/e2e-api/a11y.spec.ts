import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, make, miniAppHash, staffLogin, test } from "./fixtures";

async function audit(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

// Both a phone-sized and a desktop viewport: these pages are used on phones (Mini App) and at the front desk.
for (const [label, viewport] of [["phone", { width: 390, height: 800 }], ["desktop", { width: 1280, height: 800 }]] as const) {
  test.describe(`axe on the API-served pages (${label})`, () => {
    test.use({ viewport });

    test("guardian: sign-in, code and every tab", async ({ page }) => {
      const fam = await make("family");
      await page.goto("/ui/guardian");
      expect(await audit(page), "phone step").toEqual([]);
      await page.getByLabel("Telefon raqami").fill(fam.phone);
      await page.getByRole("button", { name: "Kod yuborish" }).click();
      await expect(page.getByRole("heading", { name: "Kodni kiriting" })).toBeVisible();
      expect(await audit(page), "code step").toEqual([]);
      await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
      await page.reload(); // a hash-only navigation does not run the page again; Telegram always opens it fresh
      await expect(page.locator("#content")).toBeVisible();
      for (const tab of ["Davomat", "Qarz va to'lov", "Hujjatlar", "Jadval", "Natijalar", "So'rovlar"]) {
        await page.getByRole("navigation", { name: "Bo'limlar" }).getByRole("button", { name: tab }).click();
        await expect(page.locator("#view h2").first()).toBeVisible();
        expect(await audit(page), tab).toEqual([]);
      }
    });

    test("guardian: the consent screen", async ({ page }) => {
      const fam = await make("family-unconsented");
      await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
      await expect(page.getByRole("heading", { name: "Rozilik" })).toBeVisible();
      expect(await audit(page)).toEqual([]);
    });

    test("teacher: sign-in and every tab", async ({ page }) => {
      const c = await make("teacher");
      await page.goto("/ui/teacher");
      expect(await audit(page), "sign-in").toEqual([]);
      await staffLogin(page, c.teacher.email, c.teacher.password);
      await page.getByRole("button", { name: "Davomat", exact: true }).click();
      await expect(page.getByRole("button", { name: "Davomatni saqlash" })).toBeVisible();
      expect(await audit(page), "roll call").toEqual([]);
      for (const tab of ["Guruhlar", "Jadval", "Oylik", "Vasiyga xabar", "Eslatmalar"]) {
        await page.getByRole("navigation", { name: "Bo'limlar" }).getByRole("button", { name: tab }).click();
        await expect(page.locator("section:not([hidden]) h2").first()).toBeVisible();
        expect(await audit(page), tab).toEqual([]);
      }
    });

    test("scan: sign-in and signed in", async ({ page }) => {
      const c = await make("teacher");
      await page.goto("/ui/scan");
      expect(await audit(page), "sign-in").toEqual([]);
      await staffLogin(page, c.owner.email, c.owner.password);
      await expect(page.getByText("1 ta dars")).toBeVisible();
      expect(await audit(page), "signed in").toEqual([]);
    });

    test("calendar: sign-in, week with a draft", async ({ page }) => {
      const c = await make("calendar");
      await page.goto("/ui/calendar");
      expect(await audit(page), "sign-in").toEqual([]);
      await staffLogin(page, c.owner.email, c.owner.password);
      await expect(page.locator("#notice-count")).toHaveText("1");
      expect(await audit(page), "signed in").toEqual([]);
    });

    test("import: sign-in, preview with problem rows", async ({ page }) => {
      const o = await make("owner");
      await page.goto("/ui/import");
      expect(await audit(page), "sign-in").toEqual([]);
      await staffLogin(page, o.email, o.password);
      await page.locator("#text").fill("full_name,phone\nA B,+998901112233\nBad,123");
      await page.getByRole("button", { name: "Tekshirish" }).click();
      await expect(page.getByRole("heading", { name: "3. Natija" })).toBeVisible();
      expect(await audit(page), "preview").toEqual([]);
    });
  });
}
