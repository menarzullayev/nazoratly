import { CHANNEL, SessionStore, type LockManagerLike, type SessionEvent } from "./store";

const channel = new BroadcastChannel(CHANNEL);

/** Web Locks serialize the cookie rotation across tabs. A browser without them could end the session by refreshing in
 * two tabs at once, so the panel refuses to start there (see `unsupportedBrowser`). */
export const unsupportedBrowser = typeof navigator === "undefined" || !navigator.locks;

const locks: LockManagerLike = {
  request: <T>(name: string, run: () => Promise<T>) => navigator.locks.request(name, run) as Promise<T>,
};

export const session = new SessionStore({
  fetch: (input, init) => fetch(input, init),
  locks,
  channel: { postMessage: (message: SessionEvent) => channel.postMessage(message) },
  now: () => Date.now(),
});

channel.addEventListener("message", (event: MessageEvent<SessionEvent>) => void session.receive(event.data));
