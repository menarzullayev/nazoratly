import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The whole landing, per language variant and per viewport: content, language switch, scripts, console, links, images,
// the demo role buttons, every capability card and FAQ item, and axe. (Static export served from out/.)

const ROUTES = [
  { path: "/", lang: "uz-Latn", name: "uz" },
  { path: "/uz-cyrl/", lang: "uz-Cyrl", name: "uz-cyrl" },
  { path: "/uz-new/", lang: "uz-Latn", name: "uz-new" },
  { path: "/ru/", lang: "ru", name: "ru" },
  { path: "/en/", lang: "en", name: "en" },
] as const;
const VIEWPORTS = [
  { label: "desktop", size: { width: 1280, height: 800 } },
  { label: "mobile", size: { width: 390, height: 800 } },
] as const;

const CYR = /[Ѐ-ӿ]/g;
const NEW_LATIN = /[öğşçÖĞŞÇ]/;
// Dictionary-key-shaped text, raw template markers or JS leftovers mean a translation did not render.
const LEAK = /\{\{|\}\}|\bundefined\b|\[object|\bNaN\b|\b(?:hero|demo|features|how|bot|tech|pricing|faq|contact|footer|nav)\.[a-zA-Z]+(?:\.\d+)?\b/;

test.describe.configure({ mode: "parallel" });

const SECTIONS = ["demo", "features", "how", "bot", "tech", "pricing", "faq", "contact"];

async function scrollThrough(page: Page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 1100) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(25);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

for (const r of ROUTES) {
  for (const vp of VIEWPORTS) {
    test.describe(`${r.name} ${vp.label}`, () => {
      test.use({ viewport: vp.size });

      test("content: h1, every section, 18 capability cards, 10 FAQ items, no leaked keys", async ({ page }) => {
        await page.goto(r.path);
        await expect(page.locator("html")).toHaveAttribute("lang", r.lang);
        await expect(page.locator("h1")).toBeVisible();
        for (const id of SECTIONS) await expect(page.locator(`section#${id}`)).toHaveCount(1);
        await expect(page.locator("#features li")).toHaveCount(18);
        await expect(page.locator("#features h4")).toHaveCount(8);
        await expect(page.locator("#faq details")).toHaveCount(10);
        await expect(page.locator("#pricing li").first()).toBeAttached();
        const text = await page.locator("body").innerText();
        expect(text).not.toMatch(LEAK);
        // the HTML (not only the visible text) has no leaked template markers either
        expect(await page.content()).not.toMatch(/\{\{[^}]*\}\}/);
        for (const el of await page.locator("#features li").all()) expect((await el.innerText()).trim().length).toBeGreaterThan(40);
      });

      test("script: the right alphabet is used and the others are not", async ({ page }) => {
        await page.goto(r.path);
        const body = await page.locator("main").innerText();
        const cyr = (body.match(CYR) ?? []).length;
        const letters = (body.match(/\p{L}/gu) ?? []).length;
        if (r.name === "uz-cyrl" || r.name === "ru") {
          expect(cyr / letters, "Cyrillic share of letters").toBeGreaterThan(0.6);
          for (const h of await page.locator("h1, h2").all()) expect(await h.innerText()).toMatch(CYR);
        } else {
          expect(cyr, "no Cyrillic letters").toBe(0);
        }
        if (r.name === "uz-new") {
          expect(body).toMatch(NEW_LATIN);
          expect(body, "new Latin never keeps the old o' g' digraphs").not.toMatch(/\b[Oo]['‘’ʻ]z|\b[Gg]['‘’ʻ]/);
        }
        if (r.name === "uz") expect(body).toMatch(/o'/);
      });

      test("no console errors, no failed requests while loading and scrolling", async ({ page }) => {
        const problems: string[] = [];
        page.on("console", (m) => {
          if (m.type() === "error") problems.push(`console: ${m.text()}`);
        });
        page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
        page.on("response", (res) => {
          if (res.status() >= 400) problems.push(`${res.status()} ${res.url()}`);
        });
        page.on("requestfailed", (req) => problems.push(`failed ${req.url()}`));
        await page.goto(r.path, { waitUntil: "networkidle" });
        await scrollThrough(page);
        await page.locator("#demo").scrollIntoViewIfNeeded();
        await page.locator("#demo").getByRole("tab").nth(1).click();
        expect(problems).toEqual([]);
      });

      test("every internal link answers 200, every anchor has its target, every image loaded", async ({ page, request }) => {
        await page.goto(r.path, { waitUntil: "networkidle" });
        await scrollThrough(page);
        const links = await page.locator("a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href")!));
        const seen = new Set<string>();
        for (const href of links) {
          if (seen.has(href)) continue;
          seen.add(href);
          if (href.startsWith("#")) {
            if (href.length > 1) await expect(page.locator(`[id="${href.slice(1)}"]`), href).toHaveCount(1);
          } else if (href.startsWith("/")) {
            const res = await request.get(href);
            expect(res.status(), href).toBe(200);
          } else if (/^(tel:|mailto:)/.test(href)) {
            expect(href).toMatch(/^(tel:\+\d{9,15}|mailto:\S+@\S+)$/);
          } else {
            expect(href, "external links are https").toMatch(/^https:\/\//);
          }
        }
        const imgs = await page.locator("img").evaluateAll((els) => els.map((e) => ({ src: (e as HTMLImageElement).currentSrc, ok: (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0, alt: e.getAttribute("alt") })));
        for (const i of imgs) {
          expect(i.ok, `image ${i.src}`).toBe(true);
          expect(i.alt, `alt of ${i.src}`).not.toBeNull();
        }
        for (const src of await page.locator("link[rel~=icon], link[rel=manifest]").evaluateAll((els) => els.map((e) => e.getAttribute("href")!))) {
          if (src.startsWith("/")) expect((await request.get(src)).status(), src).toBe(200);
        }
      });

      test("no horizontal scroll and the header is usable", async ({ page }) => {
        await page.goto(r.path);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.size.width);
        await expect(page.locator("header")).toBeVisible();
        if (vp.label === "mobile") {
          await page.locator("header details summary").click();
          await expect(page.locator('header details a[href="#pricing"]')).toBeVisible();
        } else {
          await expect(page.locator('header nav a[href="#pricing"]').first()).toBeVisible();
        }
      });

      test("axe: no WCAG A/AA violations on the settled page", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(r.path);
        const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        expect(res.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
      });

      test("demo role buttons: owner, teacher and guardian", async ({ page }) => {
        await page.goto(r.path);
        const demo = page.locator("#demo");
        await demo.scrollIntoViewIfNeeded();
        const radios = demo.getByRole("radio");
        await expect(radios).toHaveCount(3);
        for (const radio of await radios.all()) await expect(radio).toHaveText(r.name === "uz-cyrl" || r.name === "ru" ? CYR : /\p{L}/u);
        await expect(radios.nth(0)).toBeChecked();
        await expect(demo.getByRole("tab")).toHaveCount(4);
        await radios.nth(1).click();
        await expect(radios.nth(1)).toBeChecked();
        await expect(demo.getByRole("tab")).toHaveCount(2);
        await expect(demo.locator("#att-group option")).toHaveCount(1);
        await radios.nth(2).click();
        await expect(radios.nth(2)).toBeChecked();
        await expect(demo.getByRole("tablist")).toHaveCount(0);
        await expect(demo.getByText("/qarz")).toBeVisible();
        expect(await demo.innerText()).not.toMatch(/NaN|undefined|Infinity/);
        await radios.nth(0).click();
        await expect(demo.getByRole("tab")).toHaveCount(4);
      });
    });
  }

  test(`${r.name}: every capability card and FAQ item is readable; FAQ opens and closes`, async ({ page }) => {
    await page.goto(r.path);
    const cards = page.locator("#features li");
    for (let i = 0; i < 18; i++) {
      const c = cards.nth(i);
      await expect(c.locator("h3, h4, strong").first(), `card ${i}`).toBeAttached();
      expect((await c.innerText()).trim().length).toBeGreaterThan(40);
    }
    // the eight newer cards carry their edition tag
    const newer = page.locator("#features h4");
    await expect(newer).toHaveCount(8);
    const faq = page.locator("#faq details");
    for (let i = 0; i < 10; i++) {
      const d = faq.nth(i);
      await d.locator("summary").click();
      await expect(d).toHaveAttribute("open", "");
      expect((await d.innerText()).trim().length).toBeGreaterThan(30);
      await d.locator("summary").click();
      await expect(d).not.toHaveAttribute("open", "");
    }
  });

  test(`${r.name}: language switch reaches every other variant and keeps the page working`, async ({ page }) => {
    for (const to of ROUTES) {
      await page.goto(r.path);
      const link = page.locator(`header a[href="${to.path}"]:visible, nav a[href="${to.path}"]:visible`).first();
      if (to.path === r.path) {
        await expect(page.locator(`a[href="${to.path}"]`).first()).toBeAttached();
        continue;
      }
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${to.path === "/" ? "/$" : to.path}$`));
      await expect(page.locator("html")).toHaveAttribute("lang", to.lang);
      await expect(page.locator("h1")).toBeVisible();
    }
  });
}

test("the 404 page is accessible and links home", async ({ page }) => {
  const res = await page.goto("/does-not-exist/");
  expect(res?.status()).toBe(404);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await expect(page.locator("a[href='/']").first()).toBeVisible();
});

test("sitemap and robots list every variant", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const sm = await (await request.get("/sitemap.xml")).text();
  for (const p of ["/uz-cyrl/", "/uz-new/", "/ru/", "/en/"]) expect(sm).toContain(p);
});
