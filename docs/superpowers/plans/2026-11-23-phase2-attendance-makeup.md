# Phase 2: excused absence and make-up (qoplash). Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (owner rule: no subagents unless asked). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capability 4.2 in both products: an excused absence creates an entitlement according to a per-center mode (**make-up right / credit / nothing**); make-up lessons are scheduled and close the right when the student attends; rights lapse at expiry; credits reduce the next generated tuition charge; teacher pay counts a make-up lesson only when someone attended.

**Architecture:** Pure rules in both languages checked by shared golden cases (`tests/golden/entitlements.json`). API: migration 0012 (settings, `lessons.kind`, `absence_entitlements`), entitlement creation inside the existing attendance upsert, endpoints to list/schedule/cancel, credit application inside `/charges/generate`, payroll rule. Sheets: sheet "Qoplash huquqlari", settings keys, hooks in `saveAttendance` and `generateMonthlyCharges`, menu actions.

**Tech Stack:** as phase 1.

**Spec:** `docs/superpowers/specs/2026-11-23-product-expansion-design.md` (4.2; decisions: mode per center, make-up right default expiry 30 days, separate make-up lesson record, lapses at expiry configurable, teacher pay only when someone attended).

## Global Constraints

- Mode setting `excused_mode`: `makeup` (default) | `credit` | `none`. `makeup_expiry_days` default 30 (0..365). `makeup_lapses` default true (when false an expired right stays `open`, shown as overdue).
- Entitlement is created when an attendance mark becomes `excused` (and cancelled if the mark later changes away from `excused` while still `open`); `none` creates nothing.
- `credit` amount = the group's lesson price = `round_half_up(monthly_fee_of_enrollment / number_of_lessons_of_that_month)`; a month with no lessons gives 0 and no entitlement is created (reported).
- Credits are applied only when a tuition charge is generated: `amount = max(0, fee - sum(open credits))`, credits consumed oldest first, each credit stores `applied_charge`; partial use of one credit is not allowed (a credit larger than the remaining fee is consumed fully and the excess is lost, documented).
- A make-up right is `used` when the student gets `present` or `late` on the scheduled make-up lesson; scheduling is by the owner (no automatic scheduling).
- Nothing is sent to guardians automatically by this phase.
- Python `ruff` + `mypy` strict, TS `tsc`, tenant isolation (RLS), audit, `Idempotency-Key`, no DB mocks; Uzbek UI text; landing untouched.

## Review Focus

- Excused set twice, changed to present and back (no duplicate entitlement, cancellation only while open) (Task 3).
- Expiry boundary day, `makeup_lapses = false`, expiry 0 (Task 1, 3).
- Scheduling a make-up for a student not in the group, on a past date, or twice for one right (Task 3).
- Credit larger than the fee, several credits in one month, month with zero lessons (Task 1, 3).
- Make-up lesson where the student is absent again: right stays `scheduled` or returns to `open` (rule: back to `open`), teacher not paid for it (Task 3, 4).
- Another center's entitlement id: 404 (Task 3).

---

### Task 1: Golden rules (Python + TypeScript)

**Files:** Create `tests/golden/entitlements.json`, `backend/src/nazoratly/rules/entitlements.py`, `backend/tests/test_golden_entitlements.py`, `sheets/src/domain/entitlements.ts`, `sheets/test/golden.entitlements.test.ts`.

