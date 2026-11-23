# nazoratly: product expansion 2 (decisions from the owner's discussion, 2026-11-24)

Status: decisions approved by the owner in the interactive discussion (AskUserQuestion). Phases 1-8 of expansion 1 are merged and live (main at 6cd4d03). This document is the master brief for waves 1-4 below.

## 1. Intent

Owner goal: **save the owner's time**. Today the owner answers guardians' questions, chases teachers for attendance, handles discounts/refunds by hand and reads reports himself. State: the product is demo-only (no real center yet), so selling power and demo quality matter too, but time saving for the owner decides the order.

## 2. Goals, non-goals, anti-goals

Goals: the eight groups in section 4, in BOTH products (API/Postgres and Google Sheets) wherever the capability is a business rule; identical money rules proven by shared golden tests (`tests/golden/*.json`).

Non-goals: online payment providers, SMS, fiscalization stay OFF; library/transport/hostel/LMS; question banks and online testing (only simple exam results); late-payment penalties (decided: no penalty, reminders only).

Anti-goals: two products computing different amounts; messages to guardians/leads sent by AI or automation without a person's approval (Model B); child/guardian personal data leaving the server without the center's choice; silently shrinking any item.

## 3. Constraints and rules for every builder

- Stack and patterns as in phases 1-8 (plans in `docs/superpowers/plans/`, migrations up+down, `db/tests/test_schema.sql`, OpenAPI export + TS client regeneration, Sheets in-memory harness tests, golden tests, a11y/e2e for web).
- **Sheets manifest:** the test harness does NOT enforce OAuth scopes. Any new Apps Script service call must add its scope to `sheets/appsscript.json`; list new scopes in the report (phase 6 failed live because of a missing scope).
- **Dates:** server defaults use the organization's date (`nazoratly.accounting.org_today`), never `date.today()`; tests use `tests.helpers.org_today`.
- Reports and UI text in Uzbek Latin; landing copy in five variants is wave 4 only.
- No new paid services. AI = `claude -p` (see group 7).
- **Migration number ranges** (so parallel branches never collide): wave 1: S1 0020-0024, S2 0025-0029, S3 0030-0034, S4 0035-0039, S5 0040-0044; wave 2: 0050-0059 (branches); wave 3: S7 0060-0064, S8 0065-0069. Gaps are fine (the runner sorts versions).
- Nothing goes live from a builder: no migration on the live local DB, no rebuild/restart of live containers, no `clasp push` / "Boshlang'ich sozlash", no Cloudflare/DNS change, no real Telegram message. These are held for the owner.

## 4. Decisions by group

### G1 Money rules (session S1)
- Refund: wrong payment (cash/bank refund entry, not just void); student leaves: proportional remainder of the month; lesson-package remainder; or conversion to credit only (no cash). All through the journal (hash-chained in Sheets).
- Lasting discounts, four kinds: family (2nd/3rd child, automatic %), individual (% or amount with a reason), scholarship/need-based (full or partial free, separate in reports), early payment (paid by day X). S1 owns charge generation (`finance.generate`, Sheets billing) and the discount-line mechanism; no one else edits it.
- No late-payment penalty (reminders only).
- Daily cash close (smena): actual cash counted, difference against the books shown with a note, linked to the journal; the monthly period close stays.

### G2 Schedule and rooms (session S2)
- Calendar view (week/day) of all groups for owner and teacher.
- Rooms table with capacity; warn when a group's capacity does not fit the room; room/time conflict check and teacher/time conflict check on save.
- Substitute teacher per lesson (payroll goes to the substitute).
- Lesson move/cancel: guardians' notification draft is prepared, a person approves; payroll effect computed.

### G3 Growth (session S3)
- Referral: reward type and condition set by the center (amount, percent, free lesson; "after the invited student pays"); booked as credit (existing credit mechanism), never by editing charge generation.
- Promo codes and campaigns (dated, e.g. first month -50%), visible separately in accounting.
- Lead source ROI: leads, paying students and revenue per source versus the cost entered for it.
- Lead follow-up reminders: INTERNAL only (staff/owner reminder, e.g. 3 days without answer, after the trial). Nothing is sent to the lead automatically.

