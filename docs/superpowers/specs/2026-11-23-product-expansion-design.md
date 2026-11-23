# nazoratly: product expansion design (from the open-repo research)

Status: DRAFT for approval (2026-11-23). Every decision below was made by the owner in the design conversation unless marked **(my call)**. Source of ideas: `docs/RESEARCH-ochiq-repolar.md` (ideas only, no code copied: several sources are GPL/AGPL).

## 1. Intent

Make nazoratly cover the real daily life of an education center, not only attendance, payments and debt: how a person becomes a student (leads, trial), what absence costs, how families pay (plans, receipts, lesson packages), how the owner sees the business (dashboard, expenses, books), and how a center gets started (import, demo mode). Both products get it at the same time: the **Postgres + API product** and the **Google Sheets edition**, and the landing page shows the result.

## 2. Goals, non-goals, anti-goals

Goals: eight capabilities (section 4), identical money rules in both products, every rule covered by shared golden tests, every outward action still approved by a person (Model B).

Non-goals: library, transport, hostel, LMS and exams (they bloat a center product); online payment providers, SMS and fiscalization stay OFF (no YaTT/MChJ); nothing here is a tax or fiscal document.

Anti-goals: two products that compute different amounts for the same facts; a ledger that can be silently edited in the API product; automatic messages to guardians without a person's approval; silently shrinking any item below.

## 3. Constraints

- Python/FastAPI + Postgres (RLS, audit) and TypeScript/Apps Script domain code (`sheets/src/domain`, also used by the website demo) must agree. **Decision:** shared golden test suite (`tests/golden/*.json`: inputs and expected outputs per rule), read by both Python and TypeScript tests; CI fails on any difference.
- Reports and UI in Uzbek Latin (landing in five languages); code in English.
- Sheets cannot guarantee immutability. **Decision:** full accounting also in Sheets (protected sheets, written only by the script). **(my call)** To make tampering detectable the journal is hash-chained (each row stores the hash of the previous row plus its own content); a "verify journal" menu action reports the first broken row, and closed periods are checked against a stored period hash. The documentation says plainly that Sheets protection can be removed by the sheet owner.
- No new paid services; Telegram stays the only outbound channel.

## 4. Decisions by capability (build order = this order)

**4.1 Admission lifecycle.** Enrollment status becomes `trial → active → frozen → finished`; an `enrollments` row in `trial` is on the roster and in attendance but creates no charge. Trial limit: **free trial lessons count OR days, whichever comes first**, both per-center settings (defaults 1 lesson / 7 days). When the limit is reached the owner gets a "decision needed" item (accept or drop); nothing is accepted or billed automatically. Accepting asks the owner for the first-month rule: **full month / prorated to remaining lessons / free until next month**, chosen per acceptance (default shown: prorated). Lead handling: **full funnel and report**: stages (new, contacted, trial scheduled, trial attended, enrolled, lost), source, interaction timeline with next follow-up date, conversion and per-source reports; one-click "enroll in trial".

**4.2 Attendance and make-up.** `excused` vs `absent` already exists. A per-center setting decides what an excused absence does: **make-up right / credit / nothing**. Make-up right: a make-up entitlement with an expiry (default 30 days, per-center), a separate make-up lesson record (date, group, teacher), closes when the student attends, lapses at expiry (configurable). Teacher pay counts a make-up lesson as a held lesson only when someone attended.

**4.3 Payments, plans and documents.** Partial payments and FIFO stay. New: **payment plans**: an owner splits a charge into dated installments; debt and overdue are computed per installment; reminders (still drafts for approval) follow the installment. **PDF receipt and invoice**, also sent to the guardian in the bot (rich message plus the PDF) after approval; documents carry the center name and its own requisites, a document number, and no fiscal claim.

**4.4 Lesson packages.** A group has a billing mode: **monthly** (today) or **package** (e.g. 12 lessons for 600 000). Package mode: a payment adds lessons, attendance consumes them (present or unexcused absent; excused per 4.2), a package has an **expiry (default 60 days)**; unused lessons burn at expiry and the owner can extend manually; when the balance is low or exhausted the student appears in "payment needed" and a reminder draft is prepared. Debt in package mode is "negative lessons" shown in lessons and in money.

**4.5 Dashboard.** All four blocks: paid vs unpaid students (clickable lists); new vs left students and trial-to-enrolled conversion; income, expenses and net result with a six-month chart; lead funnel plus "waiting for a decision" (trials, expiring packages, lapsing make-up rights).

**4.6 Accounting (full level, in both products).** Chart of accounts and an **immutable double-entry journal** (errors fixed only by reversing entries); cash/bank accounts with statement reconciliation; payables and suppliers (invoices, partial settlement, due dates); period closing with balance sheet, income statement and trial balance. Tuition payments, refunds, teacher pay and expenses post automatically. In the API product immutability is enforced in the database (no update/delete, closed periods locked, audit log); in Sheets by script-only protected sheets plus the hash chain from section 3.

**4.7 Capacity, QR, import.**
- Capacity: group maximum (trial students count); a full group puts new students on a **waiting list** in order; when a seat frees the owner sees "next in line" and enrolls with one click. No automatic enrollment.
- QR attendance: each student has a QR card (printable and sent in Telegram); a teacher or administrator scans it in the browser, which marks "present" if the lesson is for that group; manual marking stays.
- Import: **interactive**: upload, automatic column mapping, per-row validation (phone format, duplicates, blanks), errors list, preview, all clean rows written in one transaction (or nothing). Duplicate students are detected. Menu action in Sheets, endpoint plus page for the API product.

**4.8 Demo mode and landing.** Product demo mode: sample records carry a demo flag; "clear demo data" deletes only flagged rows and refuses (with the reason) when a real record references one; per-center switch in the API product, the existing "refresh sample data" action in Sheets. Landing demo gets **role buttons: Owner / Teacher / Guardian** (teacher sees only their group's attendance and payroll; guardian sees the Telegram bot in a phone frame), and shows the new capabilities only after they exist (no promises ahead of the product).

## 5. Approaches considered (cross-cutting)

- Keeping rules consistent: (1) **shared golden tests across Python and TypeScript** (chosen); (2) API calls the TypeScript rules (one source, but a Node dependency and awkward transactions); (3) Sheets calls the API (one source, but Sheets loses "no server, your own account").
- Order: (1) **lifecycle, attendance/make-up, payments, packages, dashboard, accounting, then the rest** (chosen, because money rules should settle early); alternatives were accounting first, landing first, or small wins first.

## 6. Risks and honest limits

- Scope is large: eight capabilities in two products. Each phase gets its own implementation plan and ships tested before the next starts.
- Full accounting in Sheets has no true immutability; the hash chain detects tampering but cannot prevent it. Apps Script quotas and speed limit large journals (to be measured in the phase).
- Prorating needs a lesson calendar per group (expected lessons in the month); groups without a schedule fall back to "full month" and say so.
- Accounting follows no statutory chart of accounts; it is management accounting, not tax bookkeeping (no YaTT/MChJ yet). Confirm with an accountant before any legal use.
- The new-Latin and Cyrillic UI text for new features must be reviewed by the owner as before.

## 7. Left to the builder

Table and column names, migration slicing, the exact chart of accounts template, golden-case file format, UI layouts (inside the existing design system), PDF generation library and fonts (Cyrillic and Latin glyph coverage), QR scanner library choice, hash algorithm details for the Sheets chain.

## 8. Next step

After approval: one implementation plan per phase (starting with 4.1 + the golden-test harness), executed in this order. The landing is updated per phase, not before.
