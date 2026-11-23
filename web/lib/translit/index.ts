import { toCyrillic } from "./cyrillic";
import { toNewLatin } from "./newLatin";
import { normalizeApostrophes } from "./normalize";

export type UzScript = "latn" | "cyrl" | "new";

export { normalizeApostrophes, stripMarks } from "./normalize";
export { toCyrillic, toNewLatin };

export function convert(s: string, to: UzScript): string {
  if (to === "cyrl") return toCyrillic(s);
  if (to === "new") return toNewLatin(s);
  return normalizeApostrophes(s);
}
