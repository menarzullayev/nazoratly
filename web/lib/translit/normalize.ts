/** Every apostrophe-like character used for o', g' and the tutuq in Uzbek text becomes ASCII `'`. */
export function normalizeApostrophes(s: string): string {
  return s.replace(/[‘’ʻʼ]/g, "'");
}

/**
 * Text that must never be converted: {{marked}} brand names, HTML tags, URLs, e-mail addresses, @handles.
 * `convert` applies a mapper only to the segments between these tokens.
 */
const PROTECTED = /(\{\{[^}]*\}\}|<[^>]+>|https?:\/\/[^\s<"']+|[\w.+-]+@[\w-]+\.[\w.-]+|@\w+)/g;

export function mapUnprotected(s: string, fn: (segment: string) => string): string {
  return s
    .split(PROTECTED)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

/** Removes the {{ }} no-translate markers, keeping their content. */
export function stripMarks(s: string): string {
  return s.replace(/\{\{([^}]*)\}\}/g, "$1");
}
