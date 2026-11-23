# Landing: full site (hero A, interactive demo, sections, SEO). Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (owner rule: no subagents unless asked). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the approved prototype into the finished five-language landing page: hero A, in-page interactive demo built on the product's own domain code, how-it-works, Telegram view, technology, pricing, FAQ, contact, SEO, deployed.

**Architecture:** Same `web/` static Next.js app. Demo state is a pure TypeScript engine over `sheets/src/domain/*` (billing, debt, payroll, reminders, messages) with a fixed demo date; UI components are thin. Rich Telegram messages produced by `messages.ts` are rendered by an allowlist renderer (no `dangerouslySetInnerHTML`). All copy lives in the three dictionaries (uz source, ru, en; Cyrillic/new Latin generated).

**Tech Stack:** as in the foundation plan, plus `@axe-core/playwright` and `lighthouse` (dev only).

**Spec:** `docs/superpowers/specs/2026-11-23-landing-page-design.md` (owner choices since: hero **A**, accent **emerald**).

## Global Constraints

- No GitHub link, no "open source / ochiq kod" wording anywhere (all locales). No Payme/Click/SMS/fiscalization promised as available.
- Contacts: `@menarzullayev` (https://t.me/menarzullayev), `+998902336600`, `@nazoratlybot` (https://t.me/nazoratlybot). Nothing else personal.
- Prices only as ranges: Starter from 500 000, Business from 1 500 000, Pro from 3 000 000 UZS one-time; monthly service 300 000 to 600 000 UZS; "exact price after a short conversation".
- No invented customers, testimonials, statistics. Numbers on the page come from the live demo or the price table.
- Demo uses `@domain/*` imports only for math (no copies); demo "today" is fixed `2026-11-23` for determinism.
- No third-party requests, no cookies, no analytics. CSP stays as in `web/security-headers.conf`.
- Every locale renders every section; `prefers-reduced-motion` and no-WebGL still give the complete page.
- `NEXT_PUBLIC_DEMO_SHEET_COPY_URL` (Google Sheets copy link) is optional; unset means the button is not rendered (no fake link).

## Review Focus

- Payment larger than the debt, zero or negative amount, non-numeric input: demo shows credit / rejects, never NaN (Task 3).
- Reminder for a student without consent or chat: draft is refused with a visible reason, like the product (Task 3).
- Rich-message renderer given unknown tags or `<script>`: renders text only, never executes (Task 4).
- Very long names or Cyrillic/new-Latin text in the demo table: no overflow at 320 px (Task 5).
- Keyboard-only use of the whole demo and FAQ; visible focus; screen-reader names (Task 6).

---

### Task 1: Keep hero A, remove the prototypes and the old API landing

**Files:**
- Delete: `web/scenes/map/*`, `web/scenes/flow/*`, `web/components/LabClient.tsx`, `web/app/(lab)/*`, `web/test/mapLayout.test.ts`, `web/test/flowPath.test.ts`, `web/e2e/lab.spec.ts`, `backend/src/nazoratly/routers/landing.py` (and its include in `main.py`, its test in `backend/tests/test_ops.py`)
- Create: `web/components/Hero.tsx`, `web/e2e/hero.spec.ts`
- Modify: `web/components/ScrollStage.tsx` (only the chaos scene), `web/components/SiteHome.tsx` (uses `Hero`), `web/nginx.conf` (drop `/lab/`), `web/app/robots.ts`, `web/e2e/live.spec.ts`, `docs/DEPLOY.md`

**Interfaces:**
- Produces: `Hero({ locale }: { locale: Locale })` client component (hero copy from the dictionary over `ScrollStage` with chaos scene, accent `#34d399`); `ScrollStage({ tier, accent, children })`.

- [ ] **Step 1: Write failing e2e** `hero.spec.ts`: canvas visible at `/` on full tier (`?tier=` removed: set via `page.addInitScript` nothing; default desktop chromium with swiftshader gives full); `/lab/` now returns 404; scrolling to the end sets `[data-stage]` `data-progress` > 0.95; with `emulateMedia({ reducedMotion: "reduce" })` no canvas and `data-progress="1.000"`; context loss removes the canvas and keeps `h1`.
- [ ] **Step 2: Run** `npx playwright test e2e/hero.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the removal and `Hero`; the lab-only `useMotionTier(override)` parameter stays (used by tests through `?tier=` only if kept; otherwise delete the override).
- [ ] **Step 4: Run** `npm run lint && npm run typecheck && npm test && npm run build && npx playwright test`; and in `backend/`: `uv run pytest -q`. Expected: all pass.
- [ ] **Step 5: Commit** `refactor(web): keep hero A, drop prototypes and the API landing page`.

### Task 2: Content dictionaries for every section (uz, ru, en)

**Files:**
- Modify: `web/i18n/dictionaries/{uz,ru,en}.ts`, `web/i18n/get.ts` (type only)
- Test: `web/test/content.test.ts` (extends `i18n.test.ts` rules)

**Interfaces:**
- Produces: dictionary keys (all strings unless noted): `nav.{demo,how,bot,tech,pricing,faq,contact}`, `demo.{title,lead,tabs.{attendance,payments,reminders,payroll},...}` (UI labels listed in Task 4), `how.{title,steps: {title,text}[4]}`, `bot.{title,lead,points: string[3]}`, `tech.{title,lead,items: {title,text}[4]}`, `pricing.{title,lead,note,tiers: {name,price,desc,features:string[]}[3],monthly}`, `faq.{title,items:{q,a}[6]}`, `contact.demoSheet`. Arrays are allowed in `Dict` (extend the `Widen` type and the leaf walker in tests).

- [ ] **Step 1: Write failing tests** `content.test.ts`: key parity ru/en/uz including array lengths; no locale mentions `github|open source|ochiq kod|открыт.. код|очиқ код|payme|click|sms|fiskal|фискал` as an available feature (a negative allowlist is not needed: those words must simply not appear, except the FAQ may say Payme/Click are "not connected yet" in a single known key `faq.items.3.a` whose text the test pins by key); pricing numbers appear exactly as in Global Constraints (`500 000`, `1 500 000`, `3 000 000`, `300 000`, `600 000`) in uz/ru/en; `hero.title` unchanged.
- [ ] **Step 2: Run** `npx vitest run test/content.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the copy.** Uzbek Latin source first (owner-facing tone: foyda, tartib, nazorat; no hype), then Russian and English by hand. FAQ topics: where data lives, do guardians have to agree (consent in bot), does AI send messages (no, owner approves), what about Payme/Click (not connected yet, planned), can I start in Google Sheets (yes), what do I need to start.
- [ ] **Step 4: Run** the full unit suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): copy for all sections in uz, ru and en`.

### Task 3: Demo engine (pure, over the product's domain code)

**Files:**
- Create: `web/demo/engine.ts`, `web/demo/seed.ts`
- Test: `web/test/demoEngine.test.ts`

**Interfaces:**
- Consumes: `computeDebts`, `planCharges`, `planReminders`, `computePayroll`, `heldLessons`, `collectedTuition`, `reminderRich`, `formatSom`, `effectiveFee` from `@domain/*`.
- Produces: `DEMO_TODAY = "2026-11-23"`; `type DemoState`; `seedState(): DemoState` (8 students, 2 groups, 2 teachers, 3 months of charges, payments, attendance: same shape and names as the sheet's sample data, guardian consent for 3 students); `markAttendance(s, date, groupId, studentId, status): DemoState`; `addPayment(s, studentId, amount: number, method: string): { state: DemoState; error?: "invalid_amount" }`; `debtOf(s, studentId): StudentDebt`; `draftReminders(s): { drafts: Draft[]; skipped: { studentId: string; reason: SkipReason }[] }`; `approve(s, draftId): { state: DemoState; message: string /* rich HTML from reminderRich */ }`; `payrollOf(s, teacherId): PayrollResult`. All functions are pure (return new state).

- [ ] **Step 1: Write failing tests** with exact numbers computed from the seed (assert the seed's own debt first, e.g. `debtOf(seed, "S0005").outstanding === 1_800_000`, matching the sheet's sample): paying 600 000 for S0005 reduces outstanding to 1 200 000 and FIFO clears the oldest charge first; paying more than outstanding gives `credit > 0` and `outstanding === 0`; `addPayment(s, id, 0)`, `-5`, `NaN` return `error: "invalid_amount"` and an unchanged state; marking absent then present changes only that row; `draftReminders` skips a student without consent with reason `no_consent` and includes consenting debtors; `approve` returns a message containing `Jami qoldiq` and the student's name; `payrollOf` for a per-lesson teacher equals `rate * heldLessons`; engine never mutates its input (deep-freeze the seed in the tests).
- [ ] **Step 2: Run** `npx vitest run test/demoEngine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the engine over the domain functions; `seedState()` builds charges with `planCharges` for the three months ending at `DEMO_TODAY`.
- [ ] **Step 4: Run** the unit suite and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): demo engine on the product's domain code`.

