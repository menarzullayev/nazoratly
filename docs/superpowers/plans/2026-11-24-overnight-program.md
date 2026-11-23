# Overnight program: expansion 2 (goal prompt for all sessions)

Master design: `docs/superpowers/specs/2026-11-24-product-expansion-2-design.md` (read it first; it holds every owner decision, the migration number ranges and the rules). This file is the common goal prompt; each session gets its own scope line from section 3.

## 1. Goal

Deliver every capability of your group in BOTH products (Postgres/FastAPI and the Google Sheets edition) unless the design marks it API-only, with identical rules proven by shared golden tests. Scope is the group in the design, all of it: never drop, defer or simplify an item silently. If something truly cannot be done, say exactly what and why in the final report.

## 2. Rules for every session (non-negotiable)

1. Work only in your own git worktree/branch; your files are the ones your group needs. Do not edit another group's logic. Shared generated or index files (OpenAPI + TS client, `sheets/src/Code.ts` menus, `sheets/src/gas/schema.ts` ALL_TABLES, docs, HANDOFF) are expected to conflict: resolve by merging both sides, and regenerate generated files.
2. First write your plan: `docs/superpowers/plans/2026-11-24-<your-slug>.md`. Then work test-first (negative tests for every validation rule, RLS/permission tests, golden tests for rules shared with Sheets).
3. Use only your migration number range from the design (up AND down, `db/tests/test_schema.sql` extended, `db/scripts/test_migrations.sh` green).
4. Server defaults use `nazoratly.accounting.org_today(conn)`; tests use `tests.helpers.org_today()`. Never `date.today()`.
5. New Apps Script service calls need their OAuth scope in `sheets/appsscript.json` (the test harness does not enforce scopes). List new scopes in the report.
6. Model B: nothing is sent to a guardian, student or lead by automation or AI without a person's approval; tests use fake transports only.
7. No new paid services. No secrets in code, logs or docs.
8. HELD, never do these yourself: apply a migration to the live local database, rebuild/restart live containers (`docker compose up` on the live stack), `clasp push`, running "Boshlang'ich sozlash", Cloudflare/DNS changes, real Telegram messages. The orchestrator does the live steps after the merge.
9. Local checks before every push: backend `uv run ruff check . && uv run ruff format --check . && uv run mypy src && uv run pytest` (parallel sessions: your tests start their own Docker Postgres on a random port), sheets `npm test` + `npm run build`, web checks if you touch web/, `db/scripts/test_migrations.sh`.
10. Delivery: push, open a PR, wait until ALL checks are green (`gh pr checks`: backend, migrations, client, sheets, web, secrets, image). Then rebase onto the latest `origin/main`, regenerate generated files, re-run the local checks, push, wait for green again, and **squash-merge your own PR** (`gh pr merge --squash`). If main moved while you waited, repeat the rebase. Never merge with a red or pending check; never use `--admin`. If CI is red for a reason outside your change, diagnose it; fix it in a separate small PR if it is a real bug.
11. Tool and cost discipline: no subagents unless essential; keep the session focused; do not run Lighthouse or other heavy unrelated jobs.
12. If you are blocked (a decision only the owner can make, a failing environment), do not guess: finish everything else, then report the blocker precisely.

## 3. Sessions (scope = the design's group; slug; migrations)

| Session | Group | Slug | Migrations |
|---|---|---|---|
| S1 | G1 money rules | `money` | 0020-0024 |
| S2 | G2 schedule and rooms | `schedule` | 0025-0029 |
| S3 | G3 growth | `growth` | 0030-0034 |
| S4 | G4 learning results | `results` | 0035-0039 |
| S5 | G5 AI assistant | `ai` | 0040-0044 |
| S6 | G6 multi-branch (wave 2) | `branches` | 0050-0059 |
| S7 | G7 guardian cabinet (wave 3) | `guardian` | 0060-0064 |
| S8 | G8 teacher app (wave 3) | `teacher` | 0065-0069 |
| S9 | wave 4 landing update | `landing2` | none |

## 4. Final report (Uzbek Latin, spartan)

PR link and merge state, check results you verified yourself with the exact commands, what was delivered per item of your group (done / not done and why), new OAuth scopes, live steps held for the orchestrator (migration numbers, services to rebuild, Sheet menus to try), risks.

## 5. Orchestrator checklist (main session, not for builders)

After each wave's PRs are merged: on updated main run the full backend/sheets/web test suites once, take a `pg_dump` into `E:\projects\backups`, apply the new migrations through the migrate service (`docker compose up -d --build`), verify `/health`, container health, the live routes; roll back from the dump on failure. Start the next wave only when the previous one is merged and the live stack is healthy. `clasp push` and Sheet setup wait for the owner's Allow click in the morning. Keep a status table for the owner's morning report.
