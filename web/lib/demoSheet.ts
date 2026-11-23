const COPY_LINK = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+\/copy$/;

/** The public "make a copy" link of the demo Google Sheet, or null when none is configured (the button then stays hidden). */
export function demoSheetUrl(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return COPY_LINK.test(v) ? v : null;
}
