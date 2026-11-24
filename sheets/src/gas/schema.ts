/** Sheet layout: one table per tab, Uzbek headers, enum labels shown to users and mapped to domain values. */
export type Kind = "text" | "date" | "int" | "num" | "bool" | "enum";

export interface ColDef {
  key: string;
  header: string;
  width: number;
  kind: Kind;
  labels?: Record<string, string>; // domain value -> label shown in the sheet (kind "enum")
  options?: string[]; // free-text columns with a dropdown suggestion
  help?: string; // header note
  plain?: boolean; // stored as plain text (codes, hashes, free text): never turned into a number or a formula
  signed?: boolean; // an int column that may be negative
  optional?: boolean; // a workbook set up before this column existed still works (the value reads as empty)
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
  waitStatus: { waiting: "Kutmoqda", enrolled: "Yozildi", removed: "Olib tashlandi" },
  changeKind: { move: "Ko'chirish", cancel: "Bekor qilish", substitute: "O'rinbosar" },
  payModel: { fixed: "Qat'iy oylik", per_lesson: "Dars uchun", percent: "Foiz" },
  teacherStatus: { active: "Faol", inactive: "Nofaol" },
  draftStatus: { pending: "Kutilmoqda", approved: "Tasdiqlangan", sent: "Yuborilgan", rejected: "Rad etilgan", failed: "Xato" },
  expenseCategory: { rent: "Ijara", utilities: "Kommunal", salary: "Maosh (boshqa xodimlar)", marketing: "Reklama", equipment: "Jihoz", tax: "Soliq", other: "Boshqa" },
  payrollStatus: { draft: "Qoralama", approved: "Tasdiqlangan", paid: "To'langan" },
  accountType: { asset: "Aktiv", liability: "Majburiyat", equity: "Kapital", income: "Daromad", expense: "Xarajat" },
  cashKind: { cash: "Naqd", bank: "Bank" },
  paidFrom: { cash: "Naqd", bank: "Bank" },
  statementStatus: { open: "Ochiq", finalized: "Yopilgan" },
  entSource: { absence: "Sababli yo'qlik", referral: "Tavsiya", promo: "Promo" },
  refStatus: { pending: "Kutilmoqda", rewarded: "Mukofotlangan", cancelled: "Bekor" },
  rewardType: { amount: "Summa", percent: "Foiz", free_lesson: "Bepul dars" },
  refCondition: { paid: "To'lagandan keyin", enrolled: "Yozilgandan keyin" },
  promoKind: { percent: "Foiz", amount: "Summa" },

  discountKind: { individual: "Individual", scholarship: "Stipendiya", early_pay: "Erta to'lov" },
  discountLineKind: { family: "Oilaviy", individual: "Individual", scholarship: "Stipendiya", early_pay: "Erta to'lov" },
  refundKind: { wrong_payment: "Xato to'lov", leaving: "Ketdi (oy qoldig'i)", package_remainder: "Abonement qoldig'i", to_credit: "Kreditga o'tkazish" },
  payout: { cash: "Naqd", bank: "Bank", credit: "Kredit" },
  branchStatus: { active: "Faol", closed: "Yopilgan" },
  staffRole: { owner: "Ega", admin: "Administrator", manager: "Menejer", accountant: "Buxgalter", teacher: "O'qituvchi", viewer: "Ko'ruvchi" },
} as const;

/** Marks sample rows ("Namuna ma'lumot"). "Demo ma'lumotni tozalash" deletes only flagged rows. */
const DEMO: ColDef = { key: "demo", header: "Demo", width: 70, kind: "bool", help: "Namuna ma'lumot belgisi: 'Demo ma'lumotni tozalash' faqat shu belgili qatorlarni o'chiradi. Qo'lda o'zgartirmang" };

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
    { key: "qrCode", header: "QR kod", width: 190, kind: "text", plain: true, help: "Davomat QR kartasi kodi (nazoratly > QR davomat). Qo'lda o'zgartirmang: kartani almashtirish uchun menyudan foydalaning" },
    DEMO,
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
    { key: "schedule", header: "Jadval", width: 200, kind: "text", help: "Masalan: Du-Chor-Ju 18:00 yoki Du-Chor-Ju 18:00-19:30 (tugash vaqti yozilmasa dars 90 daqiqa). Kunlar: Du Se Chor Pay Ju Sha Yak. Taqvim: nazoratly > Jadval va xonalar" },
    { key: "status", header: "Holat", width: 100, kind: "enum", labels: L.groupStatus },
    { key: "billingMode", header: "Hisoblash turi", width: 120, kind: "enum", labels: L.billing, help: "Oylik: har oy hisob yaratiladi. Abonement: to'lov darslar sonini beradi (menyu: Abonement)" },
    { key: "packageLessons", header: "Abonement darslari", width: 120, kind: "int", help: "Bitta abonementdagi darslar soni (faqat Abonement guruhlari)" },
    { key: "packagePrice", header: "Abonement narxi (so'm)", width: 140, kind: "int", help: "Bitta abonement narxi (faqat Abonement guruhlari)" },
    { key: "capacity", header: "Sig'im (o'rinlar)", width: 110, kind: "int", help: "Guruhdagi eng ko'p o'quvchi (sinovdagilar ham sanaladi). Bo'sh = cheklanmagan. To'lsa: nazoratly > Navbat" },
    DEMO,
    { key: "roomId", header: "Xona ID", width: 90, kind: "text", help: "Guruh darslari o'tadigan xona (Xonalar varag'idan, masalan X0001). Bo'sh = xonasiz. Jadval: nazoratly > Jadval" },
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
    DEMO,
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
    DEMO,
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
    { key: "grossAmount", header: "Chegirmasiz summa", width: 130, kind: "int", help: "Doimiy chegirmalardan oldingi narx (avtomatik)" },
    { key: "earlyDiscount", header: "Erta to'lov chegirmasi", width: 130, kind: "int", help: "Muddatigacha to'lansa shuncha so'm kamayadi (avtomatik)" },
    { key: "earlyPayBy", header: "Erta to'lov muddati", width: 130, kind: "date", help: "Shu sanagacha (shu kun ham) to'langan pul chegirmani beradi" },
    DEMO,
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
    DEMO,
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
    DEMO,
    { key: "telegramChatId", header: "Telegram chat ID", width: 130, kind: "text", plain: true, optional: true, help: "Ustoz botga taklif kodi bilan ulanganda avtomatik yoziladi (nazoratly > Ustoz ilovasi > Ustozni taklif qilish). Qo'lda o'zgartirmang" },
    { key: "msgOff", header: "Vasiyga yozish o'chirilgan", width: 150, kind: "bool", optional: true, help: "Ha = bu ustoz bot orqali vasiylarga yoza olmaydi. Bo'sh/Yo'q = yoza oladi (kuniga limit bilan)" },
  ],
};

