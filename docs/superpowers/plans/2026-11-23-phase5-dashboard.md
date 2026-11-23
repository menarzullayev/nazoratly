# Phase 5: dashboard. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (owner rule: no subagents unless asked). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capability 4.5 in both products, all four owner-chosen blocks and nothing dropped:
1. **Paid vs unpaid students**, with clickable lists.
2. **New vs left students** and **trial-to-enrolled conversion**.
3. **Income, expenses and net result** with a **six-month chart**.
4. **Lead funnel** plus **"waiting for a decision"** (trials needing a decision, expiring packages, lapsing make-up rights).

**Architecture:** The dashboard is derived data only: no new table, so **no migration** (0015 stays unused). Pure rules in both languages, checked by shared golden cases (`tests/golden/dashboard.json`): `payment_status`, `student_movement`, `monthly_finance`, `waiting_items`. The lead funnel reuses `funnel_report` and trial decisions reuse `trial_status`; package expiry reuses `package_balance` (`next_expiry`) and make-up rights reuse `entitlement_state`, so no number is computed twice. API: one read endpoint `GET /v1/dashboard` (permission `reports:read`) loads facts under row-level security and calls the rules. Sheets: the existing `Boshqaruv` sheet is extended (the old KPI cards stay) and a new expenses sheet `Xarajatlar` is added because Sheets had nowhere to record expenses (the API has `expenses`).

**Tech Stack:** as phases 1-4 (no new dependency).

**Spec:** `docs/superpowers/specs/2026-11-23-product-expansion-design.md` (4.5).

## Global Constraints (definitions, identical in both products)

- **Population of block 1:** students (not deleted) with at least one `active` or `frozen` enrollment. A trial is not yet a student.
- **Unpaid:** `outstanding > 0` (open charges, installments included) OR `package_debt_lessons > 0` (negative lessons in package groups). **Overdue** is a subset of unpaid: `overdue > 0`. Everyone else is **paid**. Lists: unpaid students ordered by outstanding (desc), then id, each with outstanding, overdue and package debt lessons; paid students by id. The API returns names and public ids; `list_limit` (default 200, 1..1000) caps list length, counts are always complete.
- **Real enrollment:** every enrollment except a dropped trial (`droppedTrial` / `dropped_reason IS NOT NULL` with `accepted_on IS NULL`) and except a trial that is still running. **Joined on** of a student = the earliest, over real enrollments, of `accepted_on` when set, else `started_on`. **New** = joined on inside the range (inclusive). **Left** = student with at least one real finished enrollment and NO open enrollment (`trial`, `active`, `frozen`) now, whose left date (the latest `ended_on` of real finished enrollments) is inside the range. A student who left and came back has an open enrollment and is not counted as left.
- **Trial cohort:** enrollments that went through a trial (status `trial`, or `accepted_on` set, or dropped trial) whose `started_on` is inside the range. `accepted` = has `accepted_on`; `dropped` = dropped trial; `running` = still `trial`. **Conversion** = `accepted / (accepted + dropped)` in percent, one decimal, half up; 0 when nothing is decided yet (running trials are shown separately and never count against conversion).
- **Six-month finance:** the six calendar months ending with the month of `today` (oldest first). `income` = non-voided payments by paid date (center time zone); `operating` = non-voided expenses by spent date; `payroll` = teacher payroll in status approved or paid by period month; `expenses = operating + payroll`; `net = income - expenses` (same definition as `/v1/reports/summary`). Totals over the six months are returned too. Sheets: `Tushum` from `To'lovlar`, expenses from the new `Xarajatlar`, payroll from `Oylik`.
- **Waiting for a decision** (window `window_days`, default 7, 1..60): (a) **trials** in `decision_needed` state (lessons or days limit reached), with reason; (b) **expiring packages**: active package enrollments whose balance has lessons available and `next_expiry` within `[today, today + window]`, with `available` and `days_left`; (c) **lapsing make-up rights**: entitlements of kind `makeup`, status `open`, centers where rights lapse, `expires_on` within `[today, today + window]`, with `days_left`. Each list is ordered by urgency (date, then id). Nothing is accepted, sold, billed or sent from the dashboard.
- **Period of blocks 2 and 4 (funnel):** `date_from`..`date_to` (default: the current month; max 1830 days). Block 1 and the waiting lists are "as of today".
- **Output formats:** percentages one decimal half up; money in whole so'm (API: decimal strings, never floats). Reports and Sheets UI in Uzbek Latin. Python `ruff` + `mypy` strict, TS `tsc`, RLS tenant isolation, no DB mocks.
- Scope reminders: no auto messages, landing (`web/`) untouched, Payme/Click/SMS/fiscalization stay OFF.

## Review Focus

