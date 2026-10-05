/**
 * Multi-expiry / multi-ticker scanning.
 *
 * A per-expiry `levels` call costs one REST request, so "which expiries matter
 * this week" used to take 12+ interactive calls (see the TLT/SPY/QQQ weekly
 * scan retrospective). `scan` reuses the `expiration_dates` returned by the
 * first fetch, then pulls every expiry inside `--dte` behind a small
 * concurrency limit and projects each into the compact scalar schema — never
 * `insights` or `gex_by_strike`.
 */

import type { Snapshot } from "./types.ts";
import { daysBetween, formatUsd } from "./num.ts";
import { spotVersusFlip } from "./project.ts";

export interface LoadedSnapshot {
  snapshot: Snapshot;
  extraWarnings: string[];
}

/** Loads one (ticker, expiry) snapshot through the normal channel logic. */
export type SnapshotLoader = (ticker: string, exp?: string) => Promise<LoadedSnapshot>;

export interface ScanOptions {
  /** Maximum days to expiry to include (`--dte`, already defaulted). */
  dte: number;
  /** Restrict the scan to this single expiry (`--exp`). */
  exp?: string;
  /** Base date for DTE (`--today`, UTC today by default). */
  today: string;
  /** In-flight REST requests (`--concurrency`). */
  concurrency: number;
  /** Hard cap on expiries per ticker (`--max-exp`). */
  maxExpirations: number;
}

export interface ScanEntry {
  exp: string;
  dte?: number;
  net_gex?: number;
  net_gex_usd?: string;
  gamma_flip?: number | null;
  spot_vs_flip?: "above" | "below" | null;
  call_wall?: number;
  put_wall?: number;
  max_pain?: number;
  implied_move_pct?: number;
  stm_iv?: number;
  pc_oi_ratio?: number;
  bullish_score?: number;
  regime?: "positive" | "negative";
}

export interface SignFlip {
  from_exp: string;
  to_exp: string;
  from: number;
  to: number;
}

export interface TickerScan {
  ticker: string;
  spot?: number;
  source?: "rest" | "mcp";
  payload_fetched_at?: string;
  updated_at?: string;
  market_session?: string;
  dte_max: number;
  expirations_scanned: number;
  /** Where the sign of `net_gex` changes between adjacent expiries. */
  sign_flips: SignFlip[];
  warnings: string[];
  errors: Array<{ exp: string; error: string }>;
  scan: ScanEntry[];
}

/** Expirations inside `dte` days of `today`, ascending, capped at `limit`. */
export function selectExpirations(dates: string[], today: string, dte: number, limit: number): string[] {
  return dates
    .map((exp) => ({ exp, dte: daysBetween(today, exp) }))
    .filter((entry): entry is { exp: string; dte: number } => {
      return entry.dte !== undefined && entry.dte >= 0 && entry.dte <= dte;
    })
    .sort((a, b) => a.dte - b.dte || a.exp.localeCompare(b.exp))
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.exp);
}

/** `Snapshot` → the minimal scalar row an agent needs per expiry. */
export function scanEntry(snapshot: Snapshot, today: string): ScanEntry {
  const versus = spotVersusFlip(snapshot);
  const entry: ScanEntry = {
    exp: snapshot.selected_exp,
    net_gex: snapshot.net_gex,
    net_gex_usd: snapshot.net_gex === undefined ? undefined : formatUsd(snapshot.net_gex),
    gamma_flip: snapshot.gamma_flip ?? null,
    spot_vs_flip: versus?.spot_side ?? null,
    call_wall: snapshot.call_wall,
    put_wall: snapshot.put_wall,
    max_pain: snapshot.max_pain,
    implied_move_pct: snapshot.implied_move_pct,
    stm_iv: snapshot.stm_iv,
    pc_oi_ratio: snapshot.pc_oi_ratio,
    bullish_score: snapshot.bullish_score,
    regime:
      snapshot.net_gex === undefined ? undefined : snapshot.net_gex >= 0 ? "positive" : "negative",
  };
  const dte = daysBetween(today, snapshot.selected_exp);
  if (dte !== undefined) entry.dte = dte;
  return defined(entry);
}

function defined<T extends object>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * Scan one ticker: pin the calendar with a single fetch, then pull every
 * expiry inside `--dte` (skipping the one already loaded) concurrently.
 */
