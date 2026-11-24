import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

declare global {
  // eslint-disable-next-line no-var
  var __nzStack: ChildProcess | undefined;
}

/** Starts `backend/tests/e2e_stack.py` and waits for its READY line; exports the random API and control URLs. */
export default async function globalSetup(): Promise<void> {
  const backend = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "backend");
  const child = spawn("uv", ["run", "python", "-m", "tests.e2e_stack"], { cwd: backend, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  globalThis.__nzStack = child;
  const log: string[] = [];
  child.stderr.on("data", (d: Buffer) => log.push(String(d)));
  const info = await new Promise<{ api: string; control: string; pg: string }>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`stack did not start in 240s:\n${log.join("")}\n`)), 240_000);
    child.on("exit", (code) => fail(new Error(`stack exited early (${code}):\n${log.join("")}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("READY ")) {
        clearTimeout(timer);
        ok(JSON.parse(line.slice(6)));
      }
    });
  });
  process.env.NZ_API = info.api;
  process.env.NZ_CONTROL = info.control;
  process.env.NZ_PG = info.pg;
  // The pid is handed to the teardown through a file-less env var: the teardown runs in the same process.
  process.env.NZ_STACK_PID = String(child.pid);
}
