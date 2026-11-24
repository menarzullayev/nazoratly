import { expect, make, staffLogin, test } from "./fixtures";

test.describe("calendar", () => {
  test("week view shows today's lesson with its group and teacher/room line", async ({ page }) => {
    const c = await make("calendar");
    await page.goto("/ui/calendar");
    await staffLogin(page, c.owner.email, c.owner.password);
    await expect(page.locator("#grid .cal-day")).toHaveCount(7);
    await expect(page.locator("#grid .cal-entry").filter({ hasText: "14:00-15:00" }).first()).toContainText(c.group.name);
    await expect(page.locator("#grid .cal-entry").first()).toContainText("1 o'quvchi");
  });

  test("day view, previous/next and 'Bugun' move the range", async ({ page }) => {
    const c = await make("calendar");
    await page.goto("/ui/calendar");
    await staffLogin(page, c.owner.email, c.owner.password);
    await page.getByLabel("Ko'rinish").selectOption("day");
    await expect(page.locator("#grid .cal-day")).toHaveCount(1);
    const first = await page.locator("#range").innerText();
    await page.getByRole("button", { name: "Keyingi" }).click();
    await expect(page.locator("#range")).not.toHaveText(first);
    await expect(page.locator("#grid .cal-entry.cancelled")).toContainText("Bekor qilingan");
    await page.getByRole("button", { name: "Oldingi" }).click();
    await expect(page.locator("#range")).toHaveText(first);
    await page.getByRole("button", { name: "Keyingi" }).click();
    await page.getByRole("button", { name: "Bugun" }).click();
    await expect(page.locator("#range")).toHaveText(first);
  });

  test("a cancelled lesson's guardian draft waits; approving needs a person's click", async ({ page }) => {
    const c = await make("calendar");
    await page.goto("/ui/calendar");
    await staffLogin(page, c.owner.email, c.owner.password);
    await expect(page.locator("#notice-count")).toHaveText("1");
    await expect(page.getByText("Siz tasdiqlamaguncha hech narsa yuborilmaydi.")).toBeVisible();
    await expect(page.locator("#notices")).toContainText(c.guardian.name);
    await page.getByRole("button", { name: "Tasdiqlash va yuborish" }).click();
    await expect(page.locator("#notice-count")).toHaveText("0");
    await expect(page.locator("#notice-msg")).toHaveText("Kutayotgan loyiha yo'q.");
  });

  test("rejecting a draft removes it too", async ({ page }) => {
    const c = await make("calendar");
    await page.goto("/ui/calendar");
    await staffLogin(page, c.owner.email, c.owner.password);
    await page.getByRole("button", { name: "Rad etish" }).click();
    await expect(page.locator("#notice-count")).toHaveText("0");
  });

  test("wrong password is refused", async ({ page }) => {
    const c = await make("calendar");
    await page.goto("/ui/calendar");
    await staffLogin(page, c.owner.email, "wrong-password-123");
    await expect(page.getByRole("alert").filter({ hasText: "Login yoki parol noto'g'ri" })).toBeVisible();
  });

  test("a teacher sees the calendar but not the guardian drafts", async ({ page }) => {
    const c = await make("teacher");
    await page.goto("/ui/calendar");
    await staffLogin(page, c.teacher.email, c.teacher.password);
    await expect(page.locator("#grid .cal-day")).toHaveCount(7);
    await expect(page.locator("#notices-card")).toBeHidden();
  });
});
