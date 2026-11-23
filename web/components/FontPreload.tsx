import { preload } from "react-dom";

/** Starts the two fonts the first paint needs (body and display) before the stylesheet is parsed. */
export function preloadFonts(cyrillic: boolean): void {
  const sub = cyrillic ? "cyrillic" : "latin";
  for (const name of ["inter", "unbounded"]) {
    preload(`/fonts/${name}-${sub}.woff2`, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  }
}
