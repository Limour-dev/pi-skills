/**
 * Wire types for the Sell The News `/api/options/chain` endpoint and the
 * normalised `Snapshot` every command projects from.
 *
 * The REST payload is intentionally typed loosely: the upstream adds fields
 * over time and the CLI only reads the documented ones.
 */

export interface Insight {
  type: string;
  color?: string;
  title: string;
  text: string;
}

/** `expiration` object — one expiry, not a multi-DTE aggregate. */
export interface RestExpiration {
  spot?: number;
  forward_price?: number;
  implied_move_abs?: number;
  implied_move_pct?: number;
  stm_iv?: number;
  dns_sm?: number;
  total_call_oi?: number;
  total_put_oi?: number;
  total_call_vol?: number;
  total_put_vol?: number;
  pc_oi_ratio?: number;
  call_wall?: number;
  call_wall_oi?: number;
  put_wall?: number;
  put_wall_oi?: number;
  max_pain?: number;
  gamma_flip?: number | null;
  min_iv_strike?: number;
  net_gex?: number;
  bullish_score?: number;
  oi_source?: string;
  market_session?: string;
  insights?: Insight[];
  strikes?: number[];
  gex_by_strike?: Record<string, number>;
  cum_call_gex_by_strike?: Record<string, number>;
  cum_put_gex_by_strike?: Record<string, number>;
  greeks_exposure?: Record<string, Record<string, Record<string, number>>>;
  call_oi_by_strike?: Record<string, number>;
  put_oi_by_strike?: Record<string, number>;
  call_vol_by_strike?: Record<string, number>;
  put_vol_by_strike?: Record<string, number>;
  option_mid_by_strike?: { call?: Record<string, number>; put?: Record<string, number> };
  option_pop_by_strike?: { call?: Record<string, number>; put?: Record<string, number> };
}

/** Top-level REST response. `ok` must be checked explicitly. */
export interface RestChain {
  ok?: boolean;
  error?: string;
  ticker?: string;
  expiration_dates?: string[];
  selected_exp?: string;
  expiration?: RestExpiration;
  updated_at?: string;
  score_history?: boolean;
}

export interface HttpMeta {
  status: number;
  latency_ms: number;
  from_cache: boolean;
  /** Local wall-clock time the body was obtained (cache write time on a hit). */
  fetched_at?: string;
  cf_cache?: string;
  ratelimit?: { limit?: number; remaining?: number; reset?: number };
}

/** Where a per-strike series came from, so the units are never ambiguous. */
export type SeriesUnits = "usd_gex" | "exposure_units";

export interface Snapshot {
  source: "rest" | "mcp";
  url: string;
  ticker: string;
  selected_exp: string;
  requested_exp?: string;
  /** REST ISO timestamp of server-side computation (not a market timestamp). */
  updated_at?: string;
  /** MCP renders `Updated: 2026-10-05 08:45 ET` instead of an ISO timestamp. */
  updated_local?: string;
  market_session?: string;
  oi_source?: string;
  spot: number;
  forward_price?: number;
  implied_move_abs?: number;
  implied_move_pct?: number;
  stm_iv?: number;
  pc_oi_ratio?: number;
  total_call_oi?: number;
  total_put_oi?: number;
  total_call_vol?: number;
  total_put_vol?: number;
  call_wall?: number;
  call_wall_oi?: number;
  put_wall?: number;
  put_wall_oi?: number;
  max_pain?: number;
  gamma_flip?: number | null;
  min_iv_strike?: number;
  net_gex?: number;
  bullish_score?: number;
  insights: Insight[];
  expiration_dates: string[];
  /** MCP only: total number of expirations, since the text lists at most 8. */
  expiration_count?: number;
  strikes: number[];
  /** REST only: dollar GEX per strike; the sum equals `net_gex`. */
  gex_by_strike?: Record<string, number>;
  cum_call_gex_by_strike?: Record<string, number>;
  cum_put_gex_by_strike?: Record<string, number>;
  /**
   * Per-greek net exposure by strike, keyed by `String(strike)`.
   * REST fills this from `greeks_exposure.<greek>.net`; MCP from the
   * `--- <GREEK> Net Exposure by Strike ---` tables. These are the upstream's
   * exposure units, **not** the dollar `gex_by_strike` series.
   */
  net_by_strike: Record<string, Record<string, number>>;
  call_oi_by_strike?: Record<string, number>;
  put_oi_by_strike?: Record<string, number>;
  call_vol_by_strike?: Record<string, number>;
  put_vol_by_strike?: Record<string, number>;
  option_mid_by_strike?: { call?: Record<string, number>; put?: Record<string, number> };
  warnings: string[];
  meta: HttpMeta;
}

export interface Provenance {
  source: "rest" | "mcp";
  url: string;
  ticker: string;
  selected_exp: string;
  requested_exp?: string;
  updated_at?: string;
  updated_local?: string;
  market_session?: string;
  oi_source?: string;
  http_status?: number;
  latency_ms?: number;
  from_cache?: boolean;
  /** When the CLI obtained this payload locally — distinct from the server's `updated_at`. */
  payload_fetched_at?: string;
  /** Cloudflare edge cache status reported by the upstream (`HIT` / `MISS` / ...). */
  cf_cache?: string;
  warnings: string[];
}

/** The greek render order used by the upstream text output (not the param enum). */
export const GREEK_ORDER = ["gamma", "delta", "theta", "vega", "vanna", "charm"] as const;

/** Values the `greeks` query parameter accepts. */
export const GREEK_PARAMS = ["gamma", "delta", "theta", "vega", "vanna", "charm"] as const;

export type Greek = (typeof GREEK_PARAMS)[number];

export const DEFAULT_GREEK: Greek = "gamma";

/** Values below this magnitude are floating-point noise, not exposure. */
export const NEAR_ZERO = 1e-3;
