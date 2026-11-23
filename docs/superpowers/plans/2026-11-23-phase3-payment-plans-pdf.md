# Phase 3: payment plans and PDF documents (to'lov rejalari, kvitansiya, to'lov hisobi). Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (owner rule: no subagents unless asked). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capability 4.3 in both products: an owner splits a tuition charge into dated installments (debt and overdue are computed per installment, reminders follow the installment); a numbered PDF receipt (for a payment) and PDF invoice (for a student's open debt) carrying the center name and its own requisites and no fiscal claim; after a person approves, the guardian receives a rich message plus the PDF in the Telegram bot.

**Architecture:** Pure rules in both languages checked by shared golden cases (`tests/golden/installments.json`, `tests/golden/documents.json`). API: migration 0013 (`charge_installments`, `documents` with frozen snapshot + PDF bytes, numbering counters, `org_settings.requisites`, outbox document columns, installment-aware views), routers for plans and documents, PDF rendering with reportlab and a bundled DejaVu font, worker delivery (`sendRichMessage` then `sendDocument`), MCP read tool for due installments. Sheets: sheets "To'lov rejalari" and "Hujjatlar", installment-aware `computeDebts`, PDF from an HTML blob saved to Drive, Telegram `sendDocument`, menu "To'lov rejasi" and "Hujjatlar".

**Tech Stack:** as phases 1-2, plus `reportlab` (BSD) and DejaVu Sans (free licence, bundled with its licence file).

