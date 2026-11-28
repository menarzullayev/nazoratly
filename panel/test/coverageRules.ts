export interface Entry {
  group: string;
  part?: number;
  screen?: string;
  excluded?: string;
  pending?: boolean;
}

export interface Manifest {
  builtParts: number[];
  operations: Record<string, Entry>;
}

/** Does the source call this operation? Calls are written `api.GET("/v1/..."`; the cookie-session routes go through the
 * session store as `post("login"`. */
function calls(source: string, key: string): boolean {
  const [method, path] = key.split(" ") as [string, string];
  const web = /^\/v1\/auth\/web\/(\w+)$/.exec(path);
  if (web) return source.includes(`this.post("${web[1]}"`);
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`api\\s*\\.\\s*${method}\\(\\s*"${escaped}"`).test(source);
}

export function coverageProblems(manifest: Manifest, operations: string[], screens: Set<string>, source: string): string[] {
  const problems: string[] = [];
  const listed = manifest.operations;
  for (const op of operations) if (!(op in listed)) problems.push(`not listed: ${op}`);
  const known = new Set(operations);
  for (const [key, entry] of Object.entries(listed)) {
    if (!known.has(key)) {
      problems.push(`no longer in the API: ${key}`);
      continue;
    }
    const states = [entry.screen !== undefined, entry.excluded !== undefined, entry.pending === true].filter(Boolean).length;
    if (states !== 1) problems.push(`needs exactly one of screen, excluded, pending: ${key}`);
    if (entry.excluded !== undefined && !entry.excluded.trim()) problems.push(`excluded without a reason: ${key}`);
    if (entry.pending && (entry.part === undefined || manifest.builtParts.includes(entry.part))) problems.push(`pending in a built part: ${key}`);
    if (entry.screen !== undefined) {
      if (!screens.has(entry.screen)) problems.push(`unknown screen ${entry.screen}: ${key}`);
      if (!calls(source, key)) problems.push(`the source never calls ${key}`);
    }
  }
  return problems;
}
