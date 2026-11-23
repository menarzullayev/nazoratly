/** Pure parsing of Telegram updates for guardian linking (no network, unit-tested). */
export type ParsedUpdate =
  | { kind: "start"; chatId: string; code: string }
  | { kind: "stop"; chatId: string }
  | { kind: "consent"; chatId: string; callbackId: string; messageId: number; accept: boolean; code: string }
  | { kind: "ignore" };

interface RawUpdate {
  message?: { text?: string; chat?: { id?: number; type?: string } };
  callback_query?: { id?: string; data?: string; message?: { message_id?: number; chat?: { id?: number; type?: string } } };
}

const CODE = /^[A-Z0-9]{6,16}$/;

export function parseUpdate(u: unknown): ParsedUpdate {
  const upd = (u ?? {}) as RawUpdate;
  const m = upd.message;
  if (m?.text && m.chat?.id !== undefined && m.chat.type === "private") {
    const chatId = String(m.chat.id);
    const text = m.text.trim();
    if (text === "/stop" || text.startsWith("/stop@")) return { kind: "stop", chatId };
    if (text === "/start" || text.startsWith("/start ")) {
      const code = text.slice(6).trim().toUpperCase();
      return { kind: "start", chatId, code: CODE.test(code) ? code : "" };
    }
    return { kind: "ignore" };
  }
  const cb = upd.callback_query;
  const cbChat = cb?.message?.chat;
  if (cb?.id && cb.data && cbChat?.id !== undefined && cbChat.type === "private" && cb.message?.message_id !== undefined) {
    const [verb, code = ""] = cb.data.split(":");
    if ((verb === "y" || verb === "n") && (verb === "n" || CODE.test(code))) {
      return { kind: "consent", chatId: String(cbChat.id), callbackId: cb.id, messageId: cb.message.message_id, accept: verb === "y", code };
    }
  }
  return { kind: "ignore" };
}
