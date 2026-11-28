/** Part 2 (money) from beginning to end through the screens, per role, against the real API and PostgreSQL; what the
 * screens say happened is then read back from the server. Which role may open what is in roles.spec.ts. */

import type { Page } from "@playwright/test";
import { dialog, directApi, expect, makeCenter, open, settled, signIn, test } from "./fixtures";

const today = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date());
const plus = (days: number): string => new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthStart = (): string => `${today().slice(0, 7)}-01`;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The dialog on top: a form can be opened from inside another dialog. */
const top = (page: Page) => dialog(page).last();
const field = (page: Page, label: string) => top(page).getByLabel(new RegExp(`^${escaped(label)}( \\(ixtiyoriy\\))?$`));
const row = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

async function submit(page: Page, name = "Saqlash"): Promise<void> {
  const before = await dialog(page).count();
  await top(page).getByRole("button", { name, exact: true }).click();
  await expect(dialog(page)).toHaveCount(before - 1);
}

async function pickStudent(page: Page, name: string): Promise<void> {
  await field(page, "O'quvchi").fill(name.slice(0, 12));
  await top(page).getByRole("button", { name: new RegExp(escaped(name)) }).first().click();
}

test("accountant: payment plan, discount, refund after a preview, cash close and payroll draft", async ({ page }) => {
  test.setTimeout(240_000);
  const center = await makeCenter();
  const api = await directApi(center.accounts.accountant);
  const debtor = center.students[0];
  const paid = await api("POST", "/v1/payments", { student_id: center.students[1].id, amount: "250000", method: "cash" });
  expect(paid.status).toBe(201);
  await signIn(page, center.accounts.accountant);

  // a plan on the open charge: equal parts, then by hand, shown in the report, then removed
  await open(page, "Hisoblar");
  await row(page, debtor.name).getByRole("button", { name: "Ochish" }).click();
  const charge = (await api("GET", `/v1/charges?student_id=${debtor.id}`)).body.items[0];
  const plan = () => api("GET", `/v1/charges/${charge.id}/plan`);
  await button(page, "Teng qismlarga bo'lish").click();
  await field(page, "Birinchi muddat").fill(plus(2));
  await submit(page);
  await expect(top(page).getByRole("region", { name: "To'lov rejasi" })).toContainText("300 000");
  await top(page).getByRole("button", { name: "Qismlarni qo'lda kiritish" }).click();
  await top(page).getByLabel("1-qism summasi").fill("200 000");
  await top(page).getByLabel("1-qism muddati").fill(plus(3));
  await top(page).getByLabel("2-qism summasi").fill("100");
  await top(page).getByLabel("2-qism muddati").fill(plus(20));
  await top(page).getByRole("button", { name: "Saqlash" }).click();
  await expect(top(page).getByRole("alert")).toBeVisible(); // the parts do not add up: the server refuses
  await top(page).getByLabel("2-qism summasi").fill("400000");
  await top(page).getByRole("button", { name: "Saqlash" }).click();
  await expect(top(page).getByRole("region", { name: "To'lov rejasi" })).toContainText("400 000");
  expect((await plan()).body.installments.map((i: any) => i.amount)).toEqual(["200000.00", "400000.00"]);
  await top(page).getByRole("button", { name: "Yopish" }).click();

  await open(page, "To'lov qismlari");
  await page.getByLabel("Necha kun oldinga").fill("30");
  await expect(row(page, debtor.name).first()).toContainText("1/2");

  await open(page, "Hisoblar");
  await row(page, debtor.name).getByRole("button", { name: "Ochish" }).click();
  await button(page, "Rejani olib tashlash").click();
  await submit(page, "Rejani olib tashlash");
  await expect(top(page).getByText("Bu hisobda to'lov rejasi yo'q")).toBeVisible();
  expect((await plan()).status).toBe(404);
  await top(page).getByRole("button", { name: "Yopish" }).click();

  // a lasting discount: added, ended, seen in the month's report
  await open(page, "Chegirmalar");
  await button(page, "Chegirma qo'shish").click();
  await pickStudent(page, debtor.name);
  await field(page, "Foiz").fill("15");
  await field(page, "Sabab").fill("Ikkinchi farzand");
  await submit(page);
  await expect(row(page, debtor.name)).toContainText("15 %");
  await row(page, debtor.name).getByRole("button", { name: "Tugatish yoki sababni tuzatish" }).click();
  await field(page, "Amal qiladigan oxirgi kun").fill(plus(0));
  await submit(page);
  await expect(row(page, debtor.name)).toContainText(today().split("-").reverse().join("."));
  expect((await api("GET", `/v1/discounts?student_id=${debtor.id}`)).body.items[0].valid_to).toBe(today());
  await button(page, "Oylik hisobot").click();
  await expect(page.getByText("Stipendiyalar")).toBeVisible();

  // a refund: the preview explains a refusal; only a clean preview can be recorded, and once
  await open(page, "Qaytarishlar");
  await button(page, "Qaytarish qilish").click();
  await pickStudent(page, center.students[1].name);
  await field(page, "To'lov").selectOption({ index: 1 });
  await field(page, "Summa").fill("900000");
  await field(page, "Sabab").fill("Xato to'lov");
  await button(page, "Oldindan hisoblash").click();
  await expect(top(page).getByRole("alert")).toContainText("Summa qaytarish mumkin bo'lganidan katta");
  await expect(button(page, "Qaytarishni yozish")).toBeDisabled();
  await button(page, "O'zgartirish").last().click();
  await pickStudentAgainIfNeeded(page, center.students[1].name);
  await field(page, "To'lov").selectOption({ index: 1 });
  await field(page, "Summa").fill("50000");
  await field(page, "Sabab").fill("Xato to'lov");
  await button(page, "Oldindan hisoblash").click();
  await expect(top(page)).toContainText("50 000");
  expect((await api("GET", "/v1/refunds")).body.items).toHaveLength(0); // a preview writes nothing
  await submit(page, "Qaytarishni yozish");
  await expect(row(page, center.students[1].name)).toContainText("50 000");
  expect((await api("GET", "/v1/refunds")).body.items).toHaveLength(1);
  await row(page, center.students[1].name).getByRole("button", { name: "Ochish" }).click();
  await expect(top(page)).toContainText("Xato to'lov");
  await top(page).getByRole("button", { name: "Yopish" }).click();

  // the cash desk: counted equals the books; the closed shift is read back
  await open(page, "Kassani yopish");
  await settled(page);
  const books = (await api("GET", `/v1/cash-close/preview?branch_id=${center.branches.main}`)).body.book_balance as string;
  await button(page, "Kassani yopish").click();
  await field(page, "Sanalgan pul").fill(books.replace(/\.00$/, ""));
  await submit(page, "Kassani yopish");
  const closes = (await api("GET", "/v1/cash-close")).body.items as any[];
  expect(closes.map((c) => [c.status, c.counted])).toEqual([["ok", books]]);
  await row(page, "To'g'ri").getByRole("button", { name: "Ochish" }).click();
  await expect(top(page)).toContainText("Jurnalning oxirgi qatori");
  await top(page).getByRole("button", { name: "Yopish" }).click();

  // payroll: a draft for every teacher, a bonus added and removed; an accountant may not approve
  await open(page, "Oylik maosh");
  await button(page, "Hamma ustozga hisoblash").click();
  await submit(page, "Hisoblash");
  await expect(page.getByText(/ta qoralama hisoblandi/)).toBeVisible();
  await page.getByRole("link", { name: center.accounts.teacher.name }).click();
  await button(page, "Mukofot yoki jarima qo'shish").click();
  await field(page, "Summa").fill("70000");
  await field(page, "Tavsif").fill("Tanlov uchun");
  await submit(page);
  await expect(row(page, "Tanlov uchun")).toContainText("70 000");
  await button(page, "Qayta hisoblash").click();
  await submit(page, "Qayta hisoblash");
  await expect(row(page, "Tanlov uchun")).toBeVisible();
  await row(page, "Tanlov uchun").getByRole("button", { name: "O'chirish" }).click();
  await submit(page, "O'chirish");
  await expect(row(page, "Tanlov uchun")).toHaveCount(0);
  await expect(button(page, "Tasdiqlash")).toHaveCount(0);
});

