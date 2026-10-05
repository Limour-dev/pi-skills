/**
 * Endpoint layer: the `/async/*` fragments optioncharts.io actually serves.
 *
 * Every entry is a GET that returns an htmx HTML fragment. The chart pages
 * themselves are shells (`hx-get="/async/options_charts/<chart>?ticker=..."`),
 * so the fragment URL below is the real data endpoint. There is no JSON API:
 * `/async/options_charts/open_interest.json` returns HTTP 500.
 *
 * ```text
 * GET /async/options_charts/<chart>?ticker=TLT&expiration_dates=2026-10-09:w&option_type=all&strike_range=all
 * ```
 *
 * Two request-shaping rules matter (both handled here):
 *   - `expiration_dates` **must** carry the `:w` / `:m` suffix, otherwise the
 *     server silently answers for a different expiry;
 *   - a bare `2026-10-09` is therefore resolved against the checkbox list the
 *     fragment ships, which is why `resolve()` may cost one extra request.
 */

import { DataUnavailableError, ExpFallbackError, UsageError } from "./errors.ts";
import { extractExpiryIds, extractJson, parseExpiryLabel, tryExtractJson } from "./html.ts";
import type { Client } from "./http.ts";
import type { ExpiryEntry, FetchResult } from "./types.ts";

export type ChartName =
  | "open_interest"
  | "volume"
  | "volatility_skew"
  | "greeks"
  | "max_pain"
  | "expected_move"
  | "probability_distribution"
  | "gamma_exposure"
  | "delta_exposure";

interface ChartSpec {
  path: string;
  /** Inline `var` holding the data. */
  variable: string;
  expect: "dict" | "list";
  /** Table/statistics endpoints that ignore `expiration_dates`. */
  needsExpiries?: boolean;
  /** Extra query parameter that switches the exposure flavour. */
  typeParam?: "gamma_exposure_type" | "delta_exposure_type";
}

export const CHARTS: Record<ChartName, ChartSpec> = {
  open_interest: {
    path: "/async/options_charts/open_interest",
    variable: "chart_data",
    expect: "dict",
  },
  volume: { path: "/async/options_charts/volume", variable: "chart_data", expect: "dict" },
  volatility_skew: {
    path: "/async/options_charts/volatility_skew",
    variable: "chart_data",
    expect: "dict",
  },
  greeks: { path: "/async/options_charts/greeks", variable: "all_chart_data", expect: "dict" },
  max_pain: {
    path: "/async/options_charts/max_pain",
    variable: "chart_data",
    expect: "list",
    needsExpiries: false,
  },
  expected_move: {
    path: "/async/options_charts/expected_move",
    variable: "expectedMoveConeData",
    expect: "list",
    needsExpiries: false,
  },
  probability_distribution: {
    path: "/async/options_charts/probability_distribution",
    variable: "chart_data",
    expect: "dict",
  },
  gamma_exposure: {
    path: "/async/options_charts/gamma_exposure",
    variable: "chart_exposure_data",
    expect: "dict",
    typeParam: "gamma_exposure_type",
  },
  delta_exposure: {
    path: "/async/options_charts/delta_exposure",
    variable: "chart_exposure_data",
    expect: "dict",
    typeParam: "delta_exposure_type",
  },
};

export const TABLE_ENDPOINTS = {
  option_chain: "/async/option_chain",
  chain_statistics: "/async/option_chain_statistics",
  ticker_info: "/async/options_ticker_info",
  price_widget: "/async/stock_price_widget",
} as const;

/** Statistic columns the free tier serves; `gex` / `dex` render a lock icon. */
export const STATS_COLUMNS = [
  "expiration",
  "volume_total",
  "volume_pcr",
  "oi_total",
  "oi_pcr",
  "iv",
  "expected_move",
  "max_pain",
  "volume_calls",
  "volume_puts",
  "oi_calls",
  "oi_puts",
  "dte",
  "contracts_total",
] as const;

export const LOCKED_STATS_COLUMNS = ["gex", "dex"] as const;

export const CHAIN_COLUMNS = ["strike", "bid", "ask", "volume", "oi", "iv", "delta"] as const;

/**
 * Columns the chain endpoint accepts in addition to `CHAIN_COLUMNS`. `--columns`
 * is validated against this set so a typo fails as a usage error instead of
 * silently shifting the positional mapping (see OC-02).
 */
export const CHAIN_ALLOWED_COLUMNS = [
  ...CHAIN_COLUMNS,
  "gamma",
  "theta",
  "vega",
  "rho",
  "last",
] as const;

/**
 * `stats --columns` accepts the free-tier table columns plus the locked
 * `gex` / `dex`, and the canonical aliases (`iv_pct`, `expected_move_*`) that
 * map back onto the upstream `iv` / `expected_move` request keys.
 */
