/** Sheet layout: one table per tab, Uzbek headers, enum labels shown to users and mapped to domain values. */
export type Kind = "text" | "date" | "int" | "bool" | "enum";

export interface ColDef {
  key: string;
  header: string;
  width: number;
  kind: Kind;
  labels?: Record<string, string>; // domain value -> label shown in the sheet (kind "enum")
  options?: string[]; // free-text columns with a dropdown suggestion
  help?: string; // header note
}

export interface TableDef {
  sheet: string;
  color: string;
  cols: ColDef[];
}

const YES_NO = "Ha / Yo'q";
const L = {
  studentStatus: { lead: "Lead", active: "Faol", paused: "To'xtatilgan", left: "Ketgan" },
  groupStatus: { planned: "Rejada", active: "Faol", finished: "Tugagan", cancelled: "Bekor" },
  enrollStatus: { trial: "Sinov", active: "Faol", frozen: "Muzlatilgan", finished: "Tugagan" },
  firstMonth: { "": "", full: "To'liq oy", prorated: "Proratsiya", free_until_next: "Keyingi oydan" },
  leadStage: { new: "Yangi", contacted: "Aloqada", trial_scheduled: "Sinovga yozilgan", trial_attended: "Sinovda bo'ldi", enrolled: "Yozildi", lost: "Yo'qotildi" },
  entKind: { makeup: "Qoplash darsi", credit: "Kredit" },
  entStatus: { open: "Ochiq", scheduled: "Rejalangan", used: "Ishlatilgan", cancelled: "Bekor" },
  leadKind: { call: "Qo'ng'iroq", message: "Xabar", meeting: "Uchrashuv", trial: "Sinov", note: "Izoh" },
  attendance: { present: "Keldi", absent: "Kelmadi", late: "Kechikdi", excused: "Sababli" },
  billing: { monthly: "Oylik", package: "Abonement" },
  payModel: { fixed: "Qat'iy oylik", per_lesson: "Dars uchun", percent: "Foiz" },
  teacherStatus: { active: "Faol", inactive: "Nofaol" },
  draftStatus: { pending: "Kutilmoqda", approved: "Tasdiqlangan", sent: "Yuborilgan", rejected: "Rad etilgan", failed: "Xato" },
  payrollStatus: { draft: "Qoralama", approved: "Tasdiqlangan", paid: "To'langan" },
} as const;

export const METHODS = ["Naqd", "Karta", "O'tkazma", "Payme", "Click", "Boshqa"];

export const STUDENTS: TableDef = {
  sheet: "O'quvchilar",
  color: "#1a73e8",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik beriladi (S0001...)" },
    { key: "fullName", header: "F.I.Sh.", width: 220, kind: "text" },
    { key: "status", header: "Holat", width: 110, kind: "enum", labels: L.studentStatus },
    { key: "phone", header: "Telefon", width: 130, kind: "text", help: "+998901234567" },
    { key: "guardianName", header: "Vasiy ismi", width: 170, kind: "text" },
    { key: "guardianChatId", header: "Telegram chat ID", width: 130, kind: "text", help: "Vasiy botga ulanganda avtomatik to'ladi" },
    { key: "consentNotify", header: "Bildirishnoma roziligi", width: 120, kind: "bool", help: `Faqat vasiy botda rozilik bersa "Ha" bo'ladi. ${YES_NO}` },
    { key: "consentDate", header: "Rozilik sanasi", width: 110, kind: "date" },
    { key: "consentPolicy", header: "Siyosat versiyasi", width: 110, kind: "text", help: "Rozilik berilgan paytdagi maxfiylik siyosati" },
    { key: "linkCode", header: "Ulash kodi", width: 110, kind: "text", help: "Vasiyga beriladigan bir martalik kod (nazoratly menyusi)" },
    { key: "linkUrl", header: "Ulash havolasi", width: 260, kind: "text", help: "Vasiy shu havolani Telegramda ochadi" },
    { key: "note", header: "Izoh", width: 220, kind: "text" },
  ],
};

