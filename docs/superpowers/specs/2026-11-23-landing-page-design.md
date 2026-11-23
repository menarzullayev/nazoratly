# nazoratly landing page: design

Status: DRAFT for approval (2026-11-23). Nothing is built yet. Decisions below come from the owner's answers in the design conversation unless marked **(my call)**.

## 1. Intent and why

The page at `https://nazoratly.bugvector.uz/` is the public face of nazoratly for **education-center owners** (the buyer: owner/director). Today `/` is a small static card page served by the API. The owner wants a complete, creative, professional, cinematic page built on the most current web stack and designed so it can grow later (customer cabinet, more content).

What a visitor should do: **open a live demo Google Sheet (copy it to their own account)**, try the product in an in-page simulation first, and contact the owner or the bot. Success = a center owner understands within one minute: attendance, payments/debt and teacher payroll in one place; guardians get Telegram reminders only after the owner approves them; and they can try it without signing up.

## 2. Goals, non-goals, anti-goals

Goals
- Cinematic scroll story with a 3D hero, three hero concepts built as prototypes so the owner picks one.
- In-page interactive demo using the product's real calculation code (no fake math).
- Five reading versions: Uzbek Latin, Uzbek Cyrillic, Uzbek new Latin (2026 reform), Russian, English.
- Sections: hero, interactive demo, Telegram bot view, how it works (3-4 steps), technology (API and AI agent/MCP), pricing, FAQ, contact.
- Fast and usable on cheap phones; accessible; SEO-ready per language.

Non-goals (now)
- No customer login/cabinet, no lead database, no form backend, no payments, no blog, no analytics/tracking.
- No claims about open source and **no GitHub link or the words "open source / ochiq kod"** anywhere on the page (the repository will be made private before production). The existing GitHub button on the current `/` is removed in the interim.

Anti-goals (would make it a failure even if it "works")
- A heavy 3D page that is slow or broken on phones.
- Invented customers, testimonials, statistics or logos. Anything numeric on the page is either computed live in the demo or clearly a price range.
- Advertising features that are not live: Payme/Click, SMS and fiscalization are OFF (no YaTT/MChJ yet), so they are not promised.
- Machine-translated-looking Cyrillic/new-Latin text that nobody checked.

## 3. Constraints

- Hosting now: this PC, same domain, via the existing Cloudflare tunnel (tunnel UUID in `~/.cloudflared/nazoratly.yml`; today a single ingress rule sends the whole hostname to the API on `127.0.0.1:8010`). The Telegram webhook (`/hooks/telegram`), payment callbacks (`/pay/...`), the API (`/v1/...`) and `/health`, `/ready` must keep working unchanged.
- Repository goes private before production: nothing on the page may link to it.
- Owner-supplied public contact data (explicitly approved for publication): Telegram `@menarzullayev`, phone `+998902336600`, bot `@nazoratlybot`.
- Prices come from the agreed strategy and are unvalidated in the market: shown only as "from" ranges.
- No subagents/agent teams unless the owner asks (global rule); no placeholder production logic.

## 4. Approaches considered

Framework
1. **Next.js (App Router) + React + TypeScript, static export** (chosen by the owner for the long term; static output keeps hosting trivial and lets the page move to Cloudflare Pages later with no rewrite). Trade-off: heavier toolchain than Astro; no server features until a server runtime is added.
2. Astro + React islands: faster by default, but the owner chose Next.js for future growth. Rejected.
3. Keep the FastAPI-served HTML: no build step, but cannot carry the 3D/animation/interactivity. Rejected.

How the page is served **(my call)**: a new `web` container (static files behind nginx) and a path-based Cloudflare tunnel ingress: `/v1/*`, `/pay/*`, `/hooks/*`, `/health`, `/ready`, `/mcp` (to be confirmed against the MCP port) to the API, everything else to `web`. Alternative (a reverse proxy container in front of both) adds a moving part with no benefit now.

Hero 3D concept: owner decision is **build all three as prototypes, then choose**: (A) chaos to order (floating papers/cells snap into a dashboard), (B) isometric center map (payments green, debts red pulses), (C) data flow Sheet to bot to phone. They live at a non-indexed `/lab` route behind a switcher; after the owner picks one, the other two are deleted.

## 5. Decisions

Stack **(my calls unless noted)**
- Next.js 16 (current stable 16.4.6 at time of writing), React 19, TypeScript strict, `output: "export"`. Versions pinned exactly at implementation after re-checking the registry.
- Tailwind CSS v4 + CSS variables for tokens; no UI kit.
- GSAP + ScrollTrigger (free for commercial use) for scroll choreography; Lenis for smooth scroll (disabled under reduced motion).
- Three.js via `@react-three/fiber` and `drei` for the hero; loaded lazily after first paint; device-capability gate.
- Tests: Vitest (units: transliteration, demo logic wiring), Playwright (smoke: each locale renders, demo flow, no console errors, no external requests), Lighthouse CI budget.
- Lives in the monorepo as `web/`, with its own CI job.