### Task 4: Demo UI and the safe rich-message renderer

**Files:**
- Create: `web/lib/richRender.tsx`, `web/components/PhoneMock.tsx`, `web/components/demo/{Demo.tsx,AttendanceTab.tsx,PaymentsTab.tsx,RemindersTab.tsx,PayrollTab.tsx}`
- Modify: dictionaries (demo labels), `SiteHome.tsx` (mount `Demo`)
- Test: `web/test/richRender.test.tsx`, `web/e2e/demo.spec.ts`

**Interfaces:**
- Consumes: Task 3 engine, Task 2 `demo.*` keys.
- Produces: `renderRich(html: string): ReactNode` (allowlist: `p,b,i,h3,br,table,tr,th,td,tg-time,tg-button,tg-button-row`; everything else rendered as its text content; attributes dropped except `align` and button `type`/`data` never executed); `Demo({ locale })`; `PhoneMock({ children })`.

- [ ] **Step 1: Write failing tests.** Unit (`renderToStaticMarkup`): `renderRich('<p>a</p><script>alert(1)</script>')` contains `a` and no `<script`; `<img src=x onerror=alert(1)>` yields no `img` element; tables keep rows; `tg-button` becomes a `<span role="button" aria-disabled>` (buttons in the mock are not live). E2E `demo.spec.ts` (each of `/` and `/ru/`): marking a student absent updates the row; entering 600000 in payments lowers the shown debt; invalid input shows the validation message and no `NaN` text appears anywhere in the page; "tayyorlash" then "tasdiqlash" shows the phone message with the table; payroll tab shows a number equal to rate times lessons; whole flow works with the keyboard only (`Tab`, `Enter`, `Space`).
- [ ] **Step 2: Run** unit and e2e. Expected: FAIL.
- [ ] **Step 3: Implement** the renderer (parse with a tiny tokenizer, no `innerHTML`), the four tabs as accessible tabs (`role="tablist"`, arrow keys), live-region announcements for results.
- [ ] **Step 4: Run** unit, e2e, lint, typecheck, build. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): interactive demo with safe Telegram message rendering`.

### Task 5: Page sections, navigation and motion

**Files:**
- Create: `web/components/sections/{HowItWorks,BotSection,Tech,Pricing,Faq,Contact}.tsx`, `web/components/Reveal.tsx`, `web/components/Nav.tsx`
- Modify: `web/components/SiteHome.tsx`
- Test: `web/e2e/sections.spec.ts`

**Interfaces:**
- Consumes: dictionaries (Task 2), `Demo` (Task 4), `PhoneMock`, `renderRich`.
- Produces: anchored sections with ids `demo, how, bot, tech, pricing, faq, contact`; `Reveal` (GSAP ScrollTrigger fade/slide, no-op when tier is `static`); contact section renders the Google Sheet copy button only when `process.env.NEXT_PUBLIC_DEMO_SHEET_COPY_URL` is a valid `https://docs.google.com/spreadsheets/d/<id>/copy` URL.