export const EXPENSES: TableDef = {
  sheet: "Xarajatlar",
  color: "#d93025",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik (X0001...) yoki bo'sh qoldiring" },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "category", header: "Turi", width: 170, kind: "enum", labels: L.expenseCategory, help: "O'qituvchi oyligi 'Oylik' varag'idan olinadi: bu yerga yozmang (ikki marta hisoblanadi)" },
    { key: "amount", header: "Summa", width: 120, kind: "int" },
    { key: "note", header: "Izoh", width: 260, kind: "text" },
    { key: "voided", header: "Bekor qilingan", width: 110, kind: "bool", help: "Xarajatni o'chirmang, 'Ha' qilib bekor qiling" },
    { key: "paidFrom", header: "Qayerdan to'langan", width: 130, kind: "enum", labels: L.paidFrom, help: "Naqd (kassa) yoki Bank: buxgalteriya yozuvi shunga qarab tushadi" },
    { key: "billId", header: "Ta'minotchi hisobi", width: 120, kind: "text", plain: true, help: "Ta'minotchi hisobidan avtomatik yaratilgan xarajat (H0001...): uni hisob orqali bekor qiling" },
    DEMO,
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
    DEMO,
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
    { key: "source", header: "Manba", width: 130, kind: "enum", labels: L.entSource, help: "Kredit qayerdan: sababli yo'qlik, tavsiya mukofoti yoki promo kod (avtomatik)" },
    { key: "note", header: "Izoh (kredit)", width: 200, kind: "text", plain: true, help: "Tavsiya: taklif qilingan o'quvchi. Promo: kod (avtomatik)" },
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

// ---- accounting (capability 4.6). LEDGER_TABLES are written ONLY by the script (protected sheets, hash chain). ----
export const JOURNAL: TableDef = {
  sheet: "Jurnal",
  color: "#202124",
  cols: [
    { key: "seq", header: "№", width: 70, kind: "int", help: "Qator raqami (1, 2, 3 ...): zanjirning bir bo'g'ini" },
    { key: "entryNo", header: "Yozuv №", width: 80, kind: "int", help: "Bir yozuvning qatorlari bir xil raqamga ega" },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "account", header: "Hisob", width: 80, kind: "text", plain: true },
    { key: "debit", header: "Debet", width: 120, kind: "int" },
    { key: "credit", header: "Kredit", width: 120, kind: "int" },
    { key: "sourceType", header: "Manba turi", width: 130, kind: "text", plain: true },
    { key: "sourceKey", header: "Manba ID", width: 130, kind: "text", plain: true },
    { key: "memo", header: "Izoh", width: 320, kind: "text", plain: true },
    { key: "prevHash", header: "Oldingi hash", width: 160, kind: "text", plain: true, help: "Oldingi qatorning hashi" },
    { key: "hash", header: "Hash", width: 160, kind: "text", plain: true, help: "SHA-256: oldingi hash + shu qator mazmuni. Biror qator o'zgartirilsa menyudagi 'Jurnalni tekshirish' birinchi buzilgan qatorni ko'rsatadi" },
  ],
};

export const PERIODS: TableDef = {
  sheet: "Davrlar",
  color: "#202124",
  cols: [
    { key: "month", header: "Oy", width: 90, kind: "text", plain: true, help: "yyyy-mm. Yopilgan oyga yozuv qo'shib bo'lmaydi" },
    { key: "lastSeq", header: "Oxirgi №", width: 90, kind: "int" },
    { key: "headHash", header: "Oxirgi hash", width: 160, kind: "text", plain: true },
    { key: "totalDebit", header: "Jami debet", width: 130, kind: "int" },
    { key: "totalCredit", header: "Jami kredit", width: 130, kind: "int" },
    { key: "periodHash", header: "Davr hashi", width: 160, kind: "text", plain: true },
    { key: "closedOn", header: "Yopilgan sana", width: 120, kind: "date" },
  ],
};

export const CHART_ACCOUNTS: TableDef = {
  sheet: "Hisob rejasi",
  color: "#5f6368",
  cols: [
    { key: "code", header: "Kod", width: 80, kind: "text", plain: true, help: "3-8 raqam. Kod va tur o'zgarmaydi" },
    { key: "name", header: "Nomi", width: 280, kind: "text" },
    { key: "type", header: "Turi", width: 120, kind: "enum", labels: L.accountType },
    { key: "active", header: "Faol", width: 80, kind: "bool", help: "Faol bo'lmagan hisobga yozuv qo'shib bo'lmaydi" },
  ],
};