**Spec:** `docs/superpowers/specs/2026-11-23-product-expansion-design.md` (4.3; owner decisions: plans = split ONE charge into dated installments, not multi-month packages; documents are the center's internal documents with no fiscal claim; PDF sent to the guardian only after a person approves; Payme/Click/SMS/fiscalization stay OFF).

## Global Constraints

- Plan: 2..24 installments, amounts > 0 whole so'm in Sheets (`NUMERIC(14,2)` in the API), sum EXACTLY equals the charge amount, due dates strictly increasing. A charge has at most one plan; replacing a plan is allowed (paid money redistributes oldest installment first); a voided charge has no plan.
- Per-installment paid = the charge's allocated total applied oldest installment first. `overdue` = sum of outstanding of installments with `due_date < today`; a charge's earliest open due date is its earliest installment with outstanding > 0. The charge's own `due_date` is set to the first installment's date when a plan is saved (keeps FIFO order), FIFO and partial payments are unchanged.
- Equal split: `base = floor(total / count)` whole so'm, the remainder goes to the LAST installment; dates are monthly from the first date, day clamped to the month end.
- Document numbers: `KV-YYYY-NNNNNN` (receipt, kvitansiya) and `TH-YYYY-NNNNNN` (invoice, to'lov hisobi), serial per center + kind + calendar year, never reused. Not "hisob-faktura" (that is a fiscal term).
- Footer on every document (verbatim, both products): `Ichki hujjat. Fiskal chek yoki soliq hisob-fakturasi emas.` Money formatted `1 250 000 so'm` (space grouping, ASCII apostrophe).
- A document is frozen when issued (snapshot + PDF never change). Nothing is sent to a guardian without a person's explicit send action; the send needs the guardian linked to the student and an active `notifications` consent (the existing outbox rules).
- Python `ruff` + `mypy` strict, TS `tsc`, tenant isolation (RLS), audit, `Idempotency-Key`, no DB mocks; Uzbek UI text; landing (`web/`) untouched.

## Review Focus

- Payment smaller than the first installment, exactly one installment, more than the whole charge (credit), then plan replaced after partial payment (Task 1, 3).
- Plan sum off by one so'm, 1 installment, 25 installments, equal dates, descending dates, plan on a voided/foreign-tenant charge (Task 1, 3).
- Installment due today is NOT overdue; due yesterday is (Task 1, 3).
- Charge amount edited or charge voided while a plan exists (Task 2, 3).
- Receipt for a voided payment, second receipt request for the same payment (same document), invoice when nothing is owed (Task 4).
- Document for a guardian without a Telegram chat, without notifications consent, not linked to the student, sent twice (Task 4, 5).
- Cyrillic and `oʻ` / `gʻ` names in the PDF render without missing glyphs (Task 4).
- Telegram accepts the rich message but the document upload fails: the retry must not repeat the rich message (Task 5).

---

### Task 1: Golden rules (Python + TypeScript)

**Files:** Create `tests/golden/installments.json`, `tests/golden/documents.json`, `backend/src/nazoratly/rules/installments.py`, `backend/src/nazoratly/rules/documents.py`, `backend/tests/test_golden_installments.py`, `backend/tests/test_golden_documents.py`, `sheets/src/domain/installments.ts`, `sheets/src/domain/documents.ts`, `sheets/test/golden.installments.test.ts`, `sheets/test/golden.documents.test.ts`; modify `tests/golden/README.md`.

**Interfaces (produces):**
- `equal_installments(*, total: Decimal, count: int, first_due: date) -> list[Installment]` / `equalInstallments(total, count, firstDue)`; `Installment(amount: Decimal, due_date: date)`.
- `validate_plan(*, total: Decimal, installments: list[Installment]) -> PlanError | None` (`"count" | "non_positive" | "sum_mismatch" | "dates_not_increasing"`, checked in this order).
- `installment_balances(*, installments: list[Installment], paid: Decimal, today: date) -> list[InstallmentBalance]` (`paid`, `outstanding`, `overdue: bool` where overdue = `outstanding > 0 and due_date < today`; paid beyond the total is ignored here, it is credit).
- `plan_overdue(...) -> Decimal` (sum of overdue outstanding) and `next_open_due(...) -> date | None`.
- `document_number(kind: Literal["receipt","invoice"], year: int, serial: int) -> str`, `format_som(amount: Decimal) -> str`, constant `DOCUMENT_FOOTER`.

- [ ] Step 1: write golden cases with exact values (>= 30): equal split 1 000 000 / 3 from 2026-01-31 = 333 333, 333 333, 333 334 on 01-31, 02-28, 03-31; 100 / 3; count 24 ok, 25 and 1 rejected; each `validate_plan` error code; balances for paid 0, 100 000 (inside the first), exactly the first, across two, whole total, above total; overdue boundary (due today not overdue, yesterday overdue); `document_number("receipt", 2026, 7) == "KV-2026-000007"`, invoice `TH-`; `format_som` of 0, 999, 1000, 1250000, 1250000.50 (rounds half up to 1 250 001); footer text.
- [ ] Step 2: write failing tests in both languages reading the JSON; run both; expect FAIL.
- [ ] Step 3: implement both modules (pure, no I/O).
- [ ] Step 4: `uv run pytest backend/tests/test_golden_*`, `ruff`, `mypy`, `npm run typecheck && npx vitest run golden`; expect PASS. Commit `feat: installment and document rules with golden cases`.

### Task 2: Migration 0013

**Files:** Create `db/migrations/0013_payment_plans_documents.up.sql`, `.down.sql`; modify `db/tests/test_schema.sql`, `docs/DOMAIN.md`.

**Interfaces (produces):**
- `charge_installments(id, org_id, charge_id, seq SMALLINT, due_date DATE, amount NUMERIC(14,2) CHECK > 0, created_at)`, `UNIQUE (charge_id, seq)`, FK `(org_id, charge_id)`, RLS, audit trigger, grants SELECT/INSERT/DELETE; a deferred constraint trigger keeps `sum(amount) = charges.amount` and seq contiguous from 1 and `due_date` increasing whenever installments exist.
- `v_installment_balance(charge_id, org_id, seq, due_date, amount, paid, outstanding)` (cumulative FIFO, `security_invoker`); `v_charge_balance` gains `overdue_outstanding` and `next_due`; `v_student_balance.overdue_total` and the debtors queries use them (charges without a plan behave exactly as before).
- `org_settings.requisites TEXT NULL CHECK (length <= 1000)`.
- `document_counters(org_id, kind, year, last_serial)` and `next_document_serial(p_kind text, p_year int) -> int` (row-locked increment); `documents(id, org_id, public_id, kind, number, serial, year, student_id, payment_id NULL, issued_on, total NUMERIC(14,2), snapshot JSONB, pdf BYTEA, created_by_user_id, created_at)` with `UNIQUE (org_id, number)`, one receipt per payment (`UNIQUE (payment_id) WHERE kind = 'receipt'`), UPDATE/DELETE blocked by trigger, grants SELECT/INSERT only.
- `outbox_messages` + `body_html TEXT NULL`, `document_id BIGINT NULL` (FK in org), `text_delivered BOOLEAN NOT NULL DEFAULT false`; `outbox_claim` returns `body_html, document_id, text_delivered` too; new `outbox_document(p_message_id) -> (filename text, pdf bytea)` and `outbox_mark_text_delivered(p_message_id)` for `nazoratly_worker` (SECURITY DEFINER like 0008).
- `agent_v_debtors` gains `overdue_amount`; new `agent_v_installments_due(org_id, student_id, full_name, charge_id, seq, installments_count, due_date, outstanding, days_overdue)` (consent filtered, due within 14 days or overdue).

- [ ] Step 1: schema tests (sum mismatch fails at commit, descending dates, seq gap, voided charge cannot get a plan, amount update of a planned charge rejected, views numbers for paid 0 / partial / full, documents immutable, unique number, one receipt per payment, cross-tenant isolation, worker functions return the document only for a claimed message). Run `bash db/scripts/test_migrations.sh`; expect FAIL.
- [ ] Step 2: write up/down (down restores the 0003/0005/0008 definitions); Step 3: run the script (full cycle) and backend suite; expect PASS. Commit `feat(db): payment plans and documents (migration 0013)`.

### Task 3: API: payment plans

**Files:** Create `backend/src/nazoratly/routers/plans.py`, `backend/tests/test_plans.py`; modify `routers/finance.py` (balances, debtors, `GET /charges` fields, `patch_charge` refuses amount/due change on a planned charge with 409), `routers/settings.py` (`requisites`), `routers/v1.py`, `docs/API.md`.

**Interfaces:** `PUT /v1/charges/{id}/plan` `{ installments: [{amount, due_date}] }` or `{ equal: {count, first_due} }` -> `PlanOut{charge_id, amount, paid, outstanding, installments:[{seq, due_date, amount, paid, outstanding, overdue}]}`; `GET /v1/charges/{id}/plan`; `DELETE /v1/charges/{id}/plan`; `GET /v1/reports/installments?days_ahead=&only_overdue=` (open installments by due date with student). `ChargeOut` gains `installments_count`, `overdue`. Balance endpoint `open_charges[].overdue` uses installments; `DebtorRow.max_days_overdue` counts from the earliest open overdue installment. Errors: `422` with the rule code, `409` voided/already planned for POST-like misuse, `404` foreign tenant. Plan math uses `rules/installments.py`, never a second SQL copy in routers.

- [ ] Step 1: failing tests in `test_plans.py` for every Review Focus line of Task 1/3 plus: FIFO payment pays installments in order; student balance and debtors list show only the overdue part; a charge fully paid has no overdue; plan replaced after a partial payment keeps the paid total; `Idempotency-Key` replay; `reports/installments` filters; foreign tenant 404.
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: run new tests, full suite, `ruff`, `mypy`; expect PASS. Commit `feat(api): payment plans with per-installment debt`.

### Task 4: API: PDF receipt and invoice

**Files:** Create `backend/src/nazoratly/documents.py` (render), `backend/src/nazoratly/assets/fonts/DejaVuSans.ttf`, `DejaVuSans-Bold.ttf`, `backend/src/nazoratly/assets/fonts/LICENSE-DejaVu.txt`, `backend/src/nazoratly/routers/documents.py`, `backend/tests/test_documents.py`; modify `backend/pyproject.toml` (+`reportlab`, package data, mypy override), `routers/v1.py`, `routers/settings.py` if needed, `backend/Dockerfile` only if assets are not packaged, `docs/API.md`.

**Interfaces:** `render_pdf(snapshot: DocumentSnapshot) -> bytes` (A5/A4 portrait, header = center name + requisites, title `KVITANSIYA` / `TO'LOV HISOBI`, number, date, student, table of lines, total in so'm, footer constant, no QR, no tax words). `POST /v1/documents/receipts {payment_id}` (201 new, 200 existing for the same payment, `409` voided payment); `POST /v1/documents/invoices {student_id, charge_id?}` (lines = open installments or charges with outstanding > 0, `409 nothing_owed`); `GET /v1/documents`, `GET /v1/documents/{id}`, `GET /v1/documents/{id}/pdf` (`application/pdf`, `Content-Disposition` filename = number). Permissions `finance:write` to issue, `finance:read` to read.

- [ ] Step 1: failing tests: receipt contains number, center name, requisites, amount, footer (extract text from the PDF, `pypdf` as a dev dependency); Cyrillic and `oʻ` names present in the PDF text; numbers increase per kind/year and never repeat under concurrency (20 parallel issues); second receipt call returns the same document; invoice for a planned charge lists installments with their due dates and only the open amount; `409`s; immutability (no endpoint changes a document); foreign tenant 404; Idempotency replay.
- [ ] Step 2-4: implement and run (new tests, full suite, `ruff`, `mypy`). Commit `feat(api): PDF receipt and invoice with numbering`.

### Task 5: API + worker: send the document to the guardian

**Files:** modify `backend/src/nazoratly/routers/documents.py` (send endpoint), `backend/src/nazoratly/worker.py`, `backend/tests/test_documents.py`, `backend/tests/test_worker.py`, `docs/API.md`.

**Interfaces:** `POST /v1/documents/{id}/send {guardian_id}` -> `{message_id, status: "queued"}`: this call IS the approval (a signed-in person with `finance:write`); queues an outbox row with `body` (plain text), `body_html` (rich text: center, document number, amount, what it is for), `document_id`, idempotency key `doc-<document>-<guardian>` (second call returns the same message, never a second send). Worker: for a row with `document_id` send `sendRichMessage` (fallback `sendMessage` on 400/404), call `outbox_mark_text_delivered`, then `sendDocument` (multipart, filename = number + `.pdf`); a retry skips the text when `text_delivered`.

- [ ] Step 1: failing tests: queued only with chat + consent (`409` otherwise, reason in the message); not linked guardian 409; second send returns the same message; worker (fake Telegram server in the test, as `test_worker.py` does) sends rich then document with the right bytes and filename; document upload failure retries without repeating the rich message; plain outbox messages unchanged.
- [ ] Step 2-4: implement; run full suite, `ruff`, `mypy`. Commit `feat(api): send receipts and invoices to guardians after approval`.

### Task 6: MCP reminder data follows installments

**Files:** modify `backend/src/nazoratly/mcp_server.py`, `backend/tests/test_mcp.py`.

**Interfaces:** `list_debtors` rows gain `overdue_total`; new read tool `list_due_installments(days_ahead: int = 3, limit: int = 50)` over `agent_v_installments_due` (only students with AI consent; drafts stay pending approval as before).

- [ ] Step 1: failing tests (agent sees an installment due in 2 days; no consent hides it; paid installment hidden; `list_debtors` overdue equals the overdue installment only). Step 2-4: implement, run `test_mcp.py` and the full suite. Commit `feat(mcp): installments in reminder tools`.

### Task 7: Sheets: plans and installment-aware debt

**Files:** modify `sheets/src/gas/schema.ts` (table `INSTALLMENTS` "To'lov rejalari": `chargeId`, `seq`, `dueDate`, `amount`; settings keys `requisites`, `installmentRemindDays` default 3), `sheets/src/domain/types.ts` (`Installment`), `sheets/src/domain/debt.ts` (`computeDebts` takes installments; `StudentDebt` gains `overdueInstallments`, `nextInstallment`), `sheets/src/domain/reminders.ts` (installment wording and `planUpcomingReminders`), `sheets/src/gas/plans.ts` (new: `createPaymentPlan(chargeId?, count?, firstDue?)`, `checkPlans()`, `removePlan(chargeId?)`), `sheets/src/gas/actions.ts` (reminder run, debts report use installments), `sheets/src/gas/setup.ts`, `sheets/src/Code.ts` (menu "To'lov rejasi"), tests `sheets/test/plans.test.ts` (+ cases in `domain.test.ts`), `sheets/README.md`.

**Interfaces:** an invalid plan (sum differs from the charge, descending dates, voided charge) is ignored by `computeDebts` and listed by `checkPlans()`; `createPaymentPlan` uses `equalInstallments`, asks to confirm with the schedule shown and writes the rows plus the charge's due date (first installment); editing rows by hand is allowed and validated on the next calculation.

- [ ] Step 1: failing tests: golden-equal numbers for a planned charge; reminder text names installment number and date; upcoming reminder drafted within `installmentRemindDays`, none when 0; cooldown and consent rules unchanged; invalid plan ignored and reported; nothing sent to Telegram (drafts only).
- [ ] Step 2-4: implement; `npm run check`. Commit `feat(sheets): payment plans with per-installment debt and reminders`.

### Task 8: Sheets: receipt and invoice PDF

**Files:** create `sheets/src/gas/documents.ts` (`issueReceipt(paymentId?)`, `issueInvoice(studentId?)`, `sendDocumentToGuardian(docId?)`, numbering with `LockService` in Script Properties), modify `sheets/src/gas/schema.ts` (table `DOCUMENTS` "Hujjatlar": `number`, `kind`, `issuedOn`, `studentId`, `paymentId`, `amount`, `link`, `sentOn`), `sheets/src/gas/telegram.ts` (`sendDocument(chatId, blob, caption?)` multipart), `sheets/src/domain/documents.ts` (`renderDocumentHtml`), `sheets/src/Code.ts` (menu "Hujjatlar"), `sheets/test/documents.test.ts`, `sheets/README.md`.

**Interfaces:** PDF = `Utilities.newBlob(html, "text/html").getAs("application/pdf")` saved to Drive folder `nazoratly hujjatlari`, link stored in the register; the send action shows a confirmation dialog (recipient, document, amount); only on "Ha" it sends `sendRich` then `sendDocument`, requires `consentNotify` and `guardianChatId`, records `sentOn`; a second send asks again and is logged.

- [ ] Step 1: failing tests (harness fakes UrlFetchApp/Drive): numbers per kind/year increase, html contains center name, requisites, footer, amount; Cyrillic name intact in the html; no send without consent or chat; no send when the dialog answer is "Yo'q"; send order rich then document; failure of the document keeps `sentOn` empty and reports the error.
- [ ] Step 2-4: implement; `npm run check`. Commit `feat(sheets): receipt and invoice PDF with guardian delivery`.

### Task 9: Documentation, clients, verification, PR

- [ ] Update `docs/API.md`, `docs/DOMAIN.md`, `sheets/README.md`, `HANDOFF.md`; regenerate `clients/typescript` (`export_openapi` then `npm run generate`).
- [ ] Run: backend `uv run pytest -q`, `uv run ruff check .`, `uv run mypy`; `bash db/scripts/test_migrations.sh`; sheets `npm run check`; web `npm test` and `npm run typecheck`.
- [ ] Open the PR (CI must be green). Held for the owner: applying 0013 to the live local DB (`pg_dump` first) and `clasp push` plus "Boshlang'ich sozlash" in the real Sheet; the owner also fills `requisites` in settings.
