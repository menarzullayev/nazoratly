// Bundles the TypeScript into one Apps Script file and assembles dist/ for `clasp push`.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/Code.ts"],
  bundle: true,
  format: "iife",
  globalName: "nz",
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

// Apps Script finds triggers (onOpen, doPost) and google.script.run targets by STATIC top-level function
// declarations, so every handler registered in src/Code.ts gets a declaration that delegates to the bundle.
const names = [...readFileSync("src/Code.ts", "utf8").matchAll(/^g\.(\w+) =/gm)].map((m) => m[1]);
if (names.length < 20) throw new Error(`expected many handlers, found ${names.length}`);
const wrappers = names.map((n) => `function ${n}() { return nz.handlers.${n}.apply(null, arguments); }`).join("\n");
writeFileSync("dist/Code.js", `${readFileSync("dist/Code.js", "utf8")}\n${wrappers}\n`);

const out = readFileSync("dist/Code.js", "utf8");
for (const fn of ["onOpen", "doPost", "doGet", "getRoster", "saveAttendance", "recordPayment", "decideDrafts", "menuSetup", "openAttendance"]) {
  if (!new RegExp(`^function ${fn}\\(`, "m").test(out)) throw new Error(`bundle has no top-level function ${fn}`);
}
console.log(`dist/ ready: Code.js ${(out.length / 1024).toFixed(1)} KB, ${names.length} entry points`);
