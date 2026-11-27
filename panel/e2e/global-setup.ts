import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

declare global {
  var __nzPanel: { stack: ChildProcess; proxies: Server[]; containers: string[] } | undefined;
}

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" }).trim();

const freePort = (): Promise<number> =>
  new Promise((done) => {
    const probe = netServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => done(port));
    });
  });

/** The real panel image minus the build step: nginx with panel/nginx.conf, the built files under /app. */
function startNginx(): { name: string; port: number } {
  const dist = resolve(root, "panel", "dist");
  if (!existsSync(resolve(dist, "index.html"))) throw new Error("build the panel first: npm run build");
  const name = `nazoratly-panel-e2e-${process.pid}`;
  docker("create", "--rm", "--name", name, "-p", "127.0.0.1::80", "nginx:1.29-alpine");
  docker("cp", resolve(root, "panel", "nginx.conf"), `${name}:/etc/nginx/conf.d/default.conf`);
  docker("cp", resolve(root, "panel", "security-headers.conf"), `${name}:/etc/nginx/security-headers.conf`);
  docker("cp", dist, `${name}:/usr/share/nginx/html/app`);
  docker("start", name);
  const port = Number(docker("port", name, "80/tcp").split("\n")[0]!.split(":").pop());
  return { name, port };
}

/** One origin for the browser, as the tunnel gives it in production: /app is the panel, everything else the API. */
function proxy(panelPort: number, apiPort: () => number): Server {
  return createServer((incoming, outgoing) => {
    const panel = /^\/app(\/|\?|$)/.test(incoming.url ?? "");
    const upstream = httpRequest(
      { host: "127.0.0.1", port: panel ? panelPort : apiPort(), method: incoming.method, path: incoming.url, headers: incoming.headers },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
}

export default async function globalSetup(): Promise<void> {
  const port = await freePort();
  const origin = `http://localhost:${port}`; // localhost is a secure context: the Secure cookie works over http
  const nginx = startNginx();
  let api = 0;
  const proxies = ["127.0.0.1", "::1"].map((host) => {
    const server = proxy(nginx.port, () => api);
    server.on("error", () => {}); // a machine without ::1 still has 127.0.0.1
    server.listen(port, host);
    return server;
  });

  const stack = spawn("uv", ["run", "python", "-m", "tests.e2e_stack"], {
    cwd: resolve(root, "backend"),
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: { ...process.env, NZ_PANEL_ORIGIN: origin },
  });
  globalThis.__nzPanel = { stack, proxies, containers: [nginx.name] };
  const log: string[] = [];
  stack.stderr.on("data", (d: Buffer) => log.push(String(d)));
  const info = await new Promise<{ api: string; control: string; pg: string }>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`stack did not start in 240s:\n${log.join("")}`)), 240_000);
    stack.on("exit", (code) => fail(new Error(`stack exited early (${code}):\n${log.join("")}`)));
    createInterface({ input: stack.stdout }).on("line", (line) => {
      if (line.startsWith("READY ")) {
        clearTimeout(timer);
        ok(JSON.parse(line.slice(6)));
      }
    });
  });
  stack.removeAllListeners("exit");
  api = Number(new URL(info.api).port);
  globalThis.__nzPanel.containers.push(info.pg);
  process.env.NZ_ORIGIN = origin;
  process.env.NZ_CONTROL = info.control;
}
