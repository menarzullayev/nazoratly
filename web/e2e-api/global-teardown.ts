import { execFileSync } from "node:child_process";

/** Closes the stack's stdin (it then removes its own database container); kills it and the container if it does not exit. */
export default async function globalTeardown(): Promise<void> {
  const child = globalThis.__nzStack;
  if (!child) return;
  child.stdin?.end();
  const exited = await new Promise<boolean>((done) => {
    if (child.exitCode !== null) return done(true);
    const t = setTimeout(() => done(false), 30_000);
    child.once("exit", () => {
      clearTimeout(t);
      done(true);
    });
  });
  if (!exited) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    if (process.env.NZ_PG) {
      try {
        execFileSync("docker", ["rm", "-fv", process.env.NZ_PG], { stdio: "ignore" });
      } catch {
        /* already removed */
      }
    }
  }
}