export const CASH_ACCOUNTS: TableDef = {
  sheet: "Pul hisoblari",
  color: "#5f6368",
  cols: [
    { key: "code", header: "Hisob kodi", width: 100, kind: "text", plain: true, help: "Hisob rejasidagi aktiv hisob" },
    { key: "name", header: "Nomi", width: 240, kind: "text" },
    { key: "kind", header: "Turi", width: 100, kind: "enum", labels: L.cashKind },
  ],
};

export const STATEMENTS: TableDef = {
  sheet: "Ko'chirmalar",
  color: "#9334e6",
  cols: [
    { key: "id", header: "ID", width: 80, kind: "text", help: "Avtomatik (K0001...)" },
    { key: "accountCode", header: "Pul hisobi", width: 100, kind: "text", plain: true },
    { key: "from", header: "Davr boshi", width: 110, kind: "date" },
    { key: "to", header: "Davr oxiri", width: 110, kind: "date" },
    { key: "opening", header: "Boshlang'ich qoldiq", width: 140, kind: "int", signed: true },
    { key: "closing", header: "Oxirgi qoldiq", width: 140, kind: "int", signed: true },
    { key: "status", header: "Holat", width: 110, kind: "enum", labels: L.statementStatus, help: "Yopilgan ko'chirma o'zgarmaydi" },
  ],
};

export const STATEMENT_LINES: TableDef = {
  sheet: "Ko'chirma satrlari",
  color: "#9334e6",
  cols: [
    { key: "statementId", header: "Ko'chirma ID", width: 100, kind: "text" },
    { key: "no", header: "№", width: 60, kind: "int", help: "Ko'chirma ichida 1, 2, 3 ..." },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "description", header: "Izoh", width: 300, kind: "text", plain: true },
    { key: "amount", header: "Summa", width: 120, kind: "int", signed: true, help: "Kirim musbat, chiqim manfiy" },
    { key: "matchedSeq", header: "Jurnal №", width: 90, kind: "int", help: "Mos kelgan jurnal qatori (0 = moslanmagan). Menyu: Buxgalteriya > Ko'chirma" },
  ],
};

export const SUPPLIERS: TableDef = {
  sheet: "Ta'minotchilar",
  color: "#e37400",
  cols: [
    { key: "id", header: "ID", width: 80, kind: "text", help: "Avtomatik (V0001...)" },
    { key: "name", header: "Nomi", width: 240, kind: "text" },
    { key: "phone", header: "Telefon", width: 140, kind: "text", plain: true },
    { key: "note", header: "Izoh", width: 260, kind: "text", plain: true },
    { key: "active", header: "Faol", width: 80, kind: "bool" },
  ],
};

export const SUPPLIER_BILLS: TableDef = {
  sheet: "Ta'minotchi hisoblari",
  color: "#e37400",
  cols: [
    { key: "id", header: "ID", width: 80, kind: "text", help: "Avtomatik (H0001...): menyu Buxgalteriya > Ta'minotchi hisobi" },
    { key: "supplierId", header: "Ta'minotchi ID", width: 110, kind: "text" },
    { key: "number", header: "Hisob raqami", width: 120, kind: "text", plain: true },
    { key: "billDate", header: "Sana", width: 110, kind: "date" },
    { key: "dueDate", header: "To'lov muddati", width: 120, kind: "date" },
    { key: "category", header: "Turi", width: 170, kind: "enum", labels: L.expenseCategory },
    { key: "amount", header: "Summa", width: 120, kind: "int" },
    { key: "note", header: "Izoh", width: 240, kind: "text", plain: true },
    { key: "voided", header: "Bekor qilingan", width: 110, kind: "bool", help: "Hisobni menyu orqali bekor qiling (xarajat ham bekor bo'ladi)" },
  ],
};

export const BILL_PAYMENTS: TableDef = {
  sheet: "Ta'minotchi to'lovlari",
  color: "#e37400",
  cols: [
    { key: "id", header: "ID", width: 80, kind: "text", help: "Avtomatik (Q0001...)" },
    { key: "billId", header: "Hisob ID", width: 90, kind: "text" },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "amount", header: "Summa", width: 120, kind: "int" },
    { key: "paidFrom", header: "Qayerdan", width: 100, kind: "enum", labels: L.paidFrom },
    { key: "note", header: "Izoh", width: 240, kind: "text", plain: true },
    { key: "voided", header: "Bekor qilingan", width: 110, kind: "bool", help: "To'lovni menyu orqali bekor qiling" },
  ],
};

export const WAITLIST: TableDef = {
  sheet: "Navbat",
  color: "#188038",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik beriladi (W0001...)" },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "joinedOn", header: "Navbatga yozilgan sana", width: 140, kind: "date", help: "Navbat tartibi: sana, keyin qator tartibi" },
    { key: "status", header: "Holat", width: 130, kind: "enum", labels: L.waitStatus },
    { key: "note", header: "Izoh", width: 220, kind: "text" },
    DEMO,
  ],
};

export const ROOMS: TableDef = {
  sheet: "Xonalar",
  color: "#188038",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik beriladi (X0001...)" },
    { key: "name", header: "Xona nomi", width: 200, kind: "text" },
    { key: "capacity", header: "Sig'im (o'rinlar)", width: 120, kind: "int", help: "Xonaga sig'adigan o'quvchilar soni. Bo'sh = noma'lum (ogohlantirish berilmaydi)" },
  ],
};

