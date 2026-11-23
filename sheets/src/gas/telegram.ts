/** Telegram Bot API through UrlFetchApp. The token lives only in Script Properties and is never logged or shown. */
export interface TgResult {
  ok: boolean;
  errorCode?: number;
  description?: string;
  result?: unknown;
}

const PROP_TOKEN = "TELEGRAM_BOT_TOKEN";
const PROP_SECRET = "WEBHOOK_SECRET";

export const props = (): GoogleAppsScript.Properties.Properties => PropertiesService.getScriptProperties();
export const getToken = (): string | null => props().getProperty(PROP_TOKEN);
export const setToken = (token: string): void => {
  props().setProperty(PROP_TOKEN, token.trim());
};

export function webhookSecret(): string {
  let s = props().getProperty(PROP_SECRET);
  if (!s) {
    s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    props().setProperty(PROP_SECRET, s);
  }
  return s;
}

/** One call with a single retry when Telegram asks us to wait (429 retry_after, capped at 10 s). */
export function tg(method: string, payload: Record<string, unknown> = {}): TgResult {
  const token = getToken();
  if (!token) return { ok: false, description: "Telegram bot tokeni sozlanmagan (nazoratly > Telegram sozlash)" };
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: GoogleAppsScript.URL_Fetch.HTTPResponse;
    try {
      res = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
    } catch {
      return { ok: false, description: "Telegramga ulanib bo'lmadi" }; // never echo the exception: it contains the URL (token)
    }
    let data: { ok?: boolean; description?: string; error_code?: number; result?: unknown; parameters?: { retry_after?: number } } = {};
    try {
      data = JSON.parse(res.getContentText());
    } catch {
      /* non-JSON answer */
    }
    if (res.getResponseCode() === 200 && data.ok) return { ok: true, result: data.result };
    if (res.getResponseCode() === 429 && attempt === 0) {
      Utilities.sleep(Math.min(10, data.parameters?.retry_after ?? 3) * 1000 + 200);
      continue;
    }
    return { ok: false, errorCode: res.getResponseCode(), description: String(data.description ?? "Telegram xatosi").slice(0, 200) };
  }
  return { ok: false, description: "Telegram band, keyinroq urinib ko'ring" };
}

export const sendMessage = (chatId: string, text: string, extra: Record<string, unknown> = {}): TgResult =>
  tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
