import { botContact, botMessage, botTexts, botUpdate, expect, make, miniAppHash, ownerApi, pdfHead, test, type Json } from "./fixtures";
import type { Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 800 } });

/** Portal sign-in: phone, then the 6-digit code that the fake Telegram "delivered" to the guardian's own chat. */
async function portalLogin(page: Page, fam: Json) {
  await page.goto("/ui/guardian");
  await page.getByLabel("Telefon raqami").fill(fam.phone);
  await page.getByRole("button", { name: "Kod yuborish" }).click();
  await expect(page.getByRole("heading", { name: "Kodni kiriting" })).toBeVisible();
  const texts = await botTexts(fam.chat);
  const code = texts.at(-1)!.match(/kodi: (\d{6})/)![1]!;
  await page.getByLabel("Kod", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Kirish" }).click();
}
const tab = (page: Page, name: string) => page.getByRole("navigation", { name: "Bo'limlar" }).getByRole("button", { name });
const items = (r: Json): Json[] => (Array.isArray(r) ? r : ((r.items ?? []) as Json[]));

test.describe("portal sign-in by a one-time code", () => {
  test("phone, code from the bot chat, then the cabinet", async ({ page }) => {
    const fam = await make("family");
    await portalLogin(page, fam);
    await expect(page.locator("#who")).toContainText(`${fam.guardian.name}`);
    await expect(page.getByRole("button", { name: fam.student.name })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: /Davomat/ })).toBeVisible();
    await page.getByRole("button", { name: "Chiqish" }).click();
    await expect(page.getByRole("heading", { name: "Kirish" })).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
  });

  test("a wrong code is refused and the form stays", async ({ page }) => {
    const fam = await make("family-bare");
    await page.goto("/ui/guardian");
    await page.getByLabel("Telefon raqami").fill(fam.phone);
    await page.getByRole("button", { name: "Kod yuborish" }).click();
    await page.getByLabel("Kod", { exact: true }).fill("000000");
    await page.getByRole("button", { name: "Kirish" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Kod noto'g'ri" })).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
  });

  test("an unknown phone gets the same screen and no cabinet (no enumeration)", async ({ page }) => {
    await page.goto("/ui/guardian");
    await page.getByLabel("Telefon raqami").fill("+998900000001");
    await page.getByRole("button", { name: "Kod yuborish" }).click();
    await expect(page.getByRole("heading", { name: "Kodni kiriting" })).toBeVisible();
    await page.getByLabel("Kod", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Kirish" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Kod noto'g'ri" })).toBeVisible();
  });

  test("the back button returns to the phone step", async ({ page }) => {
    const fam = await make("family-bare");
    await page.goto("/ui/guardian");
    await page.getByLabel("Telefon raqami").fill(fam.phone);
    await page.getByRole("button", { name: "Kod yuborish" }).click();
    await page.getByRole("button", { name: "Orqaga" }).click();
    await expect(page.getByLabel("Telefon raqami")).toBeVisible();
  });

  test("a session survives a reload and sign-out ends it", async ({ page }) => {
    const fam = await make("family-bare");
    await portalLogin(page, fam);
    await expect(page.locator("#app")).toBeVisible();
    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    await page.getByRole("button", { name: "Chiqish" }).click();
    await page.reload();
    await expect(page.getByLabel("Telefon raqami")).toBeVisible();
  });
});