export const SCHEDULE_CHANGES: TableDef = {
  sheet: "Dars o'zgarishlari",
  color: "#f9ab00",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik (J0001...). O'zgarishlar shu tartibda qo'llanadi: qatorlarni o'chirmang" },
    { key: "kind", header: "Turi", width: 110, kind: "enum", labels: L.changeKind },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "date", header: "Dars sanasi", width: 110, kind: "date", help: "O'zgartirilgan paytdagi dars sanasi" },
    { key: "start", header: "Dars boshlanishi", width: 110, kind: "text", plain: true, help: "SS:DD (masalan 18:00)" },
    { key: "newDate", header: "Yangi sana", width: 110, kind: "date", help: "Faqat ko'chirishda" },
    { key: "newStart", header: "Yangi boshlanish", width: 110, kind: "text", plain: true },
    { key: "newEnd", header: "Yangi tugash", width: 110, kind: "text", plain: true },
    { key: "newRoomId", header: "Yangi xona ID", width: 100, kind: "text", help: "Bo'sh = xona o'zgarmaydi" },
    { key: "substituteId", header: "O'rinbosar ID", width: 110, kind: "text", help: "O'rinbosar o'qituvchi (faqat 'O'rinbosar' turida). Bo'sh = o'rinbosarni olib tashlash" },
    { key: "reason", header: "Sabab", width: 220, kind: "text" },
    { key: "createdOn", header: "Yaratilgan", width: 110, kind: "date" },
    { key: "payEffect", header: "Oylik ta'siri", width: 260, kind: "text", help: "O'zgarish paytida hisoblangan: kim qancha yo'qotadi/oladi (faqat 'Dars uchun' to'lanadigan o'qituvchilar)" },
  ],
};

// ---- growth (G3): referrals, promo codes, source costs. Rewards and promo discounts are credits in ENTITLEMENTS. ----
export const REFERRALS: TableDef = {
  sheet: "Tavsiyalar",
  color: "#188038",
  cols: [
    { key: "id", header: "ID", width: 80, kind: "text", help: "Avtomatik (F0001...): menyu O'sish > Tavsiya qo'shish" },
    { key: "referrerId", header: "Taklif qilgan (o'quvchi ID)", width: 150, kind: "text" },
    { key: "invitedId", header: "Taklif qilingan (o'quvchi ID)", width: 160, kind: "text", help: "Bir o'quvchi faqat bir marta taklif qilinadi" },
    { key: "status", header: "Holat", width: 130, kind: "enum", labels: L.refStatus },
    { key: "rewardType", header: "Mukofot turi", width: 110, kind: "enum", labels: L.rewardType, help: "Taklif qilingan paytdagi qoida saqlanadi" },
    { key: "rewardValue", header: "Mukofot qiymati", width: 120, kind: "int", help: "Summa (so'm), foiz yoki bepul darslar soni" },
    { key: "condition", header: "Shart", width: 150, kind: "enum", labels: L.refCondition },
    { key: "minPaid", header: "Kamida to'langan", width: 120, kind: "int" },
    { key: "rewardAmount", header: "Mukofot (so'm)", width: 120, kind: "int", help: "Mukofot berilganda to'ladi" },
    { key: "invitedOn", header: "Taklif sanasi", width: 110, kind: "date" },
    { key: "rewardedOn", header: "Mukofot sanasi", width: 110, kind: "date" },
    { key: "note", header: "Izoh", width: 220, kind: "text" },
  ],
};

export const PROMOS: TableDef = {
  sheet: "Promo kodlar",
  color: "#188038",
  cols: [
    { key: "code", header: "Kod", width: 110, kind: "text", plain: true, help: "3-32 belgi: harf, raqam, - yoki _. Katta-kichik harf farqlanmaydi" },
    { key: "name", header: "Nomi", width: 220, kind: "text", help: "Masalan: Kuz aksiyasi, birinchi oy -50%" },
    { key: "kind", header: "Turi", width: 90, kind: "enum", labels: L.promoKind },
    { key: "value", header: "Qiymat", width: 100, kind: "int", help: "Foiz (1-100) yoki summa (so'm). Chegirma birinchi oylik hisobdan oshmaydi" },
    { key: "validFrom", header: "Boshlanishi", width: 110, kind: "date" },
    { key: "validTo", header: "Tugashi", width: 110, kind: "date", help: "Bo'sh = muddatsiz" },
    { key: "maxUses", header: "Eng ko'p ishlatish", width: 120, kind: "int", help: "0 = cheklanmagan" },
    { key: "active", header: "Faol", width: 80, kind: "bool" },
  ],
};

export const PROMO_USES: TableDef = {
  sheet: "Promo ishlatilishi",
  color: "#188038",
  cols: [
    { key: "code", header: "Kod", width: 110, kind: "text", plain: true },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "enrollmentId", header: "Yozilish ID", width: 100, kind: "text" },
    { key: "fee", header: "Oylik narx", width: 110, kind: "int" },
    { key: "amount", header: "Chegirma (kredit)", width: 130, kind: "int", help: "Keyingi oylik hisobdan ayiriladi (Qoplash huquqlari varag'ida kredit sifatida)" },
    { key: "usedOn", header: "Sana", width: 110, kind: "date" },
  ],
};

export const SOURCE_COSTS: TableDef = {
  sheet: "Manba xarajatlari",
  color: "#e37400",
  cols: [
    { key: "source", header: "Manba", width: 150, kind: "text", options: ["Instagram", "Telegram", "Tanish", "OLX", "Reklama", "Boshqa"], help: "Lead'lar varag'idagi Manba bilan bir xil yozing (katta-kichik harf farqlanmaydi)" },
    { key: "month", header: "Oy", width: 110, kind: "date", help: "Oyning birinchi kuni" },
    { key: "amount", header: "Xarajat (so'm)", width: 130, kind: "int" },
    { key: "note", header: "Izoh", width: 240, kind: "text" },
  ],
};



