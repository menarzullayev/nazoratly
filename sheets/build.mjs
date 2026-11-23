// Bundles the TypeScript into one Apps Script file and assembles dist/ for `clasp push`.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/Code.ts"],
  bundle: true,
  format: "iife",
  target: "es2020", // Apps Script V8 runtime
  outfile: "dist/Code.js",
  legalComments: "none",
  logLevel: "warning",
});

const css = readFileSync("src/ui/style.css", "utf8");
for (const f of ["Attendance", "Payment", "Drafts"]) {
  const html = readFileSync(`src/ui/${f}.html`, "utf8");
  if (!html.includes("/*STYLE*/")) throw new Error(`${f}.html has no style placeholder`);
  writeFileSync(`dist/${f}.html`, html.replace("/*STYLE*/", css));
}
copyFileSync("appsscript.json", "dist/appsscript.json");

const out = readFileSync("dist/Code.js", "utf8");
for (const fn of ["onOpen", "doPost", "doGet", "getRoster", "saveAttendance", "recordPayment", "decideDrafts"]) {
  if (!new RegExp(`\\b${fn}\\b`).test(out)) throw new Error(`bundle is missing ${fn}`);
}
console.log(`dist/ ready: Code.js ${(out.length / 1024).toFixed(1)} KB`);