**Interfaces (produces):**
- `entitlement_expires_on(missed_on: date, expiry_days: int) -> date` / `entitlementExpiresOn(missedOn, expiryDays)`.
- `entitlement_state(*, status: Literal["open","scheduled","used","cancelled"], expires_on: date, today: date, lapses: bool) -> Literal["open","scheduled","used","cancelled","lapsed"]`: only `open` can become `lapsed` (when `today > expires_on` and `lapses`); `scheduled` stays `scheduled`.
- `lesson_credit_amount(*, monthly_fee: Decimal, lessons_in_month: int) -> Decimal` (round half up to whole so'm; 0 lessons -> 0).
- `apply_credits(*, fee: Decimal, credits: list[Decimal]) -> AppliedCredits(amount: Decimal, used: int)` (credits oldest first, consumed fully, `amount = max(0, fee - used credits)`; stops once amount is 0).

- [ ] Step 1: write golden cases (exact values, >= 18): expiry 2026-11-10 + 30 = 2026-12-10; expiry 0 = same day; state boundaries (`today == expires_on` is still `open`, next day `lapsed`; `lapses=false` never lapses; `scheduled`/`used` never lapse); credit amounts (600000/12 = 50000; 500000/12 = 41667; 0 lessons = 0); apply_credits (fee 600000 with [50000, 50000] -> 500000 used 2; credits exceeding the fee -> 0 and used count only until fee reached; empty -> fee).
- [ ] Step 2: write failing tests in both languages reading the JSON; run both; expect FAIL.
- [ ] Step 3: implement both modules (pure).
- [ ] Step 4: run both suites, `ruff`, `mypy`, `tsc`; expect PASS. Commit `feat: entitlement rules with golden cases`.

### Task 2: Migration 0012

**Files:** Create `db/migrations/0012_makeup.up.sql`, `0012_makeup.down.sql`; modify `db/tests/test_schema.sql`, `docs/DOMAIN.md`.

**Interfaces (produces):** `org_settings` + `excused_mode TEXT NOT NULL DEFAULT 'makeup' CHECK in (makeup, credit, none)`, `makeup_expiry_days INT NOT NULL DEFAULT 30 CHECK 0..365`, `makeup_lapses BOOLEAN NOT NULL DEFAULT true`; `lessons.kind TEXT NOT NULL DEFAULT 'regular' CHECK in (regular, makeup)`; table `absence_entitlements(id, org_id, public_id, student_id, enrollment_id, group_id, missed_lesson_id, kind CHECK (makeup, credit), amount NUMERIC(14,2) NULL CHECK (kind = 'credit' = (amount IS NOT NULL)), expires_on DATE NOT NULL, status CHECK (open, scheduled, used, cancelled), makeup_lesson_id NULL, used_on DATE NULL, applied_charge_id NULL, created_at, updated_at)` with `UNIQUE (missed_lesson_id, student_id)` (one entitlement per missed lesson and student), FKs inside the org, RLS tenant policy, audit and updated_at triggers, grants for `nazoratly_app`; indexes for `(org_id, status, expires_on)` and `(student_id, status)`.

- [ ] Step 1: add schema tests (new column defaults, checks for mode, kind/amount pairing, unique per missed lesson, FK isolation). Run `bash db/scripts/test_migrations.sh`; expect FAIL.
- [ ] Step 2: write up/down; down drops the table and columns and restores state.
- [ ] Step 3: run the script (full cycle) and the backend suite; expect PASS. Commit `feat(db): make-up entitlements (migration 0012)`.

### Task 3: API: entitlements, scheduling, credits

**Files:** Create `backend/src/nazoratly/routers/entitlements.py`, `backend/tests/test_makeup.py`; modify `routers/settings.py`, `routers/lessons.py` (attendance upsert hook), `routers/finance.py` (`/charges/generate`), `routers/v1.py`, `docs/API.md`, regenerate the TypeScript client.

**Interfaces:** `GET/PATCH /v1/settings` gain `excused_mode`, `makeup_expiry_days`, `makeup_lapses`. `GET /v1/entitlements?status=&student_id=` -> items with computed `effective_status` (via `entitlement_state`). `POST /v1/entitlements/{id}/schedule` `{ lesson_date: date, start_time, end_time, teacher_id? }` -> creates a `lessons` row with `kind='makeup'` in the student's group and sets the right to `scheduled`; errors `409 not_open`, `422` for a past date or a student not enrolled in the group. `POST /v1/entitlements/{id}/cancel` (open or scheduled only). In `put_attendance`: marking `excused` creates the entitlement per mode (idempotent per missed lesson + student); changing away from `excused` cancels an `open` one; `present`/`late` on a make-up lesson sets the right `used` (`used_on`); `absent`/`excused` on it returns the right to `open`. In `/charges/generate`: open `credit` entitlements of the enrollment's student are applied oldest first via `apply_credits`; consumed ones get `status = used`, `applied_charge_id`.

- [ ] Step 1: failing tests `test_makeup.py` for every Review Focus item above plus: default mode creates a right with expiry `missed + 30`; `credit` mode creates `amount` equal to the golden lesson price and `/charges/generate` charges `fee - credits`; `none` creates nothing; scheduling creates a lesson with `kind = makeup`; attending closes the right; absent again reopens it; lapsed shows `effective_status = lapsed` after the expiry (settings `makeup_expiry_days = 0` and a past missed lesson); foreign tenant 404; Idempotency replay of `schedule` returns the same lesson.
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: run new tests, full suite, `ruff`, `mypy`, regenerate client; expect PASS. Commit `feat(api): excused absence entitlements, make-up scheduling and credits`.

### Task 4: Payroll counts make-up lessons only when attended

**Files:** modify `backend/src/nazoratly/routers/payroll.py` (the held-lessons query and the `v_teacher_payroll_totals` view if it counts lessons), `backend/tests/test_makeup.py`.

- [ ] Step 1: failing test: a make-up lesson with only an absent mark adds 0 to a per-lesson teacher's payroll; with one `present` adds one lesson. Step 2-3: implement (`kind <> 'makeup' OR EXISTS (attendance present/late)`). Step 4: run payroll tests + full suite. Commit `fix(payroll): make-up lessons count only when someone attended`.

### Task 5: Sheets

**Files:** modify `sheets/src/gas/schema.ts` (table `ENTITLEMENTS` "Qoplash huquqlari"; settings keys `excusedMode`, `makeupExpiryDays`, `makeupLapses`), `sheets/src/gas/settings.ts`, `sheets/src/gas/actions.ts` (`saveAttendance` creates/cancels/closes entitlements; `generateMonthlyCharges` applies credits), `sheets/src/gas/admission.ts` or new `sheets/src/gas/makeup.ts` (`openEntitlements()` sheet refresh, `scheduleMakeup(id?, date?)`, `cancelEntitlement(id?)`), `sheets/src/Code.ts` (menu "Qoplash"), tests `sheets/test/makeup.test.ts`, `sheets/README.md`.

**Interfaces:** columns of "Qoplash huquqlari": `id` (R0001), `studentId`, `groupId`, `missedOn`, `kind` (makeup/credit), `amount`, `expiresOn`, `status`, `makeupOn`, `usedOn`, `appliedChargeId`. Make-up date in Sheets is just a date: attendance marked for the group on that date by that student closes the right (payroll already counts a (date, group) with any mark; an all-absent make-up day is not counted: payroll rule in `heldLessons` stays "at least one present/late mark" for make-up days, see Step 1).

- [ ] Step 1: failing tests: excused mark creates a right per mode; re-saving the same roll call does not duplicate; changing to present cancels an open right; credit mode creates the golden amount; `generateMonthlyCharges` subtracts credits and marks them used; scheduling sets the date; marking present on that date closes it, absent reopens; expired rights show `lapsed` in the list; payroll ignores a make-up date with only absent marks; nothing is sent to Telegram.
- [ ] Step 2-4: implement, `npm run check`. Commit `feat(sheets): excused absence entitlements and make-up`.

### Task 6: Documentation, verification, PR

- [ ] Update `docs/API.md`, `docs/DOMAIN.md`, `sheets/README.md`, `HANDOFF.md`.
- [ ] Run: backend `uv run pytest -q`, `ruff`, `mypy`; `bash db/scripts/test_migrations.sh`; sheets `npm run check`; web `npm test` and `npm run typecheck`.
- [ ] Open the PR (CI must be green). Held for the owner: applying 0012 to the live local DB (backup first) and `clasp push` plus "Boshlang'ich sozlash" in the real Sheet.
