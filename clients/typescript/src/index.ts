import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type { components, paths };
export type ApiError = { error: { code: string; message: string; details: Record<string, unknown>; request_id: string | null } };

/**
 * Typed nazoratly API client. Pass `getToken` to attach the bearer access token and `onUnauthorized` to refresh it
 * (POST /v1/auth/refresh) — the caller decides how tokens are stored.
 */
export function createNazoratlyClient(opts: {
  baseUrl: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  newIdempotencyKey?: () => string;
}) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl });
  const auth: Middleware = {
    async onRequest({ request }) {
      const token = await opts.getToken?.();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      if (request.method === "POST" && !request.headers.has("Idempotency-Key")) {
        request.headers.set("Idempotency-Key", (opts.newIdempotencyKey ?? (() => crypto.randomUUID()))());
      }
      return request;
    },
  };
  client.use(auth);
  return client;
}
