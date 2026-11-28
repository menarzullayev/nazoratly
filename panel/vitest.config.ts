import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: { alias: { "@api": here("../clients/typescript/src"), "@translit": here("../web/lib/translit/index.ts") } },
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node" },
});
