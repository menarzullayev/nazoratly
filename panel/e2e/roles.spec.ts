/** Every role: its menu, every one of its screens against the real API, the screens it may not open, and the same
 * refusals from the server when the request skips the panel. Then the branch and center walls. */

import { readFileSync } from "node:fs";
import { directApi, expect, makeCenter, open, settled, signIn, test, type Role } from "./fixtures";

// Written out by hand on purpose: if the server's role matrix changed, this table must be changed knowingly.
const DAILY = ["Taqvim", "Bildirishnomalar"];
const STUDY_READ = ["Guruhlar", "Kurslar", "Ustozlar", "Xonalar", "Darslar"];
const STUDY_ALL = ["O'quvchilar", "Vasiylar", ...STUDY_READ, "Qoldirilgan darslar", "Jadval tekshiruvi", "Jadval xabarlari"];
const MONEY = ["Hisoblar", "To'lovlar", "Qarzdorlar", "Xarajatlar", "Hisobotlar", "To'lov qismlari", "Abonementlar", "Chegirmalar", "Qaytarishlar", "Kassani yopish"];
const BOOKS = ["Jurnal va davrlar", "Hisoblar rejasi", "Buxgalteriya hisobotlari", "Ta'minotchilar", "Ta'minotchi hisoblari", "Ko'chirma solishtirish"];
const PAYROLL = "Oylik maosh";
const CENTER = ["Markaz", "Filiallar", "Xodimlar", "Import"];
const OWN = ["Mening ishim", "Mening darslarim", "Mening guruhlarim", "Mening oyligim", "Mening xabarlarim"];
const EVERYTHING = ["Bosh panel", ...DAILY, "QR davomat", ...STUDY_ALL, ...MONEY, PAYROLL, ...BOOKS, ...CENTER];

const MENU: Record<Role, string[]> = {
  owner: EVERYTHING,
  admin: EVERYTHING,
  manager: ["Bosh panel", ...DAILY, "QR davomat", ...STUDY_ALL, ...MONEY, ...BOOKS, "Markaz", "Filiallar", "Xodimlar", "Import"],
  accountant: ["Bosh panel", ...DAILY, "O'quvchilar", "Vasiylar", ...STUDY_READ, "Qoldirilgan darslar", ...MONEY, PAYROLL, ...BOOKS, "Markaz", "Filiallar"],
  teacher: [...OWN, ...DAILY, "QR davomat", ...STUDY_READ, "Markaz", "Filiallar"],
  viewer: ["Bosh panel", ...DAILY, "O'quvchilar", "Vasiylar", ...STUDY_READ, "Qoldirilgan darslar", "Hisobotlar", "Markaz", "Filiallar"],
};

const ADDRESS: Record<string, string> = {
  "Bosh panel": "dashboard", Taqvim: "calendar", "QR davomat": "scan", Bildirishnomalar: "notifications",
  "Mening ishim": "teacher", "Mening darslarim": "teacher/lessons", "Mening guruhlarim": "teacher/groups", "Mening oyligim": "teacher/pay", "Mening xabarlarim": "teacher/messages",
  "O'quvchilar": "students", Vasiylar: "guardians", Guruhlar: "groups", Kurslar: "courses", Ustozlar: "teachers", Xonalar: "rooms", Darslar: "lessons",
  "Qoldirilgan darslar": "absences", "Jadval tekshiruvi": "schedule-checks", "Jadval xabarlari": "notices",
  Hisoblar: "charges", "To'lovlar": "payments", Qarzdorlar: "debtors", Xarajatlar: "expenses", Hisobotlar: "reports",
  Markaz: "organization", Filiallar: "branches", Xodimlar: "staff", Import: "import",
  "To'lov qismlari": "installments", Abonementlar: "packages", Chegirmalar: "discounts", Qaytarishlar: "refunds", "Kassani yopish": "cash-close",
  "Oylik maosh": "payroll", "Jurnal va davrlar": "journal", "Hisoblar rejasi": "accounts", "Buxgalteriya hisobotlari": "book-reports",
  "Ta'minotchilar": "suppliers", "Ta'minotchi hisoblari": "bills", "Ko'chirma solishtirish": "reconciliation",
};

