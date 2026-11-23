// CPU profile of the page load (main thread), printed as the heaviest functions.  node scripts/profile-load.mjs http://127.0.0.1:4180/ [cpuSlowdown]
import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "http://127.0.0.1:4180/";
const slow = Number(process.argv[3] ?? 4);
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await b.newPage({ viewport: { width: Number(process.argv[4] ?? 412), height: 823 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: slow });
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const { profile } = await cdp.send("Profiler.stop");
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const self = {};
profile.samples.forEach((id, i) => {
  const cf = nodes.get(id).callFrame;
  const k = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber}:${cf.columnNumber}`;
  self[k] = (self[k] ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000;
});
console.log(Object.entries(self).filter(([k]) => !k.startsWith("(idle)")).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${Math.round(v)}ms ${k}`).join("\n"));
await b.close();
