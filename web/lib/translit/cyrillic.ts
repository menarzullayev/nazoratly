import { mapUnprotected, normalizeApostrophes } from "./normalize";

const SINGLE: Record<string, string> = {
  a: "а", b: "б", c: "ц", d: "д", f: "ф", g: "г", h: "ҳ", i: "и", j: "ж", k: "к", l: "л", m: "м",
  n: "н", o: "о", p: "п", q: "қ", r: "р", s: "с", t: "т", u: "у", v: "в", x: "х", y: "й", z: "з",
};

const isLetter = (c: string): boolean => /[A-Za-z]/.test(c);
const isUpper = (c: string): boolean => c !== c.toLowerCase();

/** Applies the case of `src` ("a", "A", "Sh", "SH") to the Cyrillic `out`. */
function cased(src: string, out: string): string {
  if (!isUpper(src[0]!)) return out;
  if (src.length > 1 && isUpper(src[1]!)) return out.toUpperCase();
  return out[0]!.toUpperCase() + out.slice(1);
}

function convertSegment(seg: string): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    const ch = seg[i]!;
    const prev = i > 0 ? seg[i - 1]! : "";
    const wordStart = !isLetter(prev) && prev !== "'";
    const two = seg.slice(i, i + 2);
    const low2 = two.toLowerCase();
    const next = seg[i + 2] ?? "";

    if (low2 === "o'" ) { out += cased(two[0]!, "ў"); i += 2; continue; }
    if (low2 === "g'") { out += cased(two[0]!, "ғ"); i += 2; continue; }
    if (low2 === "sh") { out += cased(two, "ш"); i += 2; continue; }
    if (low2 === "ch") { out += cased(two, "ч"); i += 2; continue; }
    if (low2 === "ye") { out += cased(two, "е"); i += 2; continue; }
    if (low2 === "yu") { out += cased(two, "ю"); i += 2; continue; }
    if (low2 === "ya") { out += cased(two, "я"); i += 2; continue; }
    if (low2 === "yo" && next !== "'") { out += cased(two, "ё"); i += 2; continue; }
    if (low2 === "ts" && wordStart) { out += cased(two, "ц"); i += 2; continue; }
    if (ch.toLowerCase() === "e") { out += cased(ch, wordStart ? "э" : "е"); i += 1; continue; }
    if (ch === "'") { out += isLetter(prev) ? "ъ" : "'"; i += 1; continue; }
    const mapped = SINGLE[ch.toLowerCase()];
    out += mapped ? cased(ch, mapped) : ch;
    i += 1;
  }
  return out;
}

/** Uzbek Latin to Uzbek Cyrillic (1995 Latin alphabet rules). */
export function toCyrillic(input: string): string {
  return mapUnprotected(normalizeApostrophes(input), convertSegment);
}
