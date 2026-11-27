/** The only thing the panel keeps in browser storage: choices that are not secret. Never put a token, a code or personal
 * data here. Storage can be unavailable (private window): every access may fail silently. */
export type PrefKey = "lang" | "org" | `branch.${string}`;

export function readPref(key: PrefKey): string | null {
  try {
    return localStorage.getItem(`nz.panel.${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: PrefKey, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(`nz.panel.${key}`);
    else localStorage.setItem(`nz.panel.${key}`, value);
  } catch {
    /* the choice is simply not remembered */
  }
}
