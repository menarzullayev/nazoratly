# Plan: Telegram bot dispatcher, center bots, Sheets relay and polling

Spec: `docs/superpowers/specs/2026-11-27-telegram-bots-design.md`. One PR, one commit per part, tests in the same commit.

## Part 1: registry, dispatcher, role and center menu
- Migration `0068_telegram_bots`: `telegram_bots` (shared = `org_id` NULL), `telegram_chats` (per bot and Telegram user: active role and center, epoch, unreachable), `telegram_updates` (dedup), delivery-route functions for the API and the worker, branch catalog and RLS entries.
- `telegram_registry.py` (lookup, shared-bot resolution, usernames), `telegram_dispatch.py` (routing order, menu, stale-button refusal), `telegram_setup.py` (operator command for the shared bot).
- `routers/bot_hook.py` (`POST /hooks/bot/{id}`) replaces the two old hooks.
- Guardian and teacher handlers take a scope (one center or all but stopped ones) and namespaced callback data.
- Outbox and staff notices are delivered through the bot the person can be reached on; undeliverable is a visible failure.
- Mini App sign-in verifies `initData` with the token of the bot it was opened from.
- Compose and `.env.example` pass the variables.

## Part 2: center-owned bot by token, staged migration
- `/v1/telegram/bot` (connect, status, disconnect, migration list, stop shared bot), owner only.
- One-time, short-lived, account-bound transition code (`NZM-...`).
- Sessions created through a center bot are locked to that center.

## Part 3: Managed Bots
- Connect request (`NZC-...` confirmation in the shared bot binds the owner's Telegram account), `managed_bot` update, `getManagedBotToken`, token rotation and owner change.

## Part 4: multi-tenant Sheets relay
- `sheet_relays` table, `POST /hooks/relay/{id}`, operator command, Apps Script targets only, nothing stored or logged. Menu item in Sheets to change the relay address.

## Part 5: Sheets getUpdates mode
- Webhook removed, time trigger (5 min default, 1 min selectable), saved offset, one run at a time, daily runtime accounting with warnings.

## Required negative tests (spec section 6)
Wrong or foreign bot secret; another center through a center bot; old button after a role or center switch; unknown user; token absent from responses and logs; duplicate update; someone else's transition code; someone else's managed bot; relay to a disallowed address.

## Docs and checks
`docs/API.md`, `docs/DEPLOY.md`, `.env.example`, `HANDOFF.md`, `docs/READINESS.md` rows 20-21. Backend lint/mypy/tests/OpenAPI, migration cycle, client types, sheets check, web e2e-api, gitleaks, image build; then the 8 CI checks.
