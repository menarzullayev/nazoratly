/** Sign-in, the cookie session, two tabs, the password reset and the headers the panel is served with. */

import { dialog, directApi, expect, makeCenter, open, resetLink, settled, signIn, test } from "./fixtures";

const COOKIE = "__Secure-nz_refresh";

test("registering a center signs in; a reload keeps the session and signing out ends it", async ({ page, context }) => {
  const bodies: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/v1/auth/")) bodies.push(await r.text().catch(() => ""));
  });
  await page.goto("");
  await expect(page).toHaveURL(/\/app\/login$/);
  await page.getByRole("link", { name: "Yangi markazni ro'yxatdan o'tkazish" }).click();
  await page.getByRole("button", { name: "Ro'yxatdan o'tish" }).click();
  await expect(page.getByText("To'ldirilishi shart").first()).toBeVisible();
  await page.getByLabel("O'quv markazi nomi").fill("Panel sinov markazi");
  await page.getByLabel("F.I.Sh.").fill("Egasi Sinov");
  const email = `reg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel("Parol", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Ro'yxatdan o'tish" }).click();
  await expect(page.getByText("Juda qisqa")).toBeVisible(); // the server's check, shown beside the field
  await page.getByLabel("Parol", { exact: true }).fill("a-long-enough-password");
  await page.getByRole("button", { name: "Ro'yxatdan o'tish" }).click();
  await expect(page).toHaveURL(/\/app\/dashboard$/);
  await settled(page);
  await expect(page.getByText("Panel sinov markazi")).toBeVisible();

  // the cookie: out of the page's reach, only for the web auth routes
  const cookies = await context.cookies();
  expect(cookies).toHaveLength(1);
  const cookie = cookies[0]!;
  expect(cookie).toMatchObject({ name: COOKIE, httpOnly: true, secure: true, sameSite: "Strict", path: "/v1/auth/web" });
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 86_400);

  // no token in any storage, in the address or readable by script; none of them in a response body
  const kept = await page.evaluate(async () =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      dbs: await indexedDB.databases(),
      cookie: document.cookie,
      url: location.href,
    }),
  );
  expect(kept).not.toMatch(/nzr_|eyJ|access_token/);
  expect(JSON.parse(kept)).toMatchObject({ session: {}, dbs: [], cookie: "" });
  expect(bodies.join("")).not.toContain(cookie.value);
  expect(bodies.join("")).not.toContain("refresh_token");

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Bosh panel" })).toBeVisible();
  await open(page, "O'quvchilar");
  await page.getByRole("link", { name: "Egasi Sinov" }).click();
  await page.getByRole("button", { name: "Chiqish" }).click();
  await expect(page).toHaveURL(/\/app\/login$/);
  expect(await context.cookies()).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Tizimga kirish" })).toBeVisible();
});

test("a wrong password says so and keeps the person on the sign-in page", async ({ page }) => {
  const center = await makeCenter();
  await page.goto("login");
  await page.getByLabel("Email yoki telefon").fill(center.accounts.owner.email);
  await page.getByLabel("Parol", { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Kirish", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Login va parolni tekshiring");
  await expect(page).toHaveURL(/\/app\/login$/);
});

test("two tabs refreshing at the same time stay signed in, and sign out together", async ({ page, context }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.owner);
  const second = await context.newPage();
  await second.goto("students");
  await expect(second.getByRole("heading", { level: 1, name: "O'quvchilar" })).toBeVisible();
  const statuses: number[] = [];
  context.on("response", (r) => {
    if (r.url().endsWith("/v1/auth/web/refresh")) statuses.push(r.status());
  });
  for (let round = 0; round < 5; round++) {
    // every load starts by rotating the one shared cookie
    await Promise.all([page.reload(), second.reload()]);
    await Promise.all([
      expect(page.getByRole("navigation", { name: "Menyu" })).toBeAttached(),
      expect(second.getByRole("navigation", { name: "Menyu" })).toBeAttached(),
    ]);
  }
  expect(statuses.length).toBeGreaterThanOrEqual(10);
  expect(new Set(statuses)).toEqual(new Set([200]));
  await second.getByRole("link", { name: /Egasi|Owner/ }).first().click();
  await second.getByRole("button", { name: "Chiqish" }).click();
  await expect(page.getByRole("heading", { name: "Tizimga kirish" })).toBeVisible(); // without a reload
});

test("the web session routes refuse any other origin", async ({ page, request }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.owner);
  const base = process.env.NZ_ORIGIN!;
  const evil: (string | undefined)[] = [undefined, "https://evil.example.com", base.replace("localhost", "127.0.0.1"), `${base}.evil.com`];
  for (const origin of evil) {
    for (const path of ["login", "refresh", "logout", "register"]) {
      const r = await request.post(`${base}/v1/auth/web/${path}`, { data: {}, headers: origin ? { origin } : {} });
      expect([r.status(), path, origin]).toEqual([403, path, origin]);
    }
  }
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Menyu" })).toBeAttached(); // nothing reached the session
});

test("an operator's reset link sets a new password once and ends the old sessions", async ({ page, browser }) => {
  const center = await makeCenter();
  const account = center.accounts.manager;
  const old = await browser.newContext({ baseURL: `${process.env.NZ_ORIGIN}/app/`, locale: "uz-UZ" });
  const oldPage = await old.newPage();
  await signIn(oldPage, account);

  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  const link = await resetLink(account.email);
  const code = new URL(link).hash.slice("#code=".length);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Yangi parol qo'yish" })).toBeVisible();
  expect(page.url()).not.toContain(code); // taken out of the address bar and the history
  await page.getByLabel("Yangi parol", { exact: true }).fill("completely-new-password");
  await page.getByLabel("Yangi parolni takrorlang").fill("a-different-password");
  await page.getByRole("button", { name: "Parolni saqlash" }).click();
  await expect(page.getByText("Parollar bir xil emas")).toBeVisible();
  await page.getByLabel("Yangi parolni takrorlang").fill("completely-new-password");
  await page.getByRole("button", { name: "Parolni saqlash" }).click();
  await expect(page.getByText("Parol almashtirildi")).toBeVisible();
  expect(requested.filter((u) => u.includes(code))).toEqual([]); // the code never travelled in an address

  await oldPage.reload();
  await expect(oldPage.getByRole("heading", { name: "Tizimga kirish" })).toBeVisible();
  await old.close();
  await signIn(page, { ...account, password: "completely-new-password" });

  for (const bad of [link, await resetLink(account.email, true), `${process.env.NZ_ORIGIN}/app/reset#code=nzp_${"x".repeat(43)}`]) {
    const other = await page.context().newPage();
    await other.goto(bad);
    await other.getByLabel("Yangi parol", { exact: true }).fill("yet-another-password");
    await other.getByLabel("Yangi parolni takrorlang").fill("yet-another-password");
    await other.getByRole("button", { name: "Parolni saqlash" }).click();
    await expect(other.getByRole("alert")).toContainText("Havola yaroqsiz");
    await other.close();
  }
});