export const DISCOUNTS: TableDef = {
  sheet: "Chegirmalar",
  color: "#e37400",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik (D0001...)" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "enrollmentId", header: "Yozilish ID", width: 100, kind: "text", help: "Bo'sh = o'quvchining har bir oylik hisobiga" },
    { key: "kind", header: "Turi", width: 120, kind: "enum", labels: L.discountKind, help: "Individual: foiz yoki summa. Stipendiya: foiz (100 = to'liq bepul). Erta to'lov: foiz + muddat kuni" },
    { key: "percent", header: "Foiz %", width: 80, kind: "num", help: "0 = foiz emas. Foiz oylik narxdan (yozilish chegirmasidan keyin) hisoblanadi" },
    { key: "amount", header: "Summa", width: 100, kind: "int", help: "Faqat individual: BITTA hisobdan ayiriladigan so'm" },
    { key: "payByDay", header: "Muddat kuni", width: 100, kind: "int", help: "Faqat erta to'lov: oyning shu kunigacha (1-28)" },
    { key: "reason", header: "Sabab", width: 240, kind: "text", help: "Majburiy" },
    { key: "validFrom", header: "Boshlanishi", width: 110, kind: "date" },
    { key: "validTo", header: "Tugashi", width: 110, kind: "date", help: "Bo'sh = tugatilmaguncha. Tugatilgan qoidani uzaytirib bo'lmaydi: yangisini qo'shing" },
    DEMO,
  ],
};

export const DISCOUNT_LINES: TableDef = {
  sheet: "Chegirma qatorlari",
  color: "#e37400",
  cols: [
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "enrollmentId", header: "Yozilish ID", width: 100, kind: "text" },
    { key: "chargeId", header: "Hisob ID", width: 90, kind: "text", help: "Bo'sh = oy to'liq bepul edi (hisob yaratilmadi)" },
    { key: "month", header: "Oy", width: 100, kind: "date" },
    { key: "kind", header: "Turi", width: 120, kind: "enum", labels: L.discountLineKind },
    { key: "sourceId", header: "Qoida ID", width: 90, kind: "text", help: "Chegirmalar varag'idagi qoida (oilaviy chegirmada bo'sh)" },
    { key: "percent", header: "Foiz %", width: 80, kind: "num" },
    { key: "amount", header: "Summa", width: 100, kind: "int" },
    { key: "reason", header: "Sabab", width: 240, kind: "text" },
    DEMO,
  ],
};

export const REFUNDS: TableDef = {
  sheet: "Qaytarishlar",
  color: "#c5221f",
  cols: [
    { key: "id", header: "ID", width: 80, kind: "text", help: "Avtomatik (R0001...)" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "kind", header: "Turi", width: 160, kind: "enum", labels: L.refundKind },
    { key: "payout", header: "Qanday", width: 90, kind: "enum", labels: L.payout, help: "Naqd/Bank: pul chiqadi (jurnalga yoziladi). Kredit: pul o'quvchi kreditida qoladi (jurnalga yozilmaydi)" },
    { key: "amount", header: "Summa", width: 110, kind: "int" },
    { key: "chargeReduction", header: "Hisob kamaydi", width: 120, kind: "int", help: "Oylik hisob shuncha kamaygan" },
    { key: "chargeId", header: "Hisob ID", width: 90, kind: "text" },
    { key: "paymentId", header: "To'lov ID", width: 90, kind: "text" },
    { key: "packageId", header: "Abonement ID", width: 100, kind: "text" },
    { key: "leftOn", header: "Ketgan sana", width: 110, kind: "date" },
    { key: "reason", header: "Sabab", width: 240, kind: "text" },
    { key: "note", header: "Izoh", width: 200, kind: "text", plain: true },
    DEMO,
  ],
};

export const CASH_CLOSES: TableDef = {
  sheet: "Kassa smenalari",
  color: "#5f6368",
  cols: [
    { key: "id", header: "ID", width: 80, kind: "text", help: "Avtomatik (M0001...)" },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "shiftNo", header: "Smena №", width: 80, kind: "int" },
    { key: "counted", header: "Sanalgan naqd", width: 120, kind: "int", help: "Kassadagi haqiqiy naqd pul" },
    { key: "bookBalance", header: "Hisob bo'yicha", width: 120, kind: "int", signed: true, help: "Jurnal bo'yicha kassa qoldig'i shu sanagacha" },
    { key: "difference", header: "Farq", width: 100, kind: "int", signed: true, help: "Sanalgan - hisob bo'yicha" },
    { key: "note", header: "Izoh", width: 260, kind: "text", plain: true, help: "Farq bo'lsa majburiy" },
    { key: "journalSeq", header: "Jurnal №", width: 90, kind: "int", help: "Smena yopilganda jurnalning oxirgi qatori" },
    { key: "entryNo", header: "Farq yozuvi №", width: 110, kind: "int", help: "Farq jurnalga yozilgan bo'lsa shu yozuv raqami (0 = yozilmagan)" },
  ],
};


// ---- learning results (G4): teacher notes and grades, exams, monthly reports, certificates ----
export const MARKS: TableDef = {
  sheet: "Baholar",
  color: "#f9ab00",
  cols: [
    { key: "scope", header: "Turi", width: 90, kind: "enum", labels: { lesson: "Dars", month: "Oy" }, help: "Dars: bitta dars uchun. Oy: butun oy uchun (sana ustuniga oyning 1-kuni yoziladi)" },
    { key: "date", header: "Sana", width: 110, kind: "date", help: "Dars sanasi yoki oyning birinchi kuni" },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "grade", header: "Baho (1-5)", width: 90, kind: "int", help: "1 dan 5 gacha butun son; bo'sh = baho yo'q (faqat izoh)" },
    { key: "note", header: "Izoh", width: 320, kind: "text", plain: true, help: "O'qituvchi izohi (1000 belgigacha). Hisobotda chiqadi" },
    { key: "updatedOn", header: "Yangilangan", width: 110, kind: "date" },
  ],
};

