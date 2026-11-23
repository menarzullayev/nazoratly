# Phase 6: full accounting. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (owner rule: no subagents unless asked). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capability 4.6 in both products, every owner-chosen part and nothing dropped:
1. **Chart of accounts** and an **immutable double-entry journal**; errors are fixed only by reversing entries.
2. **Cash/bank accounts with statement reconciliation.**
3. **Payables and suppliers**: supplier invoices (bills), partial settlement, due dates, aging.
4. **Period closing** with **balance sheet, income statement and trial balance**.
5. **Automatic postings**: tuition payments, refunds (a refund is a voided payment: it posts its reversal), teacher pay, expenses.
6. **Immutability**: API product: enforced in the database (no update/delete, closed periods locked, audit log). Sheets: script-only protected sheets plus the **hash chain** (spec section 3): "verify journal" menu action reports the first broken row; closed periods are checked against a stored period hash. The documentation says plainly that Sheets protection can be removed by the sheet owner.

**Architecture:** One set of pure rules per language, checked by shared golden cases (`tests/golden/ledger.json`: hash chain, sealing, entry validation, chain verification, period hash; `tests/golden/accounting.json`: chart template, posting rules, pending postings, reports, aging, reconciliation). The hash chain is used in BOTH products (the API product also stores `prev_hash`/`hash` per line and has a verify endpoint), so one canonical line format and one golden file prove identical hashes. Amounts are strings `"500000.00"` in JSON; Python uses `Decimal`, TypeScript integer tiyin (x100) with exact parse/format. Dates are ISO strings.