test("changing the password signs out everywhere", async ({ page, context }) => {
  const center = await makeCenter();
  const account = center.accounts.accountant;
  await signIn(page, account);
  await page.goto("account");
  await page.getByLabel("Joriy parol").fill(account.password);
  await page.getByLabel("Yangi parol", { exact: true }).fill("another-long-password");
  await page.getByRole("button", { name: "Parolni almashtirish" }).click();
  await expect(page.getByRole("heading", { name: "Tizimga kirish" })).toBeVisible();
  expect(await context.cookies()).toHaveLength(0);
  await signIn(page, { ...account, password: "another-long-password" });
});

test("an invitation is accepted and centers are switched without mixing their data, in both tabs", async ({ page, context }) => {
  const first = await makeCenter();
  const second = await makeCenter();
  const person = first.accounts.manager;
  const inviter = await directApi(second.accounts.owner);
  expect((await inviter("POST", "/v1/staff", { full_name: "Mehmon", email: person.email, role: "viewer" })).status).toBe(201);

  await signIn(page, person);
  const other = await context.newPage();
  await other.goto("students");
  await expect(other.getByRole("link", { name: first.students[1].name })).toBeVisible();

  await page.goto("account");
  await page.getByRole("button", { name: "Taklifni qabul qilish" }).click();
  await page.getByRole("button", { name: "Kirish", exact: true }).click();
  await expect(page.locator(".who")).toContainText("Kuzatuvchi");
  await open(page, "O'quvchilar");
  await expect(page.getByRole("link", { name: second.students[1].name })).toBeVisible();
  await expect(page.getByText(first.students[1].name)).toHaveCount(0);
  // the other tab followed: it must not keep showing, or writing to, the center that was left
  await expect(other.locator(".who")).toContainText("Kuzatuvchi");
  await expect(other.getByText(first.students[1].name)).toHaveCount(0);
});

test("the panel is served with a strict policy, deep links and the right caching", async ({ request }) => {
  const base = process.env.NZ_ORIGIN!;
  const index = await request.get(`${base}/app/students/some-id`);
  expect(index.status()).toBe(200);
  const headers = index.headers();
  expect(headers["content-security-policy"]).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["permissions-policy"]).toContain("camera=(self)");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  const html = await index.text();
  expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/); // no inline script
  expect(html).not.toMatch(/(src|href)="https?:/); // nothing external
  const asset = /src="(\/app\/assets\/[^"]+\.js)"/.exec(html)![1]!;
  const script = await request.get(`${base}${asset}`);
  expect(script.headers()["cache-control"]).toContain("immutable");
  expect(script.headers()["content-security-policy"]).toBeTruthy();
  expect((await request.get(`${base}/app/assets/missing.js`)).status()).toBe(404);
  expect((await request.get(`${base}/app`, { maxRedirects: 0 })).status()).toBe(301);
});

test("an unused dialog closes with the keyboard", async ({ page }) => {
  const center = await makeCenter();
  await signIn(page, center.accounts.owner);
  await page.goto("students");
  await page.getByRole("button", { name: "O'quvchi qo'shish" }).press("Enter");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});
