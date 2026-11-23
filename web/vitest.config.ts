import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: { "@domain": r("../sheets/src/domain"), "@": r(".") } },
  oxc: { jsx: { runtime: "automatic" } },
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node" },
});
