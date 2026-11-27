/**
 * getUpdates mode: instead of a webhook (which Apps Script can only receive through a relay) a time trigger asks
 * Telegram for new updates. Telegram does not allow both, so enabling it removes the webhook. One run at a time
 * (document lock), the offset is saved after every update, and the runtime of the Sheet's triggers is counted per day
 * against Google's quota, with a warning to the owner.
 */
import { DEFAULT_POLL_MINUTES, botIdOfToken, dailyLimitMs, emptyUsage, quotaLevel, quotaWarning, runBudgetMs, usageText, type PollMinutes, type Usage } from "../domain/polling";
import { PROP_MODE, pollingEnabled } from "./pollingMode";
import { today } from "./repo";
import { readSettings } from "./settings";
import { getToken, props, sendMessage, tg } from "./telegram";
import { processUpdate } from "./webhook";

export const POLL_HANDLER = "telegramPoll";
const PROP_MINUTES = "TG_POLL_MINUTES";
const PROP_USAGE = "TG_USAGE";
const PROP_ERROR = "TG_POLL_ERROR";
const ALLOWED_UPDATES = ["message", "callback_query"];

export const pollMinutes = (): PollMinutes => (props().getProperty(PROP_MINUTES) === "1" ? 1 : DEFAULT_POLL_MINUTES);

const offsetKey = (): string => `TG_OFFSET_${botIdOfToken(getToken() ?? "")}`;
const ownerLimitMs = (): number => dailyLimitMs(Session.getEffectiveUser().getEmail());

export function readUsage(): Usage {
  const date = today();
  try {
    const u = JSON.parse(props().getProperty(PROP_USAGE) ?? "null") as Usage | null;
    if (u && u.date === date) return u;
  } catch {
    /* a damaged value starts a new day */
  }
  return emptyUsage(date);
}

/** Adds one trigger run to today's count and warns the owner once per level and day. */
export function accountRun(ms: number, poll: { updates: number } | null): void {
  const u = readUsage();
  u.ms += Math.max(0, ms);
  if (poll) {
    u.pollRuns += 1;
    u.pollMs += Math.max(0, ms);
    u.updates += poll.updates;
  }
  const minutes = pollMinutes();
  const limit = ownerLimitMs();
  const level = pollingEnabled() ? quotaLevel(u, minutes, limit) : "ok";
  if (level !== "ok" && u.warned !== level && u.warned !== "over") {
    const owner = readSettings().ownerChatId;
    if (owner && sendMessage(owner, quotaWarning(level, u, minutes, limit)).ok) u.warned = level;
  }
  props().setProperty(PROP_USAGE, JSON.stringify(u));
}

interface Update { update_id?: number }

/** One run: fetch and handle updates until there are none left or the time budget of the run is used. */
function drain(minutes: PollMinutes, started: number): number {
  const key = offsetKey();
  let handled = 0;
  for (;;) {
    const offset = Number(props().getProperty(key) ?? "0");
    const r = tg("getUpdates", { ...(offset ? { offset } : {}), limit: 100, timeout: 0, allowed_updates: ALLOWED_UPDATES });
    if (!r.ok) {
      props().setProperty(PROP_ERROR, `${today()}: ${r.errorCode ?? ""} ${r.description ?? ""}`.trim());
      return handled;
    }
    props().deleteProperty(PROP_ERROR);
    const updates = (Array.isArray(r.result) ? r.result : []) as Update[];
    for (const update of updates) {
      if (typeof update.update_id !== "number") continue;
      try {
        processUpdate(update);
      } catch (e) {
        // one broken update must not block the queue; its content is not logged
        console.error(`telegram update ${update.update_id} failed: ${e instanceof Error ? e.name : "error"}`);
      }
      props().setProperty(key, String(update.update_id + 1));
      handled++;
      if (Date.now() - started >= runBudgetMs(minutes)) return handled;
    }
    if (updates.length < 100) return handled;
  }
}

/** The trigger target. */
export function pollTick(): void {
  if (!pollingEnabled()) return;
  // the document lock, not the script lock: handling an update takes the script lock itself
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(0)) return; // the previous run is still working
  const started = Date.now();
  let handled = 0;
  try {
    handled = drain(pollMinutes(), started);
  } finally {
    accountRun(Date.now() - started, { updates: handled });
    lock.releaseLock();
  }
}

function removePollTriggers(): void {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === POLL_HANDLER) ScriptApp.deleteTrigger(t);
  }
}

/** Switch to getUpdates (or change the interval). Updates waiting at Telegram are kept. */
export function startPolling(minutes: PollMinutes): void {
  if (!getToken()) throw new Error("Avval Telegram botni sozlang.");
  const removed = tg("deleteWebhook", { drop_pending_updates: false });
  if (!removed.ok) throw new Error(`Webhookni o'chirib bo'lmadi: ${removed.description}`);
  removePollTriggers();
  ScriptApp.newTrigger(POLL_HANDLER).timeBased().everyMinutes(minutes).create();
  props().setProperty(PROP_MINUTES, String(minutes));
  props().setProperty(PROP_MODE, "poll");
}

/** Leave the getUpdates mode (the caller sets the webhook again). */
export function stopPolling(): boolean {
  const was = pollingEnabled();
  removePollTriggers();
  props().deleteProperty(PROP_MODE);
  props().deleteProperty(PROP_ERROR);
  return was;
}

export function pollingStatus(): string {
  if (!pollingEnabled()) return "So'rab turish rejimi o'chiq (webhook rejimi).";
  const minutes = pollMinutes();
  const limit = ownerLimitMs();
  const usage = readUsage();
  const level = quotaLevel(usage, minutes, limit);
  const error = props().getProperty(PROP_ERROR);
  return [
    `So'rab turish yoqilgan: har ${minutes} daqiqada. Javob shu oraliqqacha kechikishi mumkin.`,
    level === "ok" ? usageText(usage, minutes, limit) : quotaWarning(level, usage, minutes, limit),
    "Hisob shu jadval triggerlarining o'lchangan vaqti; Google'ning o'z hisobi (boshqa skriptlar bilan birga) farq qilishi mumkin.",
    ...(error ? [`Oxirgi xato: ${error}`] : []),
  ].join("\n\n");
}
