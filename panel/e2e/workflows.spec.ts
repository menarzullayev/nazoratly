/** Each role does its real work from beginning to end through the screens, against the real API and PostgreSQL; what the
 * screens say happened is then read back from the server. */

import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { dialog, directApi, expect, fakeCamera, makeCenter, open, settled, signIn, test } from "./fixtures";

const today = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date());
const plus = (days: number): string => new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Submits the open dialog and waits for it to close. */
async function submit(page: Page, button = "Saqlash"): Promise<void> {
  await dialog(page).getByRole("button", { name: button, exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}

const field = (page: Page, label: string) => dialog(page).getByLabel(new RegExp(`^${label.replace(/[()?]/g, "\\$&")}( \\(ixtiyoriy\\))?$`));

async function pickStudent(page: Page, name: string): Promise<void> {
  await field(page, "O'quvchi").fill(name.slice(0, 12));
  await dialog(page).getByRole("button", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
}

const row = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });

test("owner: sets up teaching, enrolls a student, runs the schedule and approves the notice", async ({ page }) => {
  test.setTimeout(240_000);
  const center = await makeCenter();
  await signIn(page, center.accounts.owner);
  const api = await directApi(center.accounts.owner);

  await open(page, "Kurslar");
  await page.getByRole("button", { name: "Kurs qo'shish" }).click();
  await field(page, "Nomi").fill("Robototexnika");
  await field(page, "Oylik to'lov (standart)").fill("450 000");
  await submit(page);
  await expect(row(page, "Robototexnika")).toContainText("450 000");
  await row(page, "Robototexnika").getByRole("button", { name: "Tahrirlash" }).click();
  await field(page, "Tavsif").fill("Shanba kunlari");
  await submit(page);
  await expect(row(page, "Robototexnika")).toContainText("Shanba kunlari");

  await open(page, "Ustozlar");
  await page.getByRole("button", { name: "Ustoz qo'shish" }).click();
  await field(page, "F.I.Sh.").fill("Aziza Karimova");
  await field(page, "Stavka").fill("90000");
  await submit(page);
  await expect(row(page, "Aziza Karimova")).toBeVisible();

  await open(page, "Xonalar");
  await page.getByRole("button", { name: "Xona qo'shish" }).click();
  await field(page, "Nomi").fill("201-xona");
  await field(page, "Xona sig'imi").fill("12");
  await submit(page);
  await expect(row(page, "201-xona")).toContainText("12");

  await open(page, "Guruhlar");
  await page.getByRole("button", { name: "Guruh ochish" }).click();
  await field(page, "Kurs").selectOption({ label: "Robototexnika" });
  await field(page, "Nomi").fill("RB-1");
  await field(page, "Ustoz").selectOption({ label: "Aziza Karimova" });
  await submit(page);
  await expect(page).toHaveURL(/\/app\/groups\/[0-9a-f-]{36}$/);
  const groupId = page.url().split("/").pop()!;

  await page.getByRole("region", { name: "Haftalik jadval" }).getByRole("button", { name: "Tahrirlash" }).click();
  await dialog(page).getByRole("button", { name: "Dars vaqti qo'shish" }).click();
  await dialog(page).getByLabel("Hafta kuni").selectOption({ label: "Dushanba" });
  await dialog(page).getByLabel("Boshlanishi").fill("15:00");
  await dialog(page).getByLabel("Tugashi").fill("16:30");
  await dialog(page).getByLabel("Xona").selectOption({ label: "201-xona" });
  await dialog(page).getByRole("button", { name: "Saqlash" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Haftalik jadval" })).toContainText("15:00–16:30");

  await page.getByRole("button", { name: "Jadvaldan darslar yaratish" }).click();
  await field(page, "Boshlanishi").fill(plus(1));
  await field(page, "Tugashi").fill(plus(15));
  await submit(page);
  await expect(page.getByText(/Yaratildi: [23]\./)).toBeVisible();

  await open(page, "O'quvchilar");
  await page.getByRole("button", { name: "O'quvchi qo'shish" }).click();
  await field(page, "F.I.Sh.").fill("Sardor Aliyev");
  await field(page, "Telefon").fill("+998901112233");
  await submit(page);
  await expect(page.getByRole("heading", { level: 1, name: "Sardor Aliyev" })).toBeVisible();
  const studentId = page.url().split("/").pop()!;

  await open(page, "Vasiylar");
  await page.getByRole("button", { name: "Vasiy qo'shish" }).click();
  await field(page, "F.I.Sh.").fill("Aliyeva Nodira");
  await field(page, "Telegram chat ID").fill(String(6_000_000 + Math.floor(Math.random() * 1_000_000)));
  await submit(page);
  await expect(row(page, "Aliyeva Nodira")).toContainText("Ha");

  await page.goto(`students/${studentId}`);
  await page.getByRole("button", { name: "Vasiy bog'lash" }).click();
  await field(page, "Vasiy").fill("Aliyeva");
  await dialog(page).getByRole("button", { name: /Aliyeva Nodira/ }).click();
  await field(page, "Qarindoshligi").selectOption({ label: "Onasi" });
  await submit(page);
  await expect(row(page, "Aliyeva Nodira")).toContainText("Onasi");

  await page.getByRole("button", { name: "Rozilik qayd etish" }).click();
  await field(page, "Maqsad").selectOption({ label: "Bildirishnomalar" });
  await field(page, "Kim berdi").selectOption({ label: "Aliyeva Nodira" });
  await submit(page);
  await expect(row(page, "Bildirishnomalar")).toContainText("Amalda");

  await page.getByRole("button", { name: "Guruhga yozish" }).click();
  await field(page, "Guruh").selectOption({ label: "RB-1" });
  await field(page, "Boshlagan sana").fill(plus(-1));
  await submit(page);
  const enrolled = page.getByRole("region", { name: "Guruhlari" });
  await expect(enrolled).toContainText("RB-1");
  await enrolled.getByRole("button", { name: "Tahrirlash" }).click();
  await field(page, "Chegirma (%)").fill("10");
  await submit(page);
  await expect(enrolled).toContainText("405 000");

  // move one lesson on the calendar: a guardian message draft appears and is sent only after approval
  const lessons = (await api("GET", `/v1/lessons?group_id=${groupId}&date_from=${plus(1)}&date_to=${plus(15)}`)).body.items as any[];
  const lesson = lessons[0];
  await open(page, "Taqvim");
  await page.getByRole("button", { name: "Kun", exact: true }).click();
  await page.getByLabel("Sana").fill(lesson.lesson_date);
  const entry = page.getByRole("listitem").filter({ hasText: "RB-1" });
  await entry.getByRole("button", { name: "Ko'chirish" }).click();
  await field(page, "Boshlanishi").fill("17:00");
  await field(page, "Tugashi").fill("18:30");
  await field(page, "Sabab").fill("Ustoz iltimosi");
  await submit(page);
  await expect(entry).toContainText("17:00–18:30");
  await entry.getByRole("button", { name: "O'rinbosar" }).click();
  await field(page, "O'rinbosar ustoz").selectOption({ index: 1 });
  await submit(page);

  await open(page, "Jadval xabarlari");
  const notice = row(page, "Sardor Aliyev").first();
  await notice.getByRole("button", { name: "Tasdiqlab yuborish" }).click();
  await submit(page, "Tasdiqlab yuborish");
  await expect.poll(async () => (await api("GET", "/v1/outbox?limit=50")).body.items.filter((m: any) => m.student_id === studentId).length).toBe(1);

  await page.goto(`lessons/${lessons[1].id}`);
  await page.getByRole("button", { name: "Darsni bekor qilish" }).click();
  await field(page, "Sabab").fill("Bayram");
  await submit(page, "Darsni bekor qilish");
  await expect(page.getByRole("region", { name: "O'zgarishlar tarixi" })).toContainText("Bekor qilindi");
  await open(page, "Jadval xabarlari");
  await row(page, "Sardor Aliyev").first().getByRole("button", { name: "Rad etish" }).click();
  await submit(page, "Rad etish");

  await open(page, "Jadval tekshiruvi");
  await settled(page);

  // the QR card: issued to everyone, downloaded as a real PDF, queued for the guardian
  await open(page, "O'quvchilar");
  await page.getByRole("button", { name: "Hamma o'quvchiga QR kod berish" }).click();
  await submit(page, "Hamma o'quvchiga QR kod berish");
  await expect(page.getByText(/\d+ ta o'quvchiga kod berildi/)).toBeVisible();
  await page.goto(`students/${studentId}`);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Kartani yuklab olish (PDF)" }).click();
  expect((await readFile(await (await download).path())).subarray(0, 5).toString()).toBe("%PDF-");
  await page.getByRole("button", { name: "Kartani vasiyga yuborish" }).click();
  await field(page, "Vasiy").selectOption({ label: "Aliyeva Nodira" });
  await submit(page, "Tasdiqlab yuborish");
  await expect(page.getByText("Yuborish navbatiga qo'yildi")).toBeVisible();
  await page.goto(`groups/${groupId}`);
  const cards = page.waitForEvent("download");
  await page.getByRole("button", { name: "Guruh QR kartalari (PDF)" }).click();
  expect((await readFile(await (await cards).path())).subarray(0, 5).toString()).toBe("%PDF-");
  await settled(page);
});

test("owner: center profile, a branch and the dashboard", async ({ page }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.owner);
  await settled(page);
  await expect(page.getByRole("region", { name: "To'lamaganlar" })).toContainText(center.students[0].name);

  await open(page, "Markaz");
  await page.getByRole("button", { name: "Tahrirlash" }).click();
  await field(page, "Yuridik nomi").fill("Sinov MChJ");
  await field(page, "STIR / JShShIR").fill("123456789");
  await submit(page);
  await expect(page.getByText("Sinov MChJ")).toBeVisible();

  await open(page, "Filiallar");
  await page.getByRole("button", { name: "Filial qo'shish" }).click();
  await field(page, "Nomi").fill("Sergeli filiali");
  await submit(page);
  await expect(page.getByTestId("branch").getByRole("option", { name: "Sergeli filiali" })).toBeAttached();
  await row(page, "Sergeli filiali").getByRole("button", { name: "Tahrirlash" }).click();
  await field(page, "Manzil").fill("Sergeli 5");
  await submit(page);
  await expect(row(page, "Sergeli filiali")).toContainText("Sergeli 5");
  await row(page, "Sergeli filiali").getByRole("button", { name: "O'chirish" }).click();
  await submit(page, "O'chirish");
  await expect(row(page, "Sergeli filiali")).toHaveCount(0);
});

test("admin: adds a staff member, changes and suspends them; cannot grant owner or admin", async ({ page, browser }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.admin);
  await open(page, "Xodimlar");
  await page.getByRole("button", { name: "Xodim qo'shish" }).click();
  await expect(field(page, "Roli").getByRole("option")).toHaveText(["Tanlang", "Menejer", "Buxgalter", "Ustoz", "Kuzatuvchi"]);
  const email = `yangi-${Date.now()}@example.com`;
  await field(page, "F.I.Sh.").fill("Yangi Xodim");
  await field(page, "Email").fill(email);
  await field(page, "Roli").selectOption({ label: "Menejer" });
  await field(page, "Boshlang'ich parol").fill("brand-new-password-1");
  await submit(page);
  await expect(row(page, "Yangi Xodim")).toContainText("Menejer");

  const fresh = await browser.newContext({ baseURL: `${process.env.NZ_ORIGIN}/app/`, locale: "uz-UZ" });
  const theirs = await fresh.newPage();
  await signIn(theirs, { email, password: "brand-new-password-1" });
  await open(theirs, "O'quvchilar");

  await row(page, "Yangi Xodim").getByRole("button", { name: "Tahrirlash" }).click();
  await field(page, "Holati").selectOption({ label: "To'xtatilgan" });
  await submit(page);
  await expect(row(page, "Yangi Xodim")).toContainText("To'xtatilgan");
  await theirs.reload(); // a suspended person is out at once
  await expect(theirs.getByRole("link", { name: "O'quvchilar", exact: true })).toHaveCount(0);
  await fresh.close();
});

test("manager: imports students, runs a roll call, sees absences and sends debt reminders after reading them", async ({ page }) => {
  test.setTimeout(180_000);
  const center = await makeCenter();
  await signIn(page, center.accounts.manager);
  const api = await directApi(center.accounts.manager);

  await open(page, "Import");
  await page.getByLabel("CSV yoki TSV fayl").setInputFiles({
    name: "oquvchilar.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Ism familiya;Telefon\nImport Birinchi;+998907000001\nImport Ikkinchi;+998907000002\n;+998907000003\n"),
  });
  await page.getByRole("button", { name: "Tekshirib ko'rish" }).click();
  await expect(page.getByRole("region", { name: "Jami 3: toza 2, xato 1, takror 0" })).toBeVisible();
  expect((await api("GET", "/v1/students?q=Import")).body.items).toHaveLength(0); // the preview writes nothing
  await page.getByRole("button", { name: "Yozish", exact: true }).click();
  await submit(page, "Yozish");
  await expect(page.getByText(/Yozildi: O'quvchilar: 2\. Xatoli o'tkazildi: 1\./)).toBeVisible();
  expect((await api("GET", "/v1/students?q=Import")).body.items).toHaveLength(2);

  await page.goto(`lessons/${center.lesson.id}`);
  await page.getByLabel(`Holati: ${center.students[0].name}`).selectOption({ label: "Kelmadi" });
  await page.getByLabel(`Holati: ${center.students[1].name}`).selectOption({ label: "Kechikdi" });
  await page.getByLabel(`Kechikish (daqiqa): ${center.students[1].name}`).fill("7");
  await page.getByRole("button", { name: "Davomatni saqlash" }).click();
  await expect(page.getByText("2 ta belgi saqlandi")).toBeVisible();
  await row(page, center.students[1].name).getByRole("button", { name: "Belgini olib tashlash" }).click();
  await submit(page, "Belgini olib tashlash");
  const roster = (await api("GET", `/v1/lessons/${center.lesson.id}/attendance`)).body.entries as any[];
  expect(roster.filter((e) => e.status).map((e) => e.status)).toEqual(["absent"]);

  await open(page, "Qoldirilgan darslar");
  await page.getByLabel("Kamida qoldirilgan darslar").fill("1");
  await expect(row(page, center.students[0].name)).toBeVisible();

  // the fixture's debtor needs a guardian with Telegram and consent before a reminder may go
  await open(page, "Qarzdorlar");
  await expect(row(page, center.students[0].name)).toContainText("600 000");
  await page.getByRole("button", { name: "Eslatma loyihalari" }).click();
  const draft = page.getByLabel(`Xabar: ${center.students[0].name}`);
  await expect(draft).toHaveValue(/600 000 so'm/);
  await draft.fill("Hurmatli ota-ona, to'lovni kuting emas, amalga oshiring.");
  await page.getByRole("button", { name: "Hammasini tanlash" }).click();
  await page.getByRole("button", { name: "Tanlanganlarni yuborish (1)" }).click();
  expect((await api("GET", "/v1/outbox?limit=50")).body.items).toHaveLength(0); // nothing before the approval
  await submit(page, "Tanlanganlarni yuborish (1)");
  await expect(page.getByText("Navbatga qo'yildi: 1. Rad etildi: 0.")).toBeVisible();
  const outbox = (await api("GET", "/v1/outbox?limit=50")).body.items as any[];
  expect(outbox.map((m) => m.body)).toEqual(["Hurmatli ota-ona, to'lovni kuting emas, amalga oshiring."]);
});

test("accountant: bills, takes a payment once however often it is clicked, corrects and reports", async ({ page }) => {
  test.setTimeout(180_000);
  const center = await makeCenter();
  await signIn(page, center.accounts.accountant);
  const api = await directApi(center.accounts.accountant);
  const student = center.students[1];

  await open(page, "Hisoblar");
  await page.getByRole("button", { name: "Hisob yozish" }).click();
  await pickStudent(page, student.name);
  await field(page, "Summa").fill("300 000");
  await submit(page);
  await expect(row(page, student.name)).toContainText("300 000");
  await row(page, student.name).getByRole("button", { name: "Ochish" }).click();
  await dialog(page).getByRole("button", { name: "Tahrirlash" }).click();
  await field(page, "Summa").fill("350000");
  await dialog(page).getByRole("button", { name: "Saqlash" }).click();
  await expect(dialog(page).getByText("350 000").first()).toBeVisible();
  await dialog(page).getByRole("button", { name: "Yopish" }).click();

  await page.getByRole("button", { name: "Oylik hisoblarni yaratish" }).click();
  await submit(page, "Oylik hisoblarni yaratish");
  await expect(page.getByText(/Yaratildi: \d+\./)).toBeVisible();

  // a slow answer and an impatient double click: one payment
  await open(page, "To'lovlar");
  await page.getByRole("button", { name: "To'lov qabul qilish" }).click();
  await pickStudent(page, student.name);
  await field(page, "Summa").fill("100000");
  const keys: string[] = [];
  await page.route("**/v1/payments", async (route) => {
    if (route.request().method() === "POST") {
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      await new Promise((r) => setTimeout(r, 800));
    }
    await route.continue();
  });
  await dialog(page).getByRole("button", { name: "Saqlash" }).dblclick();
  await dialog(page).locator("form").evaluate((f: HTMLFormElement) => f.requestSubmit()).catch(() => {});
  await expect(page).toHaveURL(/\/app\/payments\/[0-9a-f-]{36}$/);
  await page.unroute("**/v1/payments");
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  const studentPayments = async () => (await api("GET", `/v1/payments?student_id=${student.id}`)).body.items as any[];
  expect(await studentPayments()).toHaveLength(1);
  await settled(page);

  await page.getByRole("button", { name: "Taqsimotni olib tashlash" }).first().click();
  await submit(page, "Taqsimotni olib tashlash");
  await page.getByRole("button", { name: "Hisoblarga taqsimlash" }).click();
  await dialog(page).getByRole("button", { name: "Hisoblarga taqsimlash" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await studentPayments())[0].unallocated).toBe("0.00");
  await page.getByRole("button", { name: "Bekor qilish (void)" }).click();
  await field(page, "Sabab").fill("Xato kiritilgan");
  await submit(page, "Bekor qilish (void)");
  await expect(page.getByText("Bekor qilingan").first()).toBeVisible();

  await page.goto(`students/${student.id}`);
  await expect(page.getByRole("region", { name: "Hisob-kitob" })).toContainText("Qoldiq");
  await expect(page.getByRole("button", { name: "Tahrirlash" })).toHaveCount(0); // an accountant does not edit students

  await open(page, "Xarajatlar");
  await page.getByRole("button", { name: "Xarajat kiritish" }).click();
  await field(page, "Turkum").selectOption({ label: "Ijara" });
  await field(page, "Summa").fill("2 000 000");
  await submit(page);
  await expect(row(page, "Ijara")).toContainText("2 000 000");
  await row(page, "Ijara").getByRole("button", { name: "Bekor qilish (void)" }).click();
  await field(page, "Sabab").fill("Takror yozilgan");
  await submit(page, "Bekor qilish (void)");
  await expect(row(page, "Ijara")).toHaveCount(0);

  await open(page, "Hisobotlar");
  await expect(page.getByText("Yozilgan hisoblar")).toBeVisible();
  await page.getByRole("button", { name: "Daromad" }).click();
  await settled(page);
});

test("teacher: own lessons, roll call by hand and by QR, a message to a guardian, pay and notifications", async ({ page }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.teacher);
  await expect(page).toHaveURL(/\/app\/teacher$/);
  await settled(page);
  await page.getByRole("link", { name: new RegExp("10:00") }).click();
  await page.getByRole("button", { name: "Belgilanmaganlarni «keldi» qilish" }).click();
  await page.getByRole("button", { name: "Davomatni saqlash" }).click();
  await expect(page.getByText("3 ta belgi saqlandi")).toBeVisible();
  await page.getByRole("region", { name: new RegExp(center.group.name) }).getByRole("button", { name: "Tahrirlash" }).click();
  await field(page, "Mavzu").fill("Present Simple");
  await submit(page);
  await expect(page.getByText("Present Simple")).toBeVisible();

  await row(page, center.students[2].name).getByRole("button", { name: "Belgini olib tashlash" }).click();
  await submit(page, "Belgini olib tashlash");
  await open(page, "QR davomat");
  await page.getByRole("combobox", { name: "Dars", exact: true }).selectOption({ index: 1 });
  await page.getByLabel("QR kod").fill(center.students[2].qr);
  await page.getByRole("button", { name: "Belgilash" }).click();
  await expect(page.locator(".scan-log")).toContainText("Belgilandi");
  await page.getByLabel("QR kod").fill("not-a-code");
  await page.getByRole("button", { name: "Belgilash" }).click();
  await expect(page.locator(".scan-log")).toContainText("QR kod noto'g'ri");
  const api = await directApi(center.accounts.teacher);
  expect((await api("GET", `/v1/lessons/${center.lesson.id}/attendance`)).body.entries.filter((e: any) => e.status === "present")).toHaveLength(3);

  await open(page, "Mening guruhlarim");
  await page.getByRole("button", { name: "O'quvchilarni ko'rish" }).click();
  await row(page, center.students[0].name).getByRole("button", { name: "Vasiyga yozish" }).click();
  await field(page, "Tayyor matn").selectOption({ label: "Maqtov" });
  await submit(page, "Tasdiqlab yuborish");
  await expect(page.getByText(/1 ta vasiyga yuborildi/)).toBeVisible();
  await open(page, "Mening xabarlarim");
  await expect(row(page, center.students[0].name)).toBeVisible();
  await open(page, "Mening oyligim");
  await expect(page.getByText("Taxminiy haq")).toBeVisible();
  await open(page, "Mening darslarim");
  await settled(page);
  await open(page, "Bildirishnomalar");
  await settled(page);
});

test("viewer: reads, and finds nothing that changes data", async ({ page }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.viewer);
  for (const name of ["O'quvchilar", "Vasiylar", "Guruhlar", "Kurslar", "Darslar", "Markaz", "Filiallar"]) {
    await open(page, name);
    await settled(page);
    await expect(page.locator("main").getByRole("button", { name: /qo'shish|ochish$|Tahrirlash|O'chirish/ })).toHaveCount(0);
  }
  await open(page, "O'quvchilar");
  await page.getByRole("link", { name: center.students[0].name }).click();
  await settled(page);
  await expect(page.getByRole("region", { name: "Hisob-kitob" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "QR karta" })).toHaveCount(0);
  await expect(page.locator("main").getByRole("button")).toHaveCount(0);
});

test("names and notes that look like HTML stay text", async ({ page }) => {
  const center = await makeCenter();
  const api = await directApi(center.accounts.owner);
  const nasty = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
  const made = await api("POST", "/v1/students", { full_name: nasty, notes: `"><svg onload=window.__xss=3>` });
  expect(made.status).toBe(201);
  await api("PATCH", "/v1/organization", { name: "<b onmouseover=window.__xss=4>Markaz</b>" });
  await signIn(page, center.accounts.owner);
  await open(page, "O'quvchilar");
  await expect(page.getByRole("link", { name: nasty })).toBeVisible();
  await page.getByRole("link", { name: nasty }).click();
  await expect(page.getByText(`"><svg onload=window.__xss=3>`)).toBeVisible();
  await expect(page.locator(".who")).toContainText("<b onmouseover=window.__xss=4>Markaz</b>");
  await expect(page.locator("main img, main svg, main script, .who b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
});

test("QR attendance by camera marks the card once, and the camera really stops", async ({ page }) => {
  const center = await makeCenter();
  await fakeCamera(page, center.students[0].qr);
  await signIn(page, center.accounts.teacher);
  await open(page, "QR davomat");
  await page.getByRole("combobox", { name: "Dars", exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "Kamerani yoqish" }).click();
  await expect(page.locator(".scan-log")).toContainText(`${center.students[0].name} · Belgilandi`, { timeout: 20_000 });
  await expect(page.locator(".scan-log li")).toHaveCount(1); // a card held in view is not sent again and again
  await page.getByRole("button", { name: "Kamerani o'chirish" }).click();
  await expect(page.locator("video")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__tracks.map((t: MediaStreamTrack) => t.readyState))).toEqual(["ended"]);
});

test("a refused camera points at typing the code", async ({ page }) => {
  const center = await makeCenter();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
      configurable: true,
    });
  });
  await signIn(page, center.accounts.teacher);
  await open(page, "QR davomat");
  await page.getByRole("combobox", { name: "Dars", exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "Kamerani yoqish" }).click();
  await expect(page.getByRole("alert")).toContainText("Kodni qo'lda");
  await expect(page.getByLabel("QR kod")).toBeVisible();
});
