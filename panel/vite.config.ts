import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  base: "/app/",
  plugins: [react()],
  resolve: {
    alias: {
      // shared code stays in one place: the API types of the typed client and the site's transliteration
      "@api": here("../clients/typescript/src"),
      "@translit": here("../web/lib/translit/index.ts"),
    },
  },
  // `npm run dev`: the API is proxied so the panel and the API share one origin, as in production
  server: { port: 5173, proxy: { "/v1": process.env.NZ_API ?? "http://127.0.0.1:8000" } },
  build: {
    outDir: "dist",
    sourcemap: false,
    // the CSP allows no inline scripts and no data: URLs for them: keep every asset a file
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
