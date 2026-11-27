/** The browser session. The access token lives only in this module's memory; the refresh token is in an HttpOnly cookie
 * the page cannot read. Nothing here writes either of them to storage or to a URL.
 *
 * Tabs share one cookie, and the server treats a refresh token presented twice as theft (the whole session dies). So
 * every call that reads or replaces the cookie runs under one Web Lock: a second tab refreshes only after the first one
 * has received its new cookie. Logout and a change of center are announced on a BroadcastChannel. */

import { NETWORK, toFailure } from "../api/errors";
import type { components } from "@api/schema";

export type WebSession = components["schemas"]["WebSessionOut"];
export type SessionEvent = { type: "signed-out" } | { type: "signed-in"; orgId: string | null };

const LOCK = "nz-panel-session";
const CHANNEL = "nz-panel";
const EARLY_MS = 30_000; // refresh this long before the access token runs out

export interface LockManagerLike {
  request<T>(name: string, run: () => Promise<T>): Promise<T>;
}

export interface SessionDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  locks: LockManagerLike;
  channel: { postMessage(message: SessionEvent): void };
  now: () => number;
}

export class SessionStore {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<WebSession> | null = null;
  current: WebSession | null = null;
  /** Called when the session ends underneath the page (expired, revoked, signed out in another tab). */
  onSignedOut: () => void = () => {};
  /** Called when a refresh moved the session to another center or user. */
  onChanged: (session: WebSession) => void = () => {};

  constructor(private readonly deps: SessionDeps) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.deps.fetch(`/v1/auth/web/${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw NETWORK();
    }
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toFailure(response.status, data, response.headers.get("x-request-id"));
    return data;
  }

  private adopt(session: WebSession): WebSession {
    this.current = session;
    this.token = session.access_token;
    this.expiresAt = this.deps.now() + session.expires_in * 1000;
    return session;
  }

  private drop(): void {
    this.current = null;
    this.token = null;
    this.expiresAt = 0;
  }

  async login(body: components["schemas"]["LoginIn"]): Promise<WebSession> {
    const session = await this.deps.locks.request(LOCK, async () => this.adopt((await this.post("login", body)) as WebSession));
    this.deps.channel.postMessage({ type: "signed-in", orgId: session.org?.id ?? null });
    return session;
  }

  async register(body: components["schemas"]["RegisterIn"]): Promise<WebSession> {
    const session = await this.deps.locks.request(LOCK, async () => this.adopt((await this.post("register", body)) as WebSession));
    this.deps.channel.postMessage({ type: "signed-in", orgId: session.org?.id ?? null });
    return session;
  }

  /** Rotates the cookie and returns the new session for `orgId` (default: the current center). A center the account can
   * no longer enter falls back to the account's own default. */
  refresh(orgId: string | null = this.current?.org?.id ?? null): Promise<WebSession> {
    if (this.inflight) return this.inflight.then((s) => (orgId && s.org?.id !== orgId ? this.refresh(orgId) : s));
    const before = this.current;
    this.inflight = this.deps.locks
      .request(LOCK, async () => {
        try {
          return this.adopt((await this.post("refresh", { org_id: orgId })) as WebSession);
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status !== 401 || !orgId) throw error;
          return this.adopt((await this.post("refresh", {})) as WebSession);
        }
      })
      .then((session) => {
        if (before && (before.org?.id !== session.org?.id || before.user.id !== session.user.id)) this.onChanged(session);
        return session;
      })
      .catch((error: unknown) => {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) {
          const had = this.current !== null;
          this.drop();
          if (had) this.onSignedOut();
        }
        throw error;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async switchOrg(orgId: string): Promise<WebSession> {
    const session = await this.refresh(orgId);
    this.deps.channel.postMessage({ type: "signed-in", orgId: session.org?.id ?? null });
    return session;
  }

  async logout(): Promise<void> {
    try {
      await this.deps.locks.request(LOCK, () => this.post("logout", {}));
    } finally {
      this.drop();
      this.deps.channel.postMessage({ type: "signed-out" });
    }
  }

  /** After a password change or reset the server has already ended every session. */
  forget(): void {
    this.drop();
    this.deps.channel.postMessage({ type: "signed-out" });
  }

  /** A valid access token, refreshing first when it is about to expire. */
  async accessToken(): Promise<string | null> {
    if (this.token && this.deps.now() < this.expiresAt - EARLY_MS) return this.token;
    if (!this.current) return null;
    return (await this.refresh()).access_token;
  }

  /** What another tab said. */
  async receive(event: SessionEvent): Promise<void> {
    if (event.type === "signed-out") {
      if (this.current) {
        this.drop();
        this.onSignedOut();
      }
      return;
    }
    if (!this.current) return;
    try {
      await this.refresh(event.orgId);
    } catch {
      /* refresh() has already signed this tab out when the session is over */
    }
  }
}

export { CHANNEL };
