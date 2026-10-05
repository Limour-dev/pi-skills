/**
 * Wire types for the Massive options endpoints actually used by this skill.
 *
 * Reference: https://massive.com/docs/rest/options/snapshots/option-chain-snapshot
 */

/** `GET /v3/snapshot/options/{underlyingAsset}` — one element of `results`. */
export interface OptionSnapshotResult {
  break_even_price?: number;
  day?: {
    change?: number;
    change_percent?: number;
    close?: number;
    high?: number;
    low?: number;
    open?: number;
    previous_close?: number;
    volume?: number;
    vwap?: number;
    last_updated?: number;
  };
  details?: {
    contract_type?: string;
    exercise_style?: string;
    expiration_date?: string;
    shares_per_contract?: number;
    strike_price?: number;
    ticker?: string;
  };
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number };
  implied_volatility?: number;
  last_quote?: {
    ask?: number;
    ask_size?: number;
    bid?: number;
    bid_size?: number;
    midpoint?: number;
    last_updated?: number;
    timeframe?: string;
  };
  last_trade?: {
    price?: number;
    size?: number;
    sip_timestamp?: number;
    exchange?: number;
    conditions?: number[];
  };
  open_interest?: number;
  underlying_asset?: {
    change_to_break_even?: number;
    last_updated?: number;
    price?: number;
    ticker?: string;
    timeframe?: string;
  };
}

export interface OptionChainSnapshotResponse {
  status?: string;
  request_id?: string;
  next_url?: string;
  results?: OptionSnapshotResult[];
}

/** `GET /v3/reference/options/contracts` — one element of `results`. */
export interface OptionContractRef {
  cfi?: string;
  contract_type?: string;
  exercise_style?: string;
  expiration_date?: string;
  primary_exchange?: string;
  shares_per_contract?: number;
  strike_price?: number;
  ticker?: string;
  underlying_ticker?: string;
}

/** Aggregate bar (`/v2/aggs/...` and `/v2/aggs/ticker/{t}/prev`). */
export interface AggregateBar {
  T?: string;
  c?: number;
  h?: number;
  l?: number;
  n?: number;
  o?: number;
  t?: number;
  v?: number;
  vw?: number;
}

/** Stock snapshot (`/v2/snapshot/locale/us/markets/stocks/tickers/{t}`). */
export interface StockSnapshotResponse {
  status?: string;
  ticker?: {
    day?: { c?: number; h?: number; l?: number; o?: number; v?: number; vw?: number };
    lastTrade?: { p?: number; t?: number };
    min?: { c?: number };
    prevDay?: { c?: number };
    todaysChange?: number;
    todaysChangePerc?: number;
    updated?: number;
  };
}

export type ContractType = "call" | "put" | "other";

/** A snapshot row normalised into the flat shape the analytics work on. */
export interface Contract {
  ticker: string;
  underlying: string;
  expiry: string;
  /** Calendar days from the reference date to expiry (0 = same-day expiry). */
  dte: number;
  strike: number;
  type: ContractType;
  /** Open interest; `0` when the field is absent, see `oiMissing`. */
  oi: number;
  oiMissing: boolean;
  volume: number;
  /** Dealer-relevant gamma per $1 of underlying; `null` when unavailable. */
  gamma: number | null;
  /** Where `gamma` came from: the snapshot, a Black-Scholes fallback, or nothing. */
  gammaSource: "snapshot" | "black-scholes" | "none";
  delta: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  lastPrice: number | null;
  sharesPerContract: number;
  /** Quote recency reported by the API, e.g. `REAL-TIME` or `DELAYED`. */
  timeframe: string | null;
  breakEvenPrice: number | null;
}
