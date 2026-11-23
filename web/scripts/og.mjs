// Regenerates public/og.png (1200x630) from an inline template. Run: node scripts/og.mjs
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const font = readFileSync(fileURLToPath(new URL("../node_modules/@fontsource-variable/unbounded/files/unbounded-latin-wght-normal.woff2", import.meta.url))).toString("base64");
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:U;src:url(data:font/woff2;base64,${font});font-weight:200 900}
html,body{margin:0;width:1200px;height:630px;background:#070b10;color:#e8eef5;font-family:U,system-ui,sans-serif;overflow:hidden}
.w{position:relative;width:1200px;height:630px;background:radial-gradient(900px 500px at 85% 110%,rgba(52,211,153,.28),transparent 60%)}
.in{position:absolute;left:72px;top:72px;right:72px}
.b{display:flex;align-items:center;gap:18px;font-size:34px;font-weight:600}
h1{font-size:76px;line-height:1.08;margin:150px 0 0;font-weight:700;letter-spacing:-.02em;max-width:900px}
p{font-size:30px;color:#93a4b6;margin:26px 0 0;font-family:system-ui,sans-serif}
.cards{position:absolute;right:70px;bottom:60px;display:grid;grid-template-columns:repeat(4,70px);gap:12px}
.cards i{display:block;height:44px;border-radius:8px;background:#e9eef3}.cards i:nth-child(5n+1){background:#34d399}
</style><div class="w"><div class="in">
<div class="b"><svg width="46" height="46" viewBox="0 0 26 26"><path d="M2 13s4.2-7.5 11-7.5S24 13 24 13s-4.2 7.5-11 7.5S2 13 2 13Z" fill="none" stroke="#e8eef5" stroke-width="1.8" stroke-linejoin="round"/><circle cx="13" cy="13" r="3.6" fill="#34d399"/></svg>nazoratly</div>
<h1>Your center, fully under control</h1><p>Attendance, payments, debt and payroll in one place</p></div>
<div class="cards">${'<i></i>'.repeat(12)}</div></div>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.waitForTimeout(300);
writeFileSync(fileURLToPath(new URL("../public/og.png", import.meta.url)), await page.screenshot({ type: "png" }));
await browser.close();
console.log("ok");