export const STATS_ALLOWED_COLUMNS = [
  ...STATS_COLUMNS,
  ...LOCKED_STATS_COLUMNS,
  "iv_pct",
  "expected_move_abs",
  "expected_move_pct",
] as const;

/**
 * The upstream table always renders its identity column first (`strike` for the
 * chain, `expiration` for the statistics table). `--columns` is a *local*
 * projection, so the request always carries that identity column first and the
 * caller's list is projected afterwards — otherwise a column subset shifts every
 * value by one (OC-02 / OC-03).
 */
export function withIdentity(identity: string, columns: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const column of [identity, ...columns]) {
    if (!seen.has(column)) {
      seen.add(column);
      out.push(column);
    }
  }
  return out;
}

const INVALID_TICKER = /Could not find options data for ticker\s+([A-Z0-9.\-]+)/i;

/** Turn the upstream "Invalid Ticker" page into a clean exit-3 error. */
export function assertTicker(body: string, ticker: string): void {
  const match = INVALID_TICKER.exec(body);
  if (match) {
    throw new DataUnavailableError(
      `optioncharts.io has no options data for ticker ${ticker} (invalid ticker)`,
      { ticker },
    );
  }
}

export interface ChartRequest {
  chart: ChartName;
  ticker: string;
  expiries?: string[];
  optionType?: "all" | "call" | "put";
  strikeRange?: string;
  chartType?: "column" | "scatter" | "line";
  exposureType?: "open_interest" | "volume";
}

export interface ChartResponse {
  result: FetchResult;
  data: unknown;
  /** Per-expiry summary list (`chart_data` list form) when the fragment has one. */
  summary?: unknown;
}

export function chartParams(request: ChartRequest): Record<string, string | undefined> {
  const spec = CHARTS[request.chart];
  const params: Record<string, string | undefined> = { ticker: request.ticker };
  if (spec.needsExpiries === false) return params;
  params.expiration_dates = request.expiries?.length ? request.expiries.join(",") : undefined;
  params.option_type = request.optionType ?? "all";
  params.strike_range = request.strikeRange ?? "all";
  params.chart_type = request.chartType ?? "column";
  if (spec.typeParam) params[spec.typeParam] = request.exposureType ?? "open_interest";
  return params;
}

/** Fetch one chart fragment and pull its inline JSON out. */
export async function fetchChart(
  client: Client,
  request: ChartRequest,
): Promise<ChartResponse> {
  const spec = CHARTS[request.chart];
  const result = await client.get(spec.path, chartParams(request));
  assertTicker(result.body, request.ticker);
  const data = extractJson(result.body, spec.variable, { expect: spec.expect });
  const summary =
    spec.expect === "dict" ? tryExtractJson(result.body, spec.variable, { expect: "list" }) : undefined;
  return { result, data, summary };
}

/** `GET /async/option_chain_statistics` — one row per expiry, one request. */
export async function fetchStatistics(
  client: Client,
  ticker: string,
  columns: readonly string[] = STATS_COLUMNS,
  expirationDates = "all",
): Promise<FetchResult> {
  const result = await client.get(TABLE_ENDPOINTS.chain_statistics, {
    ticker,
    expiration_dates: expirationDates,
    columns: columns.join(","),
  });
  assertTicker(result.body, ticker);
  return result;
}

export interface ChainRequest {
  ticker: string;
  expiries?: string[];
  optionType?: "all" | "call" | "put";
  view?: "list" | "straddle";
  strikeRange?: string;
  columns?: readonly string[];
}

export async function fetchChain(client: Client, request: ChainRequest): Promise<FetchResult> {
  const result = await client.get(TABLE_ENDPOINTS.option_chain, {
    ticker: request.ticker,
    option_type: request.optionType ?? "all",
    expiration_dates: request.expiries?.length ? request.expiries.join(",") : undefined,
    view: request.view ?? "list",
    strike_range: request.strikeRange ?? "all",
    columns: (request.columns ?? CHAIN_COLUMNS).join(","),
  });
  assertTicker(result.body, request.ticker);
  return result;
}

export async function fetchPriceWidget(client: Client, ticker: string): Promise<FetchResult> {
  const result = await client.get(TABLE_ENDPOINTS.price_widget, { ticker });
  assertTicker(result.body, ticker);
  return result;
}

export async function fetchTickerInfo(client: Client, ticker: string): Promise<FetchResult> {
  const result = await client.get(TABLE_ENDPOINTS.ticker_info, { ticker });
  assertTicker(result.body, ticker);
  return result;
}

/**
 * Expiry list + the `:w` / `:m` resolution the API silently requires.
 *
 * The checkbox list ships inside every chart fragment (free tier, complete to
 * 2029), so one fragment fetch answers both "what expiries exist" and "what is
 * the canonical id for 2026-10-09".
 */

