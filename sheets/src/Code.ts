/** Apps Script entry point: every function Google calls (menu, web app, sidebars) is exposed on globalThis. */
import * as actions from "./gas/actions";
import * as admission from "./gas/admission";
import * as branches from "./gas/branches";
import * as demo from "./gas/demo";
import * as documents from "./gas/documents";
import * as growth from "./gas/growth";
import * as importer from "./gas/importer";
import * as insights from "./gas/insights";
import * as qr from "./gas/qr";
import * as results from "./gas/results";
import * as waitlist from "./gas/waitlist";
import * as ledger from "./gas/ledger";
import * as makeup from "./gas/makeup";
import * as money from "./gas/money";
import * as packages from "./gas/packages";
import * as payables from "./gas/payables";
import * as plans from "./gas/plans";
import * as reconcile from "./gas/reconcile";
import * as schedule from "./gas/schedule";
import * as teacher from "./gas/teacher";
import { setupWorkbook, loadSampleData, resetSampleData } from "./gas/setup";
import { handleGet, handlePost } from "./gas/webhook";

// Collected here and exposed to Apps Script as top-level function declarations by build.mjs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (...args: any[]) => unknown> = {};
const g = handlers;

function html(file: string, title: string, w: number, h: number): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutputFromFile(file).setTitle(title).setWidth(w).setHeight(h);
}

