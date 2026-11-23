# Phase 4: lesson packages (abonement). Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (owner rule: no subagents unless asked). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capability 4.4 in both products: a group is billed `monthly` (today) or by `package` (e.g. 12 lessons for 600 000); a payment on a package adds lessons to the student's balance, attendance consumes them, unused lessons burn at the package expiry (default 60 days, owner can extend), a low or exhausted balance puts the student on a "payment needed" list with a reminder DRAFT, and debt in package mode is negative lessons shown in lessons and in money.

**Architecture:** Pure rules in both languages checked by shared golden cases (`tests/golden/packages.json`). A package purchase is an ordinary `charges` row (`kind = 'package'`) plus a `lesson_packages` row, so payments, FIFO, receipts, invoices and plans keep working unchanged. Lessons credited by a package = `min(lessons, floor(paid * lessons / price))`. Consumption and balance are derived, never stored: SQL views list consuming attendance marks and packages with their paid amount; `rules/packages.py` computes the balance (single source, no SQL copy). Agents read consent-filtered views and Python computes the same rules in the MCP server. Sheets: columns on "Guruhlar", sheet "Abonementlar", the same math in `domain/packages.ts`.

**Tech Stack:** as phases 1-3 (no new dependency).

**Spec:** `docs/superpowers/specs/2026-11-23-product-expansion-design.md` (4.4; owner decisions: billing mode per group, a payment adds lessons, present/late/unexcused absent consume and excused follows the phase-2 `excused_mode`, expiry default 60 days per center, burn at expiry, manual extension, "payment needed" list plus reminder DRAFT never auto-sent, debt = negative lessons in lessons and money). Payme/Click/SMS/fiscalization stay OFF.

## Global Constraints