export async function scanTicker(
  ticker: string,
  load: SnapshotLoader,
  options: ScanOptions,
): Promise<TickerScan> {
  const warnings: string[] = [];
  const errors: Array<{ exp: string; error: string }> = [];
  const empty: TickerScan = {
    ticker,
    dte_max: options.dte,
    expirations_scanned: 0,
    sign_flips: [],
    warnings,
    errors,
    scan: [],
  };

  let first: LoadedSnapshot;
  try {
    first = await load(ticker, options.exp);
  } catch (error) {
    errors.push({ exp: options.exp ?? "nearest", error: messageOf(error) });
    return empty;
  }

  const dates = first.snapshot.expiration_dates;
  const targets = options.exp
    ? [first.snapshot.selected_exp]
    : selectExpirations(dates, options.today, options.dte, options.maxExpirations);

  if (options.exp) warnings.push(`--exp pins the scan to ${first.snapshot.selected_exp}`);
  if (
    first.snapshot.expiration_count !== undefined &&
    first.snapshot.expiration_count > dates.length
  ) {
    warnings.push(
      `only ${dates.length} of ${first.snapshot.expiration_count} expirations are listed by this channel; ` +
        "use --source rest for the full calendar",
    );
  }
  if (!options.exp && targets.length && targets.length >= options.maxExpirations) {
    warnings.push(`capped at --max-exp ${options.maxExpirations} expiries`);
  }
  if (!targets.length) {
    warnings.push(`no listed expiry falls within --dte ${options.dte} of ${options.today}`);
    return empty;
  }

  const loaded = new Map<string, LoadedSnapshot>();
  loaded.set(first.snapshot.selected_exp, first);

  const pending = targets.filter((exp) => !loaded.has(exp));
  let stopped = false;
  const fetched = await mapLimit(pending, options.concurrency, async (exp) => {
    if (stopped) return { exp, error: "skipped after a rate limit" };
    try {
      return { exp, loaded: await load(ticker, exp) };
    } catch (error) {
      if (isRateLimited(error)) stopped = true;
      return { exp, error: messageOf(error) };
    }
  });

  for (const item of fetched) {
    if ("loaded" in item && item.loaded) {
      const got = item.loaded;
      loaded.set(item.exp, got);
      for (const warning of got.snapshot.warnings) {
        if (got.snapshot.selected_exp !== item.exp) {
          warnings.push(`requested ${item.exp} but the server returned ${got.snapshot.selected_exp}`);
        } else if (!/requested exp/.test(warning)) {
          warnings.push(warning);
        }
      }
    } else {
      errors.push({ exp: item.exp, error: item.error ?? "unknown error" });
    }
  }

  const scan: ScanEntry[] = [];
  for (const exp of targets) {
    const got = loaded.get(exp);
    if (got) scan.push(scanEntry(got.snapshot, options.today));
  }

  const out: TickerScan = {
    ticker,
    spot: first.snapshot.spot,
    source: first.snapshot.source,
    dte_max: options.dte,
    expirations_scanned: scan.length,
    sign_flips: signFlips(scan),
    warnings: [...new Set(warnings)],
    errors,
    scan,
  };
  if (first.snapshot.meta.fetched_at) out.payload_fetched_at = first.snapshot.meta.fetched_at;
  if (first.snapshot.updated_at) out.updated_at = first.snapshot.updated_at;
  if (first.snapshot.market_session) out.market_session = first.snapshot.market_session;
  return out;
}

function signFlips(entries: ScanEntry[]): SignFlip[] {
  const flips: SignFlip[] = [];
  for (let i = 1; i < entries.length; i += 1) {
    const a = entries[i - 1];
    const b = entries[i];
    if (typeof a.net_gex !== "number" || typeof b.net_gex !== "number") continue;
    if (Math.sign(a.net_gex) !== Math.sign(b.net_gex)) {
      flips.push({ from_exp: a.exp, to_exp: b.exp, from: a.net_gex, to: b.net_gex });
    }
  }
  return flips;
}

function isRateLimited(error: unknown): boolean {
  return error instanceof Error && error.name === "RateLimitedError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run `fn` over `items` with at most `limit` promises in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.min(Math.max(1, Math.floor(limit)), items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}
