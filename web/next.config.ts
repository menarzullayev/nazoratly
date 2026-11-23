import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.join(import.meta.dirname, "..");

const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // The site imports the product's own pure domain code from ../sheets/src/domain (shared math, no copies).
  experimental: { externalDir: true, globalNotFound: true },
  turbopack: {
    root: repoRoot,
    resolveAlias: { "@domain": path.join(repoRoot, "sheets", "src", "domain") },
  },
};

export default config;