type Op = [method: string, path: string, allowed: Role[]];
const ALL: Role[] = ["owner", "admin", "manager", "accountant", "teacher", "viewer"];
const LEAD: Role[] = ["owner", "admin"];
const MGMT: Role[] = ["owner", "admin", "manager"];
const CASH: Role[] = ["owner", "admin", "manager", "accountant"];
const SPEND: Role[] = ["owner", "admin", "accountant"];
const ID = "00000000-0000-4000-8000-000000000000";
// one or more operations behind every permission of part 1, and every operation of part 2; a role not listed must get 403
const OPERATIONS: Op[] = [
  ["PATCH", "/v1/organization", ["owner"]],
  ["POST", "/v1/branches", LEAD],
  ["DELETE", `/v1/branches/${ID}`, LEAD],
  ["GET", "/v1/staff", MGMT],
  ["POST", "/v1/staff", LEAD],
  ["PATCH", `/v1/staff/${ID}`, LEAD],
  ["GET", "/v1/students", CASH.concat("viewer")],
  ["POST", "/v1/students", MGMT],
  ["DELETE", `/v1/students/${ID}`, MGMT],
  ["POST", "/v1/guardians", MGMT],
  ["POST", `/v1/students/${ID}/consents`, MGMT],
  ["GET", "/v1/courses", ALL],
  ["POST", "/v1/courses", MGMT],
  ["POST", "/v1/teachers", MGMT],
  ["POST", "/v1/rooms", MGMT],
  ["POST", "/v1/groups", MGMT],
  ["PUT", `/v1/groups/${ID}/schedule`, MGMT],
  ["POST", `/v1/groups/${ID}/enrollments`, MGMT],
  ["POST", "/v1/lessons", MGMT],
  ["POST", `/v1/lessons/${ID}/move`, MGMT],
  ["POST", `/v1/lessons/${ID}/cancel`, MGMT],
  ["GET", "/v1/schedule-notices", MGMT],
  ["POST", `/v1/schedule-notices/${ID}/approve`, MGMT],
  ["PUT", `/v1/lessons/${ID}/attendance`, ["owner", "admin", "manager", "teacher"]],
  ["POST", "/v1/attendance/scan", ["owner", "admin", "manager", "teacher"]],
  ["POST", "/v1/attendance/qr-codes/issue", MGMT],
  ["POST", `/v1/students/${ID}/qr-card/send`, MGMT],
  ["GET", "/v1/charges", CASH],
  ["POST", "/v1/charges", CASH],
  ["POST", "/v1/charges/generate", CASH],
  ["POST", `/v1/charges/${ID}/void`, CASH],
  ["GET", "/v1/payments", CASH],
  ["POST", "/v1/payments", CASH],
  ["POST", `/v1/payments/${ID}/void`, CASH],
  ["DELETE", `/v1/payments/${ID}/allocations/${ID}`, CASH],
  ["GET", "/v1/reports/debtors", CASH],
  ["GET", "/v1/reports/debtors/reminders", MGMT],
  ["POST", "/v1/reports/debtors/reminders", MGMT],
  ["POST", "/v1/expenses", SPEND],
  ["POST", `/v1/expenses/${ID}/void`, SPEND],
  ["GET", "/v1/reports/summary?month=2026-01-01", CASH.concat("viewer")],
  ["GET", "/v1/dashboard", CASH.concat("viewer")],
  ["POST", "/v1/imports/students/preview", MGMT],
  ["POST", "/v1/imports/students/commit", MGMT],
  // ---- part 2, every operation of it. finance:read / finance:write
  ["GET", "/v1/discounts", CASH],
  ["POST", "/v1/discounts", CASH],
  ["PATCH", `/v1/discounts/${ID}`, CASH],
  ["GET", "/v1/reports/discounts?month=2026-01-01", CASH.concat("viewer")],
  ["GET", "/v1/refunds", CASH],
  ["GET", `/v1/refunds/${ID}`, CASH],
  ["POST", "/v1/refunds/preview", CASH],
  ["POST", "/v1/refunds", CASH],
  ["GET", "/v1/cash-close", CASH],
  ["GET", "/v1/cash-close/preview", CASH],
  ["GET", `/v1/cash-close/${ID}`, CASH],
  ["POST", "/v1/cash-close", CASH],
  ["GET", `/v1/charges/${ID}/plan`, CASH],
  ["PUT", `/v1/charges/${ID}/plan`, CASH],
  ["DELETE", `/v1/charges/${ID}/plan`, CASH],
  ["GET", "/v1/reports/installments", CASH],
  ["GET", "/v1/packages", CASH],
  ["POST", "/v1/packages", CASH],
  ["POST", `/v1/packages/${ID}/extend`, CASH],
  ["GET", `/v1/students/${ID}/lesson-balance`, CASH],
  ["GET", "/v1/reports/packages/payment-needed", CASH],
  ["GET", "/v1/reports/packages/payment-needed/reminders", MGMT],
  ["POST", "/v1/reports/packages/payment-needed/reminders", MGMT],
  // payroll:read, payroll:write, payroll:approve
  ["GET", "/v1/payrolls", SPEND],
  ["GET", `/v1/payrolls/${ID}`, SPEND],
  ["POST", "/v1/payrolls/generate", SPEND],
  ["POST", `/v1/payrolls/${ID}/items`, SPEND],
  ["DELETE", `/v1/payrolls/${ID}/items/${ID}`, SPEND],
  ["POST", `/v1/payrolls/${ID}/approve`, LEAD],
  ["POST", `/v1/payrolls/${ID}/pay`, SPEND],
  // accounting:read, accounting:write, accounting:close
  ["GET", "/v1/accounting/accounts", CASH],
  ["POST", "/v1/accounting/accounts", SPEND],
  ["PATCH", `/v1/accounting/accounts/${ID}`, SPEND],
  ["GET", "/v1/accounting/cash-accounts", CASH],
  ["POST", "/v1/accounting/cash-accounts", SPEND],
  ["GET", "/v1/accounting/entries", CASH],
  ["GET", `/v1/accounting/entries/${ID}`, CASH],
  ["POST", "/v1/accounting/entries", SPEND],
  ["POST", `/v1/accounting/entries/${ID}/reverse`, SPEND],
  ["GET", "/v1/accounting/ledger?account=1000", CASH],
  ["GET", "/v1/accounting/pending", CASH],
  ["POST", "/v1/accounting/sync", SPEND],
  ["GET", "/v1/accounting/verify", CASH],
  ["GET", "/v1/accounting/periods", CASH],
  ["POST", "/v1/accounting/periods/2020-01/close", LEAD],
  ["GET", "/v1/accounting/reports/trial-balance", CASH],
  ["GET", "/v1/accounting/reports/balance-sheet", CASH],
  ["GET", "/v1/accounting/reports/income-statement?date_from=2026-01-01&date_to=2026-01-31", CASH],
  ["GET", "/v1/accounting/suppliers", CASH],
  ["POST", "/v1/accounting/suppliers", SPEND],
  ["PATCH", `/v1/accounting/suppliers/${ID}`, SPEND],
  ["GET", "/v1/accounting/bills", CASH],
  ["GET", `/v1/accounting/bills/${ID}`, CASH],
  ["POST", "/v1/accounting/bills", SPEND],
  ["POST", `/v1/accounting/bills/${ID}/payments`, SPEND],
  ["POST", `/v1/accounting/bills/${ID}/void`, SPEND],
  ["POST", `/v1/accounting/bill-payments/${ID}/void`, SPEND],
  ["GET", "/v1/accounting/reports/payables-aging", CASH],
  ["GET", "/v1/accounting/statements", CASH],
  ["GET", `/v1/accounting/statements/${ID}`, CASH],
  ["POST", "/v1/accounting/statements", SPEND],
  ["POST", `/v1/accounting/statements/${ID}/lines`, SPEND],
  ["POST", `/v1/accounting/statements/${ID}/auto-match`, SPEND],
  ["POST", `/v1/accounting/statements/${ID}/lines/${ID}/match`, SPEND],
  ["POST", `/v1/accounting/statements/${ID}/lines/${ID}/unmatch`, SPEND],
  ["POST", `/v1/accounting/statements/${ID}/finalize`, SPEND],
];