test.describe("the four ways to link, then the cabinet", () => {
  test("one-time code: the guardian sends it to the bot, then signs in to the portal", async ({ page }) => {
    const fam = await make("unlinked", "code");
    expect(await botUpdate(botMessage(fam.chat, `/start ${fam.code}`))).toBe(200);
    // a code creates its own guardian record (no phone on file): the linked Telegram account signs in as a Mini App
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await expect(page.getByRole("heading", { name: "Rozilik" })).toBeVisible();
    await page.getByRole("button", { name: "Roziman" }).click();
    await expect(page.getByRole("heading", { name: /Davomat/ })).toBeVisible();
  });

  test("phone: Telegram's own contact card links, someone else's does not", async ({ page }) => {
    const fam = await make("unlinked", "phone");
    await botUpdate(botContact(fam.chat, fam.phone, fam.chat + 1)); // not his own card: no proof
    await page.goto("/ui/guardian");
    await page.getByLabel("Telefon raqami").fill(fam.phone);
    await page.getByRole("button", { name: "Kod yuborish" }).click();
    expect((await botTexts(fam.chat)).some((t) => /kodi: \d{6}/.test(t))).toBe(false);
    await botUpdate(botContact(fam.chat, fam.phone));
    await portalLogin(page, fam);
    await expect(page.locator("#who")).toContainText(fam.guardian.name);
    await page.getByRole("button", { name: "Roziman" }).click();
    await expect(page.getByRole("heading", { name: /Davomat/ })).toBeVisible();
  });

  test("QR card: nothing opens until the center approves the request", async ({ page }) => {
    const fam = await make("unlinked", "qr");
    await botUpdate(botMessage(fam.chat, fam.qr));
    const list = items(await ownerApi(fam.owner, "GET", "/v1/guardian/link-requests"));
    expect(list).toHaveLength(1);
    // before the approval the Telegram user is not linked to any student
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await expect(page.getByRole("alert").filter({ hasText: "ulanmagan" })).toBeVisible();
    const done = await ownerApi(fam.owner, "POST", `/v1/guardian/link-requests/${list[0]!.id}/approve`, { relation: "mother" });
    expect(done.status).toBe("approved");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await page.reload();
    await expect(page.locator("#who")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Rozilik" })).toBeVisible();
  });

  test("manual link by the center: portal works at once", async ({ page }) => {
    const fam = await make("unlinked", "manual");
    await portalLogin(page, fam);
    await expect(page.getByRole("heading", { name: /Davomat/ })).toBeVisible();
  });
});

test.describe("Telegram Mini App sign-in with signed initData", () => {
  test("valid data opens the cabinet without a phone or code", async ({ page }) => {
    const fam = await make("family");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await expect(page.locator("#who")).toContainText(fam.guardian.name);
    await expect(page.getByRole("heading", { name: /Davomat/ })).toBeVisible();
  });

  test("tampered data is refused with a message and the phone form", async ({ page }) => {
    const fam = await make("family");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat, { tamper: true })}`);
    await expect(page.getByRole("alert").filter({ hasText: /not valid|expired/i })).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
  });

  test("expired data (older than a day) is refused", async ({ page }) => {
    const fam = await make("family");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat, { age: 3 * 24 * 3600 })}`);
    await expect(page.locator("#app")).toBeHidden();
    await expect(page.getByLabel("Telefon raqami")).toBeVisible();
  });

  test("an unlinked Telegram account is told to send the center's code", async ({ page }) => {
    await page.goto(`/ui/guardian${await miniAppHash(777_000_111)}`);
    await expect(page.getByRole("alert").filter({ hasText: "ulanmagan" })).toBeVisible();
  });
});

test.describe("consent and the tabs", () => {
  test("nothing is shown before the consent is accepted", async ({ page }) => {
    const fam = await make("family-unconsented");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await expect(page.getByRole("heading", { name: "Rozilik" })).toBeVisible();
    await expect(page.locator("#content")).toBeHidden();
    await page.getByRole("button", { name: "Roziman" }).click();
    await expect(page.locator("#content")).toBeVisible();
  });

  test("attendance, balance with the payment plan, schedule and results", async ({ page }) => {
    const fam = await make("family");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await expect(page.getByText("kechikdi (7 daq)")).toBeVisible();
    await tab(page, "Qarz va to'lov").click();
    await expect(page.getByText("500 000 so'm").first()).toBeVisible();
    await expect(page.getByText("muddati o'tgan").first()).toBeVisible();
    await expect(page.getByText("kutilmoqda").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "So'nggi to'lovlar" })).toBeVisible();
    await tab(page, "Jadval").click();
    await expect(page.getByRole("heading", { name: "Yaqin 30 kun" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Haftalik jadval" })).toBeVisible();
    await tab(page, "Natijalar").click();
    await expect(page.getByText("Zo'r")).toBeVisible();
    await expect(page.getByText(/30(\.00)? \/ 40(\.00)?/)).toBeVisible();
  });
});

test.describe("documents: PDF download", () => {
  test("receipt and invoice are listed and download as real PDFs", async ({ page }) => {
    const fam = await make("family");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await tab(page, "Hujjatlar").click();
    await expect(page.getByRole("cell", { name: fam.receipt })).toBeVisible();
    await expect(page.getByRole("cell", { name: fam.invoice })).toBeVisible();
    for (const number of [fam.receipt, fam.invoice]) {
      const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("row", { name: new RegExp(number) }).getByRole("button", { name: "PDF" }).click()]);
      expect(dl.suggestedFilename()).toBe(`${number}.pdf`);
      const head = (await pdfHead((await dl.path())!)).split("|");
      expect(head[0]).toBe("%PDF-");
      expect(head[1]).toContain("%%EOF");
      expect(Number(head[2])).toBeGreaterThan(1500);
    }
  });

  test("the approved monthly report downloads as a PDF", async ({ page }) => {
    const fam = await make("family");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await tab(page, "Natijalar").click();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Oylik hisobot/ }).click()]);
    expect((await pdfHead((await dl.path())!)).startsWith("%PDF-")).toBe(true);
  });

  test("the certificate downloads as a PDF", async ({ page }) => {
    const fam = await make("certificate");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await tab(page, "Natijalar").click();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: new RegExp(`Sertifikat ${fam.certificate}`) }).click()]);
    expect(dl.suggestedFilename()).toBe(`${fam.certificate}.pdf`);
    expect((await pdfHead((await dl.path())!)).startsWith("%PDF-")).toBe(true);
  });
});

