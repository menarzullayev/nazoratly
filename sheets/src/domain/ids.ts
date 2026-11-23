/** Sequential, human-friendly ids: S0001, G0003, ... `existing` may contain ids of any prefix. */
export function nextId(prefix: string, existing: Iterable<string>): string {
  let max = 0;
  for (const id of existing) {
    if (id.startsWith(prefix)) {
      const n = Number(id.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

/** Allocates `count` consecutive ids in one go (avoids re-reading the sheet for every row). */
export function nextIds(prefix: string, existing: Iterable<string>, count: number): string[] {
  const first = Number(nextId(prefix, existing).slice(prefix.length));
  return Array.from({ length: count }, (_, i) => `${prefix}${String(first + i).padStart(4, "0")}`);
}
