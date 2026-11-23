# Phase 1: admission lifecycle (leads, trial, accept) + golden-test harness. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (owner rule: no subagents unless asked). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capability 4.1 in both products (Postgres + API and Google Sheets): lead funnel, trial enrollments with a free limit (lessons or days, whichever first), an owner decision to accept (full / prorated / free until next month) or drop, with identical money rules proven by a shared golden test suite.

**Architecture:** Pure rule functions (`trial_status`, `first_month_charge`) exist twice (Python `nazoratly/rules/lifecycle.py`, TypeScript `sheets/src/domain/lifecycle.ts`) and are checked against the same JSON cases in `tests/golden/`. The API adds migration 0011 (trial status, org settings, leads, interactions), endpoints and funnel report. The Sheets edition adds a Leads sheet, trial status, settings keys and menu actions. Nothing is accepted or billed automatically.

**Tech Stack:** Python 3.13, FastAPI, psycopg3, Postgres 16 (RLS); TypeScript 5.9, Vitest, Apps Script; existing test harnesses (Docker PG, Apps Script in-memory harness).

**Spec:** `docs/superpowers/specs/2026-11-23-product-expansion-design.md` (section 4.1, constraints in section 3).

## Global Constraints

- Money in whole so'm in Sheets/TS; `NUMERIC(14,2)` in Postgres; both round the prorated amount half up to a whole so'm (`291666.67 → 291667`).
- Trial limits are per-center settings: `trial_free_lessons` default 1, `trial_free_days` default 7. The limit is reached when lessons attended >= free lessons OR days since the trial start >= free days. Reaching it only creates a "decision needed" item; no automatic accept/drop/billing.
- First-month mode is chosen at acceptance: `full`, `prorated`, `free_until_next`; the UI default is `prorated`. A group with no lessons in the month falls back to `full` and reports `fallback_to_full: true`.
- A `trial` enrollment is on the roster and in attendance, counts toward group capacity, and creates no charge (`/charges/generate` and `planCharges` must not bill it).
- Leads: stages `new, contacted, trial_scheduled, trial_attended, enrolled, lost`; source is free text from a per-center list; every interaction has a date and optional next follow-up date. Converting a lead is atomic and idempotent (a lead converts once).
- Tenant isolation (RLS), audit log, `Idempotency-Key` on writes, permissions `students:write` / `finance:write` as in existing routers. Python `ruff` + `mypy` strict clean; TS `tsc` clean; no mocks of Postgres.
- Reports and UI text Uzbek Latin; code English. Landing is NOT changed in this phase.

## Review Focus

- Trial settings of 0 days or 0 lessons, or a trial started in the future: no crash, sensible state (Task 1).
- Accepting an enrollment twice, accepting a non-trial enrollment, dropping an accepted one: 409 with a clear code, no duplicate charge (Task 4).
- Accepting on the last day of the month or before the first lesson: proration stays within 0..fee and never negative (Task 1).
- Converting the same lead twice or with a duplicate phone of an existing student: second call returns the first result / flags the duplicate, never two students (Task 5).
- A trial student counted against capacity, and a group's last seat taken by a trial (Task 4).
- Another center's lead/enrollment id in any endpoint: 404 (Tasks 4, 5).

---

### Task 1: Golden harness and the two pure rules

**Files:**
- Create: `tests/golden/README.md`, `tests/golden/lifecycle.json`, `backend/src/nazoratly/rules/__init__.py`, `backend/src/nazoratly/rules/lifecycle.py`, `backend/tests/test_golden_lifecycle.py`, `sheets/src/domain/lifecycle.ts`, `sheets/test/golden.lifecycle.test.ts`
- Modify: `.github/workflows/ci.yml` (no new job; both existing jobs already run these tests; add the golden folder to path filters only if filters exist)