export const EXAMS: TableDef = {
  sheet: "Imtihonlar",
  color: "#f9ab00",
  cols: [
    { key: "id", header: "ID", width: 80, kind: "text", help: "Avtomatik beriladi (X0001...)" },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "title", header: "Nomi", width: 220, kind: "text", plain: true },
    { key: "heldOn", header: "Sana", width: 110, kind: "date" },
    { key: "maxScore", header: "Eng yuqori ball", width: 110, kind: "int", help: "Butun son, 0 dan katta" },
  ],
};

export const EXAM_RESULTS: TableDef = {
  sheet: "Imtihon natijalari",
  color: "#f9ab00",
  cols: [
    { key: "examId", header: "Imtihon ID", width: 100, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "score", header: "Ball", width: 80, kind: "int", help: "Butun son, 0 dan imtihonning eng yuqori balligacha" },
    { key: "note", header: "Izoh", width: 260, kind: "text", plain: true },
  ],
};

export const REPORTS: TableDef = {
  sheet: "Oylik hisobotlar",
  color: "#f9ab00",
  cols: [
    { key: "id", header: "ID", width: 80, kind: "text", help: "Avtomatik beriladi (R0001...)" },
    { key: "month", header: "Oy", width: 100, kind: "date", help: "Oyning birinchi kuni" },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "status", header: "Holat", width: 120, kind: "enum", labels: { draft: "Qoralama", approved: "Tasdiqlangan" }, help: "Qoralama vasiyga yuborilmaydi. Tasdiqlash va yuborish: nazoratly > Natijalar menyusi" },
    { key: "percent", header: "Davomat %", width: 100, kind: "text", plain: true, help: "Hisobot yaratilgan paytdagi davomat foizi; bo'sh = ma'lumot yo'q" },
    { key: "average", header: "O'rtacha baho", width: 110, kind: "text", plain: true },
    { key: "link", header: "PDF havolasi", width: 300, kind: "text", help: "Google Drive dagi PDF fayl" },
    { key: "generatedOn", header: "Yaratilgan", width: 110, kind: "date" },
    { key: "approvedOn", header: "Tasdiqlangan sana", width: 130, kind: "date", help: "Tasdiqlangandan keyin hisobot o'zgarmaydi" },
  ],
};

export const CERTIFICATES: TableDef = {
  sheet: "Sertifikatlar",
  color: "#f9ab00",
  cols: [
    { key: "number", header: "Raqam", width: 130, kind: "text", plain: true, help: "SR-yyyy-000001" },
    { key: "code", header: "Tekshirish kodi", width: 170, kind: "text", plain: true, help: "NZC-XXXX-XXXX-XXXX: sertifikatda bosilgan kod. Qo'lda o'zgartirmang" },
    { key: "enrollmentId", header: "Yozilish ID", width: 100, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "courseName", header: "Kurs", width: 200, kind: "text", plain: true },
    { key: "studentName", header: "O'quvchi ismi", width: 220, kind: "text", plain: true, help: "Sertifikat berilgan paytdagi ism (o'zgarmaydi)" },
    { key: "issuedOn", header: "Berilgan sana", width: 110, kind: "date" },
    { key: "completedOn", header: "Tugatgan sana", width: 110, kind: "date" },
    { key: "link", header: "PDF havolasi", width: 300, kind: "text" },
    { key: "voided", header: "Bekor qilingan", width: 110, kind: "bool", help: "Sertifikatni menyu orqali bekor qiling (sabab bilan)" },
    { key: "voidReason", header: "Bekor sababi", width: 220, kind: "text", plain: true },
    { key: "sentOn", header: "Vasiyga yuborilgan", width: 130, kind: "date" },
  ],
};

export const TEACHER_INVITES: TableDef = {
  sheet: "Ustoz taklifnomalari",
  color: "#9334e6",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text" },
    { key: "teacherId", header: "O'qituvchi ID", width: 110, kind: "text" },
    { key: "codeHash", header: "Kod (SHA-256)", width: 220, kind: "text", plain: true, help: "Kodning o'zi saqlanmaydi, faqat izi. Kod egasiga bir marta ko'rsatiladi" },
    { key: "status", header: "Holat", width: 110, kind: "enum", labels: { pending: "Kutilmoqda", used: "Ishlatilgan", revoked: "Bekor" } },
    { key: "expiresAt", header: "Muddati (yyyy-mm-ddThh:mm)", width: 170, kind: "text", plain: true },
    { key: "createdOn", header: "Yaratilgan", width: 110, kind: "date" },
    { key: "usedOn", header: "Ishlatilgan", width: 110, kind: "date" },
  ],
};

export const TEACHER_MESSAGES: TableDef = {
  sheet: "Ustoz xabarlari",
  color: "#9334e6",
  cols: [
    { key: "at", header: "Vaqt", width: 150, kind: "text", plain: true },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "teacherId", header: "O'qituvchi ID", width: 110, kind: "text" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "groupId", header: "Guruh ID", width: 90, kind: "text" },
    { key: "template", header: "Shablon", width: 100, kind: "text", plain: true, help: "Bo'sh = erkin matn" },
    { key: "body", header: "Matn", width: 380, kind: "text", plain: true, help: "Vasiyga yuborilgan matn. Jurnal: o'qituvchi uni o'zgartira yoki o'chira olmaydi (ustozlar varaqqa kirmaydi, faqat bot orqali ishlaydi)" },
  ],
};

