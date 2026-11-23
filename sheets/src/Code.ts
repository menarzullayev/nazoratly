/** Apps Script entry point: every function Google calls (menu, web app, sidebars) is exposed on globalThis. */
import * as actions from "./gas/actions";
import * as admission from "./gas/admission";
import * as documents from "./gas/documents";
import * as makeup from "./gas/makeup";
import * as plans from "./gas/plans";
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
        .createMenu("Qoplash (sababli yo'qlik)")
        .addItem("Huquqlarni ko'rish", "menuEntitlements")
        .addItem("Qoplash darsini rejalash", "menuScheduleMakeup")
        .addItem("Huquqni bekor qilish", "menuCancelEntitlement"),
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
    .addItem("O'qituvchi oyligini hisoblash", "menuPayroll")
    .addSeparator()
    .addItem("Boshlang'ich sozlash", "menuSetup")
    .addItem("Namuna ma'lumot yuklash", "menuSample")
    .addItem("Namuna ma'lumotni yangilash", "menuSampleReset")
    .addItem("Yordam", "menuHelp")
    .addToUi();
};

g.openAttendance = (): void => SpreadsheetApp.getUi().showSidebar(html("Attendance", "Davomat", 380, 600));
g.openDrafts = (): void => SpreadsheetApp.getUi().showSidebar(html("Drafts", "Eslatmalar", 420, 600));
g.openPayment = (): void => SpreadsheetApp.getUi().showModalDialog(html("Payment", "To'lov qabul qilish", 460, 560), "To'lov qabul qilish");

g.menuGenerateCharges = (): void => actions.guard("Oylik hisoblar", actions.generateMonthlyCharges);
g.menuDebtors = (): void => actions.guard("Qarzdorlar", actions.refreshDebtors);
g.menuDashboard = (): void => actions.guard("Boshqaruv paneli", actions.refreshDashboard);
g.menuCreateDrafts = (): void => actions.guard("Eslatmalar", actions.createReminderDrafts);
g.menuSendApproved = (): void => actions.guard("Telegram", actions.sendApprovedReminders);
g.menuSetupTelegram = (): void => actions.guard("Telegram", actions.setupTelegram);
g.menuLinkCodes = (): void => actions.guard("Ulash havolalari", actions.generateLinkCodes);
g.menuPendingTrials = admission.menu.pending;
g.menuAcceptTrial = admission.menu.accept;
g.menuDropTrial = admission.menu.drop;
g.menuLeadToTrial = admission.menu.leadToTrial;
g.menuFunnel = admission.menu.funnel;
g.menuPlanCreate = plans.menu.create;
g.menuPlanView = plans.menu.view;
g.menuPlanRemove = plans.menu.remove;
g.menuPlanCheck = plans.menu.check;
g.menuDocReceipt = documents.menu.receipt;
g.menuDocInvoice = documents.menu.invoice;
g.menuDocSend = documents.menu.send;
g.menuEntitlements = makeup.menu.view;
g.menuScheduleMakeup = makeup.menu.schedule;
g.menuCancelEntitlement = makeup.menu.cancel;
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
g.getBalance = actions.getBalance;
g.recordPayment = actions.recordPayment;
g.getPendingDrafts = actions.getPendingDrafts;
g.decideDrafts = actions.decideDrafts;
g.todayIso = (): string => Utilities.formatDate(new Date(), SpreadsheetApp.getActive().getSpreadsheetTimeZone(), "yyyy-MM-dd");

// Telegram webhook (Web App)
g.doGet = (): GoogleAppsScript.Content.TextOutput => handleGet();
g.doPost = (e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput => handlePost(e);