- Paid/unpaid: zero debt, debt only in installments, package debt with zero money outstanding, credit (overpaid) student counts as paid, a trial-only student is not in the population, frozen enrollment is.
- Movement: dropped trial is neither new nor left; accepted trial joins on `accepted_on` not `started_on`; left and re-enrolled is not left; two enrollments of one student counted once; range edges inclusive.
- Conversion: running trials excluded from the denominator; nothing decided = 0.0; rounding half up.
- Finance: month with nothing (zeros), voided rows excluded by the caller, payroll draft excluded, six months across a year boundary, payment on the last day of a month, time-zone date.
- Waiting: window edges (today and today + window inclusive), expired package not listed, right already lapsed not listed, scheduled/used rights not listed, trial just under both limits not listed.
- API: tenant isolation (tenant B's data never appears), permission (teacher 403, viewer ok), range validation, large lists truncated but counts complete.
- Sheets: hand-edited rows (bad dates, missing ids) must not break the sheet; missing optional sheets (`Xarajatlar`, `Abonementlar`) read as empty.

---

### Task 1: Golden rules (Python + TypeScript)

**Files:** Create `tests/golden/dashboard.json`, `backend/src/nazoratly/rules/dashboard.py`, `backend/tests/test_golden_dashboard.py`, `sheets/src/domain/dashboard.ts`, `sheets/test/golden.dashboard.test.ts`; modify `tests/golden/README.md`.

**Interfaces (produces):**
- `payment_status(students: list[StudentMoney]) -> PaymentStatus(paid, unpaid, overdue, unpaid_students: list[UnpaidStudent], paid_ids)`.
- `student_movement(enrollments: list[EnrollmentFact], *, date_from, date_to) -> Movement(new, left, new_ids, left_ids, trials_started, accepted, dropped, running, conversion)`.
- `monthly_finance(*, payments: list[MoneyOn], expenses: list[MoneyOn], payroll: list[PayrollMonth], today) -> Finance(months: list[MonthPoint(month, income, operating, payroll, expenses, net)], income, expenses, net)`.
- `waiting_items(*, trials, packages, rights, today, window_days, free_lessons, free_days, makeup_lapses) -> Waiting(trials, packages, rights, total)`.
- TypeScript: the same names in camelCase.

- [ ] Step 1: golden cases (>= 45) with exact values covering every Review Focus line.
- [ ] Step 2: failing tests in both languages reading the JSON; run both; expect FAIL.
- [ ] Step 3: implement both modules (pure, no I/O).
- [ ] Step 4: `uv run pytest tests/test_golden_dashboard.py`, `ruff`, `mypy`, `npm run typecheck && npx vitest run golden`; expect PASS. Commit `feat: dashboard rules with golden cases`.

### Task 2: API: `GET /v1/dashboard`

**Files:** Create `backend/src/nazoratly/routers/dashboard.py`, `backend/tests/test_dashboard.py`; modify `routers/v1.py`, `docs/API.md`.

**Interfaces:** `GET /v1/dashboard?date_from&date_to&window_days&list_limit` -> `DashboardOut{as_of, range, payments: {paid, unpaid, overdue, unpaid_students[], paid_students[]}, movement: {...}, finance: {months[], income, expenses, net}, funnel: FunnelOut, waiting: {trials[], packages[], rights[], total}}`. Loads facts with SQL under RLS (`v_student_balance`, `load_balances`, `enrollments`, `v_daily_revenue`, `expenses`, `v_teacher_payroll_totals`, `leads`, `absence_entitlements`), maps ids to public UUIDs and names, calls only the rules.

- [ ] Step 1: failing integration tests: each block with real rows created through the API (payments, installments, package debt, trial accept/drop, expenses, payroll, leads, entitlements), tenant isolation with a second center, permissions (owner/viewer ok, teacher 403, no token 401), range validation 422, `list_limit` truncation with full counts, empty center returns zeros.
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: new tests, full suite, `ruff`, `mypy`; expect PASS. Commit `feat(api): dashboard endpoint`.

### Task 3: Sheets: dashboard sheet, expenses sheet, menu

**Files:** Create `sheets/src/gas/dashboard.ts`, `sheets/test/dashboard.test.ts`; modify `sheets/src/gas/schema.ts` (`EXPENSES` table `Xarajatlar`, `ALL_TABLES`), `sheets/src/gas/actions.ts` (`refreshDashboard` delegates the new blocks), `sheets/src/Code.ts`, `sheets/src/domain/types.ts` (`Expense`), `sheets/src/gas/setup.ts` (sample expenses), `sheets/README.md`.

**Interfaces:** `refreshDashboard()` keeps cards A4:F6 and the old month table/chart, then writes: block 1 counts and clickable lists (`O'quvchilar` row links via `#gid` hyperlinks), block 2 table, block 3 six-month table + chart (income, expenses, net), block 4 funnel + waiting lists. All from `domain/dashboard.ts` and the existing domain modules.

- [ ] Step 1: harness tests with real sheet data: each block's cells, hand-edited bad rows ignored, absent `Xarajatlar`/`Abonementlar` reads as empty, idempotent refresh (no duplicate chart rows), existing dashboard test still passes.
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: `npm run check`; expect PASS. Commit `feat(sheets): dashboard with paid/unpaid, movement, finance and waiting blocks`.

### Task 4: Docs, client regeneration, final checks

**Files:** `docs/API.md`, `docs/DOMAIN.md`, `sheets/README.md`, `HANDOFF.md`, `clients/typescript/openapi.json`, `clients/typescript/src/schema.d.ts`.

- [ ] Step 1: regenerate OpenAPI and the TypeScript client; update docs and HANDOFF (held items: `clasp push` + `Boshlang'ich sozlash` to create `Xarajatlar`; no DB migration pending).
- [ ] Step 2: full checks: backend `ruff check/format --check`, `mypy`, `pytest tests -q`; OpenAPI diff; `bash db/scripts/test_migrations.sh` (disposable containers only, unchanged schema); client `generate` + `typecheck`; sheets `npm run check`.
- [ ] Step 3: push branch, open PR, all CI checks (backend, migrations, client, sheets, web, secrets, image) green. Do NOT merge, do NOT apply migrations to the live DB, do NOT run `clasp push` or `Boshlang'ich sozlash`.
