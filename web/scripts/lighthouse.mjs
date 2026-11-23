// Lighthouse against one or more URLs, several runs each, median per category.
//   node scripts/lighthouse.mjs [--runs 3] [--preset mobile|desktop|both] [--min 100] url [url...]
// Fails when the median performance score of any URL is below --min or another budget is missed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const runs = Number(opt("runs", "3"));
const presetArg = opt("preset", "mobile");
const minPerf = Number(opt("min", "100"));
const urls = args.length ? args : ["http://127.0.0.1:4173/"];
const presets = presetArg === "both" ? ["mobile", "desktop"] : [presetArg];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function once(url, preset) {
  const out = join(mkdtempSync(join(tmpdir(), "lh-")), "r.json");
  const flags = ["--output=json", `--output-path=${out}`, "--quiet", "--chrome-flags=--headless=new --no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader"];
  if (preset === "desktop") flags.push("--preset=desktop");
  execFileSync(process.execPath, ["node_modules/lighthouse/cli/index.js", url, ...flags], { stdio: "inherit" });
  const r = JSON.parse(readFileSync(out, "utf8"));
  const sc = (k) => Math.round((r.categories[k]?.score ?? 0) * 100);
  const a = r.audits;
  return {
    performance: sc("performance"),
    accessibility: sc("accessibility"),
    "best-practices": sc("best-practices"),
    seo: sc("seo"),
    lcp: a["largest-contentful-paint"].numericValue,
    tbt: a["total-blocking-time"].numericValue,
    cls: a["cumulative-layout-shift"].numericValue,
  };
}

const budget = { accessibility: 100, "best-practices": 95, seo: 100 };
let failed = false;
for (const preset of presets) {
  for (const url of urls) {
    const rs = Array.from({ length: runs }, () => once(url, preset));
    const med = Object.fromEntries(Object.keys(rs[0]).map((k) => [k, median(rs.map((r) => r[k]))]));
    console.log(`${preset} ${url} runs=${runs} perf=[${rs.map((r) => r.performance).join(",")}] median`, JSON.stringify({ ...med, lcp: Math.round(med.lcp), tbt: Math.round(med.tbt), cls: +med.cls.toFixed(3) }));
    const bad = [["performance", minPerf], ...Object.entries(budget)].filter(([k, v]) => med[k] < v);
    if (bad.length) {
      failed = true;
      console.error("BUDGET MISSED:", preset, url, bad.map(([k, v]) => `${k} ${med[k]} < ${v}`).join(", "));
    }
  }
}
if (failed) process.exit(1);
console.log("PASSED");