test("the denial table names every operation of part 2", () => {
  const manifest = JSON.parse(readFileSync(new URL("../coverage.json", import.meta.url), "utf8")) as { operations: Record<string, { part?: number }> };
  const shape = (method: string, path: string): string => `${method} ${path.split("?")[0]!.replace(new RegExp(ID, "g"), "{}").replace("2020-01", "{}").replace(/\{\w+\}/g, "{}")}`;
  const listed = new Set(OPERATIONS.map(([method, path]) => shape(method, path)));
  const missing = Object.entries(manifest.operations)
    .filter(([, entry]) => entry.part === 2)
    .map(([key]) => shape(...(key.split(" ") as [string, string])))
    .filter((key) => !listed.has(key));
  expect(missing).toEqual([]);
});

for (const role of ALL) {
  test(`${role}: menu, every allowed screen, refused screens and refused requests`, async ({ page }) => {
    test.setTimeout(240_000);
    const center = await makeCenter();
    const account = center.accounts[role];
    await signIn(page, account);
    const menu = page.getByRole("navigation", { name: "Menyu" });
    await expect(menu.getByRole("link").first()).toBeVisible();
    expect((await menu.getByRole("link").allInnerTexts()).sort()).toEqual([...MENU[role]].sort());

    for (const name of MENU[role]) {
      await open(page, name);
      await settled(page);
    }
    for (const [name, address] of Object.entries(ADDRESS)) {
      if (MENU[role].includes(name)) continue;
      await page.goto(address);
      await expect(page.getByTestId("forbidden"), `${role} opens /${address}`).toBeVisible();
    }

    const call = await directApi(account);
    const refused: string[] = [];
    for (const [method, path, allowed] of OPERATIONS) {
      const { status } = await call(method, path, method === "GET" || method === "DELETE" ? undefined : {});
      if (!allowed.includes(role)) {
        if (status !== 403) refused.push(`${method} ${path}: ${status}, expected 403`);
      } else if (status === 403) refused.push(`${method} ${path}: 403, but this role may`);
    }
    // the /v1/teacher routes answer only to a signed-in teacher, whatever the permissions
    for (const path of ["/v1/teacher/me", "/v1/teacher/groups", "/v1/teacher/lessons", "/v1/teacher/pay", "/v1/teacher/guardian-messages"]) {
      const { status } = await call("GET", path);
      if (role === "teacher" ? status !== 200 : status !== 403) refused.push(`GET ${path}: ${status}`);
    }
    expect(refused).toEqual([]);
  });
}

