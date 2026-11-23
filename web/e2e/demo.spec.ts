import { expect, test } from "@playwright/test";

const PAGES = [
  { path: "/", tabs: { attendance: "Davomat", payments: "To'lov", reminders: "Eslatma", payroll: "Oylik" }, record: "Qabul qilish", prepare: "Loyihalarni tayyorlash", approve: "Tasdiqlab yuborish", invalid: "Summani 0 dan katta" },
  { path: "/ru/", tabs: { attendance: "Посещаемость", payments: "Оплата", reminders: "Напоминание", payroll: "Зарплата" }, record: "Принять", prepare: "Подготовить черновики", approve: "Подтвердить и отправить", invalid: "Введите сумму" },
];

for (const p of PAGES) {
  test.describe(p.path, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(p.path);
      await page.locator("#demo").scrollIntoViewIfNeeded();
    });

    test("marking attendance updates the counters", async ({ page }) => {
      const demo = page.locator("#demo");
      await expect(demo.getByRole("status").first()).toContainText("0");
      await demo.getByRole("group").first().getByRole("button").nth(2).click(); // first student: absent
      await expect(demo.getByRole("status").first()).toContainText("1");
    });

    test("a payment lowers the debt; invalid input is rejected and never shows NaN", async ({ page }) => {
      const demo = page.locator("#demo");
      await demo.getByRole("tab", { name: p.tabs.payments }).click();
      await expect(demo.getByText("1 800 000").first()).toBeVisible();
      await demo.getByRole("textbox").fill("600000");
      await demo.getByRole("button", { name: p.record }).click();
      await expect(demo.getByText("1 200 000").first()).toBeVisible();

      await demo.getByRole("textbox").fill("abc");
      await demo.getByRole("button", { name: p.record }).click();
      await expect(demo.getByRole("alert")).toContainText(p.invalid);
      await demo.getByRole("textbox").fill("-5");
      await demo.getByRole("button", { name: p.record }).click();
      await expect(demo.getByRole("alert")).toBeVisible();
      expect(await page.locator("body").innerText()).not.toMatch(/NaN|undefined|Infinity/);
    });

    test("reminder: prepare, approve, see the Telegram message with its table", async ({ page }) => {
      const demo = page.locator("#demo");
      await demo.getByRole("tab", { name: p.tabs.reminders }).click();
      await demo.getByRole("button", { name: p.prepare }).click();
      await expect(demo.getByRole("button", { name: p.approve })).toHaveCount(2);
      await demo.getByRole("button", { name: p.approve }).first().click();
      await expect(demo.locator("table")).toBeVisible();
      await expect(demo.getByText(/Jami qoldiq/)).toBeVisible();
    });

    test("payroll follows the attendance", async ({ page }) => {
      const demo = page.locator("#demo");
      await demo.getByRole("tab", { name: p.tabs.payroll }).click();
      await expect(demo.locator("dd[aria-live]")).toContainText("270 000");
      await demo.getByRole("tab", { name: p.tabs.attendance }).click();
      await demo.getByRole("group").first().getByRole("button").first().click();
      await demo.getByRole("tab", { name: p.tabs.payroll }).click();
      await expect(demo.locator("dd[aria-live]")).toContainText("360 000");
    });
  });
}

test("the demo works with the keyboard only", async ({ page }) => {
  await page.goto("/");
  await page.locator("#demo").scrollIntoViewIfNeeded();
  const demo = page.locator("#demo");
  await demo.getByRole("tab", { name: "Davomat" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(demo.getByRole("tab", { name: "To'lov" })).toBeFocused();
  await expect(demo.getByRole("tab", { name: "To'lov" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab"); // into the panel
  await page.keyboard.press("Tab"); // student select
  await page.keyboard.press("Tab"); // amount
  await page.keyboard.type("1000");
  await page.keyboard.press("Enter");
  await expect(demo.getByRole("status").filter({ hasText: "To'lov qabul qilindi" })).toBeVisible();
});

test("the demo is rendered in the Cyrillic script on /uz-cyrl/", async ({ page }) => {
  await page.goto("/uz-cyrl/");
  await page.locator("#demo").scrollIntoViewIfNeeded();
  const demo = page.locator("#demo");
  await expect(demo.getByRole("tab").first()).toHaveText(/[Ѐ-ӿ]/);
  await expect(demo.getByText("Азиз Раҳимов").first()).toBeVisible();
});