export const TEACHER_NOTICES: TableDef = {
  sheet: "Ustoz eslatmalari",
  color: "#9334e6",
  cols: [
    { key: "key", header: "Kalit", width: 240, kind: "text", plain: true, help: "lesson:<dars> yoki digest:<sana>: bir eslatma ikki marta yuborilmasligi uchun" },
    { key: "kind", header: "Turi", width: 130, kind: "enum", labels: { lesson: "Ustozga eslatma", digest: "Egaga kun yakuni" } },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "text", header: "Matn", width: 380, kind: "text", plain: true },
  ],
};

export const LEDGER_TABLES: TableDef[] = [JOURNAL, PERIODS, CHART_ACCOUNTS, CASH_ACCOUNTS, REFUNDS, CASH_CLOSES];
// ---- branches (G6): one center, one books, a branch mark on every row ---------------------------------------------------
export const BRANCHES: TableDef = {
  sheet: "Filiallar",
  color: "#00796b",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text", help: "Avtomatik (F01...)" },
    { key: "name", header: "Filial nomi", width: 220, kind: "text" },
    { key: "address", header: "Manzil", width: 260, kind: "text" },
    { key: "status", header: "Holat", width: 100, kind: "enum", labels: L.branchStatus },
    { key: "isDefault", header: "Asosiy", width: 90, kind: "bool", help: "Filial tanlanmagan yozuvlar shu filialga tushadi. Faqat bittasi 'Ha' bo'ladi (nazoratly > Filiallar > Asosiy filialni almashtirish)" },
  ],
};

export const STAFF: TableDef = {
  sheet: "Xodimlar",
  color: "#00796b",
  cols: [
    { key: "email", header: "Email", width: 240, kind: "text", plain: true, help: "Xodimning Google emaili" },
    { key: "role", header: "Rol", width: 130, kind: "enum", labels: L.staffRole },
    { key: "branchId", header: "Filial ID", width: 100, kind: "text", help: "Bo'sh = butun markaz (egasi). To'ldirilsa xodim menyuda va hisobotlarda faqat shu filialni ko'radi va faqat shu filialga yozadi" },
  ],
};

export const BRANCH_PRICES: TableDef = {
  sheet: "Filial narxlari",
  color: "#00796b",
  cols: [
    { key: "branchId", header: "Filial ID", width: 100, kind: "text" },
    { key: "course", header: "Kurs (guruh nomi)", width: 240, kind: "text", help: "Guruh nomi shu so'z bilan boshlansa shu narx taklif qilinadi" },
    { key: "monthlyFee", header: "Oylik narx (so'm)", width: 140, kind: "int" },
  ],
};

export const BRANCH_SETTINGS: TableDef = {
  sheet: "Filial sozlamalari",
  color: "#00796b",
  cols: [
    { key: "branchId", header: "Filial ID", width: 100, kind: "text" },
    { key: "label", header: "Sozlama", width: 300, kind: "text", help: "Sozlamalar varag'idagi nom bilan bir xil. Shu filial uchun markaz qiymati o'rniga ishlaydi" },
    { key: "value", header: "Qiymat", width: 220, kind: "text", plain: true },
  ],
};

export const BRANCH_MOVES: TableDef = {
  sheet: "Filial ko'chirishlar",
  color: "#00796b",
  cols: [
    { key: "id", header: "ID", width: 70, kind: "text" },
    { key: "date", header: "Sana", width: 110, kind: "date" },
    { key: "studentId", header: "O'quvchi ID", width: 100, kind: "text" },
    { key: "fromBranchId", header: "Qaysi filialdan", width: 110, kind: "text" },
    { key: "toBranchId", header: "Qaysi filialga", width: 110, kind: "text" },
    { key: "endedEnrollments", header: "Tugatilgan yozilishlar", width: 140, kind: "int" },
    { key: "reason", header: "Sabab", width: 260, kind: "text" },
  ],
};

export const BRANCH_COL: ColDef = {
  key: "branchId",
  header: "Filial",
  width: 80,
  kind: "text",
  plain: true,
  optional: true,
  help: "Qator qaysi filialga tegishli (avtomatik). Bo'sh = asosiy filial. Qo'lda o'zgartirmang: o'quvchini nazoratly > Filiallar > Filialga ko'chirish bilan o'tkazing",
};

/** Tables whose rows carry a branch mark: the same decisions as the strict tables of db/migrations/0050 (the catalog). */
export const BRANCH_MARKED: TableDef[] = [STUDENTS, GROUPS, ENROLLMENTS, ATTENDANCE, CHARGES, PAYMENTS, TEACHERS, PAYROLL, DRAFTS, LEADS, LEAD_LOG, ENTITLEMENTS, INSTALLMENTS, PACKAGES, DOCUMENTS, JOURNAL, SUPPLIER_BILLS, BILL_PAYMENTS, WAITLIST, ROOMS, SCHEDULE_CHANGES, REFERRALS, PROMO_USES, SOURCE_COSTS, DISCOUNTS, DISCOUNT_LINES, REFUNDS, CASH_CLOSES, MARKS, EXAMS, EXAM_RESULTS, REPORTS, CERTIFICATES, EXPENSES];
for (const t of BRANCH_MARKED) if (!t.cols.some((c) => c.key === "branchId")) t.cols.push(BRANCH_COL);
export const BRANCH_TABLES: TableDef[] = [BRANCHES, STAFF, BRANCH_PRICES, BRANCH_SETTINGS, BRANCH_MOVES];

