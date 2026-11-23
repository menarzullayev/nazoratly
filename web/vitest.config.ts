import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: { "@domain": r("../sheets/src/domain"), "@": r(".") } },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
