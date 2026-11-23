import { mapUnprotected, normalizeApostrophes } from "./normalize";

const upper = (c: string): boolean => c !== c.toLowerCase();

/**
 * Uzbek Latin to the 2026-reform Latin: o' -> ö, g' -> ğ, sh -> ş, ch -> ç.
 * "ng" keeps its spelling and the tutuq (apostrophe) stays, as in ma'no.
 */
export function toNewLatin(input: string): string {
  return mapUnprotected(normalizeApostrophes(input), (seg) =>
    seg
      .replace(/([oOgG])'/g, (_, c: string) => {
        const base = c.toLowerCase() === "o" ? ["ö", "Ö"] : ["ğ", "Ğ"];
        return upper(c) ? base[1]! : base[0]!;
      })
      .replace(/sh/gi, (m) => (upper(m[0]!) ? "Ş" : "ş"))
      .replace(/ch/gi, (m) => (upper(m[0]!) ? "Ç" : "ç")),
  );
}