### G4 Learning results (session S4)
- Lesson/month note and grade by the teacher (visible later in the guardian cabinet).
- Monthly progress report PDF (attendance + grade + note); sent only after a person approves.
- Simple exam/test results (one score per group event); no question bank, no online tests.
- Certificate PDF at course completion with a verification code.

### G5 AI assistant (session S5)
- Weekly owner summary, debt follow-up advice (who first, tone, draft text), churn-risk list (attendance drop, debt, no answer after trial). Everything is a suggestion/draft; sending needs a person.
- AI runs inside our system through `claude -p` (like tg-solver and the other projects), **not** a paid API. A separate AI worker runs on the host outside Docker in tool-less lean mode (`--tools ""`, no MCP, no session persistence, model per `~/.claude/rules/pro-agent.md`: Haiku by default), takes text and returns text; credentials never enter containers.
- Privacy: per-center setting "AI sees names" (owner chooses); default is anonymized (pseudonyms and numbers; names restored locally in the answer).
- Fallback when the AI is unavailable or the limit is reached: rule-based reports (debt age, attendance %, risk score by formula).
- Honest limit: Apps Script cannot reach a host AI worker, so the Sheets edition gets the rule-based reports (same formulas, golden tested); the AI-written text exists in the API product only.

### G6 Multi-branch (session S6)
- Branches inside one center: one owner, one books, a branch mark on every row. Students may move between branches; reports total and per branch.
- Separated by branch: cash and reports, staff permissions (admin/teacher see only their branch), prices and settings.

### G7 Guardian cabinet (session S7)
- Staged: Telegram bot buttons, then Telegram Mini App, then a standalone web portal (login). API product; the Sheets edition gets the owner side (linking, approvals).
- Guardian sees: attendance, debt and payment plan, receipts/invoices (PDF), lesson schedule.
- Linking, all methods: student QR card, one-time code, phone number via Telegram contact, manual link by the center.
- Guardian actions (every one needs the center's approval): report absence with a reason before a lesson; promise a payment date; choose a make-up slot from an open make-up right.

### G8 Teacher app (session S8)
- Bot first, Mini App and API login too (both entry ways); invitation by the owner, teacher sees only his groups.
- Marks attendance (also by QR scan), writes notes/grades, sees own hours and pay, groups and schedule.
- If a lesson is not marked: automatic reminder to the teacher after X hours; end-of-day list of unmarked lessons to the owner.
- Teacher may message guardians directly (a person, not automation), with limits: own groups only, every message logged and not deletable by the teacher, daily limit and templates plus free text, owner can switch the right off per teacher.

## 5. Order and parallelism (builder's plan, owner asked for overnight parallel worktree sessions)

- Wave 1 (parallel): S1 money, S2 schedule/rooms, S3 growth, S4 results, S5 AI. Disjoint tables and endpoints; shared files (OpenAPI/TS client, Code.ts menus, `sheets/src/gas/schema.ts` ALL_TABLES, docs, HANDOFF) are regenerated/merged on rebase.
- Wave 2: S6 multi-branch alone (it touches every table; must run on a main that already has wave 1).
- Wave 3 (parallel): S7 guardian cabinet, S8 teacher app (need calendar, results, branches).
- Wave 4: landing update for the new capabilities (five language variants, real claims only), then a full regression and the owner's morning checklist.
- Merge policy and live steps are set by the owner in the final confirmation of the discussion.

## 6. Risks

- Volume: eight groups x two products. Each session writes a plan first and ships tested.
- Shared-file conflicts between parallel PRs: sessions rebase onto the latest main before merging and regenerate generated files.
- `claude -p` as a product dependency: the subscription's limits and the host availability apply; mitigated by the rule-based fallback.
- Personal data of children: default anonymized; per-center switch.
- Mini App origin hardening and BotFather settings need the owner (held).