export const ALL_TABLES: TableDef[] = [STUDENTS, GROUPS, ENROLLMENTS, ATTENDANCE, CHARGES, PAYMENTS, TEACHERS, PAYROLL, DRAFTS, LEADS, LEAD_LOG, ENTITLEMENTS, PACKAGES, INSTALLMENTS, DOCUMENTS, EXPENSES, WAITLIST, ...LEDGER_TABLES, STATEMENTS, STATEMENT_LINES, SUPPLIERS, SUPPLIER_BILLS, BILL_PAYMENTS, DISCOUNTS, DISCOUNT_LINES, ROOMS, SCHEDULE_CHANGES, REFERRALS, PROMOS, PROMO_USES, SOURCE_COSTS, MARKS, EXAMS, EXAM_RESULTS, REPORTS, CERTIFICATES, ...BRANCH_TABLES, TEACHER_INVITES, TEACHER_MESSAGES, TEACHER_NOTICES];

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
  { key: "dashboardWindowDays", label: "Panelda yaqinlashayotgan muddat oynasi (kun)", value: "7", help: "Boshqaruv panelida shuncha kun ichida tugaydigan abonement va qoplash huquqlari 'qaror kutayotganlar' ga chiqadi (1-60)" },
  { key: "installmentRemindDays", label: "Qism haqida oldindan eslatma (kun)", value: "3", help: "To'lov qismi muddatiga shuncha kun qolganda eslatma loyihasi yaratiladi (0 = o'chirilgan)" },
  { key: "requisites", label: "Markaz rekvizitlari (hujjatlarda)", value: "", help: "Manzil, telefon, hisob raqami... Kvitansiya va to'lov hisobida markaz nomi ostida chiqadi. Hujjat ichki hujjat: fiskal chek emas" },
  { key: "payInfo", label: "To'lov rekvizitlari", value: "", help: "Karta raqami yoki hisob. Xabardagi 'Nusxalash' tugmasi shuni nusxalaydi (bo'sh = tugma yo'q)" },
  { key: "ledgerEditors", label: "Jurnalga yozishi mumkin bo'lgan emaillar", value: "", help: "Vergul bilan. Jurnal, Davrlar, Hisob rejasi va Pul hisoblari varaqlari himoyalangan: faqat egasi (skript) va shu emaillar yoza oladi. Bo'sh = faqat ega. Varaq egasi himoyani olib tashlashi mumkin; hash zanjiri o'zgartirishni aniqlaydi, lekin to'sa olmaydi" },
  { key: "referralActive", label: "Tavsiya dasturi yoqilgan", value: "Yo'q", help: "Ha / Yo'q. Yoqilmaguncha yangi tavsiya qo'shib bo'lmaydi" },
  { key: "referralRewardType", label: "Tavsiya mukofoti turi", value: "Summa", help: "Summa = qat'iy so'm, Foiz = taklif qilganning oylik narxidan foiz, Bepul dars = shuncha darsning narxi" },
  { key: "referralRewardValue", label: "Tavsiya mukofoti qiymati", value: "0", help: "Summa (so'm), foiz (1-1000) yoki bepul darslar soni (1-100). 0 = belgilanmagan" },
  { key: "referralCondition", label: "Tavsiya sharti", value: "To'lagandan keyin", help: "To'lagandan keyin = taklif qilingan o'quvchi to'lov qilganda, Yozilgandan keyin = faol yozilishga o'tganda" },
  { key: "referralMinPaid", label: "Tavsiya: kamida to'langan (so'm)", value: "0", help: "Faqat 'To'lagandan keyin' sharti uchun: taklif qilingan o'quvchi jami shuncha to'lashi kerak (0 = istalgan to'lov)" },
  { key: "leadReminderDays", label: "Lead eslatmasi: jim kunlar", value: "3", help: "Yangi/aloqada/sinovga yozilgan lead bilan shuncha kun aloqa bo'lmasa 'Lead eslatmalari' ro'yxatiga tushadi (1-60). Lead'ga hech narsa yuborilmaydi: bu faqat xodim uchun ro'yxat" },

  { key: "familySecond", label: "Oilaviy chegirma: 2-farzand (%)", value: "0", help: "Bir vasiyning (Vasiy ismi bir xil) ikkinchi farzandi uchun foiz. 0 = o'chirilgan" },
  { key: "familyThird", label: "Oilaviy chegirma: 3-farzand va keyingilar (%)", value: "0", help: "Uchinchi va undan keyingi farzandlar uchun foiz. 0 = o'chirilgan. Birinchi farzand to'liq narxda to'laydi" },
  { key: "teacherReminderHours", label: "Ustoz eslatmasi: davomat belgilanmasa (soat)", value: "2", help: "Dars tugaganidan shuncha soat o'tib davomat belgilanmagan bo'lsa ustozga ichki eslatma boradi (0-48). Vasiylarga hech narsa yuborilmaydi" },
  { key: "teacherDigestAfter", label: "Egaga kun yakuni ro'yxati: soat", value: "20:00", help: "Shu vaqtdan keyin bugungi davomat belgilanmagan darslar ro'yxati egaga (yuqoridagi chat ID) bir marta yuboriladi (HH:MM)" },
  { key: "teacherDailyLimit", label: "Ustoz: vasiyga kunlik xabar limiti", value: "20", help: "Bitta ustoz kuniga nechta vasiyga bot orqali yoza oladi (0-500). Ustozga yozish huquqini o'chirish: O'qituvchilar varag'ida 'Vasiyga yozish o'chirilgan'" },
  { key: "ownerChatId", label: "Egasining Telegram chat ID si", value: "", help: "Vasiy 'To'lov qildim' bossa shu yerga xabar keladi (botga /start yozib, @userinfobot dan ID ni oling)" },
];
