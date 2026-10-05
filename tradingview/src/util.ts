/**
 * Shared helpers: timeframe normalization, bar-close math and time parsing.
 */

import { CliError, usageError, EXIT } from "./output.ts";

/**
 * TradingView timeframes supported by this CLI.
 *
 * This list is the single source of truth for `--tf`: the help text, the parse
 * error and `references/commands.md` all derive from it, so they can never
 * disagree again. Only resolutions verified to work anonymously are listed.
 * `360` / `480` / `720` minutes and seconds (`1S`) are rejected right here as a
 * local `USAGE` error (exit 2): they are outside the accepted set, regardless of
 * the account. A server-side entitlement refusal for a series the CLI does pass
 * through surfaces later as `SERIES_ERROR` (exit 4).
 */
export const TIMEFRAMES: readonly string[] = [
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
  "D",
  "W",
  "M",
];

/** Human-friendly aliases, mapped to the values above. */
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
  "1d": "D",
  "1w": "W",
  "1mo": "M",
};

const VALID_TIMEFRAMES = new Set(TIMEFRAMES);

/** One-line `--tf` description used by help, errors and docs. */
export const TIMEFRAME_HELP = `${TIMEFRAMES.filter((t) => /^\d+$/.test(t)).join(" ")} (minutes), ${TIMEFRAMES.filter(
  (t) => !/^\d+$/.test(t),
).join(" ")}; aliases ${Object.keys(TIMEFRAME_ALIASES).join(" ")}`;

export function normalizeTimeframe(raw: string | undefined, dflt = "D"): string {
  if (raw === undefined) return dflt;
  const value = raw.trim();
  if (VALID_TIMEFRAMES.has(value)) return value;
  const alias = TIMEFRAME_ALIASES[value.toLowerCase()];
  if (alias) return alias;
  throw usageError(`unknown timeframe '${raw}'. Supported: ${TIMEFRAME_HELP}.`);
}

/** Fixed bar length in seconds, or `null` for calendar months. */
export function timeframeSeconds(timeframe: string): number | null {
  if (timeframe === "M") return null;
  if (timeframe === "D") return 86_400;
  if (timeframe === "W") return 604_800;
  const minutes = Number(timeframe);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
}


function nextMonthStart(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

function previousMonthStart(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000);
}

/**
 * Whether a bar that *opened* at `time` has already closed by `now`.
 *
 * Timeframe-agnostic and deliberately conservative: a bar counts as closed
 * only once a full bar length has elapsed since its open time. This never
 * leaks the still-forming bar, even for markets whose sessions do not line up
 * with the UTC day; the price is that a daily bar from an exchange that closes
 * early only appears when its full 24 h have passed.
 */
export function isBarFinished(time: number, timeframe: string, now: number): boolean {
  if (timeframe === "M") return nextMonthStart(time) <= now;
  const step = timeframeSeconds(timeframe);
  return step !== null && time + step <= now;
}

/** Latest bar open time that could already be closed at `now`. */
export function lastFinishedBarTime(now: number, timeframe: string): number {
  if (timeframe === "M") return previousMonthStart(now);
  return now - (timeframeSeconds(timeframe) ?? 0);
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

export function round(value: unknown, digits = 6): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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

/**
 * Whether an error looks like server-side rate limiting. TradingView answers a
 * burst of websocket handshakes with HTTP 429, surfaced here as a
 * `CONNECTION_ERROR` whose message contains `429`. Those need a longer,
 * jittered backoff than an ordinary transport hiccup: retrying immediately in
 * lockstep just re-triggers the limit.
 */
export function isRateLimited(err: unknown): boolean {
  const message = String((err as Coded | null)?.message ?? "");
  return /\b429\b|too many requests|rate.?limit/i.test(message);
}

/** Retry a transient operation with exponential, jittered backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, delayMs = 400): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1 || !isRetryable(err)) throw err;
      const base = isRateLimited(err) ? delayMs * 4 : delayMs;
      const backoff = base * 2 ** attempt;
      // Jitter spreads concurrent callers so they do not retry in lockstep.
      const jitter = Math.random() * base;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }
  throw lastError;
}
