/**
 * Error types and the stable exit-code contract every command shares.
 *
 * Exit codes are part of the agent-facing interface:
 *   0 ok · 1 runtime error · 2 usage error · 3 data unavailable
 *   4 rate limited · 5 silent expiry fallback (only with --strict-exp)
 */

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  unavailable: 3,
  rateLimited: 4,
  expFallback: 5,
} as const;

export type ErrorCode =
  | "usage"
  | "runtime"
  | "unavailable"
  | "rate_limited"
  | "exp_fallback";

export interface CliErrorOptions {
  code?: ErrorCode;
  exitCode?: number;
  details?: unknown;
}

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details: unknown;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.code = options.code ?? "runtime";
    this.exitCode = options.exitCode ?? EXIT.error;
    this.details = options.details;
  }
}

/** Bad flags, missing arguments, or values the API would reject anyway. */
export class UsageError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "usage", exitCode: EXIT.usage, details });
    this.name = "UsageError";
  }
}

/** The ticker has no listed options, or the endpoint answered `ok:false`. */
export class DataUnavailableError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "unavailable", exitCode: EXIT.unavailable, details });
    this.name = "DataUnavailableError";
  }
}

/** HTTP 429 survived every retry. */
export class RateLimitedError extends CliError {
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, retryAfterSeconds?: number, details?: unknown) {
    super(message, { code: "rate_limited", exitCode: EXIT.rateLimited, details });
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** `selected_exp` did not match the requested `--exp` and --strict-exp is set. */
export class ExpFallbackError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "exp_fallback", exitCode: EXIT.expFallback, details });
    this.name = "ExpFallbackError";
  }
}

/** Network failure (DNS, TLS, timeout, connection reset). */
export class NetworkError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "runtime", exitCode: EXIT.error, details });
    this.name = "NetworkError";
  }
}

export function errorPayload(error: unknown): {
  ok: false;
  error: { code: ErrorCode; message: string; details?: unknown };
} {
  if (error instanceof CliError) {
    const payload: { ok: false; error: { code: ErrorCode; message: string; details?: unknown } } = {
      ok: false,
      error: { code: error.code, message: error.message },
    };
    if (error.details !== undefined) payload.error.details = error.details;
    return payload;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: "runtime", message } };
}