**Interfaces:**
- Produces (Python): `trial_status(*, started_on: date, today: date, lessons_attended: int, free_lessons: int, free_days: int) -> Literal["running", "decision_needed"]`; `first_month_charge(*, mode: Literal["full","prorated","free_until_next"], monthly_fee: Decimal, accepted_on: date, lesson_dates: list[date]) -> FirstMonth` where `FirstMonth` is a frozen dataclass `(amount: Decimal, fallback_to_full: bool)` and `lesson_dates` are all lessons of the acceptance month.
- Produces (TS): `trialStatus(a: { startedOn: ISODate; today: ISODate; lessonsAttended: number; freeLessons: number; freeDays: number }): "running" | "decision_needed"`; `firstMonthCharge(a: { mode: "full" | "prorated" | "free_until_next"; monthlyFee: number; acceptedOn: ISODate; lessonDates: ISODate[] }): { amount: number; fallbackToFull: boolean }`.
- Golden file shape: `{ "trial_status": [ { "name", "in": {...snake_case...}, "out": "running|decision_needed" } ], "first_month_charge": [ { "name", "in": {...}, "out": { "amount": number, "fallback_to_full": bool } } ] }`. Both languages read the same file and map keys.

- [ ] **Step 1: Write the golden cases** in `lifecycle.json` (at least these, exact values): free 1 lesson / 7 days: `attended 0, day 3 → running`; `attended 1, day 1 → decision_needed`; `attended 0, day 7 → decision_needed`; `attended 0, day 6 → running`; settings `free_lessons 0` → `decision_needed` immediately; `free_days 0` → `decision_needed`; trial start in the future (`started_on > today`) → `running`. First month, fee 600000, lessons on 12 dates of 2026-11: accept on the 12th with 8 lessons on/after it → `prorated 400000`; accept on the 1st → `prorated 600000`; accept after the last lesson → `prorated 0`; `full → 600000`; `free_until_next → 0`; `lesson_dates []` with `prorated` → `600000, fallback_to_full true`; fee 500000, 12 lessons, 7 remaining → `291667`.
- [ ] **Step 2: Write the failing tests** `test_golden_lifecycle.py` (parametrized over the JSON) and `golden.lifecycle.test.ts` (same). Run `uv run pytest backend/tests/test_golden_lifecycle.py -q` and `npx vitest run test/golden.lifecycle.test.ts` in `sheets/`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** both rule modules (pure, no I/O); prorated = `monthly_fee * remaining / total` rounded half up to a whole so'm, where `remaining` counts `lesson_dates >= accepted_on`.
- [ ] **Step 4: Run** both suites plus `ruff`, `mypy`, `tsc`. Expected: PASS, identical case counts printed.
- [ ] **Step 5: Add a cross-check** test in Python that asserts the case count in the JSON equals the count the TS test file declares (a constant `GOLDEN_COUNTS` in `tests/golden/README.md` is not parsed; instead both tests assert `len(cases) >= 14`). Commit `feat: golden test harness and lifecycle rules`.

### Task 2: Migration 0011 (trial, settings, leads)

**Files:**
- Create: `db/migrations/0011_admission_lifecycle.up.sql`, `db/migrations/0011_admission_lifecycle.down.sql`
- Modify: `db/scripts/test_migrations.sh` (expected counts), `docs/DOMAIN.md` (new tables)

**Interfaces:**
- Produces tables: `org_settings(org_id PK, trial_free_lessons INT NOT NULL DEFAULT 1 CHECK (>= 0), trial_free_days INT NOT NULL DEFAULT 7 CHECK (>= 0), updated_at)`; `lead_sources(org_id, id, name UNIQUE per org)`; `leads(org_id, id, public_id, full_name, phone, source_id, stage CHECK in the six stages, next_follow_up_on DATE, note, student_id NULL, converted_at NULL, deleted_at, created_at, updated_at)` with `UNIQUE(student_id)` where not null; `lead_interactions(org_id, id, lead_id, happened_on DATE, kind CHECK in ('call','message','meeting','trial','note'), summary, next_follow_up_on, created_by_user_id, created_at)`. Changes: `enrollments.status` CHECK adds `'trial'`; new nullable `enrollments.accepted_on DATE` and `enrollments.first_month_mode TEXT CHECK in ('full','prorated','free_until_next')`; `enrollments_open_pair` index extended to `status IN ('trial','active','frozen')`; new partial index `enrollments_trial ON (org_id, started_on) WHERE status = 'trial'`.
- RLS policies, `updated_at` trigger and audit trigger attached exactly as migration 0002 does (copy its `DO $$ FOREACH` pattern); grants for `nazoratly_app` / `nazoratly_agent` (agent read-only on leads) like earlier migrations.