export const GROUPS: TableDef = {
  sheet: "Guruhlar",
  color: "#188038",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text" },
    { key: "name", header: "Guruh nomi", width: 200, kind: "text" },
    { key: "teacherId", header: "O'qituvchi ID", width: 110, kind: "text" },
    { key: "monthlyFee", header: "Oylik narx (so'm)", width: 130, kind: "int" },
    { key: "schedule", header: "Jadval", width: 200, kind: "text", help: "Masalan: Du-Chor-Ju 18:00" },
    { key: "status", header: "Holat", width: 100, kind: "enum", labels: L.groupStatus },
    { key: "billingMode", header: "Hisoblash turi", width: 120, kind: "enum", labels: L.billing, help: "Oylik: har oy hisob yaratiladi. Abonement: to'lov darslar sonini beradi (menyu: Abonement)" },
    { key: "packageLessons", header: "Abonement darslari", width: 120, kind: "int", help: "Bitta abonementdagi darslar soni (faqat Abonement guruhlari)" },
    { key: "packagePrice", header: "Abonement narxi (so'm)", width: 140, kind: "int", help: "Bitta abonement narxi (faqat Abonement guruhlari)" },
  ],
};

export const ENROLLMENTS: TableDef = {
  sheet: "Yozilishlar",
  color: "#188038",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "startedOn", header: "Boshlangan sana", width: 120, kind: "date" },
    { key: "endedOn", header: "Tugagan sana", width: 120, kind: "date" },
    { key: "discountPercent", header: "Chegirma %", width: 100, kind: "int" },
    { key: "status", header: "Holat", width: 110, kind: "enum", labels: L.enrollStatus, help: "Sinov: hisob yaratilmaydi. Qabul qilish: nazoratly > Qabul menyusi" },
    { key: "acceptedOn", header: "Qabul sanasi", width: 110, kind: "date", help: "Sinov qabul qilingan sana (avtomatik)" },
    { key: "firstMonthMode", header: "Birinchi oy", width: 120, kind: "enum", labels: L.firstMonth, help: "Qabul paytida tanlangan: to'liq oy / proratsiya / keyingi oydan (avtomatik)" },
    { key: "droppedTrial", header: "Sinov bekor qilingan", width: 120, kind: "bool", help: "Sinov bekor qilinsa avtomatik 'Ha': sinov darslari bepul qoladi" },
  ],
};

export const ATTENDANCE: TableDef = {
  sheet: "Davomat",
  color: "#f9ab00",
  cols: [
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "status", header: "Holat", width: 110, kind: "enum", labels: L.attendance },
    { key: "minutesLate", header: "Kechikish (daq)", width: 110, kind: "int" },
  ],
};

export const CHARGES: TableDef = {
  sheet: "Hisoblar",
  color: "#d93025",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "enrollmentId", header: "Yozilish ID", width: 100, kind: "text" },
    { key: "month", header: "Oy", width: 100, kind: "date", help: "Oyning birinchi kuni" },
    { key: "amount", header: "Summa", width: 110, kind: "int" },
    { key: "dueDate", header: "To'lov muddati", width: 120, kind: "date" },
    { key: "note", header: "Izoh", width: 200, kind: "text" },
    { key: "voided", header: "Bekor qilingan", width: 110, kind: "bool", help: "Hisobni o'chirmang, 'Ha' qilib bekor qiling" },
  ],
};

export const PAYMENTS: TableDef = {
  sheet: "To'lovlar",
  color: "#d93025",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "paidOn", header: "Sana", width: 110, kind: "date" },
    { key: "amount", header: "Summa", width: 110, kind: "int" },
    { key: "method", header: "Usul", width: 110, kind: "text", options: METHODS },
    { key: "note", header: "Izoh", width: 200, kind: "text" },
    { key: "voided", header: "Bekor qilingan", width: 110, kind: "bool", help: "To'lovni o'chirmang, 'Ha' qilib bekor qiling" },
  ],
};

