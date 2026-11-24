/**
 * Ids of rows the current user cannot see (another branch's rows): they still count when the next id is chosen, or two
 * branches would both hand out S0007. Filled by the Apps Script adapter (gas/repo.ts); empty = no effect.
 */
const reserved = new Map<string, number>();
export function reserveIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(id);
    if (m && Number(m[2]) > (reserved.get(m[1]!) ?? 0)) reserved.set(m[1]!, Number(m[2]));
  }
}
export function clearReservedIds(): void {
  reserved.clear();
}

/** Sequential, human-friendly ids: S0001, G0003, ... `existing` may contain ids of any prefix. */
export function nextId(prefix: string, existing: Iterable<string>): string {
  let max = reserved.get(prefix) ?? 0;
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