- [ ] **Step 1: Write failing expectations** in `db/scripts/test_migrations.sh` (new table, policy and trigger counts; a check that inserting an enrollment with status `trial` succeeds and with `bogus` fails).
- [ ] **Step 2: Run** `bash db/scripts/test_migrations.sh`. Expected: FAIL.
- [ ] **Step 3: Write** up and down migrations (down drops new tables/columns and restores the old CHECK and index; fails clearly if `trial` rows exist).
- [ ] **Step 4: Run** the script. Expected: `MIGRATION TESTS PASSED` with the new counts; run the backend suite once (`uv run pytest -q`) to prove nothing else broke.
- [ ] **Step 5: Commit** `feat(db): trial enrollments, org settings, leads and interactions`.

### Task 3: Org settings and trial enrollments in the API

**Files:**
- Create: `backend/src/nazoratly/routers/settings.py`, `backend/tests/test_trials.py`
- Modify: `backend/src/nazoratly/routers/academics.py` (enroll endpoint, enrollment schemas), `backend/src/nazoratly/routers/v1.py`, `backend/src/nazoratly/permissions.py` (if a new permission is needed), `docs/API.md`, regenerate `clients/typescript/*`

**Interfaces:**
- Consumes: `trial_status`, `first_month_charge` (Task 1).
- Produces endpoints: `GET /v1/settings` and `PATCH /v1/settings` (`trial_free_lessons`, `trial_free_days`); `POST /v1/groups/{group_id}/enrollments` accepts `status: "trial" | "active"` (default `active`; `trial` creates no charge and counts toward capacity); `POST /v1/enrollments/{id}/accept` body `{ "mode": "full"|"prorated"|"free_until_next", "accepted_on": date? }` → creates the first tuition charge by mode (idempotent per enrollment and month), sets `status = active`, `accepted_on`, `first_month_mode`; `POST /v1/enrollments/{id}/drop` body `{ "reason": str? }` → `finished` with `ended_on`; `GET /v1/trials/pending` → trials whose `trial_status` is `decision_needed`, each with student, group, started_on, lessons_attended, days_elapsed, and the reason (`lessons` or `days`). Error codes: `409 enrollment_not_trial`, `409 already_accepted`, `404` for foreign ids.

- [ ] **Step 1: Write failing tests** `test_trials.py`: settings defaults and patch (validation: negatives rejected); a trial enrollment creates no charge and `/charges/generate` skips it; it counts toward capacity (group of capacity 1 with a trial refuses a second enrollment with 409); after one attended lesson the trial appears in `/trials/pending` with reason `lessons`; with `trial_free_days = 0` it appears immediately with reason `days`; `accept` with each mode creates exactly the golden amount (use two groups with real lesson rows) and a second `accept` is `409 already_accepted` with still one charge; accepting a non-trial is `409 enrollment_not_trial`; `drop` finishes it and removes it from pending; tenant B gets 404 on tenant A's enrollment; Idempotency-Key replay returns the same charge.
- [ ] **Step 2: Run** `uv run pytest backend/tests/test_trials.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** settings router and the new enrollment endpoints; load group lesson dates for the acceptance month in one query; compute through `first_month_charge`; all in one transaction.
- [ ] **Step 4: Run** the new tests and the full backend suite, `ruff`, `mypy`; regenerate OpenAPI and the TypeScript client (CI checks sync). Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): trial enrollments, acceptance modes and pending decisions`.

