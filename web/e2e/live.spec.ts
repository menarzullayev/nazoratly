import { expect, test } from "@playwright/test";

// Run against the deployed stack:  BASE_URL=https://nazoratly.bugvector.uz npx playwright test e2e/live.spec.ts
test.skip(!process.env.BASE_URL, "needs BASE_URL of a deployment that routes /v1,/health to the API and the rest to web");

test("API paths still reach the API", async ({ request }) => {
  const h = await request.get("/health");
  expect(h.status()).toBe(200);
  expect((await h.json()).status).toBe("ok");
  const me = await request.get("/v1/me");
  expect(me.status()).toBe(401);
  expect((await me.json()).error.code).toBeTruthy();
  const hook = await request.post("/hooks/telegram", { data: {} });
  expect([403, 404]).toContain(hook.status());
});

test("the site is served from the web container", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page.locator("h1")).toBeVisible();
  expect(res?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
});

test("lab prototypes are gone", async ({ request }) => {
  expect((await request.get("/lab/")).status()).toBe(404);
});

test("unknown paths show the site's 404, not API JSON", async ({ request }) => {
  const r = await request.get("/definitely-missing");
  expect(r.status()).toBe(404);
  expect(r.headers()["content-type"]).toContain("text/html");
});