export const TEACHERS: TableDef = {
  sheet: "O'qituvchilar",
  color: "#9334e6",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text" },
    { key: "fullName", header: "F.I.Sh.", width: 220, kind: "text" },
    { key: "payModel", header: "Oylik turi", width: 130, kind: "enum", labels: L.payModel },
    { key: "payRate", header: "Stavka", width: 120, kind: "int", help: "so'm (qat'iy/dars) yoki foiz" },
    { key: "status", header: "Holat", width: 100, kind: "enum", labels: L.teacherStatus },
  ],
};

export const PAYROLL: TableDef = {
  sheet: "Oylik",
  color: "#9334e6",
  cols: [
    { key: "month", header: "Oy", width: 100, kind: "date" },
    { key: "teacherId", header: "O'qituvchi ID", width: 110, kind: "text" },
    { key: "teacherName", header: "O'qituvchi", width: 200, kind: "text" },
    { key: "heldLessons", header: "Darslar", width: 80, kind: "int" },
    { key: "collected", header: "Yig'ilgan to'lov", width: 130, kind: "int" },
    { key: "bonus", header: "Bonus / (jarima)", width: 120, kind: "int", help: "Qo'lda: bonus musbat, jarima manfiy" },
    { key: "total", header: "Jami oylik", width: 120, kind: "int" },
    { key: "status", header: "Holat", width: 110, kind: "enum", labels: L.payrollStatus },
  ],
};

export const DRAFTS: TableDef = {
  sheet: "Eslatmalar",
  color: "#00acc1",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "createdOn", header: "Yaratilgan", width: 110, kind: "date" },
    { key: "text", header: "Xabar matni", width: 480, kind: "text" },
    { key: "status", header: "Holat", width: 120, kind: "enum", labels: L.draftStatus },
    { key: "error", header: "Xato", width: 220, kind: "text" },
  ],
};

export const LEADS: TableDef = {
  sheet: "Lead'lar",
  color: "#e37400",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik beriladi (L0001...)" },
    { key: "fullName", header: "F.I.Sh.", width: 220, kind: "text" },
    { key: "phone", header: "Telefon", width: 130, kind: "text", help: "+998901234567" },
    { key: "source", header: "Manba", width: 130, kind: "text", options: ["Instagram", "Telegram", "Tanish", "OLX", "Reklama", "Boshqa"], help: "Qayerdan keldi" },
    { key: "stage", header: "Bosqich", width: 140, kind: "enum", labels: L.leadStage },
    { key: "nextFollowUpOn", header: "Keyingi aloqa", width: 120, kind: "date" },
    { key: "note", header: "Izoh", width: 240, kind: "text" },
    { key: "createdOn", header: "Qo'shilgan sana", width: 120, kind: "date" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text", help: "Sinovga yozilganda avtomatik to'ladi" },
  ],
};

export const LEAD_LOG: TableDef = {
  sheet: "Lead aloqalari",
  color: "#f29900",
  cols: [
    { key: "leadId", header: "Lead ID", width: 90, kind: "text" },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "kind", header: "Turi", width: 120, kind: "enum", labels: L.leadKind },
    { key: "summary", header: "Qisqacha", width: 320, kind: "text" },
    { key: "nextFollowUpOn", header: "Keyingi aloqa", width: 120, kind: "date" },
  ],
};

