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
  enrollStatus: { active: "Faol", frozen: "Muzlatilgan", finished: "Tugagan" },
  attendance: { present: "Keldi", absent: "Kelmadi", late: "Kechikdi", excused: "Sababli" },
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
    { key: "status", header: "Holat", width: 110, kind: "enum", labels: L.enrollStatus },
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

export const ALL_TABLES: TableDef[] = [STUDENTS, GROUPS, ENROLLMENTS, ATTENDANCE, CHARGES, PAYMENTS, TEACHERS, PAYROLL, DRAFTS];

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
  { key: "payInfo", label: "To'lov rekvizitlari", value: "", help: "Karta raqami yoki hisob. Xabardagi 'Nusxalash' tugmasi shuni nusxalaydi (bo'sh = tugma yo'q)" },
  { key: "ownerChatId", label: "Egasining Telegram chat ID si", value: "", help: "Vasiy 'To'lov qildim' bossa shu yerga xabar keladi (botga /start yozib, @userinfobot dan ID ni oling)" },
];