/**
 * optioncharts.io marks the third Friday of each month `:m` and every other
 * expiry `:w`. Every expiry the CLI sends must carry one of those suffixes.
 */
export function inferExpiryKind(date: string): "weekly" | "monthly" {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDay() !== 5) return "weekly";
  const fridayOfMonth = Math.floor((parsed.getUTCDate() - 1) / 7) + 1;
  return fridayOfMonth === 3 ? "monthly" : "weekly";
}

/**
 * Expiries implied by OCC contract symbols (`TLT261009C00065000`), the only
 * expiry evidence in fragments that carry no checkbox list or expiry hrefs
 * (the option-chain tables).
 */
export function expiryIdsFromSymbols(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(/[A-Z]{1,6}(\d{2})(\d{2})(\d{2})[CP]\d{8}/g)) {
    const date = `20${match[1]}-${match[2]}-${match[3]}`;
    const kind = inferExpiryKind(date);
    ids.add(`${date}:${kind === "monthly" ? "m" : "w"}`);
  }
  return [...ids];
}

export class ExpiryService {
  readonly client: Client;
  private cache = new Map<string, ExpiryEntry[]>();
  private fetched = new Map<string, FetchResult>();

  constructor(client: Client) {
    this.client = client;
  }

  /** All listed expiries for a ticker, oldest first (one request, cached). */
  async entries(ticker: string): Promise<ExpiryEntry[]> {
    const cached = this.cache.get(ticker);
    if (cached) return cached;
    const result = await this.client.get(CHARTS.open_interest.path, { ticker });
    assertTicker(result.body, ticker);
    const entries = expiriesFromFragment(result.body);
    if (!entries.length) {
      throw new DataUnavailableError(
        `no expiration dates found for ${ticker} — the fragment layout may have changed`,
        { ticker },
      );
    }
    this.cache.set(ticker, entries);
    this.fetched.set(ticker, result);
    return entries;
  }

  lastFetch(ticker: string): FetchResult | undefined {
    return this.fetched.get(ticker);
  }

  /**
   * Canonicalise user-supplied expiries.
   *
   * A bare `2026-10-09` is mapped to `2026-10-09:w`; a wrong suffix is corrected
   * (and reported); a date that is not listed at all fails loudly instead of
   * letting the server silently answer for a different expiry.
   */
  async resolve(
    ticker: string,
    requested: string[],
  ): Promise<{ expiries: ExpiryEntry[]; corrections: Array<Record<string, string>> }> {
    if (!requested.length) return { expiries: [], corrections: [] };
    const canonical = requested.map((item) => item.trim()).filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    for (const raw of canonical) {
      const [date, suffix] = raw.split(":");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new UsageError(`invalid --exp ${raw}: expected YYYY-MM-DD or YYYY-MM-DD:w|m`);
      }
      if (suffix && suffix !== "w" && suffix !== "m") {
        throw new UsageError(`invalid --exp ${raw}: the suffix must be :w or :m`);
      }
      if (date < today) throw new DataUnavailableError(`${ticker}: ${date} is in the past`, { ticker, requested: raw });
    }
    // Fast path: an expiry that already carries its :w / :m suffix needs no
    // resolution, so the command spends its one request on the data fragment.
    if (canonical.every((raw) => /^\d{4}-\d{2}-\d{2}:[wm]$/.test(raw))) {
      return {
        expiries: canonical.map((raw) => {
          const [date, suffix] = raw.split(":");
          return { exp_id: raw, date, kind: suffix === "m" ? "monthly" : "weekly" } as ExpiryEntry;
        }),
        corrections: [],
      };
    }
    const entries = await this.entries(ticker);
    const byDate = new Map(entries.map((entry) => [entry.date, entry]));
    const resolved: ExpiryEntry[] = [];
    const corrections: Array<Record<string, string>> = [];
    for (const item of requested) {
      const raw = item.trim();
      if (!raw) continue;
      const [date, suffix] = raw.split(":");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new UsageError(`invalid --exp ${raw}: expected YYYY-MM-DD or YYYY-MM-DD:w|m`);
      }
      const entry = byDate.get(date);
      if (!entry) {
        const today = new Date().toISOString().slice(0, 10);
        if (date < today) {
          throw new DataUnavailableError(`${ticker}: ${date} is in the past`, {
            ticker,
            requested: raw,
          });
        }
        // The checkbox list is capped at 30 entries, so a valid far-dated expiry can be
        // absent. Infer the convention (third Friday = :m, everything else = :w) and let
        // the payload check catch a wrong guess.
        const kind = inferExpiryKind(date);
        const expId = `${date}:${kind === "monthly" ? "m" : "w"}`;
        corrections.push({
          requested: raw,
          used: expId,
          why: "suffix inferred (date is past the 30-entry expiry list)",
        });
        resolved.push({ exp_id: expId, date, kind });
        continue;
      }
      if (suffix && suffix !== (entry.kind === "weekly" ? "w" : "m")) {
        corrections.push({ requested: raw, used: entry.exp_id, why: "suffix corrected" });
      } else if (!suffix) {
        corrections.push({ requested: raw, used: entry.exp_id, why: "suffix added" });
      }
      if (!resolved.some((item2) => item2.exp_id === entry.exp_id)) resolved.push(entry);
    }
    return { expiries: resolved, corrections };
  }
}

