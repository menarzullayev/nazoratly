/** A deployed Apps Script Web App endpoint: https://script.google.com/macros/s/<deployment id>/exec (pure, unit-tested). */
const WEB_APP = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

export const isWebAppUrl = (v: string): boolean => WEB_APP.test(v.trim());

/**
 * `ScriptApp.getService().getUrl()` is unreliable for container-bound scripts: it can return an HTML-page URL or
 * a `/dev` test URL instead of the deployed `/exec` endpoint. Only a well-formed `/exec` URL is accepted.
 */
export function pickWebAppUrl(stored: string | null | undefined, reported: string | null | undefined): string {
  for (const c of [stored, reported]) {
    const v = (c ?? "").trim();
    if (isWebAppUrl(v)) return v;
  }
  return "";
}