test.describe("requests wait for the center's approval", () => {
  test("a payment promise shows as pending approval and can be withdrawn", async ({ page }) => {
    const fam = await make("family");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await tab(page, "Qarz va to'lov").click();
    const d = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    await page.getByLabel("Qaysi sanagacha to'layman").fill(d);
    await page.getByRole("button", { name: "Markazga yuborish" }).click();
    await expect(page.getByText("So'rov markazga yuborildi.")).toBeVisible();
    await tab(page, "So'rovlar").click();
    const row = page.getByRole("row", { name: /To'lov va'dasi/ });
    await expect(row.getByText("kutilmoqda")).toBeVisible();
    await expect(page.getByText("Har bir so'rov markaz tasdiqlagandan keyingina kuchga kiradi.")).toBeVisible();
    await row.getByRole("button", { name: "Qaytarib olish" }).click();
    await expect(page.getByRole("row", { name: /To'lov va'dasi/ }).getByText("bekor qilindi")).toBeVisible();
  });

  test("an absence reason is pending, then approved by the center and shown as such", async ({ page }) => {
    const fam = await make("family");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await tab(page, "So'rovlar").click();
    await page.getByLabel("Sabab").fill("Kasal");
    await page.getByRole("button", { name: "Markazga yuborish" }).click();
    const row = page.getByRole("row", { name: /Darsga kela olmaslik/ });
    await expect(row.getByText("kutilmoqda")).toBeVisible();
    const pending = items(await ownerApi(fam.owner, "GET", "/v1/guardian/requests?status=pending"));
    expect(pending).toHaveLength(1);
    await ownerApi(fam.owner, "POST", `/v1/guardian/requests/${pending[0]!.id}/approve`, {});
    await page.reload();
    await tab(page, "So'rovlar").click();
    await expect(page.getByRole("row", { name: /Darsga kela olmaslik/ }).getByText("tasdiqlandi")).toBeVisible();
  });

  test("an empty reason is refused by the form (required)", async ({ page }) => {
    const fam = await make("family");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await tab(page, "So'rovlar").click();
    await page.getByRole("button", { name: "Markazga yuborish" }).click();
    await expect(page.getByRole("row", { name: /Darsga kela olmaslik/ })).toHaveCount(0);
  });

  test("a make-up choice is pending approval", async ({ page }) => {
    const fam = await make("makeup");
    await page.goto(`/ui/guardian${await miniAppHash(fam.chat)}`);
    await tab(page, "So'rovlar").click();
    await expect(page.getByRole("heading", { name: "Qoplash darsi" })).toBeVisible();
    await page.getByLabel("Vaqtni tanlang").selectOption({ index: 0 });
    await page.getByRole("button", { name: "Markazga yuborish" }).last().click();
    await expect(page.getByRole("row", { name: /Qoplash darsi/ }).getByText("kutilmoqda")).toBeVisible();
  });
});
