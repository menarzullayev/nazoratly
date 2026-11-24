/** Telegram webhook (Apps Script Web App). A guardian links a chat to a student ONLY after explicitly consenting. */
import { parseUpdate } from "../domain/telegramUpdates";
import { read, today, updateById } from "./repo";
import { STUDENTS } from "./schema";
import { readSettings } from "./settings";
import { verifyJson } from "./results";
import { handleTeacherUpdate } from "./teacher";
import { sendRich, tg, webhookSecret, sendMessage } from "./telegram";
import { balanceHtmlForChat, withLock } from "./actions";
import type { Student } from "../domain/types";
import { awaitingConsent, phoneLinkStudents, qrLinkRequest } from "./guardian";

type StudentRow = Student & { linkCode?: string };

const text = (s: string): GoogleAppsScript.Content.TextOutput => ContentService.createTextOutput(s);

function consentPrompt(chatId: string, center: string, studentName: string, code: string): void {
  sendMessage(
    chatId,
    `${center}: siz ${studentName} ning ota-onasi/vasiysi sifatida ulanmoqchisiz.\n\nUshbu bot orqali to'lov va davomat haqida xabarlar olishga rozilik berasizmi? Istalgan payt /stop yuborib bekor qilishingiz mumkin.`,
    { reply_markup: { inline_keyboard: [[{ text: "Roziman", callback_data: `y:${code}` }, { text: "Rad etaman", callback_data: "n" }]] } },
  );
}

/** Students the center linked to this chat that still wait for the guardian's consent: ask for it. */
function askConsent(chatId: string, center: string): boolean {
  const waiting = awaitingConsent(chatId);
  for (const w of waiting) consentPrompt(chatId, center, w.fullName, w.code);
  return waiting.length > 0;
}

export function handleGet(e?: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput {
  // public certificate check: ?verify=NZC-XXXX-XXXX-XXXX answers with JSON (the holder's name is masked)
  const code = e?.parameter?.verify;
  if (code) return text(verifyJson(code));
  return text("nazoratly webhook ishlayapti");
}

export function handlePost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  // Apps Script cannot read headers, so the shared secret travels in the URL (?s=...). Wrong secret: do nothing.
  const given = e.parameter?.s ?? "";
  const secret = webhookSecret();
  if (given.length !== secret.length || given !== secret) return text("ok");
  let update: unknown;
  try {
    update = JSON.parse(e.postData?.contents ?? "{}");
  } catch {
    return text("ok");
  }
  if (handleTeacherUpdate(update)) return text("ok"); // the teacher bot (G8): invitation, roll call, messages
  const u = parseUpdate(update);
  const center = readSettings().center;
  if (u.kind === "start") {
    const s = u.code ? read<StudentRow>(STUDENTS).find((x) => x.linkCode && x.linkCode.toUpperCase() === u.code) : undefined;
    if (!s && !u.code && askConsent(u.chatId, center)) {
      // a link the center approved or made by hand: only the guardian's own consent is left
    } else if (!s) {
      sendMessage(u.chatId, `Assalomu alaykum! Bu ${center} o'quv markazining rasmiy boti. Ulash uchun markaz bergan havoladan, o'quvchi kartasidagi kodni yuborish yoki telefon raqamingizni ulashish orqali foydalaning.`);
    } else {
      sendMessage(
        u.chatId,
        `${center}: siz ${s.fullName} ning ota-onasi/vasiysi sifatida ulanmoqchisiz.\n\nUshbu bot orqali to'lov va davomat haqida xabarlar olishga rozilik berasizmi? Istalgan payt /stop yuborib bekor qilishingiz mumkin.`,
        { reply_markup: { inline_keyboard: [[{ text: "Roziman", callback_data: `y:${u.code}` }, { text: "Rad etaman", callback_data: "n" }]] } },
      );
    }
  } else if (u.kind === "qr") {
    const r = qrLinkRequest(u.chatId, "", u.code);
    sendMessage(u.chatId, r === "pending" ? "So'rovingiz markazga yuborildi. Markaz tasdiqlagach /start yuboring." : "Bu kartaga o'quvchi topilmadi. Kodni tekshiring yoki markazga murojaat qiling.");
  } else if (u.kind === "contact") {
    const hits = phoneLinkStudents(u.phone, u.verified);
    if (!hits.length) sendMessage(u.chatId, "Bu raqam bo'yicha o'quvchi topilmadi yoki raqam sizniki emas. Markaz bergan havoladan foydalaning.");
    for (const h of hits) consentPrompt(u.chatId, center, h.fullName, h.code);
  } else if (u.kind === "consent") {
    tg("answerCallbackQuery", { callback_query_id: u.callbackId });
    if (!u.accept) {
      tg("editMessageText", { chat_id: u.chatId, message_id: u.messageId, text: "Bekor qilindi. Hech qanday xabar yuborilmaydi." });
    } else {
      const linked = withLock(() => {
        const s = read<StudentRow>(STUDENTS).find((x) => x.linkCode && x.linkCode.toUpperCase() === u.code);
        if (!s) return false;
        // the code is single-use: it is cleared so the link cannot be replayed by someone who saw it
        return updateById(STUDENTS, "id", s.id, {
          guardianChatId: u.chatId, consentNotify: true, consentDate: today(), consentPolicy: readSettings().policyVersion, linkCode: "", linkUrl: "",
        });
      });
      tg("editMessageText", {
        chat_id: u.chatId, message_id: u.messageId,
        text: linked ? "Rahmat! Ulandingiz. To'xtatish uchun /stop yuboring." : "Bu havola eskirgan yoki ishlatilgan. Markazdan yangisini so'rang.",
      });
    }
  } else if (u.kind === "command") {
    const s = readSettings();
    if (u.name === "balance") sendRich(u.chatId, balanceHtmlForChat(u.chatId));
    else if (u.name === "privacy") sendMessage(u.chatId, s.policyText || "Maxfiylik siyosati hali kiritilmagan. Markazga murojaat qiling.");
    else sendMessage(u.chatId, "/qarz: qarzdorlik holati\n/privacy: maxfiylik siyosati\n/stop: xabarlarni to'xtatish");
  } else if (u.kind === "paid") {
    const s = withLock(() => read<StudentRow>(STUDENTS).find((x) => x.id === u.studentId && x.guardianChatId === u.chatId));
    if (!s) {
      tg("answerCallbackQuery", { callback_query_id: u.callbackId, text: "Bu o'quvchi sizga ulanmagan", show_alert: true });
    } else {
      withLock(() => updateById(STUDENTS, "id", s.id, { note: `${(s as { note?: string }).note ?? ""} [${today()}: vasiy "to'lov qildim" dedi]`.trim() }));
      tg("answerCallbackQuery", { callback_query_id: u.callbackId, text: "Rahmat! Markaz to'lovni tekshiradi.", show_alert: true });
      const owner = readSettings().ownerChatId;
      if (owner) sendMessage(owner, `${s.fullName}: vasiy "To'lov qildim" tugmasini bosdi. To'lovni tekshirib kiriting.`);
    }
  } else if (u.kind === "stop") {
    const hits = withLock(() => read<StudentRow>(STUDENTS).filter((x) => x.guardianChatId === u.chatId));
    for (const s of hits) updateById(STUDENTS, "id", s.id, { consentNotify: false, guardianChatId: "" });
    sendMessage(u.chatId, hits.length ? "Xabarlar to'xtatildi. Rozilikni qaytarish uchun markazdan yangi havola so'rang." : "Sizga ulangan o'quvchi topilmadi.");
  }
  return text("ok");
}
