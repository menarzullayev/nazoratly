# Phase 7: capacity + waiting list, QR attendance, interactive import, demo mode. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (owner rule: no subagents unless asked). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Spec capabilities 4.7 and 4.8 (product part) in BOTH products, none dropped: (1) group capacity limit + waiting list in order + "next in line" notification when a seat frees (no automatic enrollment); (2) QR attendance: a printable / Telegram-sendable student QR card, scanning in the browser marks `present` when the student belongs to the lesson's group, manual marking stays; (3) interactive import with automatic column mapping, per-row validation (phone, duplicates, blanks), error list, preview, all clean rows written in one transaction (or nothing); (4) demo mode: demo-flagged sample records, "clear demo data" deletes only flagged rows and refuses (with the reason) when a real record references one; per-center switch in the API product, the existing "refresh sample data" action in Sheets. The landing page "role buttons" item is LATER (phase 8) and NOT done here.

**Delivery:** one PR on this branch (`claude/phase-7-capacity-qr-df13d4`), commits per part. If CI or size forces a split, the remaining parts follow as sequential PRs on the same branch line; all four parts are delivered either way. Migration `0016_capacity_qr_demo` carries all schema. Held for the owner: applying 0016 to the live local DB (`pg_dump` first), `clasp push` and "Boshlang'ich sozlash".

