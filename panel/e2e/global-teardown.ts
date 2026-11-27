import { execFileSync } from "node:child_process";

export default async function globalTeardown(): Promise<void> {
  const state = globalThis.__nzPanel;
  if (!state) return;
  for (const server of state.proxies) {
    server.closeAllConnections();
    server.close();
  }
  const exited = new Promise<void>((done) => {
    if (state.stack.exitCode !== null) done();
    state.stack.once("exit", () => done());
  });
  state.stack.stdin?.end(); // the stack removes its PostgreSQL container itself
  await Promise.race([exited, new Promise((done) => setTimeout(done, 30_000))]);
  state.stack.kill();
  for (const name of state.containers) {
    try {
      execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}
