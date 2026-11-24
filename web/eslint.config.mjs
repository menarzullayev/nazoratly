import next from "eslint-config-next/core-web-vitals";
import ts from "eslint-config-next/typescript";

const config = [...next, ...ts, { ignores: ["out/**", ".next/**", "next-env.d.ts", "e2e/**", "e2e-api/**", "playwright.config.ts", "playwright.api.config.ts"] }];
export default config;
