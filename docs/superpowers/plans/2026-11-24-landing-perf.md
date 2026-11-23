# Landing performance to Lighthouse 100 (2026-11-24)

Goal: Lighthouse Performance 100 on every language route, mobile and desktop profile, without removing the 3D hero, the demo or any section.

## Method
- Serve `web/out` with the repo's own `web/nginx.conf` (local container `nzr-perf-nginx`, port 4180), so compression and cache headers are the real ones.
- `node web/scripts/lighthouse.mjs --runs N --preset both --min 100 <urls>` reports the median of N runs per route and preset and fails below `--min`.
- `node web/scripts/profile-load.mjs <url> [cpuSlowdown] [width]` prints the heaviest main-thread functions of a page load.

## Baseline (median of 3, before changes)
Mobile 80 / 98 / 80 / 85 / 96 (uz, uz-cyrl, uz-new, ru, en), desktop 96 / 100 / 94 / 96 / 99. LCP was fine (0.9 s mobile); the loss was Total Blocking Time (155-870 ms mobile).

## Causes found
1. `useMotionTier` created a WebGL2 context on every page load (to tell `static` from `lite`/`full`), even on phones that never run WebGL. With software GL this is one 250 ms main-thread task during hydration. Fix: the probe is skipped for weak devices (decided from width/cores/memory/reduced motion first) and, for desktops, runs once the page is idle, after load.
2. The WebGL chunk, its context and Lenis started at hydration. Fix: they start after `load` and an idle callback (or on first user input); until then the DOM story is the poster.
3. The hero section height changed after hydration (100svh to 320svh), so the demo section sat inside the observer margin and the demo chunk loaded at first paint. Fix: the pinned height is reserved from the first paint.
4. The demo dictionary was passed as props, so it was serialised into the page payload. Fix: the lazy demo chunk reads its own dictionary.
5. Fonts: all unicode subsets were bundled; the new Uzbek orthography pulled the 85 KB and 118 KB latin-ext files for two letters. Fix: self-hosted latin and cyrillic subsets in `public/fonts`, 3 KB ext subsets, preloaded, cached for a year; `@fontsource-variable/*` dependencies removed.
6. nginx: `gzip_vary`, level 6, `/fonts/` immutable cache.

## Tests
- `web/test/capability.test.ts`: a weak device is never probed for WebGL2.
- Existing vitest, Playwright (axe, hero WebGL, context loss, reduced motion) stay green.
- CI web job gains a Lighthouse step (median of 3, mobile and desktop, five routes). Locally the target is 100; the CI gate is lower because shared runners are slower and noisier (see PR text for the measured numbers).

## Held
Merge, and rebuilding the live web container, wait for owner approval.