### Task 4: Leads, interactions, conversion and funnel report (API)

**Files:**
- Create: `backend/src/nazoratly/routers/leads.py`, `backend/tests/test_leads.py`
- Modify: `backend/src/nazoratly/routers/v1.py`, `docs/API.md`, regenerate client

**Interfaces:**
- Produces endpoints: `POST/GET/PATCH /v1/leads`, `GET /v1/leads/{id}` (with interactions), `POST /v1/leads/{id}/interactions`, `GET/POST /v1/lead-sources`, `POST /v1/leads/{id}/enroll-trial` body `{ "group_id": str, "started_on": date? }` (atomic: creates the student with guardian contact from the lead if none exists, creates a `trial` enrollment, sets `stage = trial_scheduled`, `student_id`, `converted_at`; repeating returns the same result), `GET /v1/reports/funnel?from=&to=` → `{ stages: {stage: count}, by_source: [{source, leads, enrolled, conversion}], trial_to_enrolled: number }`. Lead list filters: `stage`, `source`, `follow_up_before`.

- [ ] **Step 1: Write failing tests** `test_leads.py`: create/list/filter; stage change; interaction with next follow-up appears in `follow_up_before` filter; `enroll-trial` creates one student and one trial enrollment and is idempotent; a lead whose phone equals an existing student's returns `409 duplicate_student` with that student's id unless `link_existing: true` is passed; funnel counts and conversion match a hand-built dataset (3 leads from source A, 1 enrolled → 33.3%); `lost` leads excluded from conversion denominator only when older than the range end (document the chosen rule in the test); another tenant gets 404/empty.
- [ ] **Step 2: Run** `uv run pytest backend/tests/test_leads.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** the router; conversion in one transaction with `SELECT ... FOR UPDATE` on the lead.
- [ ] **Step 4: Run** the new tests, full suite, `ruff`, `mypy`, regenerate client. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): leads, interactions, trial conversion and funnel report`.

### Task 5: Sheets domain, golden check and sheet model

**Files:**
- Modify: `sheets/src/domain/types.ts` (`Enrollment.status` adds `"trial"`, new `Lead`, `LeadStage`), `sheets/src/domain/billing.ts` (`planCharges` skips `trial`), `sheets/src/gas/schema.ts` (new `LEADS` table "Lead'lar", status labels, settings keys `trialFreeLessons`, `trialFreeDays` with defaults 1 and 7, `ownerChatId` untouched), `sheets/src/gas/setup.ts` (create the sheet), `sheets/src/domain/funnel.ts` (new, pure), `sheets/test/domain.test.ts`, `sheets/test/gas.test.ts`
- Create: `sheets/src/domain/funnel.ts`, `sheets/test/funnel.test.ts`

**Interfaces:**
- Consumes: `trialStatus`, `firstMonthCharge` (Task 1).
- Produces: `funnelReport(leads: Lead[], range: { from: ISODate; to: ISODate }): { stages: Record<LeadStage, number>; bySource: { source: string; leads: number; enrolled: number; conversion: number }[]; trialToEnrolled: number }` (same rule as Task 4, same numbers).

- [ ] **Step 1: Write failing tests:** `planCharges` ignores a `trial` enrollment and bills an `active` one; `funnelReport` equals the API's example dataset (keep the dataset in `tests/golden/funnel.json` and read it from Python `test_leads.py` and TS `funnel.test.ts`); the Leads sheet exists after `setupWorkbook` with headers; setting defaults present.
- [ ] **Step 2: Run** `npx vitest run` in `sheets/`. Expected: FAIL.
- [ ] **Step 3: Implement** types, `planCharges` change, `funnel.ts`, schema and setup; extend the codec for the new enum labels (`sinov`, stage labels in Uzbek).
- [ ] **Step 4: Run** `npm run check` in `sheets/` (tsc + vitest + bundle). Expected: PASS.
- [ ] **Step 5: Commit** `feat(sheets): trial status, leads sheet and funnel rules`.