- [ ] **Step 1: Write failing e2e** `sections.spec.ts` for all five locales: every nav link scrolls to an existing section id; FAQ items open and close with Enter/Space and expose `aria-expanded`; price cards show the five exact figures; the three contact links exist; the demo-sheet button is absent when the env var is unset; no horizontal scroll at 320 px with the longest locale (`/uz-cyrl/`); no external request; `h1` count is 1 and heading levels never skip.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** sections and nav (sticky header with language switch, mobile menu as a `<details>`), `Reveal`.
- [ ] **Step 4: Run** e2e, lint, typecheck, build. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): how it works, bot, technology, pricing, FAQ and contact sections`.

### Task 6: SEO, accessibility audit, performance budget

**Files:**
- Create: `web/app/icon.svg`, `web/app/opengraph-image.png` (generated once by `web/scripts/og.mjs` with Playwright), `web/components/JsonLd.tsx`, `web/e2e/a11y.spec.ts`, `web/scripts/lighthouse.mjs`
- Modify: `web/i18n/metadata.ts`, `web/package.json` (dev deps `@axe-core/playwright`, `lighthouse`)
- Test: `web/e2e/a11y.spec.ts`, `web/test/seo.test.ts`

**Interfaces:**
- Produces: `jsonLd(locale: Locale): object` (schema.org `SoftwareApplication`, name, description, inLanguage, offers as `PriceSpecification` ranges, contact point), emitted as `<script type="application/ld+json">`.

- [ ] **Step 1: Write failing tests.** `seo.test.ts`: `jsonLd` has `@type` `SoftwareApplication`, `inLanguage` matches the locale tag, no GitHub URL, valid JSON. `a11y.spec.ts`: axe (`wcag2a, wcag2aa, wcag21aa`) reports zero violations for every locale on `/` with the demo's each tab opened; `og:image`, `twitter:card`, canonical and hreflang present.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** metadata, icon, OG image script, JSON-LD; fix every axe finding at the cause (contrast tokens first).
- [ ] **Step 4: Measure.** `node scripts/lighthouse.mjs http://127.0.0.1:4173/ ` (mobile emulation) must report Performance >= 90, Accessibility 100, Best Practices >= 95, SEO 100; if Performance is lower, reduce initial JS (lazy-load the demo below the fold, split GSAP/Lenis) and re-measure; record the numbers in the PR text.
- [ ] **Step 5: Commit** `feat(web): SEO metadata, JSON-LD, axe audit and Lighthouse budget`.

