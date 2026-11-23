import { defineConfig } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  use: { baseURL: base, launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] } },
  webServer: process.env.BASE_URL
    ? undefined
    : { command: "npx --yes serve@14 out -l 4173 --no-clipboard", url: base, reuseExistingServer: true, timeout: 60_000 },
});
