/** Bot profile: localized commands, description and short description (Bot API setMyCommands/setMyDescription/...). */
import { tg } from "./telegram";

interface Locale { code: string | null; commands: { command: string; description: string }[]; short: string; description: (center: string) => string }

const LOCALES: Locale[] = [
  {
    code: null,
    commands: [
      { command: "qarz", description: "Qarzdorlik holati" },
      { command: "privacy", description: "Maxfiylik siyosati" },
      { command: "yordam", description: "Yordam" },
      { command: "stop", description: "Xabarlarni to'xtatish" },
    ],
    short: "O'quv markazining to'lov va davomat xabarlari",
    description: (c) => `${c} o'quv markazining rasmiy boti: to'lov, qarz va davomat haqida xabarlar. Faqat ota-onaning roziligi bilan ulanadi, /stop bilan istalgan payt o'chiriladi.`,
  },
  {
    code: "ru",
    commands: [
      { command: "qarz", description: "Состояние задолженности" },
      { command: "privacy", description: "Политика конфиденциальности" },
      { command: "yordam", description: "Помощь" },
      { command: "stop", description: "Отключить уведомления" },
    ],
    short: "Уведомления об оплате и посещаемости учебного центра",
    description: (c) => `Официальный бот учебного центра ${c}: уведомления об оплате, задолженности и посещаемости. Подключается только с согласия родителя, отключение: /stop.`,
  },
  {
    code: "en",
    commands: [
      { command: "qarz", description: "Balance and debts" },
      { command: "privacy", description: "Privacy policy" },
      { command: "yordam", description: "Help" },
      { command: "stop", description: "Stop notifications" },
    ],
    short: "Payment and attendance notices from your learning center",
    description: (c) => `Official bot of ${c}: payment, balance and attendance notices. Connects only with a parent's consent; send /stop to opt out.`,
  },
];

/** Applies the profile; returns the failures (empty = all good). Safe to run repeatedly. */
export function applyBotProfile(center: string): string[] {
  const failures: string[] = [];
  for (const l of LOCALES) {
    const lang = l.code ? { language_code: l.code } : {};
    const calls: [string, Record<string, unknown>][] = [
      ["setMyCommands", { commands: l.commands, scope: { type: "all_private_chats" }, ...lang }],
      ["setMyShortDescription", { short_description: l.short.slice(0, 120), ...lang }],
      ["setMyDescription", { description: l.description(center).slice(0, 512), ...lang }],
    ];
    for (const [method, payload] of calls) {
      const r = tg(method, payload);
      if (!r.ok) failures.push(`${method}${l.code ? ` (${l.code})` : ""}: ${r.description}`);
    }
  }
  return failures;
}