/** Read the checkbox list out of any chart fragment. */
export function expiriesFromFragment(body: string): ExpiryEntry[] {
  const labels = new Map<string, string>();
  const labelPattern =
    /<input\b[^>]*value="(\d{4}-\d{2}-\d{2}:[wm])"[^>]*>[\s\S]{0,400}?<label\b[^>]*>([^<]*)<\/label>/g;
  for (const match of body.matchAll(labelPattern)) labels.set(match[1], match[2].trim());
  const ids = extractExpiryIds(body);
  return ids
    .map((exp_id) => {
      const [date, suffix] = exp_id.split(":");
      const display = labels.get(exp_id);
      const parsed = display ? parseExpiryLabel(display) : {};
      const entry: ExpiryEntry = {
        exp_id,
        date,
        kind: suffix === "m" ? "monthly" : "weekly",
      };
      if (display) entry.display = display;
      if (parsed.dte !== undefined) entry.dte = parsed.dte;
      return entry;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface ExpiryFilter {
  /** Keep only expiries at most this many days out. */
  dte?: number;
  weeklyOnly?: boolean;
  monthlyOnly?: boolean;
  /** Cap the number of returned expiries (scan guardrail). */
  max?: number;
}

export function filterExpiries(entries: ExpiryEntry[], filter: ExpiryFilter): ExpiryEntry[] {
  let out = entries;
  if (filter.dte !== undefined) {
    out = out.filter((entry) => entry.dte === undefined || entry.dte <= filter.dte!);
  }
  if (filter.weeklyOnly) out = out.filter((entry) => entry.kind === "weekly");
  if (filter.monthlyOnly) out = out.filter((entry) => entry.kind === "monthly");
  if (filter.max !== undefined && filter.max > 0) out = out.slice(0, filter.max);
  return out;
}

/**
 * Guard against the documented silent expiry fallback: the payload keys carry
 * the expiry the server actually answered for, so compare them to the request.
 */
export function checkExpiryFallback(
  payload: unknown,
  requested: string[],
  strict: boolean,
  ticker: string,
  options: { ignoreMissing?: boolean } = {},
): string[] {
  if (!requested.length) return [];
  const returned = payloadExpiries(payload);
  if (!returned.length) return [];
  const warnings: string[] = [];
  const unexpected = returned.filter((exp) => !requested.includes(exp));
  const missing = requested.filter((exp) => !returned.includes(exp));
  if (unexpected.length) {
    const message =
      `${ticker}: requested ${missing.join(",") || requested.join(",")} but the server returned ` +
      `${unexpected.join(",")} — expiration_dates must carry the :w / :m suffix`;
    if (strict) throw new ExpFallbackError(message, { ticker, requested, returned });
    warnings.push(message);
  }
  // A requested expiry that is simply absent means partial data; the GEX/DEX
  // per-expiry collapse on the free tier is expected and opts out of this check.
  if (missing.length && !options.ignoreMissing) {
    warnings.push(
      `${ticker}: the payload has no rows for ${missing.join(",")} (returned ${returned.join(",")}) ` +
        `— treat those expiries as missing rather than zero`,
    );
  }
  return warnings;
}

/** Expiries referenced by a chart payload's `expiry:side` keys. */
export function payloadExpiries(payload: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const match = /^(\d{4}-\d{2}-\d{2}:[wm])(?::(calls|puts))?$/.exec(key);
      if (match) found.add(match[1]);
      else if (/^\d{4}-\d{2}-\d{2}:[wm]$/.test(key)) found.add(key);
      if (inner && typeof inner === "object") {
        if (Array.isArray(inner)) {
          for (const row of inner) {
            if (row && typeof row === "object") {
              const exp = (row as { expiration_date_id?: unknown }).expiration_date_id;
              if (typeof exp === "string") found.add(exp);
            }
          }
        } else {
          const exp = (inner as { expiration_date_id?: unknown }).expiration_date_id;
          if (typeof exp === "string") found.add(exp);
          else visit(inner);
        }
      }
    }
  };
  visit(payload);
  return [...found].sort();
}
