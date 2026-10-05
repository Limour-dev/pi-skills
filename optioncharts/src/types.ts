/**
 * Shared types for the optioncharts.io client.
 *
 * The upstream payloads are typed loosely on purpose: they are Rails-template
 * locals (`var chart_data = {...}`) rather than a public API, so the CLI reads
 * only the documented fields and tolerates everything else.
 */

export interface ExpiryEntry {
  /** Canonical id used in every request, e.g. `2026-10-09:w`. */
  exp_id: string;
  /** `YYYY-MM-DD` part of `exp_id`. */
  date: string;
  /** `w` (weekly) or `m` (monthly, third Friday). */
  kind: "weekly" | "monthly";
  /** Upstream label, e.g. `Oct 09, 2026 (4 days) (w)`. */
  display?: string;
  /** Day count shown by the upstream label when available. */
  dte?: number;
}

export interface HttpMeta {
  status: number;
  latency_ms: number;
  from_cache: boolean;
  /** Local wall-clock time the body was obtained (cache write time on a hit). */
  fetched_at: string;
  url: string;
  params: Record<string, string>;
}

export interface FetchResult extends HttpMeta {
  body: string;
}

/** One strike row of a chart payload (`{expiry}:{calls|puts}` keyed). */
export interface StrikeRow {
  strike: number;
  option_type: "CALL" | "PUT" | string;
  value: number | null;
  contract_symbol?: string;
  [key: string]: unknown;
}

export interface ExposureStrike {
  strike: number;
  call_exposure: number;
  put_exposure: number;
  net_exposure: number;
}

export interface ExposureExpiry {
  expiration_date_id: string;
  expiration_date_display?: string;
  net_exposure: number;
  call_exposure?: number;
  put_exposure?: number;
  call_wall: number | null;
  put_wall: number | null;
  gamma_zero_level: number | null;
  expiration_int?: number;
}

export interface ExposurePayload {
  ticker: string;
  call_exposure: number;
  put_exposure: number;
  net_exposure: number;
  call_wall: number | null;
  put_wall: number | null;
  exposure_by_strike_series: ExposureStrike[];
  exposure_by_expiration_series: ExposureExpiry[];
}

/** A parsed `<td>`/`<th>`: text plus the first href (used to recover the expiry id). */
export interface TableCell {
  text: string;
  href?: string;
  /** Upstream renders paid cells as a lock icon instead of a value. */
  locked: boolean;
}

export interface Table {
  id?: string;
  headers: string[];
  rows: TableCell[][];
}

export interface PriceWidget {
  ticker?: string;
  name?: string;
  price: number | null;
  currency?: string;
  change: number | null;
  change_pct: number | null;
  as_of?: string;
  market_status?: string;
  options_delay?: string;
}

export interface MaxPainRow {
  expiration_date_id: string;
  expiration_date_display?: string;
  max_pain: number | null;
  max_pain_diff: number | null;
  max_pain_diff_display?: string;
  max_pain_diff_pct: number | null;
}

export interface ExpectedMovePoint {
  /** milliseconds since epoch as sent upstream. */
  t: number;
  iso: string | null;
  /** `YYYY-MM-DD` in America/New_York — the session whose close this point stamps. */
  et_date: string | null;
  /** `HH:mm:ss` in America/New_York (the point is the session close, ~23:59:59 ET). */
  et_time: string | null;
  em_amt: number | null;
  em_pct: number | null;
  low: number | null;
  high: number | null;
  avg_iv: number | null;
}

export interface ChainRow {
  option_type: "CALL" | "PUT";
  strike: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  oi: number | null;
  iv_pct: number | null;
  delta: number | null;
}

export interface StatsRow {
  expiration: string;
  kind: "weekly" | "monthly";
  dte: number | null;
  [column: string]: unknown;
}
