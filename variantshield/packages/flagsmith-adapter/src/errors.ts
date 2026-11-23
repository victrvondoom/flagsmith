export type FlagsmithErrorKind =
  | "auth" | "forbidden" | "not_found" | "invalid_transition" | "validation" | "rate_limited"
  | "unavailable" | "timeout" | "network" | "contract" | "config";

/** Every failure from the adapter is one of these, so callers can branch on `kind`. */
export class FlagsmithError extends Error {
  readonly kind: FlagsmithErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly detail: unknown;

  constructor(kind: FlagsmithErrorKind, message: string, opts: { status?: number; retryAfterMs?: number; detail?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "FlagsmithError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.detail = opts.detail ?? null;
  }
}

export function kindForStatus(status: number): FlagsmithErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 409 || status === 422) return "validation";
  if (status >= 500) return "unavailable";
  return "validation";
}
