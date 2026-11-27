/** Every role: its menu, every one of its screens against the real API, the screens it may not open, and the same
 * refusals from the server when the request skips the panel. Then the branch and center walls. */

import { directApi, expect, makeCenter, open, settled, signIn, test, type Role } from "./fixtures";

// Written out by hand on purpose: if the server's role matrix changed, this table must be changed knowingly.
const DAILY = ["Taqvim", "Bildirishnomalar"];
const STUDY_READ = ["Guruhlar", "Kurslar", "Ustozlar", "Xonalar", "Darslar"];
const STUDY_ALL = ["O'quvchilar", "Vasiylar", ...STUDY_READ, "Qoldirilgan darslar", "Jadval tekshiruvi", "Jadval xabarlari"];
const MONEY = ["Hisoblar", "To'lovlar", "Qarzdorlar", "Xarajatlar", "Hisobotlar"];
const CENTER = ["Markaz", "Filiallar", "Xodimlar", "Import"];
const OWN = ["Mening ishim", "Mening darslarim", "Mening guruhlarim", "Mening oyligim", "Mening xabarlarim"];
const EVERYTHING = ["Bosh panel", ...DAILY, "QR davomat", ...STUDY_ALL, ...MONEY, ...CENTER];

const MENU: Record<Role, string[]> = {
  owner: EVERYTHING,
  admin: EVERYTHING,
  manager: ["Bosh panel", ...DAILY, "QR davomat", ...STUDY_ALL, ...MONEY, "Markaz", "Filiallar", "Xodimlar", "Import"],
  accountant: ["Bosh panel", ...DAILY, "O'quvchilar", "Vasiylar", ...STUDY_READ, "Qoldirilgan darslar", ...MONEY, "Markaz", "Filiallar"],
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
};

type Op = [method: string, path: string, allowed: Role[]];
const ALL: Role[] = ["owner", "admin", "manager", "accountant", "teacher", "viewer"];
const LEAD: Role[] = ["owner", "admin"];
const MGMT: Role[] = ["owner", "admin", "manager"];
const CASH: Role[] = ["owner", "admin", "manager", "accountant"];
const SPEND: Role[] = ["owner", "admin", "accountant"];
const ID = "00000000-0000-4000-8000-000000000000";
// one or more operations behind every permission of part 1; a role not listed must get 403
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
];

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