- **Journal line format (hash input):** `v1|prev|seq|entry_no|date|account|debit|credit|source_type|source_key|memo`, text fields escaped (`\` `\\`, `|` `\p`, LF `\n`, CR `\r`), amounts with exactly two decimals, genesis `prev` = 64 zeros, hash = lower-case hex SHA-256 of the UTF-8 string. The chain unit is the LINE (Sheets: "each row stores the hash of the previous row plus its own content"). TypeScript has its own SHA-256 (Apps Script and tests share it), verified against known vectors and Python's `hashlib`.
- **Period hash:** `period|YYYY-MM|last_seq|head_hash|total_debit|total_credit|lines` where totals are cumulative through `last_seq`. Verification re-derives all of it and also reports any line that appears after the close but is dated inside a closed month.
- **Automatic postings (management accounting, cash basis for tuition):** payment cash -> Dr 1000 Kassa, other methods -> Dr 1010 Bank, Cr 4000 O'quv to'lovlari. Expense (category -> 5000 rent, 5010 utilities, 5020 other staff pay, 5030 marketing, 5040 equipment, 5050 tax, 5090 other): Dr expense, Cr cash or bank (`paid_from`), or Cr 2000 Payables when the expense is the accrual of a supplier bill. Supplier bill creates an `expenses` row linked by `bill_id` (so the dashboard counts it); settlement Dr 2000, Cr cash/bank. Payroll approved: Dr 5100 Teacher pay, Cr 2100 Salary payable; payroll paid: Dr 2100, Cr 1000. Voiding any of these posts the exact reversing entry (dated today). Opening balances and anything else: manual balanced entries. No statutory chart: management accounting (spec section 6).
- **Reversal:** a reversal is a NEW entry with debit and credit swapped that points at the original; one reversal per entry (DB unique constraint; script check in Sheets); reversal dated today in an open period.
- **Periods:** monthly; a month can be closed only after it ended (before the current month) and only when no source document of the month is unposted; closing stores last seq, head hash, totals and the period hash; no reopening (corrections are reversing entries in an open month). Entries dated in a closed month are refused.
- **Pending postings rule (`pending_postings`):** the shared rule that decides, from source facts (payments, expenses, bill payments, payrolls with voided/status) and the list of already posted `(source_type, source_key)`, which entries are still missing (including reversals of voided sources). The API posts inline in the same transaction and offers `POST /v1/accounting/sync` (catch-up, e.g. for rows that existed before 0015); Sheets posts through the menu action "Kutayotganlarni o'tkazish" and inline best-effort (a staff member who is not a protection editor cannot write the journal; the action then says so and the entry is posted later).
- **Reconciliation:** statement (opening, closing, lines with signed amounts) per cash/bank account; `match_statement` pairs statement lines to ledger lines on that account (same signed amount, within a tolerance of days, deterministic); manual match and unmatch until the statement is finalized; finalize only when the statement foots (opening + lines = closing), nothing is unmatched and the difference to the ledger balance is zero.
- **Aging:** buckets not due, 1-30, 31-60, 61-90, 90+ days overdue on the outstanding amount of each bill.
- **Permissions (API):** `accounting:read` (owner, admin, accountant, manager), `accounting:write` (owner, admin, accountant: manual entries, accounts, suppliers, bills, reconciliation), `accounting:close` (owner, admin).
- **Sheets limits (stated in README):** whole so'm only; Apps Script quotas make a very large journal slow (measured in this phase and written in the README); the sheet owner can remove protection, the hash chain then detects edits but cannot prevent them.

**Tech Stack:** as phases 1-5 (no new dependency; SHA-256 written in TypeScript, `hashlib` in Python).

**Spec:** `docs/superpowers/specs/2026-11-23-product-expansion-design.md` (4.6, section 3).

## Review Focus

- Hash: escaping of `|`, newlines and backslash in memo, non-ASCII (Cyrillic, surrogate pairs), amounts with tiyin, genesis, seq/entry gaps, tampered amount/date/account/memo, deleted row, inserted row, swapped rows, re-hashed tampered row (next row's `prev` breaks), unbalanced entry, one-sided and negative lines.
- Posting: every payment method, every expense category, bill expense credits payables, settlement from cash and bank, payroll accrual and payment, reversal swaps exactly, zero/negative skipped, void of a never-posted source posts nothing.
- Immutability in the database: UPDATE and DELETE and TRUNCATE rejected for entries, lines, periods, bill payments' entries; unbalanced entry rejected at commit; entry into a closed month rejected; wrong chain head rejected; inactive/foreign-tenant account rejected; one reversal per entry; RLS isolation; app role cannot bypass.
- Reports: empty ledger, contra balances (credit balance on an asset), income and expense nets, balance sheet balances with current result, as-of dates inclusive.
- Reconciliation: duplicate amounts match in order, tolerance edges, a ledger line matched once, statement that does not foot, difference not zero blocks finalize, finalized statement is frozen.
- Payables: partial settlement, overpayment refused, voided bill with payments refused, aging edges (due today, 30/31, 60/61, 90/91).
- API: permissions per role (teacher/viewer 403), tenant isolation, closed-period refusal through the API, sync idempotent (second run posts nothing), auto-post in the same transaction as the source (rollback leaves neither), online payment and package purchase paths post too.
- Sheets: hand-edited rows, missing optional sheets, protection applied and re-applied idempotently, tampering detected by the menu action, posting failure on a protected sheet does not break recording a payment.

---

### Task 1: Golden rules (Python + TypeScript)

**Files:** Create `tests/golden/ledger.json`, `tests/golden/accounting.json`, `backend/src/nazoratly/rules/ledger.py`, `backend/src/nazoratly/rules/accounting.py`, `backend/tests/test_golden_ledger.py`, `backend/tests/test_golden_accounting.py`, `sheets/src/domain/sha256.ts`, `sheets/src/domain/ledger.ts`, `sheets/src/domain/accounting.ts`, `sheets/test/golden.ledger.test.ts`, `sheets/test/golden.accounting.test.ts`; modify `tests/golden/README.md`.

- [ ] Step 1: golden cases with exact values; hash expectations produced by an independent `hashlib` script (not by the rules module).
- [ ] Step 2: failing tests in both languages; run; expect FAIL.
- [ ] Step 3: implement both languages (pure, no I/O).
- [ ] Step 4: `uv run pytest tests/test_golden_ledger.py tests/test_golden_accounting.py`, `ruff`, `mypy`, `npm run typecheck && npx vitest run golden`; expect PASS. Commit `feat: accounting rules with golden cases`.

### Task 2: Migration 0015 (up, down, schema tests)

**Files:** Create `db/migrations/0015_accounting.up.sql`, `0015_accounting.down.sql`; modify `db/tests/test_schema.sql`.

Tables: `accounts`, `ledger_heads`, `journal_entries`, `journal_lines`, `accounting_periods`, `cash_accounts`, `bank_statements`, `statement_lines`, `suppliers`, `supplier_bills`, `bill_payments`; `expenses` gets `paid_from` and `bill_id`. Triggers: no update/delete on entries, lines, periods; chain continuity and head advance on each line; balanced entry at commit (deferred constraint trigger); closed-month lock; active account; one-sided positive lines; one reversal per entry; account code immutable; bill payment and statement guards. RLS + audit + grants (app role: SELECT, INSERT only on the journal tables).

- [ ] Step 1: schema tests first (every Review Focus line about the database), run via `bash db/scripts/test_migrations.sh`: expect FAIL. Step 2: migration up + down. Step 3: expect PASS (up, test, down to empty, up, test). Commit `feat(db): accounting schema (0015)`.

### Task 3: API

**Files:** Create `backend/src/nazoratly/accounting.py` (posting service, chart seeding, head locking), `backend/src/nazoratly/routers/accounting.py`, `backend/src/nazoratly/routers/payables.py`, `backend/src/nazoratly/routers/reconciliation.py`, `backend/tests/test_accounting.py`, `backend/tests/test_payables.py`, `backend/tests/test_reconciliation.py`; modify `permissions.py`, `routers/v1.py`, `routers/finance.py`, `routers/packages.py`, `routers/pay.py`, `routers/payroll.py`, `db.py` (resolvable tables), `tests/test_tenancy_and_staff.py` if the permission matrix is asserted.

Endpoints (`/v1/accounting/...`): `GET accounts`, `POST accounts`, `PATCH accounts/{id}` (name, active); `GET/POST entries` (manual, balanced), `GET entries/{id}`, `POST entries/{id}/reverse`; `GET ledger?account=` (statement with running balance); `GET reports/trial-balance`, `reports/income-statement`, `reports/balance-sheet`; `GET periods`, `POST periods/{YYYY-MM}/close`; `GET verify` (chain and periods); `POST sync`; `GET/POST cash-accounts`; `GET/POST statements`, `POST statements/{id}/lines` (import lines), `POST statements/{id}/auto-match`, `POST statement-lines/{id}/match` and `/unmatch`, `GET statements/{id}/reconciliation`, `POST statements/{id}/finalize`; `suppliers` CRUD (create, list, patch), `bills` (create, list, void), `bills/{id}/payments` (create, void), `reports/payables-aging`.

- [ ] Step 1: failing integration tests (real rows through the API, every Review Focus line about the API). Step 2: run, expect FAIL. Step 3: implement; hook the five posting sites. Step 4: new tests, full suite, `ruff`, `mypy`; expect PASS. Commit `feat(api): accounting`.

### Task 4: Sheets edition

**Files:** Create `sheets/src/gas/ledger.ts` (posting, sync, verify, close, reports), `sheets/src/gas/payables.ts`, `sheets/src/gas/reconcile.ts`, `sheets/test/ledger.test.ts`, `sheets/test/payables.test.ts`, `sheets/test/reconcile.test.ts`; modify `schema.ts` (sheets `Hisob rejasi`, `Jurnal`, `Davrlar`, `Pul hisoblari`, `Ko'chirmalar`, `Ko'chirma satrlari`, `Yetkazib beruvchilar`, `Yetkazib beruvchi hisoblari`, `Hisob to'lovlari`), `setup.ts` (sheets, chart seed, protection), `Code.ts` (menu "Buxgalteriya"), `actions.ts` (best-effort inline posting after payment), `harness.ts` (protection record, `Session`), `sheets/README.md`.

- [ ] Step 1: harness tests with real sheet data (every Review Focus line about Sheets). Step 2: run, expect FAIL. Step 3: implement. Step 4: `npm run check`; expect PASS. Commit `feat(sheets): accounting`.

### Task 5: Docs, client regeneration, final checks

**Files:** `docs/API.md`, `docs/DOMAIN.md`, `sheets/README.md`, `HANDOFF.md`, `clients/typescript/openapi.json`, `clients/typescript/src/schema.d.ts`.

- [ ] Step 1: regenerate OpenAPI and the TypeScript client; docs and HANDOFF (held items: apply 0015 to the live DB, run `POST /v1/accounting/sync`, `clasp push` + `Boshlang'ich sozlash`).
- [ ] Step 2: full checks: backend `ruff check/format --check`, `mypy`, `pytest tests -q`; OpenAPI diff; `bash db/scripts/test_migrations.sh` (disposable containers only); client `generate` + `typecheck`; sheets `npm run check`.
- [ ] Step 3: push branch, open PR, all CI checks (backend, migrations, client, sheets, web, secrets, image) green. Do NOT merge, do NOT apply migrations to the live DB, do NOT run `clasp push` or `Boshlang'ich sozlash`.
