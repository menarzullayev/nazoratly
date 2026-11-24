import { expect, make, staffLogin, test } from "./fixtures";
import type { Page } from "@playwright/test";

const CSV = [
  "full_name,phone,birth_date",
  "Aliyev Vali,+998901112233,2012-05-01",
  "Aliyev Vali,+998901112233,2012-05-01", // the same row twice
  "Qodirova Madina,90 765 43 21,2013-02-11",
  "Telefon Xato,12345,2010-01-01", // invalid phone
  ",+998907778899,2011-03-03", // no name
].join("\n");

async function openImport(page: Page) {
  const o = await make("owner");
  await page.goto("/ui/import");
  await staffLogin(page, o.email, o.password);
  await expect(page.getByRole("heading", { name: "1. Fayl" })).toBeVisible();
}

async function check(page: Page, text = CSV) {
  await page.locator("#text").fill(text);
  await page.getByRole("button", { name: "Tekshirish" }).click();
  await expect(page.getByRole("heading", { name: "3. Natija" })).toBeVisible();
}

const write = (page: Page) => page.getByRole("button", { name: "Yozish", exact: true });

test.describe("import wizard", () => {
  test("empty input asks for a file first", async ({ page }) => {
    await openImport(page);
    await page.getByRole("button", { name: "Tekshirish" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Avval fayl tanlang" })).toBeVisible();
  });

  test("preview counts ok, duplicate and error rows and lists the reasons", async ({ page }) => {
    await openImport(page);
    await check(page);
    const stats = page.locator("#stats .stat");
    await expect(stats.nth(0)).toContainText("5"); // total
    await expect(stats.nth(1)).toContainText("2"); // ready: Aliyev Vali once, Qodirova
    await expect(stats.nth(2)).toContainText("1"); // duplicate in the file
    await expect(stats.nth(3)).toContainText("2"); // bad phone, no name
    await expect(page.locator("#rows tr")).toHaveCount(5);
    await expect(page.locator("#rows")).toContainText("telefon noto'g'ri");
    await expect(page.locator("#rows")).toContainText("majburiy qiymat yo'q");
    await expect(page.locator("#rows")).toContainText("faylda 2-qatorda takrorlangan");
    await page.getByLabel("Faqat muammoli qatorlar").check();
    await expect(page.locator("#rows tr")).toHaveCount(3);
  });

  test("columns are mapped by their headers and can be changed", async ({ page }) => {
    await openImport(page);
    await check(page);
    await expect(page.locator("#map-full_name")).toHaveValue("0");
    await expect(page.locator("#map-phone")).toHaveValue("1");
    await page.locator("#map-phone").selectOption("");
    await expect(page.locator("#stats .stat").nth(3)).toContainText("1"); // only the missing name is left
  });

  test("a missing required column is named and nothing can be written", async ({ page }) => {
    await openImport(page);
    await page.locator("#text").fill("phone,birth_date\n+998901112233,2012-05-01");
    await page.getByRole("button", { name: "Tekshirish" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Majburiy ustunlar topilmadi: Ism familiya" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "4. Yozish" })).toBeHidden();
  });

  test("commit writes the ready rows and skips the problem rows", async ({ page }) => {
    await openImport(page);
    await check(page);
    page.once("dialog", (d) => d.accept());
    await write(page).click();
    await expect(page.locator("#done")).toContainText("Yozildi: 2 ta students");
    await expect(page.locator("#done")).toContainText("2 xato");
    await expect(page.locator("#done")).toContainText("1 takroriy");
  });

  test("declining the confirmation writes nothing", async ({ page }) => {
    await openImport(page);
    await check(page);
    page.once("dialog", (d) => d.dismiss());
    await write(page).click();
    await expect(page.locator("#done")).toHaveText("");
  });

  test("'abort on error' refuses everything and says nothing changed", async ({ page }) => {
    await openImport(page);
    await check(page);
    await page.getByLabel("Xatoli qatorlar").selectOption("abort");
    page.once("dialog", (d) => d.accept());
    await write(page).click();
    await expect(page.locator("#done")).toContainText("Yozilmadi, bazada hech narsa o'zgarmadi.");
    await expect(page.locator("#done")).toContainText("Birinchi xato:");
  });

  test("a second import of the same people finds them already in the database", async ({ page }) => {
    await openImport(page);
    await check(page, "full_name,phone\nTakror Bola,+998905550011");
    page.once("dialog", (d) => d.accept());
    await write(page).click();
    await expect(page.locator("#done")).toContainText("Yozildi: 1 ta students");
    await page.getByRole("button", { name: "Tekshirish" }).click();
    await expect(page.locator("#rows")).toContainText("bazada allaqachon bor");
  });

  test("leads and groups have their own column hints", async ({ page }) => {
    await openImport(page);
    await page.getByLabel("Nimani import qilamiz").selectOption("leads");
    await expect(page.locator("#hint")).toContainText("manba");
    await page.getByLabel("Nimani import qilamiz").selectOption("groups");
    await expect(page.locator("#hint")).toContainText("guruh nomi");
  });

  test("a CSV file can be chosen instead of pasting", async ({ page }) => {
    await openImport(page);
    await page.locator("#file").setInputFiles({ name: "bolalar.csv", mimeType: "text/csv", buffer: Buffer.from("full_name,phone\nFayl Bola,+998905550022\n") });
    await expect(page.getByRole("heading", { name: "3. Natija" })).toBeVisible();
    await expect(page.locator("#stats .stat").nth(1)).toContainText("1");
  });
});
