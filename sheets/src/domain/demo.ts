/**
 * Demo rows and what blocks removing them. A real row (no Demo flag) that references a demo row blocks the removal:
 * deleting the demo row would leave it pointing at nothing. Pure; the sheets are read by gas/demo.ts.
 * (The API product enforces the same rule in the database function demo_clear(); there is no shared golden file because
 * the two products store the references differently.)
 */
export interface DemoRow {
  /** natural key within its table (attendance has none: the adapter builds date|group|student) */
  id: string;
  demo: boolean;
  /** references to rows of other tables: [table, id] */
  refs: [string, string][];
}
export interface DemoTable {
  table: string;
  rows: DemoRow[];
}
export interface Blocker {
  table: string;
  id: string;
  refTable: string;
  refId: string;
}

export function demoBlockers(tables: DemoTable[]): Blocker[] {
  const demoIds = new Map<string, Set<string>>();
  for (const t of tables) demoIds.set(t.table, new Set(t.rows.filter((r) => r.demo).map((r) => r.id)));
  const out: Blocker[] = [];
  for (const t of tables) {
    for (const r of t.rows) {
      if (r.demo) continue;
      for (const [refTable, refId] of r.refs) if (refId && demoIds.get(refTable)?.has(refId)) out.push({ table: t.table, id: r.id, refTable, refId });
    }
  }
  return out;
}
