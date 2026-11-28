/** Five languages, accessibility (axe) on the main screens, a phone-sized window and keyboard use. */

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { dialog, expect, makeCenter, settled, signIn, test } from "./fixtures";

const PAGES = [
  "dashboard", "calendar", "scan", "students", "guardians", "groups", "courses", "teachers", "rooms", "lessons", "absences",
  "schedule-checks", "notices", "charges", "payments", "debtors", "expenses", "reports", "organization", "branches", "staff",
  "import", "account", "notifications", "installments", "packages", "discounts", "refunds", "cash-close", "payroll", "journal", "accounts",
  "book-reports", "suppliers", "bills", "reconciliation",
];

async function axe(page: Page, where: string): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((v) => `${where}: ${v.id} (${v.nodes[0]?.target.join(" ")})`)).toEqual([]);
}

test("every staff screen passes axe, in light and dark", async ({ page }) => {
  test.setTimeout(240_000);
  const center = await makeCenter();
  await page.goto("login");
  await axe(page, "login");
  await page.goto("register");
  await axe(page, "register");
  await signIn(page, center.accounts.owner);
  for (const address of [...PAGES, `students/${center.students[0].id}`, `groups/${center.group.id}`, `lessons/${center.lesson.id}`]) {
    await page.goto(address);
    await settled(page);
    await axe(page, address);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  for (const address of ["students", "dashboard", "calendar", "debtors"]) {
    await page.goto(address);
    await settled(page);
    await axe(page, `${address} (dark)`);
  }
  await page.goto("students");
  await page.getByRole("button", { name: "O'quvchi qo'shish" }).click();
  await axe(page, "dialog");
});

test("on a phone nothing needs sideways scrolling and the menu opens", async ({ page }) => {
  test.setTimeout(180_000);
  const center = await makeCenter();
  await page.setViewportSize({ width: 375, height: 740 });
  await signIn(page, center.accounts.owner);
  const menu = page.getByRole("button", { name: "Menyu" });
  await menu.click();
  await page.getByRole("link", { name: "O'quvchilar", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "O'quvchilar" })).toBeVisible();
  await expect(page.getByRole("link", { name: "O'quvchilar", exact: true })).toBeHidden(); // the menu closed itself
  const wide: string[] = [];
  for (const address of [...PAGES, `students/${center.students[0].id}`, `groups/${center.group.id}`, `lessons/${center.lesson.id}`]) {
    await page.goto(address);
    await settled(page);
    // the month grid of a group scrolls inside its own box; the page itself must not
    const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (extra > 1) wide.push(`${address}: ${extra}px`);
  }
  expect(wide).toEqual([]);
});

test("the five languages: interface text changes, a person's name never does", async ({ page }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.owner);
  await page.goto(`students/${center.students[0].id}`);
  await settled(page);
  const language = page.locator("select.language");
  const expected: [string, string, string][] = [
    ["uz-cyrl", "uz-Cyrl", "Ўқувчилар"],
    ["uz-new", "uz-Latn", "Öquvçilar"],
    ["ru", "ru", "Ученики"],
    ["en", "en", "Students"],
    ["uz", "uz-Latn", "O'quvchilar"],
  ];
  for (const [value, tag, students] of expected) {
    await language.selectOption(value);
    await expect(page.locator("html")).toHaveAttribute("lang", tag);
    await expect(page.getByRole("navigation").getByRole("link", { name: students, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: center.students[0].name })).toBeVisible();
  }
  await language.selectOption("ru");
  await page.reload();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Ученики", exact: true })).toBeVisible();
});

test("a server rule is explained in the chosen language, with the request id for unknown codes", async ({ page }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.owner);
  await page.route("**/v1/students?*", (route) =>
    route.fulfill({ status: 418, contentType: "application/json", body: JSON.stringify({ error: { code: "brand_new_code", message: "x", request_id: "req-12345678", details: {} } }) }),
  );
  await page.goto("students");
  await expect(page.getByRole("alert")).toContainText("Kutilmagan xato yuz berdi.");
  await expect(page.getByRole("alert")).toContainText("So'rov ID: req-12345678");
  await page.unroute("**/v1/students?*");
  await page.getByRole("button", { name: "Qayta urinish" }).click();
  await expect(page.getByRole("link", { name: center.students[0].name })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
});