- Group: `billing_mode` `monthly` (default) | `package`; package groups carry `package_lessons` (1..200) and `package_price` (> 0, whole so'm in Sheets); monthly groups carry neither. Monthly generation (`/charges/generate`, `planCharges`) and the first-month charge at trial acceptance SKIP package groups.
- Settings per center: `package_expiry_days` default 60 (1..730), `package_low_lessons` default 2 (0..50).
- Package: `expires_on = purchased_on + package_expiry_days` (inclusive: a lesson on the expiry day still consumes); price and lesson count are frozen on the package when sold; extension only to a later date (<= purchased_on + 730 days). A voided charge removes its package from every calculation (void needs no allocations, as today).
- Credited lessons: `credited = min(lessons, floor(paid * lessons / price))` (partial payment = proportional lessons).
- Consumption (`consumes_lesson`): `present`, `late`, `absent` consume; `excused` consumes only when `excused_mode = none`; make-up lessons never consume; cancelled lessons and marks before `COALESCE(accepted_on, started_on)`, trial and dropped-trial enrollments consume nothing. In package groups `excused_mode = credit` creates NO money credit (not consuming IS the credit); `makeup` still creates the right.
- Balance (`package_balance`): packages by `(purchased_on, id)`; each consumed date, oldest first, takes one lesson from the first package with credited left and `purchased_on <= date <= expires_on`, else it is `uncovered`; then uncovered lessons are covered from any package not expired today; `burned` = credited left in packages with `expires_on < today`; `available` = credited left in packages with `expires_on >= today`; `balance = available - uncovered` (negative = debt). `debt_amount = round_half_up(uncovered * package_price / package_lessons)` of the group's CURRENT package config.
- `payment_need`: balance < 0 `debt`, = 0 `exhausted`, <= `package_low_lessons` `low`, else `ok`. Students in package groups with active enrollment and need != ok are "payment needed".
- Reminders are DRAFTS only: Sheets "Eslatmalar" rows (status pending), API: suggested text on the report row and an MCP read tool; the agent drafts, a person approves (nothing new is sent automatically). Existing consent, cooldown and guardian-link rules apply.
- Payroll: percent-pay teachers count `package` charges like `tuition` (Sheets already does).
- Python `ruff` + `mypy` strict, TS `tsc`, tenant isolation (RLS), audit, `Idempotency-Key`, no DB mocks; Uzbek UI text; landing (`web/`) untouched.

## Review Focus

- Payment smaller than a lesson price, exactly one package, double package, overpayment (credit), payment after the lessons were already attended (negative lessons cleared by the payment) (Task 1, 3).
- Lesson on the expiry day consumes, the day after it burns; extension revives burned-by-clock lessons; package bought after the old one expired (Task 1, 3).
- Excused under each `excused_mode`; make-up lesson attended; marks changed present -> excused -> absent; lesson cancelled (Task 1, 4).
- Trial in a package group consumes nothing and bills nothing; trial dropped; accepted mid-month (Task 4).
- Group switched monthly <-> package with existing charges/packages; package group in monthly generation (Task 3, 4).
- Voided package charge; package for another center's enrollment (404); selling for a trial/frozen/finished enrollment (409) (Task 3).
- Student without consent or guardian chat on the payment-needed list: listed, but reminder skipped with the reason (Task 5, 7).
- Sheets: hand-edited package rows (bad dates, lessons <= 0) ignored and reported (Task 6).

---

### Task 1: Golden rules (Python + TypeScript)

**Files:** Create `tests/golden/packages.json`, `backend/src/nazoratly/rules/packages.py`, `backend/tests/test_golden_packages.py`, `sheets/src/domain/packages.ts`, `sheets/test/golden.packages.test.ts`; modify `tests/golden/README.md`.

**Interfaces (produces):**
- `credited_lessons(*, paid: Decimal, price: Decimal, lessons: int) -> int`; `package_expires_on(purchased_on: date, expiry_days: int) -> date`.
- `consumes_lesson(*, status: AttStatus, is_makeup: bool, excused_mode: ExcusedMode) -> bool`.
- `PackageInput(credited: int, purchased_on: date, expires_on: date)`; `package_balance(*, packages: list[PackageInput], consumed_on: list[date], today: date) -> Balance(available, burned, uncovered, balance: int, next_expiry: date | None)` (`next_expiry` = earliest `expires_on` among non-expired packages with credited left).
- `lessons_money(*, lessons: int, price: Decimal, package_lessons: int) -> Decimal`; `payment_need(*, balance: int, low_lessons: int) -> Literal["ok","low","exhausted","debt"]`.
- `package_reminder_text(*, need, guardian: str, student: str, balance: int, debt_amount: Decimal, center: str) -> str` (uses `format_som`; texts fixed in the golden file).
- TypeScript: same names in camelCase (`creditedLessons`, `packageExpiresOn`, `consumesLesson`, `packageBalance`, `lessonsMoney`, `paymentNeed`, `packageReminderText`).

- [ ] Step 1: write golden cases (>= 40) with exact values: credited (0, 299 999 of 600 000 for 12 = 5, 300 000 = 6, 600 000 = 12, 1 200 000 capped at 12, price 500 000/10 with 125 000 = 2); expiry (+60, year end, leap day); `consumes_lesson` for the full status x mode x makeup table; balance: fresh package 12 and 0 consumed, 5 consumed, exactly 12 consumed (exhausted), 14 consumed with no second package (uncovered 2, balance -2), lesson on the expiry day consumes and on the next day is uncovered, burned after expiry (12 bought, 4 used, today = expiry + 1 -> burned 8 available 0), second package covers the next lessons, two packages overlapping (oldest first), uncovered cleared by a package bought later (debt 3 then new 12 -> balance 9), uncovered NOT covered by an expired package, `next_expiry`; `lessons_money` (3 of 12 at 600 000 = 150 000; 1 of 7 at 500 000 = 71 429 half up); `payment_need` thresholds for low = 2 and low = 0; the three reminder texts.
- [ ] Step 2: failing tests in both languages reading the JSON; run both; expect FAIL.
- [ ] Step 3: implement both modules (pure, no I/O).
- [ ] Step 4: `uv run pytest tests/test_golden_packages.py`, `ruff`, `mypy`, `npm run typecheck && npx vitest run golden`; expect PASS. Commit `feat: lesson package rules with golden cases`.

### Task 2: Migration 0014

**Files:** Create `db/migrations/0014_lesson_packages.up.sql`, `.down.sql`; modify `db/tests/test_schema.sql`, `docs/DOMAIN.md`.

**Interfaces (produces):**
- `study_groups.billing_mode TEXT NOT NULL DEFAULT 'monthly' CHECK in (monthly, package)`, `package_lessons INTEGER`, `package_price NUMERIC(14,2)`, CHECK: package groups have `package_lessons BETWEEN 1 AND 200` and `package_price > 0`, monthly groups have both NULL.
- `org_settings.package_expiry_days INTEGER NOT NULL DEFAULT 60 CHECK BETWEEN 1 AND 730`, `package_low_lessons INTEGER NOT NULL DEFAULT 2 CHECK BETWEEN 0 AND 50`.
- `charges.kind` accepts `'package'`.
- `lesson_packages(id, org_id, public_id, student_id, enrollment_id, charge_id UNIQUE, lessons INT CHECK > 0, price NUMERIC(14,2) CHECK > 0, purchased_on DATE, expires_on DATE CHECK >= purchased_on, created_by_user_id, created_at, updated_at)` with in-org FKs, RLS, audit and updated_at triggers, grants SELECT/INSERT/UPDATE; a trigger rejects a package whose charge is not `kind = 'package'` or belongs to another student; index `(enrollment_id, purchased_on, id)`.
- Views (`security_invoker`): `v_lesson_packages(org_id, package_id, public_id, student_id, enrollment_id, charge_id, lessons, price, paid, purchased_on, expires_on)` (voided charges excluded) and `v_package_consumption(org_id, student_id, enrollment_id, group_id, lesson_id, lesson_date)` implementing the Global Constraints consumption rule with the center's `excused_mode`.
- Agent views (consent `ai_assistant_processing`, `org_id = app_org_id()`, SELECT to `nazoratly_agent`): `agent_v_package_packages(org_id, student_id, full_name, enrollment_id, group_id, group_name, package_lessons, package_price, lessons, price, paid, purchased_on, expires_on)` and `agent_v_package_consumption(org_id, student_id, enrollment_id, lesson_date)`.
- Drop-trial marker: the API stores `dropped_reason = COALESCE(reason, '')` so a dropped trial is recognisable (`status = 'finished' AND accepted_on IS NULL AND dropped_reason IS NOT NULL`) and excluded from consumption.

- [ ] Step 1: schema tests: group CHECKs both ways; settings defaults and ranges; package charge kind; package unique per charge, wrong-kind/student charge rejected; cross-tenant isolation; views for paid 0 / partial, voided charge hidden; consumption view for present/late/absent/excused under each mode, makeup lesson, cancelled lesson, trial, dropped trial, pre-acceptance lesson; agent views hide a student without consent. Run `bash db/scripts/test_migrations.sh`; expect FAIL.
- [ ] Step 2: write up/down (down refuses while package groups, package charges or packages exist). Step 3: run the script (full cycle) and the backend suite; expect PASS. Commit `feat(db): lesson packages (migration 0014)`.

### Task 3: API: group billing mode, packages, balances

**Files:** Create `backend/src/nazoratly/packages.py` (loaders `load_balances(conn, *, student_id=None, group_id=None, today)` over the views, shared with the MCP server through a `source` argument), `backend/src/nazoratly/routers/packages.py`, `backend/tests/test_packages.py`; modify `routers/academics.py` (group in/patch/out + validation), `routers/settings.py` (+2 settings), `routers/finance.py` (`ChargeKind` + `package`), `routers/v1.py`, `docs/API.md`.

**Interfaces:** `POST /v1/groups` / `PATCH` accept `billing_mode`, `package_lessons`, `package_price`; `GroupOut` returns them. `POST /v1/packages {enrollment_id, purchased_on?, pay?: {amount, method, note?}}` -> `PackageOut{id, student_id, student_name, group_id, group_name, enrollment_id, charge_id, lessons, price, paid, credited_lessons, purchased_on, expires_on}` (201): creates the charge (`kind package`, `period_month` = month of purchase, due = purchase day) and the package in one transaction; with `pay` also records the payment, allocates it to THIS charge first and the rest FIFO. `GET /v1/packages?student_id=&group_id=&active=`; `POST /v1/packages/{id}/extend {expires_on}`; `GET /v1/students/{id}/lesson-balance` -> `[{enrollment_id, group_id, group_name, available, burned, debt_lessons, balance_lessons, debt_amount, need, next_expiry}]`; `GET /v1/reports/packages/payment-needed?need=` -> same fields + student + `reminder_text`, worst first (debt, exhausted, low). Errors: `409` group not package-billed / enrollment not active, `422` extension not later, `404` foreign tenant. All balance math goes through `rules/packages.py`.

- [ ] Step 1: failing tests in `test_packages.py` for every Review Focus line of Task 1/3 (sell with and without `pay`, partial payment credits proportionally, payment after the lessons were attended clears the negative lessons, extension, void via the charge, group switch, foreign tenant, `Idempotency-Key` replay, the report order and the three texts, settings defaults and ranges).
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: run new tests, full suite, `ruff`, `mypy`; expect PASS. Commit `feat(api): lesson packages with lesson balance and payment-needed report`.

### Task 4: API: integration with admission, make-up, billing and payroll

**Files:** modify `routers/finance.py` (`/charges/generate` skips package groups and reports `skipped_package_groups`), `routers/lifecycle.py` (accept in a package group bills nothing: `charge_amount 0`; drop stores `dropped_reason = ''` when empty), `routers/entitlements.py` (`sync_entitlement`: no credit entitlement in a package group), `routers/payroll.py` (`kind IN ('tuition','package')`), `backend/tests/test_packages.py`, `docs/API.md`.

- [ ] Step 1: failing tests: generate skips a package group and counts it; trial in a package group attends free then accepts with no charge and consumption starts at `accepted_on`; dropped trial consumes nothing; excused under `makeup` (right created, lesson not consumed), `credit` (no entitlement row, not consumed), `none` (consumed); make-up lesson attended consumes nothing; absent consumes; cancelled lesson; marks changed present -> excused -> absent update the balance; percent payroll counts the package money.
- [ ] Step 2-4: implement; run full suite, `ruff`, `mypy`. Commit `feat(api): packages follow attendance, admission, make-up and payroll rules`.

### Task 5: MCP: payment-needed reminder data

**Files:** modify `backend/src/nazoratly/mcp_server.py`, `backend/tests/test_mcp.py`.

**Interfaces:** read tool `list_packages_needing_payment(limit: int = 50)` -> rows `{student_id, student_name, group_name, balance_lessons, debt_lessons, debt_amount, need, next_expiry, reminder_text}` computed by `rules/packages.py` over `agent_v_package_*` (only students with AI consent; drafts stay pending approval as before).

- [ ] Step 1: failing tests (low balance listed with text; no consent hidden; `ok` student hidden; negative lessons show money). Step 2-4: implement, run `test_mcp.py` and the full suite. Commit `feat(mcp): packages needing payment`.

### Task 6: Sheets: packages, balance, reminders

**Files:** modify `sheets/src/gas/schema.ts` (GROUPS + `billingMode` "Hisoblash turi" enum Oylik/Abonement, `packageLessons`, `packagePrice`; ENROLLMENTS + `droppedTrial` bool; new table `PACKAGES` "Abonementlar": `id` (P0001), `studentId`, `groupId`, `chargeId`, `lessons`, `price`, `purchasedOn`, `expiresOn`; settings `packageExpiryDays` 60, `packageLowLessons` 2), `sheets/src/domain/types.ts` (`Package`, `Group` fields), `sheets/src/domain/billing.ts` (`planCharges` skips package groups), `sheets/src/gas/settings.ts`, `sheets/src/gas/admission.ts` (accept in a package group bills nothing; drop sets `droppedTrial`), `sheets/src/gas/makeup.ts` (no credit entitlement in package groups), `sheets/src/gas/packages.ts` (new: `sellPackage(studentId?, groupId?)`, `extendPackage(id?)`, `checkPackages()`, `openPackageStatus()` sheet "Abonement holati", `createPackageReminderDrafts()`), `sheets/src/domain/reminders.ts` (`planPackageReminders`), `sheets/src/Code.ts` (menu "Abonement"), tests `sheets/test/packages.test.ts`, `sheets/README.md`.

**Interfaces:** consumption from "Davomat" rows of the student in the group (statuses per `consumesLesson`; a row on an entitlement's `lastMakeupOn` is a make-up and does not consume; rows before `acceptedOn || startedOn`, trial or dropped-trial enrollments do not count); credited lessons use the FIFO `paid` of the package's charge from `computeDebts`; an invalid package row (lessons <= 0, `expiresOn < purchasedOn`, unknown charge/student) is ignored and listed by `checkPackages()`; `sellPackage` shows lessons, price and expiry for confirmation, writes the charge (note `Abonement N dars`) and the package row; reminder drafts use `packageReminderText`, respect consent, chat, cooldown and write rows with status `pending` only.

- [ ] Step 1: failing tests (harness): golden-equal balances from sheet rows; monthly run skips a package group; trial and dropped trial consume nothing; sale creates charge + package with the default expiry; extension rules; invalid rows ignored and reported; payment-needed rows; drafts created per need with the right text and skipped for no consent / no chat / cooldown; nothing sent to Telegram.
- [ ] Step 2-4: implement; `npm run check`. Commit `feat(sheets): lesson packages with balance, expiry and payment-needed reminders`.

### Task 7: Documentation, clients, verification, PR

- [ ] Update `docs/API.md`, `docs/DOMAIN.md`, `sheets/README.md`, `HANDOFF.md`; regenerate `clients/typescript` (`export_openapi` then `npm run generate`).
- [ ] Run: backend `uv run pytest -q`, `uv run ruff check src tests && uv run ruff format --check src tests`, `uv run mypy`; `bash db/scripts/test_migrations.sh`; sheets `npm run check`; web `npm test` and `npm run typecheck`.
- [ ] Open the PR (CI must be green). Held for the owner: applying 0014 to the live local DB (`pg_dump` first) and `clasp push` plus "Boshlang'ich sozlash" in the real Sheet.
