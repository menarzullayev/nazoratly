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
  // 320px, narrower than common phones: text is wider with some systems' fonts than on the developer's machine
  await page.setViewportSize({ width: 320, height: 740 });
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

// the file field, the column mapping and the preview only show after a file is chosen, and their labels differ by language
test("on a phone the import screen stays within the width in all five languages, before and after the preview", async ({ page }) => {
  const center = await makeCenter();
  await page.setViewportSize({ width: 320, height: 740 });
  await signIn(page, center.accounts.owner);
  await page.goto("import");
  await settled(page);
  const wide: string[] = [];
  const measure = async (what: string): Promise<void> => {
    const found = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      const extra = document.documentElement.scrollWidth - limit;
      const culprits = [...document.querySelectorAll("main *")]
        .filter((e) => e.getBoundingClientRect().right > limit + 1 && !e.closest(".table-wrap"))
        .slice(0, 4)
        .map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute("type") ?? e.className}] ${Math.round(e.getBoundingClientRect().right)}`);
      return extra > 1 ? `${extra}px ${culprits.join(", ")}` : "";
    });
    if (found) wide.push(`${what}: ${found}`);
  };
  const languages = ["uz", "uz-cyrl", "uz-new", "ru", "en"];
  for (const language of languages) {
    await page.locator("select.language").selectOption(language);
    await measure(`${language}, empty`);
  }
  await page.locator('input[type="file"]').setInputFiles({
    name: "oquvchilar-royxati-sentabr-oktabr-2026-yakuniy.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(["F.I.Sh.,Telefon,JudaUzunUstunNomiBoshJoysizKelganHolat", "Tekshiruv Bolasi,+998901234567,x"].join(String.fromCharCode(10))),
  });
  await page.locator("main button.primary").first().click();
  await expect(page.locator(".mapping")).toBeVisible();
  for (const language of languages) {
    await page.locator("select.language").selectOption(language);
    await measure(`${language}, preview`);
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
