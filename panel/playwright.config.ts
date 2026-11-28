import { defineConfig } from "@playwright/test";

// Browser tests of the staff panel against the real API and PostgreSQL. global-setup starts a throw-away stack
// (backend/tests/e2e_stack.py), serves the built panel with the real nginx configuration, and puts both behind one
// origin. Nothing here ever points at a live deployment. Build the panel first (`npm run build`).
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { timezoneId: "Asia/Tashkent", locale: "uz-UZ", acceptDownloads: true, trace: "retain-on-failure" },
});
