/** The typed API client (types generated from the OpenAPI document). It adds the bearer token and the chosen branch,
 * refreshes once after a 401, and turns every refused answer into an `ApiFailure`. */

import createClient from "openapi-fetch";
import type { paths } from "@api/schema";
import { session } from "../session/browser";
import { ApiFailure, NETWORK, toFailure } from "./errors";

let branchId: string | null = null;

/** The branch center-wide staff narrowed their view to (X-Branch); null = all branches. */
export function setBranch(id: string | null): void {
  branchId = id;
}

async function send(request: Request): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const copy = request.clone();
    const token = await session.accessToken();
    if (token) copy.headers.set("Authorization", `Bearer ${token}`);
    if (branchId) copy.headers.set("X-Branch", branchId);
    return fetch(copy);
  };
  try {
    const response = await attempt();
    if (response.status !== 401 || !session.current) return response;
    await session.refresh(); // the token was refused early (clock, key rotation): one new token, one more try
    return await attempt();
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw NETWORK();
  }
}

export const api = createClient<paths>({ baseUrl: window.location.origin, fetch: send, credentials: "omit" });

type Result<T> = { data?: T; error?: unknown; response: Response };

/** The data of a successful call; anything else throws `ApiFailure`. */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) throw toFailure(response.status, error, response.headers.get("x-request-id"));
  return data as T;
}

/** The header that makes a repeated POST (double click, retry after a lost answer) create one record only. */
export const idempotent = (key: string): { headers: Record<string, string> } => ({ headers: { "Idempotency-Key": key } });

export const newKey = (): string => crypto.randomUUID();

/** Saves a file the API answered with (a PDF). */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
