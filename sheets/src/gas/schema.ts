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
  plain?: boolean; // stored as plain text (codes, hashes, free text): never turned into a number or a formula
  signed?: boolean; // an int column that may be negative
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

export const LEDGER_TABLES: TableDef[] = [JOURNAL, PERIODS, CHART_ACCOUNTS, CASH_ACCOUNTS];
export const ALL_TABLES: TableDef[] = [STUDENTS, GROUPS, ENROLLMENTS, ATTENDANCE, CHARGES, PAYMENTS, TEACHERS, PAYROLL, DRAFTS, LEADS, LEAD_LOG, ENTITLEMENTS, PACKAGES, INSTALLMENTS, DOCUMENTS, EXPENSES, WAITLIST, ...LEDGER_TABLES, STATEMENTS, STATEMENT_LINES, SUPPLIERS, SUPPLIER_BILLS, BILL_PAYMENTS, ROOMS, SCHEDULE_CHANGES];

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
  { key: "ownerChatId", label: "Egasining Telegram chat ID si", value: "", help: "Vasiy 'To'lov qildim' bossa shu yerga xabar keladi (botga /start yozib, @userinfobot dan ID ni oling)" },
];
