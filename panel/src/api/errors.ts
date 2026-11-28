/** Server error messages are English; the panel translates the error CODE. */

export interface FieldProblem {
  field: string;
  type: string;
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly requestId: string | null;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, detail: string, requestId: string | null, details: Record<string, unknown> = {}) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.requestId = requestId;
    this.details = details;
  }

  /** Per-field problems of a 422 validation answer. */
  get fields(): FieldProblem[] {
    const errors = this.details.errors;
    if (!Array.isArray(errors)) return [];
    return errors.flatMap((e: { loc?: string[]; type?: string }) => {
      const loc = (e.loc ?? []).filter((part) => !["body", "query", "path"].includes(part));
      return loc.length ? [{ field: loc[0]!, type: e.type ?? "invalid" }] : [];
    });
  }
}

export function toFailure(status: number, body: unknown, requestIdHeader: string | null): ApiFailure {
  const error = (body as { error?: { code?: string; message?: string; request_id?: string | null; details?: Record<string, unknown> } } | undefined)?.error;
  return new ApiFailure(status, error?.code ?? "unknown", error?.message ?? "", error?.request_id ?? requestIdHeader, error?.details ?? {});
}

export const NETWORK = (): ApiFailure => new ApiFailure(0, "network", "", null);