export const ENTITLEMENTS: TableDef = {
  sheet: "Qoplash huquqlari",
  color: "#9334e6",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik (R0001...): sababli yo'qlikdan hosil bo'ladi" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "missedOn", header: "Qoldirilgan sana", width: 120, kind: "date" },
    { key: "kind", header: "Turi", width: 120, kind: "enum", labels: L.entKind },
    { key: "amount", header: "Summa (kredit)", width: 120, kind: "int" },
    { key: "expiresOn", header: "Muddat", width: 110, kind: "date" },
    { key: "status", header: "Holat", width: 110, kind: "enum", labels: L.entStatus },
    { key: "makeupOn", header: "Qoplash sanasi", width: 120, kind: "date", help: "Rejalangan qoplash darsi sanasi (menyu: Qoplash)" },
    { key: "usedOn", header: "Ishlatilgan sana", width: 120, kind: "date" },
    { key: "appliedChargeId", header: "Hisob ID", width: 90, kind: "text", help: "Kredit qaysi oylik hisobdan ayirilgani" },
    { key: "lastMakeupOn", header: "Oxirgi qoplash sanasi", width: 130, kind: "date", help: "Oylik hisobida: bu kunda faqat kelgan bo'lsa dars hisoblanadi" },
  ],
};

export const INSTALLMENTS: TableDef = {
  sheet: "To'lov rejalari",
  color: "#d93025",
  cols: [
    { key: "chargeId", header: "Hisob ID", width: 90, kind: "text", help: "Qismlarga bo'linadigan hisob (menyu: To'lov rejasi > Reja tuzish)" },
    { key: "seq", header: "Qism №", width: 80, kind: "int", help: "1, 2, 3 ... ketma-ket" },
    { key: "dueDate", header: "To'lov muddati", width: 120, kind: "date", help: "Qismlar muddati o'sib borishi kerak" },
    { key: "amount", header: "Summa", width: 110, kind: "int", help: "Qismlar yig'indisi hisob summasiga teng bo'lishi shart (menyu: Rejalarni tekshirish)" },
  ],
};

export const PACKAGES: TableDef = {
  sheet: "Abonementlar",
  color: "#188038",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik (P0001...): menyu Abonement > Abonement sotish" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "enrollmentId", header: "Yozilish ID", width: 100, kind: "text" },
    { key: "chargeId", header: "Hisob ID", width: 90, kind: "text", help: "Abonement narxi shu hisobga yoziladi; to'langan pul darslarni beradi" },
    { key: "lessons", header: "Darslar", width: 80, kind: "int" },
    { key: "price", header: "Narx", width: 110, kind: "int" },
    { key: "purchasedOn", header: "Sotilgan sana", width: 120, kind: "date" },
    { key: "expiresOn", header: "Muddati", width: 120, kind: "date", help: "Shu kundan keyin ishlatilmagan darslar kuyadi (menyu: Muddatni uzaytirish)" },
  ],
};

export const DOCUMENTS: TableDef = {
  sheet: "Hujjatlar",
  color: "#5f6368",
  cols: [
    { key: "number", header: "Raqam", width: 130, kind: "text", help: "KV-yyyy-000001 kvitansiya, TH-yyyy-000001 to'lov hisobi" },
    { key: "kind", header: "Turi", width: 110, kind: "enum", labels: { receipt: "Kvitansiya", invoice: "To'lov hisobi" } },
    { key: "issuedOn", header: "Sana", width: 110, kind: "date" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "paymentId", header: "To'lov ID", width: 90, kind: "text", help: "Kvitansiya uchun" },
    { key: "amount", header: "Summa", width: 110, kind: "int" },
    { key: "link", header: "PDF havolasi", width: 300, kind: "text", help: "Google Drive dagi PDF fayl (hujjat o'zgarmaydi)" },
    { key: "sentOn", header: "Vasiyga yuborilgan", width: 130, kind: "date" },
  ],
};

export const ALL_TABLES: TableDef[] = [STUDENTS, GROUPS, ENROLLMENTS, ATTENDANCE, CHARGES, PAYMENTS, TEACHERS, PAYROLL, DRAFTS, LEADS, LEAD_LOG, ENTITLEMENTS, PACKAGES, INSTALLMENTS, DOCUMENTS];

export const SETTINGS_SHEET = "Sozlamalar";
export const DEBTORS_SHEET = "Qarzdorlar";
export const DASHBOARD_SHEET = "Boshqaruv";

