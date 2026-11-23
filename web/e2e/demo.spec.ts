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

const ROLE_PAGES = [
  { path: "/", owner: "Egasi", teacher: "O'qituvchi", guardian: "Vasiy", tabs: { attendance: "Davomat", payments: "To'lov", reminders: "Eslatma", payroll: "Oylik" }, prepare: "Loyihalarni tayyorlash", approve: "Tasdiqlab yuborish" },
  { path: "/ru/", owner: "Владелец", teacher: "Преподаватель", guardian: "Родитель", tabs: { attendance: "Посещаемость", payments: "Оплата", reminders: "Напоминание", payroll: "Зарплата" }, prepare: "Подготовить черновики", approve: "Подтвердить и отправить" },
  { path: "/en/", owner: "Owner", teacher: "Teacher", guardian: "Guardian", tabs: { attendance: "Attendance", payments: "Payment", reminders: "Reminder", payroll: "Payroll" }, prepare: "Prepare drafts", approve: "Approve and send" },
];

for (const p of ROLE_PAGES) {
  test.describe(`roles ${p.path}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(p.path);
      await page.locator("#demo").scrollIntoViewIfNeeded();
    });

    test("owner is the default and sees all four tabs", async ({ page }) => {
      const demo = page.locator("#demo");
      await expect(demo.getByRole("radio")).toHaveCount(3);
      await expect(demo.getByRole("radio", { name: p.owner })).toBeChecked();
      await expect(demo.getByRole("tab")).toHaveCount(4);
    });

    test("teacher sees only attendance and payroll, and only their own group", async ({ page }) => {
      const demo = page.locator("#demo");
      await demo.getByRole("radio", { name: p.teacher }).click();
      await expect(demo.getByRole("radio", { name: p.teacher })).toBeChecked();
      await expect(demo.getByRole("tab")).toHaveCount(2);
      await expect(demo.getByRole("tab", { name: p.tabs.payments })).toHaveCount(0);
      await expect(demo.getByRole("tab", { name: p.tabs.reminders })).toHaveCount(0);
      await expect(demo.locator("#att-group option")).toHaveCount(1);
      await expect(demo.getByRole("group")).toHaveCount(4); // the four students of the first teacher's group
      await demo.getByRole("tab", { name: p.tabs.payroll }).click();
      await expect(demo.locator("dd[aria-live]")).toContainText("270 000");
      await expect(demo.locator("#pay-teacher")).toHaveCount(0);
    });

    test("switching the teacher switches the group and the payroll", async ({ page }) => {
      const demo = page.locator("#demo");
      await demo.getByRole("radio", { name: p.teacher }).click();
      const other = demo.locator("select").first();
      await other.selectOption({ index: 1 });
      await expect(demo.locator("#att-group option")).toHaveCount(1);
      await expect(demo.locator("#att-group option")).toContainText(/Matematika|Математика|Math/);
      await demo.getByRole("tab", { name: p.tabs.payroll }).click();
      await expect(demo.locator("dd[aria-live]")).not.toContainText("270 000");
    });

    test("guardian sees only the bot: the /qarz answer for their own child, and what the owner approved", async ({ page }) => {
      const demo = page.locator("#demo");
      await demo.getByRole("radio", { name: p.guardian }).click();
      await expect(demo.getByRole("tablist")).toHaveCount(0);
      await expect(demo.getByText("/qarz")).toBeVisible();
      await expect(demo.getByText("800 000").first()).toBeVisible(); // Madina: the balance answer
      await expect(demo.getByText("Jami qoldiq")).toHaveCount(0); // no reminder yet
      await expect(demo.locator("option")).toHaveCount(2); // only guardians who consented
      expect(await demo.innerText()).not.toMatch(/NaN|undefined/);

      await demo.getByRole("radio", { name: p.owner }).click();
      await demo.getByRole("tab", { name: p.tabs.reminders }).click();
      await demo.getByRole("button", { name: p.prepare }).click();
      await demo.getByRole("button", { name: p.approve }).first().click();
      await demo.getByRole("button", { name: p.approve }).first().click();
      await demo.getByRole("radio", { name: p.guardian }).click();
      await expect(demo.getByText("Jami qoldiq")).toHaveCount(1); // the approved reminder arrived
    });

    test("role buttons work with the arrow keys", async ({ page }) => {
      const demo = page.locator("#demo");
      await demo.getByRole("radio", { name: p.owner }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(demo.getByRole("radio", { name: p.teacher })).toBeFocused();
      await expect(demo.getByRole("radio", { name: p.teacher })).toBeChecked();
      await page.keyboard.press("ArrowLeft");
      await expect(demo.getByRole("radio", { name: p.owner })).toBeChecked();
    });
  });
}

test("the role buttons are in the Cyrillic script on /uz-cyrl/", async ({ page }) => {
  await page.goto("/uz-cyrl/");
  await page.locator("#demo").scrollIntoViewIfNeeded();
  for (const r of await page.locator("#demo").getByRole("radio").all()) await expect(r).toHaveText(/[Ѐ-ӿ]/);
});
