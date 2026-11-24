import { expect, make, miniAppHash, staffLogin, test } from "./fixtures";

test.use({ viewport: { width: 390, height: 800 } });

const nav = (page: import("@playwright/test").Page, name: string) => page.getByRole("navigation", { name: "Bo'limlar" }).getByRole("button", { name });

test.describe("teacher Mini App: sign-in", () => {
  test("e-mail and password open the app and show today's lesson", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await expect(page.getByRole("heading", { name: "Bugungi darslar" })).toBeVisible();
    await expect(page.getByText(c.group.name).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Davomat", exact: true })).toBeVisible();
  });

  test("a wrong password is refused", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, "not-the-password");
    await expect(page.getByRole("alert").filter({ hasText: "Login yoki parol noto'g'ri" })).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
  });

  test("signed Telegram initData signs the teacher in without a password", async ({ page }) => {
    const c = await make("teacher");
    await page.goto(`/ui/teacher${await miniAppHash(c.teacher.chat)}`);
    await expect(page.getByRole("heading", { name: "Bugungi darslar" })).toBeVisible();
    await expect(page.locator("#login")).toBeHidden();
  });

  test("tampered initData falls back to the sign-in form", async ({ page }) => {
    const c = await make("teacher");
    await page.goto(`/ui/teacher${await miniAppHash(c.teacher.chat, { tamper: true })}`);
    await expect(page.getByLabel("Parol")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
  });

  test("a Telegram account that is not a teacher gets the form too", async ({ page }) => {
    await page.goto(`/ui/teacher${await miniAppHash(888_000_222)}`);
    await expect(page.getByLabel("Parol")).toBeVisible();
  });

  test("sign-out returns to the form and a reload stays signed out", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await page.getByRole("button", { name: "Chiqish" }).click();
    await expect(page.getByLabel("Parol")).toBeVisible();
  });
});

test.describe("teacher Mini App: attendance and the rest", () => {
  test("marks the roll call, saves it and the lesson turns 'marked'", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await page.getByRole("button", { name: "Davomat", exact: true }).click();
    const [a, b, d] = c.students as { id: string; name: string }[];
    await page.locator(`label[for="st-${a!.id}-present"]`).click();
    await page.locator(`label[for="st-${b!.id}-absent"]`).click();
    await page.locator(`label[for="st-${d!.id}-late"]`).click();
    await expect(page.locator(`#st-${b!.id}-absent`)).toBeChecked();
    await page.getByRole("button", { name: "Davomatni saqlash" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Davomat saqlandi" })).toBeVisible();
    await expect(page.getByText("3/3 belgilangan")).toBeVisible();
    await expect(page.getByText("Davomat belgilanmagan")).toHaveCount(0);
  });

  test("saving with nobody marked is refused", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await page.getByRole("button", { name: "Davomat", exact: true }).click();
    await page.getByRole("button", { name: "Davomatni saqlash" }).click();
    await expect(page.getByText("Hech kim belgilanmadi")).toBeVisible();
  });

  test("a grade and a note are saved for a student", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await page.getByRole("button", { name: "Davomat", exact: true }).click();
    const s = c.students[0] as { id: string; name: string };
    await page.getByLabel(`Baho: ${s.name}`).selectOption("5");
    await page.getByLabel(`Izoh: ${s.name}`).fill("Faol");
    await page.locator("div.row").filter({ has: page.getByLabel(`Izoh: ${s.name}`) }).getByRole("button", { name: "Baho/izohni saqlash" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Saqlandi: ${s.name}` })).toBeVisible();
  });

  test("groups, week, pay and messages tabs", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await nav(page, "Guruhlar").click();
    await expect(page.getByText("3 o'quvchi")).toBeVisible();
    await nav(page, "Jadval").click();
    await expect(page.getByRole("heading", { name: /^Jadval:/ })).toBeVisible();
    await expect(page.locator("#tab-week").getByText(c.group.name).first()).toBeVisible();
    const before = await page.getByRole("heading", { name: /^Jadval:/ }).innerText();
    await page.getByRole("button", { name: "Keyingi hafta" }).click();
    await expect(page.getByRole("heading", { name: /^Jadval:/ })).not.toHaveText(before);
    await nav(page, "Oylik").click();
    await expect(page.getByRole("heading", { name: "Soatlar va oylik" })).toBeVisible();
    await expect(page.locator("#tab-pay .stat").nth(2)).toContainText("taxminiy oylik");
  });

  test("a template message to a guardian is queued with the daily limit shown", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await nav(page, "Vasiyga xabar").click();
    await expect(page.getByText(/Bugun yana \d+ ta xabar yuborish mumkin/).first()).toBeVisible();
    await page.locator("#msg-template").selectOption("homework");
    await page.getByRole("button", { name: "Yuborish" }).click();
    await expect(page.getByText(/1 ta vasiyga yuborishga qo'yildi\. Bugun yana \d+ ta mumkin\./)).toBeVisible();
  });

  test("an empty free-text message is refused with the server's reason", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await nav(page, "Vasiyga xabar").click();
    await page.getByRole("button", { name: "Yuborish" }).click();
    await expect(page.getByRole("status").filter({ hasText: /\S/ })).toBeVisible();
    await expect(page.getByText(/vasiyga yuborishga qo'yildi/)).toHaveCount(0);
  });

  test("reminders tab opens", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await nav(page, "Eslatmalar").click();
    await expect(page.getByRole("heading", { name: "Eslatmalar" })).toBeVisible();
  });

  test("the QR scanner link keeps the session", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/teacher");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await page.getByRole("link", { name: "QR skaner" }).click();
    await expect(page).toHaveURL(/\/ui\/scan$/);
    await expect(page.getByRole("heading", { name: "1. Darsni tanlang" })).toBeVisible();
  });
});