**Architecture:** Pure rules in both languages with shared golden cases (`tests/golden/capacity.json`, `qr.json`, `import.json`, `demo.json`). Postgres: `waitlist_entries`, `students.qr_code`, `attendance.marked_via`, `is_demo` flags, `org_settings.demo_mode`, SECURITY DEFINER `demo_clear()` (the only way to delete rows, deletes `is_demo` rows of the caller's center only). API pages for the API product (QR scanner and import) are small static HTML/JS served by the API under `/ui/*` (no build step). Sheets: new columns/sheets, sidebars and dialogs, in-memory harness tests.

## Decisions (builder's calls, within the spec)

- **Seats:** a seat is held by `trial` and `active` enrollments (as before; `frozen` holds none, so a frozen student returning is checked against the capacity too). `capacity NULL` = unlimited.
- **Waiting list order:** `(joined_at, id)`. A student can join when the group is full OR somebody already waits (seats are reserved for the queue); a direct enrollment of a student not on the list is refused while `free_seats <= waiting` unless `ignore_waitlist = true` (owner override). One waiting entry per student per group.
- **"Next in line" notification:** derived, not event-driven (so it can never be missed): `GET /v1/waitlist/offers` lists, per group with free seats, the first `free_seats` waiting entries with a suggested guardian text; the dashboard decision list shows them; the MCP read tool `list_waitlist_offers` lets the agent DRAFT the message; Sheets creates pending reminder drafts. Nothing is sent or enrolled automatically (Model B).
- **QR:** the card encodes only `NZQ1-` + 20 random base32 characters (no personal data). `students.qr_code` is unique; rotating invalidates the old card. A scan needs a lesson context; marks `present` only if the student is in that lesson's roster (enrolled, or entitled make-up) and the lesson is not cancelled; an existing `present`/`late` is kept ("already marked"); `absent`/`excused` are overwritten by a scan (the student showed up); `attendance.marked_via = 'qr'`. Teachers only scan for their own lessons. Card PDF uses reportlab's QR encoder; Sheets has a TypeScript QR encoder checked against reportlab's matrix in `qr.json` and by decoding with jsQR in tests.
- **Sheets QR scanning:** Apps Script iframes may block the camera, so the sidebar has (a) camera scanning when the browser allows it and (b) a focused input that works with any USB/Bluetooth scanner or a phone's scanner app. Camera behaviour inside Google's iframe is NOT verified here and is reported as such.
- **Import:** entities `students` (optional guardian name/phone and group enrollment), `groups`, `leads`. CSV/TSV text in, auto-mapped by header aliases (uz/ru/en), per-row validation, duplicates detected (same normalised phone, or same normalised name + birth date, inside the file and against existing rows). Commit re-validates server-side, writes all clean rows in one transaction; `on_error = skip | abort` (abort writes nothing when any row is bad), duplicates are skipped by default. Sheets: the same rules in a dialog (file or paste), writes through one batch per sheet after full validation.
- **Demo mode:** `is_demo` on students, guardians, teachers, courses, groups, enrollments, lessons, attendance, charges, payments, expenses, leads, waitlist rows. Demo money never enters the books: demo payments/expenses are excluded from journal postings in both products (the journal stays immutable and the hash chain untouched). `demo_clear()` refuses (409 with the blocking references) when a non-demo row references a demo one. API: `GET /v1/demo`, `POST /v1/demo/enable` (seeds, sets `org_settings.demo_mode`), `POST /v1/demo/disable` (clears, then switches off; refusal leaves the mode on). Sheets: `Demo` column on every data sheet, menu "Namuna ma'lumotni yangilash" (existing) now flags, new "Demo ma'lumotni tozalash".
- **Permissions:** waitlist/import/demo = `academics:write` + `students:write` (import) / `org:manage` (demo); scan = `attendance:write`; QR card = `students:read`.
- **Out of scope here:** automatic enrollment, real-time push to the owner (derived lists + drafts only), XLSX upload (CSV/TSV and Sheets paste), landing.

## Review Focus

- Capacity: trial counts, frozen returns, concurrent last seat (group row lock), capacity patched below occupancy, queue reservation and the override, foreign tenant 404, duplicate waiting 409, seat freed by drop/finish makes an offer, offers never enroll.
- QR: rotated code, code of another tenant (404 not 'no such student'), student not in group (nothing written), cancelled lesson, teacher scanning a foreign lesson (403), scan over an `absent` mark, double scan, card for a student without code (created), no personal data in the payload.
- Import: header aliases, BOM, `;`/`,`/TAB delimiters, quoted newlines, phone normalisation, bad dates, blanks, duplicates inside the file and against the DB, group enrollment into a full group (row error), unknown teacher/course, abort vs skip, DB failure rolls everything back, tenant isolation, size cap.
- Demo: clear refuses when a real payment/enrollment/attendance references demo; clear removes only demo rows (real rows untouched, counts equal); journal untouched; enable twice 409; disable on refusal keeps demo mode.
- Sheets: hand-edited bad rows ignored and reported, ledger protection untouched, demo rows excluded from journal sync, no new OAuth scope needed (no new Apps Script service used: HtmlService, DriveApp(file scope already granted), UrlFetch already whitelisted).

---

### Task 1: Golden rules (Python + TypeScript)

**Files:** create `tests/golden/{capacity,qr,import,demo}.json`, `backend/src/nazoratly/rules/{capacity,qr,imports,demo}.py`, `backend/tests/test_golden_{capacity,qr,import,demo}.py`, `sheets/src/domain/{capacity,qr,qrcode,imports,demo}.ts`, `sheets/test/golden.{capacity,qr,import,demo}.test.ts`; modify `tests/golden/README.md`.

- capacity: `free_seats`, `waitlist_order`, `queue_position`, `can_join_waitlist`, `offers` (next in line per group), `direct_enroll_allowed`, `offer_text`.
- qr: `new_code` format check, `qr_payload`, `parse_payload`, `scan_decision` (marked / already_present / overwritten / not_in_group / cancelled / unknown_code), reportlab-reference matrices.
- import: `detect_columns`, `normalize_phone`, `parse_date`, `validate_row` per entity, `find_duplicates`.
- demo: `blocking_references` (what blocks a clear), sample dataset shape counts.

### Task 2: Migration 0016 and schema tests
### Task 3: API: capacity and waiting list (+ MCP tool, dashboard list)
### Task 4: API: QR (codes, card PDF, Telegram send, scan, scanner page)
### Task 5: API: import (preview/commit, page)
### Task 6: API: demo mode
### Task 7: Sheets: capacity + waiting list
### Task 8: Sheets: QR cards and scanning
### Task 9: Sheets: import dialog
### Task 10: Sheets: demo flag, clear, journal exclusion
### Task 11: Docs, OpenAPI + TS client, full verification, PR, CI

Each task: failing tests first (including negative cases from Review Focus), implement, run the relevant suite, commit. Verification commands (all run and read before any claim): `cd backend && uv run pytest -q`, `uv run ruff check src tests && uv run ruff format --check src tests`, `uv run mypy`, `bash db/scripts/test_migrations.sh`, OpenAPI export diff, `cd clients/typescript && npm run generate && npm run typecheck`, `cd sheets && npm run check`, `cd web && npm run lint && npm run typecheck && npm test`.