### Task 6: Sheets actions: accept, drop, pending decisions, funnel sheet

**Files:**
- Modify: `sheets/src/gas/actions.ts`, `sheets/src/Code.ts` (menu "Qabul" submenu), `sheets/src/gas/setup.ts`, `sheets/test/gas.test.ts`, `sheets/README.md`

**Interfaces:**
- Consumes: `trialStatus`, `firstMonthCharge`, `funnelReport`, `planCharges`.
- Produces handlers: `actions.pendingTrials(): void` (writes/refreshes sheet "Qaror kutayotganlar": student, group, trial start, lessons attended, days, reason); `actions.acceptTrial(enrollmentId?: string): void` (selected row or prompt id; asks the first-month mode with a 3-button dialog, default prorated; creates the first charge via `firstMonthCharge` using the group's `Darslar`-derived lesson dates, sets status `active`); `actions.dropTrial(enrollmentId?: string): void`; `actions.refreshFunnel(): void` (sheet "Voronka" with counts by stage and source). Lesson dates for proration come from attendance rows of the group in the acceptance month plus the group's weekday schedule when no rows exist; if neither exists the action tells the owner it fell back to the full month.

- [ ] **Step 1: Write failing tests** in `gas.test.ts` using the in-memory harness: a trial student attends 1 lesson then appears in "Qaror kutayotganlar"; accepting with `prorated` writes one charge of the golden amount; accepting twice is refused with a visible message and still one charge; dropping sets the enrollment finished; `refreshFunnel` matches `funnelReport` for a seeded Leads sheet; nothing is sent to Telegram by any of these actions.
- [ ] **Step 2: Run** `npx vitest run test/gas.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the handlers and the menu; keep dialogs in Uzbek; guard every action with `actions.guard`.
- [ ] **Step 4: Run** `npm run check`; push with clasp to the owner's sheet only after the owner agrees in chat (outside this plan's verification).
- [ ] **Step 5: Commit** `feat(sheets): accept or drop trials, pending decisions and funnel report`.

### Task 7: Documentation, handoff, full verification

**Files:**
- Modify: `docs/API.md`, `docs/DOMAIN.md`, `HANDOFF.md`, `sheets/README.md`, `tests/golden/README.md`

- [ ] **Step 1: Document** the lifecycle, settings, golden suite and how to add a case (one JSON entry, both suites run it).
- [ ] **Step 2: Run everything:** backend `uv run pytest -q`, `ruff`, `mypy`; `bash db/scripts/test_migrations.sh`; sheets `npm run check`; web `npm test` (the demo still imports the domain: it must still pass).
- [ ] **Step 3: Verify on the running stack:** `docker compose up -d --build api migrate`, run migration 0011 on the live database after taking a `pg_dump` backup (outward side effect: confirm with the owner first), smoke `GET /v1/settings` with a test center.
- [ ] **Step 4: Open the PR** with test counts and the open items.
- [ ] **Step 5: Commit** `docs: admission lifecycle phase 1`.

---

## Self-review

- Spec coverage (4.1): trial status and limits (T1-T3), accept modes incl. owner-chosen first month (T1, T3, T6), drop (T3, T6), lead funnel with source/interactions/follow-up/report and one-click trial (T4, T5, T6), no auto billing (constraints, T3 tests), both products plus golden suite (T1, T5). Landing untouched by design.
- Types: `trial_status`/`trialStatus`, `first_month_charge`/`firstMonthCharge`, `funnelReport` named consistently; endpoint names consistent across tasks.
- Proportion: bodies left to the implementer; golden JSON and tests carry exact values.
- Held: applying migration 0011 to the live local database needs the owner's go-ahead (backup first); clasp push to the owner's real sheet needs the owner's go-ahead.
