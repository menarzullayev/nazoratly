/** Pure parsing of Telegram updates for guardian linking and commands (no network, unit-tested). */
export type ParsedUpdate =
  | { kind: "start"; chatId: string; code: string }
  | { kind: "stop"; chatId: string }
  | { kind: "command"; chatId: string; name: "balance" | "privacy" | "help" }
  | { kind: "consent"; chatId: string; callbackId: string; messageId: number; accept: boolean; code: string }
  | { kind: "paid"; chatId: string; callbackId: string; studentId: string }
  | { kind: "ignore" };

interface RawUpdate {
  message?: { text?: string; chat?: { id?: number; type?: string } };
  callback_query?: { id?: string; data?: string; message?: { message_id?: number; chat?: { id?: number; type?: string } } };
}

const CODE = /^[A-Z0-9]{6,16}$/;
const STUDENT_ID = /^S\d{4,}$/;
const COMMANDS: Record<string, "balance" | "privacy" | "help"> = {
  qarz: "balance", balance: "balance", privacy: "privacy", yordam: "help", help: "help",
};

export function parseUpdate(u: unknown): ParsedUpdate {
  const upd = (u ?? {}) as RawUpdate;
  const m = upd.message;
  if (m?.text && m.chat?.id !== undefined && m.chat.type === "private") {
    const chatId = String(m.chat.id);
    const text = m.text.trim();
    const cmd = /^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/.exec(text);
    if (!cmd) return { kind: "ignore" };
    const name = cmd[1]!.toLowerCase();
    if (name === "stop") return { kind: "stop", chatId };
    if (name === "start") {
      const code = (cmd[2] ?? "").trim().toUpperCase();
      return { kind: "start", chatId, code: CODE.test(code) ? code : "" };
    }
    const known = COMMANDS[name];
    return known ? { kind: "command", chatId, name: known } : { kind: "ignore" };
  }
  const cb = upd.callback_query;
  const cbChat = cb?.message?.chat;
  if (cb?.id && cb.data && cbChat?.id !== undefined && cbChat.type === "private") {
    const [verb, arg = ""] = cb.data.split(":");
    if (verb === "p" && STUDENT_ID.test(arg)) return { kind: "paid", chatId: String(cbChat.id), callbackId: cb.id, studentId: arg };
    if (cb.message?.message_id !== undefined && (verb === "y" || verb === "n") && (verb === "n" || CODE.test(arg))) {
      return { kind: "consent", chatId: String(cbChat.id), callbackId: cb.id, messageId: cb.message.message_id, accept: verb === "y", code: arg };
    }
  }
  return { kind: "ignore" };
}