export const SETTING_DEFAULTS: { key: string; label: string; value: string; help: string }[] = [
  { key: "center", label: "Markaz nomi", value: "Mening markazim", help: "Eslatma xabarlarida ko'rinadi" },
  { key: "dueDay", label: "To'lov muddati (oyning kuni)", value: "10", help: "1-28" },
  { key: "cooldownDays", label: "Eslatmalar orasidagi kunlar", value: "7", help: "Bir o'quvchiga shuncha kun ichida qayta eslatma yaratilmaydi" },
  { key: "minOverdue", label: "Minimal muddati o'tgan qarz (so'm)", value: "50000", help: "Undan kichik qarzga eslatma yaratilmaydi" },
  { key: "template", label: "Eslatma shabloni", value: "", help: "{guardian} {student} {amount} {days} {center} o'zgaruvchilari" },
  { key: "policyVersion", label: "Maxfiylik siyosati versiyasi", value: "2026-11", help: "Rozilik yozuvida saqlanadi" },
  { key: "policyText", label: "Maxfiylik siyosati (bot /privacy)", value: "Biz faqat to'lov va davomat haqida xabar yuborish uchun ota-onaning ism va Telegram chat ID sini saqlaymiz. Rozilikni istalgan payt /stop bilan qaytarishingiz mumkin.", help: "Bot /privacy buyrug'iga shuni javob beradi (Telegram talabi). Havola bo'lsa shu yerga yozing" },
  { key: "trialFreeLessons", label: "Bepul sinov darslari soni", value: "1", help: "Shuncha dars o'tgach (yoki kun chegarasi oldin tugasa) qaror kerak bo'ladi" },
  { key: "trialFreeDays", label: "Bepul sinov kunlari", value: "7", help: "Sinov boshlanganidan shuncha kun o'tgach qaror kerak bo'ladi" },
  { key: "excusedMode", label: "Sababli yo'qlik", value: "Qoplash", help: "Qoplash = qoplash huquqi, Kredit = keyingi oylik hisobdan ayiriladi, Yo'q = hech narsa" },
  { key: "makeupExpiryDays", label: "Qoplash muddati (kun)", value: "30", help: "Sababli yo'qlikdan keyin huquq shuncha kun amal qiladi (0-365)" },
  { key: "makeupLapses", label: "Muddati o'tgan huquq kuyadi", value: "Ha", help: "Ha / Yo'q" },
  { key: "packageExpiryDays", label: "Abonement muddati (kun)", value: "60", help: "Abonement sotilgan kundan boshlab shuncha kun amal qiladi, keyin ishlatilmagan darslar kuyadi (1-730)" },
  { key: "packageLowLessons", label: "Abonementda oz dars qolganda", value: "2", help: "Qolgan darslar shuncha yoki kam bo'lsa 'to'lov kerak' ro'yxatiga tushadi (0-50)" },
  { key: "installmentRemindDays", label: "Qism haqida oldindan eslatma (kun)", value: "3", help: "To'lov qismi muddatiga shuncha kun qolganda eslatma loyihasi yaratiladi (0 = o'chirilgan)" },
  { key: "requisites", label: "Markaz rekvizitlari (hujjatlarda)", value: "", help: "Manzil, telefon, hisob raqami... Kvitansiya va to'lov hisobida markaz nomi ostida chiqadi. Hujjat ichki hujjat: fiskal chek emas" },
  { key: "payInfo", label: "To'lov rekvizitlari", value: "", help: "Karta raqami yoki hisob. Xabardagi 'Nusxalash' tugmasi shuni nusxalaydi (bo'sh = tugma yo'q)" },
  { key: "ownerChatId", label: "Egasining Telegram chat ID si", value: "", help: "Vasiy 'To'lov qildim' bossa shu yerga xabar keladi (botga /start yozib, @userinfobot dan ID ni oling)" },
];