g.onOpen = (): void => {
  SpreadsheetApp.getUi()
    .createMenu("nazoratly")
    .addItem("Davomat belgilash", "openAttendance")
    .addItem("To'lov qabul qilish", "openPayment")
    .addSeparator()
    .addItem("Oylik hisoblarni yaratish", "menuGenerateCharges")
    .addItem("Qarzdorlar hisoboti", "menuDebtors")
    .addItem("Boshqaruv panelini yangilash", "menuDashboard")
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Hisobotlar (qoidalar bo'yicha)")
        .addItem("Haftalik xulosa", "menuInsightWeekly")
        .addItem("Qarz bo'yicha maslahat va qoralamalar", "menuInsightDebt")
        .addItem("Ketish xavfi ro'yxati", "menuInsightRisk"),
    )
    .addSeparator()
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Qabul (sinov, lead)")
        .addItem("Qaror kutayotgan sinovlar", "menuPendingTrials")
        .addItem("Sinovni qabul qilish", "menuAcceptTrial")
        .addItem("Sinovni bekor qilish", "menuDropTrial")
        .addSeparator()
        .addItem("Lead'ni sinovga yozish", "menuLeadToTrial")
        .addItem("Voronka hisoboti", "menuFunnel"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("O'sish (tavsiya, promo, manba)")
        .addItem("Tavsiya qo'shish", "menuReferralAdd")
        .addItem("Tavsiya mukofotlarini hisoblash", "menuReferralBook")
        .addItem("Tavsiyani bekor qilish", "menuReferralCancel")
        .addSeparator()
        .addItem("Promo kodni qo'llash", "menuPromoRedeem")
        .addItem("Marketing chegirmalari hisoboti", "menuGrowthCredits")
        .addSeparator()
        .addItem("Manba xarajatini kiritish", "menuSourceCost")
        .addItem("Manba ROI hisoboti", "menuSourceRoi")
        .addItem("Lead eslatmalari (ichki ro'yxat)", "menuLeadReminders"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Qoplash (sababli yo'qlik)")
        .addItem("Huquqlarni ko'rish", "menuEntitlements")
        .addItem("Qoplash darsini rejalash", "menuScheduleMakeup")
        .addItem("Huquqni bekor qilish", "menuCancelEntitlement"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Abonement (dars paketi)")
        .addItem("Abonement sotish", "menuPackageSell")
        .addItem("Abonement holati / to'lov kerak", "menuPackageStatus")
        .addItem("Muddatni uzaytirish", "menuPackageExtend")
        .addItem("To'lov eslatma loyihalarini yaratish", "menuPackageDrafts")
        .addItem("Abonementlarni tekshirish", "menuPackageCheck"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Pul qoidalari (chegirma, qaytarish, kassa)")
        .addItem("Chegirma qo'shish", "menuDiscountAdd")
        .addItem("Chegirmani tugatish", "menuDiscountEnd")
        .addItem("Chegirmalar hisoboti", "menuDiscountReport")
        .addSeparator()
        .addItem("Qaytarish (pulni qaytarish, kreditga o'tkazish)", "menuRefund")
        .addSeparator()
        .addItem("Kassani yopish (smena)", "menuCashClose")
        .addItem("Kassa holati", "menuCashStatus"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Navbat (guruh sig'imi)")
        .addItem("Navbatga yozish", "menuWaitAdd")
        .addItem("Navbat va bo'sh o'rinlar", "menuWaitView")
        .addItem("Navbatdagini guruhga yozish", "menuWaitEnroll")
        .addItem("Navbatdan olib tashlash", "menuWaitRemove")
        .addItem("Bo'sh o'rin xabarlarini yaratish", "menuWaitDrafts")
        .addItem("Sig'imni tekshirish", "menuWaitCheck"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Jadval va xonalar")
        .addItem("Haftalik taqvim", "menuCalWeek")
        .addItem("Kunlik taqvim", "menuCalDay")
        .addItem("Xona qo'shish", "menuRoomAdd")
        .addItem("Jadvalni tekshirish (to'qnashuv, sig'im)", "menuScheduleCheck")
        .addItem("Darsni ko'chirish", "menuLessonMove")
        .addItem("Darsni bekor qilish", "menuLessonCancel")
        .addItem("O'rinbosar o'qituvchi", "menuLessonSubstitute"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Filiallar")
        .addItem("Filiallar ro'yxati", "menuBranchList")
        .addItem("Filial hisoboti (har bir filial va jami)", "menuBranchReport")
        .addItem("Filialni tanlash (ko'rinish)", "menuBranchChoose")
        .addSeparator()
        .addItem("O'quvchini filialga ko'chirish", "menuBranchTransfer")
        .addItem("Filial qo'shish", "menuBranchAdd")
        .addItem("Filialni yopish", "menuBranchClose")
        .addItem("Filialni qayta ochish", "menuBranchReopen")
        .addItem("Asosiy filialni almashtirish", "menuBranchDefault")
        .addSeparator()
        .addItem("Xodimni filialga biriktirish", "menuBranchStaff")
        .addItem("Filial narxi (kurs)", "menuBranchPrice")
        .addItem("Guruh narxini filial narxidan olish", "menuBranchApplyPrice")
        .addItem("Filial sozlamasi", "menuBranchSetting"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("QR davomat")
        .addItem("QR skaner (davomat)", "openQrScan")
        .addItem("Guruh uchun QR kartalar (PDF)", "menuQrCards")
        .addItem("QR kartani vasiyga yuborish", "menuQrSend")
        .addItem("QR kartani almashtirish (yo'qolgan)", "menuQrRotate")
        .addItem("Hamma o'quvchiga QR kod berish", "menuQrIssue"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("To'lov rejasi (qismlarga bo'lish)")
        .addItem("Reja tuzish", "menuPlanCreate")
        .addItem("Qismlar holati", "menuPlanView")
        .addItem("Rejani olib tashlash", "menuPlanRemove")
        .addItem("Rejalarni tekshirish", "menuPlanCheck"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Ustoz ilovasi")
        .addItem("Ustozni taklif qilish (kod)", "menuTeacherInvite")
        .addItem("Davomat belgilanmagan darslar", "menuTeacherUnmarked")
        .addItem("Ustoz eslatmalarini hozir yuborish", "menuTeacherRemind")
        .addItem("Ustozning vasiyga yozish huquqini almashtirish", "menuTeacherMessaging")
        .addSeparator()
        .addItem("Avto-eslatmani yoqish (har soat)", "menuTeacherTriggerOn")
        .addItem("Avto-eslatmani o'chirish", "menuTeacherTriggerOff"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Natijalar (baho, imtihon, hisobot, sertifikat)")
        .addItem("Baho / izoh qo'yish", "menuMarkSet")
        .addItem("Bahoni olib tashlash", "menuMarkRemove")
        .addSeparator()
        .addItem("Imtihon qo'shish", "menuExamAdd")
        .addItem("Imtihon natijasini kiritish", "menuExamScore")
        .addItem("Imtihon natijalarini ko'rish", "menuExamView")
        .addSeparator()
        .addItem("Oylik hisobot yaratish (o'quvchi)", "menuReportMake")
        .addItem("Guruh uchun hisobotlar yaratish", "menuReportGroup")
        .addItem("Hisobotni tasdiqlab vasiyga yuborish", "menuReportSend")
        .addSeparator()
        .addItem("Sertifikat berish", "menuCertIssue")
        .addItem("Sertifikatni bekor qilish", "menuCertVoid")
        .addItem("Sertifikatni vasiyga yuborish", "menuCertSend")
        .addItem("Sertifikatni tekshirish (kod)", "menuCertVerify"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Hujjatlar (kvitansiya, to'lov hisobi)")
        .addItem("Kvitansiya yaratish (to'lov)", "menuDocReceipt")
        .addItem("To'lov hisobi yaratish (o'quvchi)", "menuDocInvoice")
        .addItem("Hujjatni vasiyga yuborish", "menuDocSend"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Telegram eslatmalar")
        .addItem("Eslatma loyihalarini yaratish", "menuCreateDrafts")
        .addItem("Eslatmalarni ko'rib chiqish", "openDrafts")
        .addItem("Tasdiqlanganlarni yuborish", "menuSendApproved")
        .addSeparator()
        .addItem("Telegram sozlash", "menuSetupTelegram")
        .addItem("Webhook relay sozlamalari", "menuWebhookInfo")
        .addItem("Vasiylar uchun ulash havolalari", "menuLinkCodes"),
    )
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu("Buxgalteriya")
        .addItem("Kutayotganlarni jurnalga o'tkazish", "menuLedgerSync")
        .addItem("Jurnalni tekshirish (hash zanjiri)", "menuLedgerVerify")
        .addItem("Qo'lda yozuv", "menuLedgerManual")
        .addItem("Teskari yozuv (xatoni tuzatish)", "menuLedgerReverse")
        .addItem("Davrni yopish", "menuLedgerClose")
        .addSeparator()
        .addItem("Sinov balansi", "menuReportTrial")
        .addItem("Foyda va zarar", "menuReportIncome")
        .addItem("Balans", "menuReportBalance")
        .addItem("Hisob kartochkasi", "menuReportLedger")
        .addSeparator()
        .addItem("Hisob qo'shish", "menuAccountAdd")
        .addItem("Pul hisobi qo'shish (kassa, bank)", "menuCashAdd")
        .addItem("Jurnal varaqlarini himoyalash", "menuLedgerProtect")
        .addSeparator()
        .addItem("Ta'minotchi qo'shish", "menuSupplierAdd")
        .addItem("Ta'minotchi hisobi kiritish", "menuBillAdd")
        .addItem("Ta'minotchiga to'lov", "menuBillPay")
        .addItem("To'lovni bekor qilish", "menuBillPayVoid")
        .addItem("Hisobni bekor qilish", "menuBillVoid")
        .addItem("Qarz yoshi (ta'minotchilar)", "menuAging")
        .addSeparator()
        .addItem("Ko'chirma ochish", "menuStatementCreate")
        .addItem("Ko'chirmani avtomatik moslash", "menuStatementAuto")
        .addItem("Ko'chirma holati (solishtirish)", "menuStatementStatus")
        .addItem("Qatorni qo'lda moslash", "menuStatementMatch")
        .addItem("Moslashni bekor qilish", "menuStatementUnmatch")
        .addItem("Ko'chirmani yopish", "menuStatementFinalize"),
    )
    .addItem("O'qituvchi oyligini hisoblash", "menuPayroll")
    .addSeparator()
    .addItem("Boshlang'ich sozlash", "menuSetup")
    .addItem("Namuna ma'lumot yuklash", "menuSample")
    .addItem("Namuna ma'lumotni yangilash", "menuSampleReset")
    .addItem("Demo ma'lumotni tozalash", "menuDemoClear")
    .addItem("Import (o'quvchi, guruh, lead)", "openImport")
    .addItem("Yordam", "menuHelp")
    .addToUi();
};

g.openAttendance = (): void => SpreadsheetApp.getUi().showSidebar(html("Attendance", "Davomat", 380, 600));
g.openDrafts = (): void => SpreadsheetApp.getUi().showSidebar(html("Drafts", "Eslatmalar", 420, 600));
g.openQrScan = (): void => SpreadsheetApp.getUi().showSidebar(html("QRScan", "QR davomat", 400, 640));
g.openImport = importer.menu.open;
g.openPayment = (): void => SpreadsheetApp.getUi().showModalDialog(html("Payment", "To'lov qabul qilish", 460, 560), "To'lov qabul qilish");

g.menuGenerateCharges = (): void => actions.guard("Oylik hisoblar", actions.generateMonthlyCharges);
g.menuDebtors = (): void => actions.guard("Qarzdorlar", actions.refreshDebtors);
g.menuDashboard = (): void => actions.guard("Boshqaruv paneli", actions.refreshDashboard);
g.menuInsightWeekly = (): void => actions.guard("Haftalik xulosa", insights.menu.weekly);
g.menuInsightDebt = (): void => actions.guard("Qarz bo'yicha maslahat", insights.menu.debt);
g.menuInsightRisk = (): void => actions.guard("Ketish xavfi", insights.menu.risk);
g.menuCreateDrafts = (): void => actions.guard("Eslatmalar", actions.createReminderDrafts);
g.menuSendApproved = (): void => actions.guard("Telegram", actions.sendApprovedReminders);
g.menuSetupTelegram = (): void => actions.guard("Telegram", actions.setupTelegram);
g.menuLinkCodes = (): void => actions.guard("Ulash havolalari", actions.generateLinkCodes);
g.menuPendingTrials = admission.menu.pending;
g.menuAcceptTrial = admission.menu.accept;
g.menuDropTrial = admission.menu.drop;
g.menuLeadToTrial = admission.menu.leadToTrial;
g.menuFunnel = admission.menu.funnel;
g.menuReferralAdd = growth.menu.addReferral;
g.menuReferralBook = growth.menu.book;
g.menuReferralCancel = growth.menu.cancelReferral;
g.menuPromoRedeem = growth.menu.redeem;
g.menuGrowthCredits = growth.menu.credits;
g.menuSourceCost = growth.menu.cost;
g.menuSourceRoi = growth.menu.roi;
g.menuLeadReminders = growth.menu.reminders;

g.menuDiscountAdd = money.menu.addDiscount;
g.menuDiscountEnd = money.menu.endDiscount;
g.menuDiscountReport = money.menu.discountReport;
g.menuRefund = money.menu.refund;
g.menuBranchList = branches.menu.list;
g.menuBranchReport = branches.menu.report;
g.menuBranchChoose = branches.menu.choose;
g.menuBranchTransfer = branches.menu.transfer;
g.menuBranchAdd = branches.menu.add;
g.menuBranchClose = branches.menu.close;
g.menuBranchReopen = branches.menu.reopen;
g.menuBranchDefault = branches.menu.makeDefault;
g.menuBranchStaff = branches.menu.staff;
g.menuBranchPrice = branches.menu.price;
g.menuBranchApplyPrice = branches.menu.applyPrice;
g.menuBranchSetting = branches.menu.setting;
g.menuCashClose = money.menu.cashClose;
g.menuCashStatus = money.menu.cashStatus;
g.menuWaitAdd = waitlist.menu.add;
g.menuWaitView = waitlist.menu.view;
g.menuWaitEnroll = waitlist.menu.enroll;
g.menuWaitRemove = waitlist.menu.remove;
g.menuWaitDrafts = waitlist.menu.drafts;
g.menuWaitCheck = waitlist.menu.check;
g.menuCalWeek = schedule.menu.week;
g.menuCalDay = schedule.menu.day;
g.menuRoomAdd = schedule.menu.room;
g.menuScheduleCheck = schedule.menu.check;
g.menuLessonMove = schedule.menu.move;
g.menuLessonCancel = schedule.menu.cancel;
g.menuLessonSubstitute = schedule.menu.substitute;
g.menuQrCards = qr.menu.cards;
g.menuQrSend = qr.menu.send;
g.menuQrRotate = qr.menu.rotate;
g.menuQrIssue = qr.menu.issue;
g.menuDemoClear = demo.menu.clear;
g.menuPlanCreate = plans.menu.create;
g.menuPlanView = plans.menu.view;
g.menuPlanRemove = plans.menu.remove;
g.menuPlanCheck = plans.menu.check;
g.menuPackageSell = packages.menu.sell;
g.menuPackageStatus = packages.menu.status;
g.menuPackageExtend = packages.menu.extend;
g.menuPackageDrafts = packages.menu.drafts;
g.menuPackageCheck = packages.menu.check;
g.menuDocReceipt = documents.menu.receipt;
g.menuDocInvoice = documents.menu.invoice;
g.menuDocSend = documents.menu.send;
g.menuTeacherInvite = (): void => actions.guard("Ustoz taklifi", teacher.menu.invite);
g.menuTeacherUnmarked = (): void => actions.guard("Davomat belgilanmagan darslar", teacher.menu.unmarked);
g.menuTeacherRemind = (): void => actions.guard("Ustoz eslatmalari", teacher.menu.remind);
g.menuTeacherMessaging = (): void => actions.guard("Vasiyga yozish huquqi", teacher.menu.toggleMessaging);
g.menuTeacherTriggerOn = (): void => actions.guard("Avto-eslatma", teacher.menu.triggerOn);
g.menuTeacherTriggerOff = (): void => actions.guard("Avto-eslatma", teacher.menu.triggerOff);
g.teacherTick = teacher.tick; // the hourly trigger
g.menuMarkSet = results.menu.mark;
g.menuMarkRemove = results.menu.removeMark;
g.menuExamAdd = results.menu.examAdd;
g.menuExamScore = results.menu.examScore;
g.menuExamView = results.menu.examView;
g.menuReportMake = results.menu.reportMake;
g.menuReportGroup = results.menu.reportGroup;
g.menuReportSend = results.menu.reportSend;
g.menuCertIssue = results.menu.certIssue;
g.menuCertVoid = results.menu.certVoid;
g.menuCertSend = results.menu.certSend;
g.menuCertVerify = results.menu.certVerify;
g.menuEntitlements = makeup.menu.view;
g.menuScheduleMakeup = makeup.menu.schedule;
g.menuCancelEntitlement = makeup.menu.cancel;
g.menuLedgerSync = ledger.menu.sync;
g.menuLedgerVerify = ledger.menu.verify;
g.menuLedgerManual = ledger.menu.manual;
g.menuLedgerReverse = ledger.menu.reverse;
g.menuLedgerClose = ledger.menu.close;
g.menuReportTrial = ledger.menu.trial;
g.menuReportIncome = ledger.menu.income;
g.menuReportBalance = ledger.menu.balance;
g.menuReportLedger = ledger.menu.ledger;
g.menuAccountAdd = ledger.menu.addAccount;
g.menuCashAdd = ledger.menu.addCash;
g.menuLedgerProtect = ledger.menu.protect;
g.menuSupplierAdd = payables.menu.addSupplier;
g.menuBillAdd = payables.menu.addBill;
g.menuBillPay = payables.menu.pay;
g.menuBillPayVoid = payables.menu.voidPayment;
g.menuBillVoid = payables.menu.voidBill;
g.menuAging = payables.menu.aging;
g.menuStatementCreate = reconcile.menu.create;
g.menuStatementAuto = reconcile.menu.auto;
g.menuStatementStatus = reconcile.menu.status;
g.menuStatementMatch = reconcile.menu.match;
g.menuStatementUnmatch = reconcile.menu.unmatch;
g.menuStatementFinalize = reconcile.menu.finalize;
g.menuPayroll = (): void => actions.guard("Oylik", actions.calculatePayroll);
g.menuWebhookInfo = (): void => actions.guard("Webhook", actions.showWebhookInfo);
g.menuHelp = (): void => actions.showHelp();
g.menuSetup = (): void =>
  actions.guard("Sozlash", () => {
    const ui = SpreadsheetApp.getUi();
    const ok = ui.alert("Boshlang'ich sozlash", "Varaqlar, ustunlar va tekshiruv qoidalari yaratiladi. Mavjud ma'lumotlar o'chirilmaydi (faqat Sozlamalar varag'i qayta yoziladi). Davom etamizmi?", ui.ButtonSet.YES_NO);
    if (ok === ui.Button.YES) {
      setupWorkbook();
      SpreadsheetApp.getActive().toast("Tayyor. Sozlamalar varag'ini to'ldiring.", "nazoratly", 8);
    }
  });
g.menuSample = (): void =>
  actions.guard("Namuna", () => {
    const ui = SpreadsheetApp.getUi();
    if (ui.alert("Namuna ma'lumot", "Bo'sh jadvallarga demo ma'lumot yuklanadi. Davom etamizmi?", ui.ButtonSet.YES_NO) === ui.Button.YES) {
      const msg = loadSampleData();
      actions.refreshDashboard();
      ui.alert("Namuna", msg, ui.ButtonSet.OK);
    }
  });

g.menuSampleReset = (): void =>
  actions.guard("Namuna", () => {
    const ui = SpreadsheetApp.getUi();
    const ok = ui.alert(
      "Namuna ma'lumotni yangilash",
      "DIQQAT: o'quvchilar, guruhlar, hisoblar, to'lovlar, davomat va eslatma loyihalari O'CHIRILADI va bugungi sanaga mos yangi demo ma'lumot yuklanadi (Sozlamalar va vasiylarning Telegram ulanishi saqlanadi). Davom etamizmi?",
      ui.ButtonSet.YES_NO,
    );
    if (ok === ui.Button.YES) {
      const msg = resetSampleData();
      actions.refreshDashboard();
      ui.alert("Namuna", msg, ui.ButtonSet.OK);
    }
  });

// Called from the sidebars through google.script.run
g.getAttendanceGroups = actions.getAttendanceGroups;
g.getRoster = actions.getRoster;
g.saveAttendance = actions.saveAttendance;
g.searchStudents = actions.searchStudents;
g.scanQr = qr.scanQr;
g.importPreview = importer.importPreview;
g.importCommit = importer.importCommit;
g.getBalance = actions.getBalance;
g.recordPayment = actions.recordPayment;
g.getPendingDrafts = actions.getPendingDrafts;
g.decideDrafts = actions.decideDrafts;
g.todayIso = (): string => Utilities.formatDate(new Date(), SpreadsheetApp.getActive().getSpreadsheetTimeZone(), "yyyy-MM-dd");

// Telegram webhook (Web App)
g.doGet = (e?: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput => handleGet(e);
g.doPost = (e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput => handlePost(e);
