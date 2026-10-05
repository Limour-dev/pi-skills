/**
 * Small shared helpers: timeframe normalization, time parsing, ratings.
 */

import { CliError, usageError, EXIT } from "./output.ts";

/** TradingView timeframes: minutes as numbers, then D / W / M / 1S. */
const TIMEFRAME_ALIASES: Record<string, string> = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "45m": "45",
  "1h": "60",
  "2h": "120",
  "3h": "180",
  "4h": "240",
  "6h": "360",
  "8h": "480",
  "12h": "720",
  "1d": "D",
  "1w": "W",
  "1mo": "M",
  "1s": "1S",
};

const VALID_TIMEFRAMES = new Set([
  "1",
  "3",
  "5",
  "15",
  "30",
  "45",
  "60",
  "120",
  "180",
  "240",
  "360",
  "480",
  "720",
  "D",
  "W",
  "M",
  "1S",
]);

export function normalizeTimeframe(raw: string | undefined, dflt = "D"): string {
  if (raw === undefined) return dflt;
  const value = raw.trim();
  if (VALID_TIMEFRAMES.has(value)) return value;
  const alias = TIMEFRAME_ALIASES[value.toLowerCase()];
  if (alias) return alias;
  throw usageError(
    `unknown timeframe '${raw}'. Use minutes (1,5,15,60,240), D, W, M or aliases (1m,1h,4h,1d,1w,1mo).`,
  );
}

/**
 * Parse a time argument. Accepts:
 *   - Unix seconds or milliseconds (digits)
 *   - `YYYY-MM-DD` or ISO 8601
 *   - relative offsets: `-7d`, `-12h`, `-30m`, `-1w`
 */
export function parseTime(raw: string, label: string): Date {
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    // Heuristic: 13+ digits means milliseconds.
    return new Date(value.length >= 13 ? n : n * 1000);
  }
  const relative = /^-(\d+)([smhdw])$/.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return new Date(Date.now() - amount * unitMs[relative[2]]);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliError(
      `cannot parse ${label} '${raw}'. Use ISO (2026-01-31), Unix seconds, or a relative offset like -7d / -12h.`,
      EXIT.usage,
    );
  }
  return parsed;
}

export function toIso(unixSeconds: number | null | undefined): string | null {
  if (unixSeconds === null || unixSeconds === undefined || !Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

/** Map TradingView's -2..2 technical rating to a label. */
export function ratingLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  if (value <= -1.5) return "strong sell";
  if (value <= -0.5) return "sell";
  if (value < 0.5) return "neutral";
  if (value < 1.5) return "buy";
  return "strong buy";
}

export function round(value: unknown, digits = 6): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Run async tasks with a bounded concurrency, preserving result order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

type Coded = { code?: unknown; message?: unknown };

/** Whether an error is a transient transport failure worth retrying. */
export function isRetryable(err: unknown): boolean {
  const code = (err as Coded | null)?.code;
  if (code === "TIMEOUT" || code === "CONNECTION_ERROR" || code === "DISCONNECTED") return true;
  if (code === "HTTP_ERROR") {
    const message = String((err as Coded).message ?? "");
    // 4xx responses are deterministic (bad query); 5xx / fetch failures are not.
    return !/HTTP 4\d\d/.test(message);
  }
  return false;
}

/** Retry a transient operation a few times with a short backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 400): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1 || !isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}