Languages and scripts
- Source copy is written once in **Uzbek Latin (current orthography)**; Russian and English are written by hand; **Uzbek Cyrillic and Uzbek new Latin are generated by a tested transliterator** at build time.
- New Latin rules (from news reports on the law signed 2026-10-21; official lex.uz text not yet read, so re-verify before release): `o'` becomes `ö`, `g'` becomes `ğ`, `sh` becomes `ş`, `ch` becomes `ç`; `ng` is spelled unchanged (no longer an alphabet letter); the apostrophe (tutuq) stays (`ma'no`); 28 letters plus one mark; effective 2027-04-22. Edge cases to test: `s'h` vs `sh`, `n'g` vs `ng`, capitals, words with `o'`/`g'` at word boundaries.
- Cyrillic uses the standard Latin to Cyrillic mapping with the usual exceptions (`ye`, `yo`, `yu`, `ya`, `ts`, `e` vs `э`, `'` to `ъ`, `ы` not used). Owner (or a native reader) reviews all five versions before release; the page does not ship with unreviewed text.
- URLs **(my call)**: `/` Uzbek Latin (default), `/uz-cyrl`, `/uz-new`, `/ru`, `/en`. A language switcher on the page; `hreflang` alternates and `x-default`; no automatic redirect (static export).

Visual direction
- Cinematic dark theme with **one accent color**, wordmark "nazoratly" plus a simple eye/dot mark designed by me **(my call)**. Brand proposals (2-3 accent colors) are shown inside the `/lab` prototypes and the owner picks.
- Typography: one variable sans for UI and one display face; fonts self-hosted (no third-party requests; works under a strict CSP).
- Motion: scroll-scrubbed hero, section reveals, magnetic buttons; everything has a reduced-motion fallback.

Interactive demo (all client-side, no server)
- Attendance marking, payment entry with live FIFO debt recalculation, reminder draft to approve to Telegram message preview (rich message table and buttons rendered in a phone mockup), teacher payroll calculator.
- **Math is shared with the product:** the demo imports `sheets/src/domain/*` (billing, debt, payroll, reminders, messages) through a path alias so the page and the real product can never disagree.
- Sample data = the same demo set as the sheet's sample data.

Demo Google Sheet
- Primary button opens a **public template copy link** (`.../copy`) of a clean demo sheet. The owner's own working sheet is never exposed (it holds a linked Telegram chat and settings).
- The template and its sharing are created by the owner's Google account. **Blocker/hold:** until the copy URL exists, the primary button scrolls to the in-page demo and the "copy to Google Sheets" button stays hidden (configured by `NEXT_PUBLIC_DEMO_SHEET_COPY_URL`, no fake link).

Pricing section
- Shown as ranges: Starter from 500,000 UZS, Business from 1,500,000 UZS, Pro from 3,000,000 UZS one-time, plus a separate monthly service fee (300-600k UZS range), "exact price after a short conversation". Easy to change in one data file.

Technology section
- API and AI-agent (MCP) for integrators, plus the trust facts that are true today: data separated per center, audit log, the AI reads and drafts but a person approves every send, tests run automatically. No code or repository links.

Performance and accessibility
- Mobile-first: phones and `prefers-reduced-motion` get a lightweight scene (CSS/GSAP, no WebGL); desktop with a capable GPU gets the full scene. Target Lighthouse mobile 90+ (Performance), 100 Accessibility, LCP under 2.5 s on a mid phone; WebGL chunk is lazy.
- WCAG AA contrast, full keyboard use of the demo, meaningful text kept in HTML (nothing important only inside the canvas), semantic landmarks.
- No cookies, no analytics, no third-party scripts or fonts; CSP `default-src 'none'` family with explicit self allowances.

Delivery
- `web/Dockerfile`: node build stage then nginx static; new `web` service in `docker-compose.yml`; update tunnel ingress (path rules) and `docs/DEPLOY.md`; remove the old FastAPI landing route once `web` serves `/` (keep until then so `/` never 404s).
- Roll-out order: (1) `web/` shell, tokens, i18n and transliterator with tests; (2) the three hero prototypes at `/lab`, deployed locally for the owner to choose; (3) after the choice: full sections, interactive demo, five languages, SEO; (4) container, tunnel path routing, CI job, live verification; (5) owner review of all five language versions, then release.

## 6. Left to the builder

Component structure, exact easing and timings, scene geometry details, copy polish in Uzbek/Russian/English (owner reviews), favicon/OG image generation, sitemap/robots, nginx caching headers.

## 7. Open items needing the owner

- Create and share the clean demo sheet template (copy link) when ready.
- Pick hero concept A/B/C and the accent color from `/lab`.
- Review the five language versions; confirm the new-Latin rules against the official law text when it is published on lex.uz.
- Confirm final price ranges before any marketing use.
