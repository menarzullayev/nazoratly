import { defineConfig } from "@playwright/test";

// Browser tests for the pages the API itself serves (/ui/*). The stack (Postgres in Docker, the real app, a fake Telegram)
// is started by global-setup and removed by global-teardown; nothing here ever points at the live compose project.
export default defineConfig({
  testDir: "e2e-api",
  timeout: 60_000,
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e-api/global-setup.ts",
  globalTeardown: "./e2e-api/global-teardown.ts",
  use: { timezoneId: "Asia/Tashkent", locale: "uz-UZ", acceptDownloads: true },
});