test("staff tied to a branch see only that branch, in the panel and past it", async ({ page }) => {
  const center = await makeCenter();
  const account = center.accounts.branch_manager;
  await signIn(page, account);
  const chooser = page.getByTestId("branch");
  await expect(chooser).toBeDisabled();
  await expect(chooser).toHaveValue(center.branches.second);
  await open(page, "O'quvchilar");
  await expect(page.getByRole("link", { name: center.far_student.name })).toBeVisible();
  await expect(page.getByText(center.students[0].name)).toHaveCount(0);
  await page.goto(`students/${center.students[0].id}`);
  await expect(page.getByRole("alert")).toContainText("Yozuv topilmadi");

  const call = await directApi(account);
  expect((await call("GET", `/v1/students/${center.students[0].id}`)).status).toBe(404);
  expect((await call("GET", `/v1/groups/${center.group.id}`)).status).toBe(404);
  expect((await call("GET", "/v1/students", undefined, { "X-Branch": center.branches.main })).status).toBe(403);
  const mine = (await call("GET", "/v1/students?limit=200")).body.items as { id: string }[];
  expect(mine.map((s) => s.id)).toEqual([center.far_student.id]);
});

test("center-wide staff narrow the view with the branch chooser", async ({ page }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.owner);
  await open(page, "O'quvchilar");
  await expect(page.getByRole("link", { name: center.far_student.name })).toBeVisible();
  await expect(page.getByRole("link", { name: center.students[0].name })).toBeVisible();
  const sent: (string | undefined)[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/v1/students?")) sent.push(r.headers()["x-branch"]);
  });
  await page.getByTestId("branch").selectOption(center.branches.second);
  await expect(page.getByRole("link", { name: center.far_student.name })).toBeVisible();
  await expect(page.getByRole("link", { name: center.students[0].name })).toHaveCount(0);
  expect(sent.at(-1)).toBe(center.branches.second);
  await page.reload(); // the choice is remembered; it is not a secret
  await expect(page.getByTestId("branch")).toHaveValue(center.branches.second);
});

test("one center never sees another's records", async ({ page }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.owner);
  await open(page, "O'quvchilar");
  await expect(page.getByText(center.other.student.name)).toHaveCount(0);
  await page.goto(`students/${center.other.student.id}`);
  await expect(page.getByRole("alert")).toContainText("Yozuv topilmadi");
  const call = await directApi(center.accounts.owner);
  expect((await call("GET", `/v1/students/${center.other.student.id}`)).status).toBe(404);
  expect((await call("PATCH", `/v1/students/${center.other.student.id}`, { notes: "x" })).status).toBe(404);
  expect((await call("POST", "/v1/payments", { student_id: center.other.student.id, amount: "1000", method: "cash" })).status).toBeGreaterThanOrEqual(400);
});