/** "Change" on the preview goes back to an empty form for the same student. */
async function pickStudentAgainIfNeeded(page: Page, name: string): Promise<void> {
  if (await field(page, "O'quvchi").count()) await pickStudent(page, name);
}

test("accountant: suppliers and bills, the journal, reports and a statement reconciled", async ({ page }) => {
  test.setTimeout(240_000);
  const center = await makeCenter();
  const api = await directApi(center.accounts.accountant);
  await signIn(page, center.accounts.accountant);

  await open(page, "Ta'minotchilar");
  await button(page, "Ta'minotchi qo'shish").click();
  await field(page, "Nomi").fill("Suv ta'minoti");
  await submit(page);
  await row(page, "Suv ta'minoti").getByRole("button", { name: "Tahrirlash" }).click();
  await field(page, "Telefon").fill("+998712000000");
  await submit(page);
  await expect(row(page, "Suv ta'minoti")).toContainText("+998712000000");

  await open(page, "Ta'minotchi hisoblari");
  await button(page, "Hisob kiritish").click();
  await field(page, "Ta'minotchi").selectOption({ label: "Suv ta'minoti" });
  await field(page, "Hisob raqami").fill("INV-1");
  await field(page, "Summa").fill("400 000");
  await submit(page);
  await expect(page).toHaveURL(/\/app\/bills\/[0-9a-f-]{36}$/);
  const billId = page.url().split("/").pop()!;
  const bill = async () => (await api("GET", `/v1/accounting/bills/${billId}`)).body;
  await button(page, "To'lash").click();
  await field(page, "Summa").fill("150000");
  await submit(page);
  await expect(page.getByText("Qisman to'langan")).toBeVisible();
  expect((await bill()).outstanding).toBe("250000.00");
  await expect(button(page, "Hisobni bekor qilish")).toHaveCount(0); // a bill with a live payment cannot be voided
  await button(page, "Bekor qilish (void)").click();
  await field(page, "Sabab").fill("Xato to'lov");
  await submit(page, "Bekor qilish (void)");
  await expect(page.getByText("Xato to'lov")).toBeVisible();
  await open(page, "Ta'minotchi hisoblari");
  await button(page, "Qarz yoshi").click();
  await expect(row(page, "INV-1")).toContainText("400 000");
  await page.getByRole("link", { name: "INV-1" }).click();
  await button(page, "Hisobni bekor qilish").click();
  await field(page, "Sabab").fill("Takror hisob");
  await submit(page, "Hisobni bekor qilish");
  await expect(page.getByText("Takror hisob")).toBeVisible();
  expect((await bill()).voided).toBe(true);

  await open(page, "Hisoblar rejasi");
  await button(page, "Hisob qo'shish").click();
  await field(page, "Kod").fill("5950");
  await field(page, "Nomi").fill("Bank xizmati");
  await submit(page);
  await row(page, "Bank xizmati").getByRole("button", { name: "Tahrirlash" }).click();
  await field(page, "Nomi").fill("Bank komissiyasi");
  await submit(page);
  await expect(row(page, "Bank komissiyasi")).toContainText("5950");
  await button(page, "Kassa yoki bank qo'shish").click();
  await field(page, "Nomi").fill("Hisob raqami 2");
  await field(page, "Turi (kassa yoki bank)").selectOption({ label: "Bank" });
  await field(page, "Kod").fill("1020");
  await submit(page);
  await expect(row(page, "Hisob raqami 2").first()).toBeVisible();

  // the journal: what is missing is posted, a manual entry that does not balance is refused, a reversal corrects
  await open(page, "Jurnal va davrlar");
  await button(page, "Davrlar va tekshiruv").click();
  await button(page, "Jurnalga o'tkazish").click();
  await expect(page.getByText("Hammasi jurnalga yozilgan")).toBeVisible();
  await button(page, "Tekshirish").click();
  await expect(page.getByText(/Zanjir butun/)).toBeVisible();
  await expect(button(page, "Oyni yopish")).toHaveCount(0); // an accountant may not close a month
  await button(page, "Jurnal").click();
  await button(page, "Qo'lda yozuv").click();
  await field(page, "Izoh").fill("Bankka kirim");
  await top(page).getByLabel("1-qator hisobi").selectOption("1020");
  await top(page).getByLabel("1-qator debeti").fill("150 000");
  await top(page).getByLabel("2-qator hisobi").selectOption("4100");
  await top(page).getByLabel("2-qator krediti").fill("100000");
  await top(page).getByRole("button", { name: "Jurnalga yozish" }).click();
  await expect(top(page).getByRole("alert")).toBeVisible();
  await top(page).getByLabel("2-qator krediti").fill("150000");
  await submit(page, "Jurnalga yozish");
  await expect(row(page, "Bankka kirim")).toBeVisible();
  await button(page, "Qo'lda yozuv").click();
  await field(page, "Izoh").fill("Xato yozuv");
  await top(page).getByLabel("1-qator hisobi").selectOption("5090");
  await top(page).getByLabel("1-qator debeti").fill("1000");
  await top(page).getByLabel("2-qator hisobi").selectOption("3000");
  await top(page).getByLabel("2-qator krediti").fill("1000");
  await submit(page, "Jurnalga yozish");
  await row(page, "Xato yozuv").getByRole("button", { name: "Ochish" }).click();
  await top(page).getByRole("button", { name: "Teskari yozuv kiritish" }).click();
  await submit(page, "Teskari yozuv kiritish");
  const entries = (await api("GET", "/v1/accounting/entries?limit=200")).body.items as any[];
  expect(entries.filter((e) => e.source_type === "reversal")).toHaveLength(1);

  await open(page, "Buxgalteriya hisobotlari");
  await expect(page.getByText("Debet va kredit teng")).toBeVisible();
  await button(page, "Foyda va zarar").click();
  await expect(page.getByRole("heading", { name: /^Daromadlar:/ })).toBeVisible();
  await button(page, "Balans").click();
  await expect(page.getByRole("heading", { name: /^Aktivlar:/ })).toBeVisible();
  await button(page, "Hisob kartochkasi").click();
  await page.getByRole("main").getByRole("combobox").selectOption("1020");
  await expect(row(page, "Bankka kirim")).toContainText("150 000");

  // reconciliation: a line typed from the bank, matched by hand, unmatched, matched automatically, finalized
  await open(page, "Ko'chirma solishtirish");
  await button(page, "Ko'chirma ochish").click();
  await field(page, "Pul hisobi").selectOption({ label: "Hisob raqami 2 (Bank)" });
  await field(page, "Boshlanishi").or(field(page, "Dan")).first().fill(monthStart());
  await field(page, "Boshlang'ich qoldiq").fill("0");
  await field(page, "Yakuniy qoldiq").fill("150 000");
  await submit(page);
  await expect(page).toHaveURL(/\/app\/reconciliation\/[0-9a-f-]{36}$/);
  const statementId = page.url().split("/").pop()!;
  await expect(button(page, "Ko'chirmani yopish")).toBeDisabled();
  await button(page, "Qator kiritish").click();
  await field(page, "Summa").fill("150 000");
  await field(page, "Tavsif").fill("Kirim 1");
  await submit(page);
  await expect(row(page, "Kirim 1")).toContainText("Moslanmagan");
  await row(page, "Kirim 1").getByRole("button", { name: "Qo'lda moslash" }).click();
  await field(page, "Jurnal qatori").selectOption({ index: 1 });
  await submit(page);
  await expect(row(page, "Kirim 1")).toContainText("qatoriga moslangan");
  await row(page, "Kirim 1").getByRole("button", { name: "Moslikni bekor qilish" }).click();
  await submit(page, "Moslikni bekor qilish");
  await expect(row(page, "Kirim 1")).toContainText("Moslanmagan");
  await button(page, "Avtomatik moslash").click();
  await submit(page, "Avtomatik moslash");
  await button(page, "Ko'chirmani yopish").click();
  await submit(page, "Ko'chirmani yopish");
  expect((await api("GET", `/v1/accounting/statements/${statementId}`)).body.status).toBe("finalized");
  await expect(button(page, "Qator kiritish")).toHaveCount(0);
});