### Task 7: Deploy, live verification, PR

**Files:**
- Modify: `web/e2e/live.spec.ts`, `docs/DEPLOY.md`, `.github/workflows/ci.yml` (add `npx playwright install --with-deps chromium` and `npm run e2e` to the `web` job, with the swiftshader args from `playwright.config.ts`)

- [ ] **Step 1: Extend** `live.spec.ts`: `/` has the OG image reachable (200), `/sitemap.xml` lists all five URLs, `/lab/` is 404, `/robots.txt` has no `/lab/` rule, the five locale pages return 200.
- [ ] **Step 2: Run** locally first: full unit + e2e + build; then `docker compose up -d --build web`.
- [ ] **Step 3: Run** `BASE_URL=https://nazoratly.bugvector.uz npx playwright test e2e/live.spec.ts`; check Telegram webhook still answers (`/yordam` to the bot, API log shows 200).
- [ ] **Step 4: Open the PR** with the Lighthouse numbers and the list of owner follow-ups (language review, demo Sheet copy link, price confirmation, new-Latin check on lex.uz).
- [ ] **Step 5: Commit** `feat(web): deploy full landing, extend live checks and CI`.

---

## Self-review

- Spec coverage: hero A (T1), five languages and all sections (T2, T5), interactive demo on the product's code with all four flows (T3, T4), Telegram view (T4, T5), technology without GitHub (T2, T5), pricing ranges (T2, T5), FAQ (T5), contact and demo-sheet copy link (T5), mobile/reduced-motion/WebGL (T1, T5), SEO/a11y/performance (T6), deploy and routing (T7). Owner-held: demo Sheet template and sharing, language review, price confirmation, new-Latin check.
- Types: `DemoState`, `Draft`, `renderRich`, `Reveal`, `jsonLd` named consistently across tasks.
- Proportion: bodies left to the implementer; tests carry the exact values.
