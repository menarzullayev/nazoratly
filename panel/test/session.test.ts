/** The session store against a fake server that behaves like the real one: one cookie shared by all tabs, and a cookie
 * value presented twice kills the session. */

import { describe, expect, it, vi } from "vitest";
import { SessionStore, type LockManagerLike, type SessionEvent, type WebSession } from "../src/session/store";

function fakeServer() {
  let generation = 0;
  let live: string | null = null;
  const jar = { cookie: null as string | null };
  const log: string[] = [];
  let dead = false;
  const issue = (org: string): Response => {
    live = jar.cookie = `r${++generation}`;
    const body: WebSession = {
      access_token: `a${generation}`, token_type: "bearer", expires_in: 900,
      user: { id: "u", full_name: "U", email: null, phone: null },
      org: { id: org, name: org, role: "owner", membership_status: "active" }, organizations: [],
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const sent = jar.cookie; // the browser attaches the cookie when the request leaves
    const path = url.split("/").pop()!;
    const org = (JSON.parse(String(init.body)) as { org_id?: string }).org_id ?? "A";
    await new Promise((r) => setTimeout(r, 5));
    log.push(`${path}:${sent ?? "-"}`);
    const refuse = (code: string) => new Response(JSON.stringify({ error: { code, message: code } }), { status: 401 });
    if (path === "login") {
      dead = false;
      return issue(org);
    }
    if (path === "logout") {
      live = jar.cookie = null;
      return new Response("{}", { status: 200 });
    }
    if (org === "forbidden") return refuse("unauthorized");
    if (dead || !sent || sent !== live) {
      if (sent && sent !== live) dead = true; // reuse: the whole family dies
      return refuse("unauthorized");
    }
    return issue(org);
  };
  return { fetch, log, jar };
}

function fakeLocks(): LockManagerLike {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request: <T>(_name: string, run: () => Promise<T>) => {
      const next = tail.then(run, run);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
const noLocks: LockManagerLike = { request: (_name, run) => run() };

function tab(server: ReturnType<typeof fakeServer>, locks: LockManagerLike, sent: SessionEvent[] = [], clock = { now: 0 }) {
  const store = new SessionStore({ fetch: server.fetch, locks, channel: { postMessage: (m) => sent.push(m) }, now: () => clock.now });
  store.onSignedOut = vi.fn();
  store.onChanged = vi.fn();
  return store;
}

describe("two tabs", () => {
  it("refresh at the same time without ending the session", async () => {
    const server = fakeServer();
    const locks = fakeLocks();
    const [a, b] = [tab(server, locks), tab(server, locks)];
    await a.login({ identifier: "x@y.uz", password: "p" });
    await b.refresh();
    await Promise.all([a.refresh(), b.refresh(), a.refresh(), b.refresh()]);
    await expect(a.refresh()).resolves.toBeTruthy();
    await expect(b.refresh()).resolves.toBeTruthy();
    expect(a.onSignedOut).not.toHaveBeenCalled();
    expect(b.onSignedOut).not.toHaveBeenCalled();
  });

  it("would lose the session without the lock (the test above is not passing by luck)", async () => {
    const server = fakeServer();
    const [a, b] = [tab(server, noLocks), tab(server, noLocks)];
    await a.login({ identifier: "x@y.uz", password: "p" });
    await b.refresh();
    await Promise.allSettled([a.refresh(), b.refresh()]);
    await expect(a.refresh()).rejects.toMatchObject({ status: 401 });
  });

  it("hear about a logout and a change of center", async () => {
    const server = fakeServer();
    const locks = fakeLocks();
    const sent: SessionEvent[] = [];
    const [a, b] = [tab(server, locks, sent), tab(server, locks)];
    await a.login({ identifier: "x@y.uz", password: "p" });
    await b.refresh();
    await a.switchOrg("B");
    expect(sent.at(-1)).toEqual({ type: "signed-in", orgId: "B" });
    await b.receive(sent.at(-1)!);
    expect(b.current?.org?.id).toBe("B");
    expect(b.onChanged).toHaveBeenCalledOnce();
    await a.logout();
    expect(sent.at(-1)).toEqual({ type: "signed-out" });
    await b.receive(sent.at(-1)!);
    expect(b.current).toBeNull();
    expect(b.onSignedOut).toHaveBeenCalledOnce();
    await expect(b.accessToken()).resolves.toBeNull();
  });
});

describe("one tab", () => {
  it("shares one refresh between concurrent callers and refreshes shortly before expiry", async () => {
    const server = fakeServer();
    const clock = { now: 0 };
    const store = tab(server, fakeLocks(), [], clock);
    await store.login({ identifier: "x@y.uz", password: "p" });
    await expect(store.accessToken()).resolves.toBe("a1");
    clock.now = 880_000; // 20 seconds left
    const tokens = await Promise.all([store.accessToken(), store.accessToken(), store.accessToken()]);
    expect(tokens).toEqual(["a2", "a2", "a2"]);
    expect(server.log.filter((l) => l.startsWith("refresh"))).toHaveLength(1);
  });

  it("falls back to the account's own center when a remembered one is refused, keeping the session", async () => {
    const server = fakeServer();
    const store = tab(server, fakeLocks());
    await store.login({ identifier: "x@y.uz", password: "p" });
    await expect(store.refresh("forbidden")).resolves.toMatchObject({ org: { id: "A" } });
    expect(store.onSignedOut).not.toHaveBeenCalled();
  });

  it("signs out when the session is over", async () => {
    const server = fakeServer();
    const store = tab(server, fakeLocks());
    await store.login({ identifier: "x@y.uz", password: "p" });
    server.jar.cookie = null;
    await expect(store.refresh()).rejects.toMatchObject({ status: 401 });
    expect(store.current).toBeNull();
    expect(store.onSignedOut).toHaveBeenCalledOnce();
  });

  it("keeps the session when the network fails", async () => {
    const server = fakeServer();
    let offline = false;
    const store = new SessionStore({
      fetch: (u, i) => (offline ? Promise.reject(new TypeError("offline")) : server.fetch(u, i)),
      locks: fakeLocks(), channel: { postMessage: () => {} }, now: () => 0,
    });
    await store.login({ identifier: "x@y.uz", password: "p" });
    offline = true;
    await expect(store.refresh()).rejects.toMatchObject({ code: "network" });
    expect(store.current).not.toBeNull();
  });
});