test("owner: approves and pays a payroll, closes the last month", async ({ page }) => {
  test.setTimeout(180_000);
  const center = await makeCenter();
  const api = await directApi(center.accounts.owner);
  const teacher = (await api("GET", "/v1/teachers")).body.items[0];
  const made = await api("POST", "/v1/payrolls/generate", { teacher_id: teacher.id, month: monthStart() });
  expect(made.status).toBe(200);
  await api("POST", `/v1/payrolls/${made.body.id}/items`, { kind: "bonus", amount: "120000" });
  await signIn(page, center.accounts.owner);

  await open(page, "Oylik maosh");
  await page.getByRole("link", { name: teacher.full_name }).click();
  await button(page, "Tasdiqlash").click();
  await submit(page, "Tasdiqlash");
  await expect(page.getByText("Tasdiqlangan", { exact: true })).toBeVisible();
  await expect(button(page, "Mukofot yoki jarima qo'shish")).toHaveCount(0); // approved lines are frozen
  await button(page, "To'langan deb belgilash").click();
  await submit(page, "To'langan deb belgilash");
  await expect(page.getByText("To'langan", { exact: true })).toBeVisible();
  expect((await api("GET", `/v1/payrolls/${made.body.id}`)).body.status).toBe("paid");

  await api("POST", "/v1/accounting/sync");
  const last = new Date(Date.parse(`${monthStart()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 7);
  await open(page, "Jurnal va davrlar");
  await button(page, "Davrlar va tekshiruv").click();
  await button(page, "Oyni yopish").click();
  await field(page, "Oy").fill(last);
  await submit(page, "Oyni yopish");
  await expect(row(page, last)).toBeVisible();
  expect((await api("GET", "/v1/accounting/periods")).body.map((p: any) => p.month)).toEqual([last]);
});

test("manager: reminds about a used-up package, sells and extends one; reads the books, writes nothing there", async ({ page }) => {
  test.setTimeout(180_000);
  const center = await makeCenter();
  const api = await directApi(center.accounts.manager);
  const student = center.students[0]; // consented, with a guardian who has a Telegram chat
  const course = (await api("POST", "/v1/courses", { name: "Paket kursi", default_monthly_fee: "500000" })).body;
  const group = await api("POST", "/v1/groups", {
    course_id: course.id, name: "Paket-1", start_date: plus(-40), status: "active", billing_mode: "package", package_lessons: 8, package_price: "800000",
  });
  expect(group.status).toBe(201);
  expect((await api("POST", `/v1/groups/${group.body.id}/enrollments`, { student_id: student.id, started_on: plus(-30) })).status).toBe(201);
  await signIn(page, center.accounts.manager);

  await open(page, "Abonementlar");
  await button(page, "To'lov kerak").click();
  await expect(row(page, student.name)).toContainText("Tugagan");
  await button(page, "Eslatma loyihalari").click();
  await expect(page.getByText(/«To'lov qildim» tugmalari qo'shiladi/)).toBeVisible();
  const text = page.getByRole("textbox", { name: `Xabar: ${student.name}` });
  await expect(text).toHaveValue(/abonementdagi darslar tugadi/);
  await text.fill("Abonement to'lovini kutamiz.");
  expect((await api("GET", "/v1/outbox")).body.items).toHaveLength(0); // reading a draft sends nothing
  await page.getByRole("checkbox", { name: new RegExp(escaped(student.name)) }).check();
  await button(page, "Tanlanganlarni yuborish (1)").click();
  await submit(page, "Tanlanganlarni yuborish (1)");
  await expect(page.getByText(/Navbatga qo'yildi: 1/)).toBeVisible();
  expect((await api("GET", "/v1/outbox")).body.items.map((m: any) => [m.body, m.status])).toEqual([["Abonement to'lovini kutamiz.", "queued"]]);

  await button(page, "Sotilgan abonementlar").click();
  await button(page, "Abonement sotish").click();
  await pickStudent(page, student.name);
  await field(page, "Guruh").selectOption({ label: "Paket-1" });
  await submit(page, "Abonement sotish");
  await expect(row(page, student.name)).toContainText("800 000");
  await row(page, student.name).getByRole("button", { name: "Muddatni uzaytirish" }).click();
  await field(page, "Yangi muddat").fill(plus(200));
  await submit(page);
  expect((await api("GET", `/v1/packages?student_id=${student.id}`)).body.items[0].expires_on).toBe(plus(200));
  await page.getByLabel("O'quvchi", { exact: true }).fill(student.name.slice(0, 12));
  await page.getByRole("button", { name: new RegExp(escaped(student.name)) }).first().click();
  await expect(page.getByRole("region", { name: new RegExp(`^Darslar qoldig'i`) })).toContainText("Paket-1");

  await open(page, "Ta'minotchilar");
  await settled(page);
  await expect(button(page, "Ta'minotchi qo'shish")).toHaveCount(0);
  await open(page, "Jurnal va davrlar");
  await expect(button(page, "Qo'lda yozuv")).toHaveCount(0);
});
