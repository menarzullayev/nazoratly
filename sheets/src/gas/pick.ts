const ui = (): GoogleAppsScript.Base.Ui => SpreadsheetApp.getUi();

/** The id typed in a prompt, or the one in column A of the selected row when the user is on the given sheet. */
export function pickId(arg: string | undefined, sheetName: string, label: string): string {
  if (arg) return arg.trim();
  try {
    const sh = SpreadsheetApp.getActiveSheet();
    if (sh.getName() === sheetName) {
      const row = SpreadsheetApp.getActiveRange()?.getRow() ?? 0;
      const v = row >= 2 ? String(sh.getRange(row, 1).getValue()).trim() : "";
      if (v) return v;
    }
  } catch {
    // no active sheet (tests, trigger): fall through to the prompt
  }
  const r = ui().prompt(label, "ID ni kiriting (masalan E0003). Jadvaldagi qatorni tanlab ham ishlatish mumkin.", ui().ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui().Button.OK) throw new Error("Bekor qilindi.");
  const id = r.getResponseText().trim();
  if (!id) throw new Error("ID kiritilmadi.");
  return id;
}
