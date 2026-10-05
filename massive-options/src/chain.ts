/**
 * Chain loading: resolves the underlying spot price, discovers short-dated
 * expirations, and pulls `/v3/snapshot/options/{underlying}` into a flat
 * `Contract[]` (open interest + greeks + quotes).
 *
 * Two sources are supported:
 *   1. live API  — needs an options plan that includes the chain snapshot
 *   2. `--from-file` — a saved snapshot response, so GEX/max-pain can be
 *      reproduced offline or fed from another open-interest source
 */

import { EntitlementError, MassiveClient, NotFoundError, PRICING_URL, redactUrl } from "./api.ts";
import type {
  AggregateBar,
  Contract,
  ContractType,
  OptionChainSnapshotResponse,
  OptionContractRef,
  OptionSnapshotResult,
  StockSnapshotResponse,
} from "./types.ts";

export const CHAIN_ENDPOINT = (underlying: string): string =>
  `/v3/snapshot/options/${encodeURIComponent(underlying)}`;
export const CONTRACTS_ENDPOINT = "/v3/reference/options/contracts";

/** Plans that include the option chain snapshot (open interest + greeks). */
export const CHAIN_PLAN_HINT =
  `the option chain snapshot is included from the "Options Starter" plan up ` +
  `(Options Basic does not include it) — see ${PRICING_URL}`;

export const STOCK_SNAPSHOT_HINT =
  `stock snapshots require a stocks plan; this skill falls back to the delayed ` +
  `previous-day bar (/v2/aggs/ticker/{ticker}/prev) when they are unavailable`;

export interface SpotInfo {
  price: number;
  source: "snapshot" | "stock-snapshot" | "previous-close" | "open-close" | "file" | "flag";
  /** `REAL-TIME`, `DELAYED`, or `UNKNOWN`. */
  timeframe: string;
  asOf: string | null;
}

export interface ExpiryInfo {
  expiry: string;
  dte: number;
}

export interface ChainLoad {
  underlying: string;
  spot: SpotInfo;
  /** All expirations present in the loaded snapshot, ascending. */
  expirations: ExpiryInfo[];
  /** Filtered to the requested expirations / dte window. */
  contracts: Contract[];
  /** Contracts dropped because the snapshot carried no gamma and no IV. */
  missingGreeks: number;
  /** Contracts whose gamma was reconstructed with Black-Scholes. */
  gammaFromBlackScholes: number;
  /** Contracts without an `open_interest` field. */
  missingOpenInterest: number;
  pages: number;
  requests: number;
  truncated: boolean;
  warnings: string[];
}

/* ------------------------------------------------------------------ dates */

const ET_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in US/Eastern (market time), as YYYY-MM-DD. */
export function etToday(now: Date = new Date()): string {
  return ET_DATE.format(now);
}

/** Whole calendar days from `from` (YYYY-MM-DD) to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Valid YYYY-MM-DD literal. */
export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}

/** Time to expiry in years, assuming a 16:00 ET (≈20:00 UTC) expiry moment. */
export function yearsToExpiry(expiry: string, now: Date = new Date()): number {
  const t = Date.parse(`${expiry}T20:00:00Z`);
  if (!Number.isFinite(t)) return Number.NaN;
  const years = (t - now.getTime()) / (365 * 86_400_000);
  // 0DTE contracts: keep the number positive so gamma stays finite.
  return Math.max(years, 1 / (365 * 48));
}

/* -------------------------------------------------------------- analytics */

/** Standard normal probability density. */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes gamma per $1 of underlying, used only when the snapshot does
 * not return greeks (deep ITM contracts are a common case).
 */
export function blackScholesGamma(S: number, K: number, T: number, sigma: number, r = 0.04): number | null {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const g = normalPdf(d1) / (S * sigma * sqrtT);
  return Number.isFinite(g) && g >= 0 ? g : null;
}

/**
 * Snapshot `implied_volatility` is usually a decimal (0.3049) but has been
 * observed in percentage points (5 = 500%). Normalise, and drop implausible
 * values instead of silently producing garbage gammas.
 */
export function normalizeIv(v: number | undefined | null): number | null {
  if (v === undefined || v === null || !Number.isFinite(v) || v <= 0) return null;
  const iv = v > 3 ? v / 100 : v;
  return iv > 0 && iv <= 10 ? iv : null;
}

function contractType(raw: string | undefined): ContractType {
  if (raw === "call" || raw === "put") return raw;
  return "other";
}

/* --------------------------------------------------------------- spot price */

export interface SpotOptions {
  asOf?: string;
  /** Skip the (plan-gated) stock snapshot and go straight to delayed data. */
  preferDelayed?: boolean;
  /** Explicit override, e.g. `--spot 640.5`. */
  override?: number;
}

/** Resolve the underlying price, degrading gracefully across plan tiers. */
export async function resolveSpot(
  client: MassiveClient,
  underlying: string,
  opts: SpotOptions = {},
): Promise<SpotInfo> {
  if (opts.override !== undefined && Number.isFinite(opts.override)) {
    return { price: opts.override, source: "flag", timeframe: "UNKNOWN", asOf: opts.asOf ?? null };
  }

  if (!opts.preferDelayed) {
    try {
      const snap = await client.rawGet<StockSnapshotResponse>(
        `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(underlying)}`,
      );
      const t = snap.ticker;
      const price = t?.lastTrade?.p ?? t?.min?.c ?? t?.day?.c ?? t?.prevDay?.c;
      if (typeof price === "number" && price > 0) {
        return {
          price,
          source: "stock-snapshot",
          timeframe: "REAL-TIME",
          asOf: t?.updated ? new Date(t.updated / 1e6).toISOString() : null,
        };
      }
    } catch (err) {
      if (!(err instanceof EntitlementError)) throw err;
      // fall through to delayed aggregates
    }
  }

  try {
    const prev = await client.rawGet<{ results?: AggregateBar[]; status?: string }>(
      `/v2/aggs/ticker/${encodeURIComponent(underlying)}/prev`,
    );
    const bar = prev.results?.[0];
    if (bar && typeof bar.c === "number" && bar.c > 0) {
      return {
        price: bar.c,
        source: "previous-close",
        // The previous-day bar is always end-of-day data, whatever the plan.
        timeframe: "END-OF-DAY",
        asOf: bar.t ? new Date(bar.t).toISOString().slice(0, 10) : null,
      };
    }
  } catch (err) {
    if (!(err instanceof EntitlementError)) throw err;
  }

  if (opts.asOf) {
    const oc = await client.rawGet<{ close?: number; status?: string }>(
      `/v1/open-close/${encodeURIComponent(underlying)}/${opts.asOf}`,
    );
    if (typeof oc.close === "number" && oc.close > 0) {
      return { price: oc.close, source: "open-close", timeframe: "DELAYED", asOf: opts.asOf };
    }
  }

  throw new EntitlementError(`Could not determine the price of ${underlying}.`, {
    hint:
      "pass --spot <price> to supply it manually, or check that the ticker is a " +
      "US stock/ETF symbol (indices need --spot)",
  });
}

/* ------------------------------------------------------------ expirations */

export interface ExpiryQuery {
  /** Horizon in calendar days from the reference date; default 7. */
  dte?: number;
  asOf?: string;
  expirations?: string[];
  /** Max expirations to keep (nearest first). */
  maxExpiries?: number;
  spot?: number;
}

/**
 * Discover expiration dates, cheapest first.
 *
 * `/v3/reference/options/contracts` is available on the entry-level options
 * plan, so this works even when the chain snapshot does not. Restricting to
 * calls inside ±10% of spot keeps the response to a single small page.
 */
export async function listExpiries(
  client: MassiveClient,
  underlying: string,
  query: ExpiryQuery = {},
): Promise<ExpiryInfo[]> {
  const asOf = query.asOf ?? etToday();
  const dte = query.dte ?? 7;
  const to = addDays(asOf, dte);

  const params: Record<string, string | number> = {
    underlying_ticker: underlying,
    "expiration_date.gte": asOf,
    "expiration_date.lte": to,
    contract_type: "call",
    limit: 1000,
    sort: "expiration_date",
    order: "asc",
  };
  if (query.spot && query.spot > 0) {
    params["strike_price.gte"] = Number((query.spot * 0.9).toFixed(2));
    params["strike_price.lte"] = Number((query.spot * 1.1).toFixed(2));
  }

  const collected = await client.collect<OptionContractRef>(CONTRACTS_ENDPOINT, params, {
    maxPages: 5,
    maxItems: 5000,
  });

  const uniq = new Set<string>();
  for (const row of collected.results) {
    const e = row.expiration_date;
    if (e && isIsoDate(e)) uniq.add(e);
  }

  let expiries = [...uniq]
    .filter((e) => {
      const d = daysBetween(asOf, e);
      return d >= 0 && d <= dte;
    })
    .sort()
    .map((expiry) => ({ expiry, dte: daysBetween(asOf, expiry) }));

  if (query.expirations?.length) {
    const wanted = new Set(query.expirations);
    for (const e of wanted) {
      if (!expiries.some((x) => x.expiry === e)) {
        expiries.push({ expiry: e, dte: daysBetween(asOf, e) });
      }
    }
    expiries = expiries.filter((x) => wanted.has(x.expiry)).sort((a, b) => a.expiry.localeCompare(b.expiry));
  }

  if (query.maxExpiries && expiries.length > query.maxExpiries) {
    expiries = expiries.slice(0, query.maxExpiries);
  }
  return expiries;
}

/* ------------------------------------------------------------------ chain */

export interface ChainQuery extends ExpiryQuery {
  /** Keep only strikes within ±pct of spot (e.g. 0.25 = ±25%). */
  strikeRangePct?: number;
  minOpenInterest?: number;
  /** Hard cap on contracts kept (nearest expiry first). */
  maxContracts?: number;
  maxPages?: number;
  maxItems?: number;
  /** Reference "now" for DTE maths in offline mode. */
  now?: Date;
  /** Risk-free rate used by the Black-Scholes gamma fallback. */
  rate?: number;
  /** Reconstruct missing gammas from IV (default true). */
  gammaFallback?: boolean;
}

function toContract(row: OptionSnapshotResult, ctx: { underlying: string; asOf: string; now: Date; spot: number | null; rate: number; gammaFallback: boolean }): Contract | null {
  const d = row.details;
  const ticker = d?.ticker;
  const expiry = d?.expiration_date;
  const strike = d?.strike_price;
  if (!ticker || !expiry || typeof strike !== "number") return null;

  const iv = normalizeIv(row.implied_volatility);
  const snapshotGamma = row.greeks?.gamma;
  let gamma: number | null = typeof snapshotGamma === "number" && snapshotGamma >= 0 ? snapshotGamma : null;
  let gammaSource: Contract["gammaSource"] = gamma === null ? "none" : "snapshot";

  if (gamma === null && ctx.gammaFallback && iv !== null && ctx.spot && ctx.spot > 0) {
    const T = yearsToExpiry(expiry, ctx.now);
    const bs = blackScholesGamma(ctx.spot, strike, T, iv, ctx.rate);
    if (bs !== null) {
      gamma = bs;
      gammaSource = "black-scholes";
    }
  }

  const oiMissing = typeof row.open_interest !== "number";
  const bid = row.last_quote?.bid ?? null;
  const ask = row.last_quote?.ask ?? null;
  const mid =
    row.last_quote?.midpoint ?? (typeof bid === "number" && typeof ask === "number" ? (bid + ask) / 2 : null);

  return {
    ticker,
    underlying: ctx.underlying,
    expiry,
    dte: daysBetween(ctx.asOf, expiry),
    strike,
    type: contractType(d?.contract_type),
    oi: oiMissing ? 0 : row.open_interest!,
    oiMissing,
    volume: row.day?.volume ?? 0,
    gamma,
    gammaSource,
    delta: row.greeks?.delta ?? null,
    theta: row.greeks?.theta ?? null,
    vega: row.greeks?.vega ?? null,
    iv,
    bid,
    ask,
    mid,
    lastPrice: row.last_trade?.price ?? row.day?.close ?? null,
    sharesPerContract: d?.shares_per_contract ?? 100,
    timeframe: row.underlying_asset?.timeframe ?? row.last_quote?.timeframe ?? null,
    breakEvenPrice: row.break_even_price ?? null,
  };
}

/** Fetch the option chain snapshot for the requested expirations. */
export async function fetchChain(
  client: MassiveClient,
  underlying: string,
  query: ChainQuery = {},
): Promise<ChainLoad> {
  const warnings: string[] = [];
  const now = query.now ?? new Date();
  const asOf = query.asOf ?? query.expirations?.[0] ?? etToday(now);

  const spot =
    query.spot !== undefined
      ? { price: query.spot, source: "flag" as const, timeframe: "UNKNOWN", asOf }
      : await resolveSpot(client, underlying, { asOf: query.expirations?.[0] ?? etToday(now) });

  const expirations = await listExpiries(client, underlying, { ...query, asOf: query.expirations?.[0] ?? etToday(now), spot: spot.price });
  if (expirations.length === 0) {
      throw new NotFoundError(
        `No option expirations found for ${underlying} within ${query.dte ?? 7} day(s) of ${asOf}.`,
        { hint: "widen the horizon with --dte (e.g. --dte 14) or pass explicit --expiries" },
      );
  }

  const first = expirations[0]!.expiry;
  const last = expirations[expirations.length - 1]!.expiry;
  const endpoint = CHAIN_ENDPOINT(underlying);

  let collected;
  try {
    collected = await client.collect<OptionSnapshotResult>(
      endpoint,
      {
        "expiration_date.gte": first,
        "expiration_date.lte": last,
        limit: 250,
        sort: "expiration_date",
        order: "asc",
      },
      { maxPages: query.maxPages ?? 20, maxItems: query.maxItems ?? 5000 },
    );
  } catch (err) {
    if (err instanceof EntitlementError) {
      throw new EntitlementError(`Not entitled to the ${underlying} option chain snapshot (HTTP 403).`, {
        status: 403,
        endpoint: redactUrl(err.endpoint ?? client.url(endpoint)),
        body: err.body,
        hint: `${CHAIN_PLAN_HINT[0]!.toUpperCase()}${CHAIN_PLAN_HINT.slice(1)}. GEX and max pain need per-contract open interest + gamma, which only this endpoint provides.`,
      });
    }
    throw err;
  }

  const ctx = { underlying, asOf, now, spot: spot.price, rate: query.rate ?? 0.04, gammaFallback: query.gammaFallback ?? true };
  const wanted = new Set(expirations.map((e) => e.expiry));
  const contracts: Contract[] = [];
  let missingGreeks = 0;
  let gammaFromBlackScholes = 0;
  let missingOpenInterest = 0;

  for (const row of collected.results) {
    const c = toContract(row, ctx);
    if (!c) continue;
    if (!wanted.has(c.expiry)) continue;
    if (c.gamma === null) {
      missingGreeks++;
      continue; // contributes nothing to GEX
    }
    if (c.gammaSource === "black-scholes") gammaFromBlackScholes++;
    if (c.oiMissing) missingOpenInterest++;
    contracts.push(c);
  }

  let kept = contracts;
  if (query.strikeRangePct && query.strikeRangePct > 0) {
    const lo = spot.price * (1 - query.strikeRangePct);
    const hi = spot.price * (1 + query.strikeRangePct);
    kept = kept.filter((c) => c.strike >= lo && c.strike <= hi);
  }
  if (query.minOpenInterest && query.minOpenInterest > 0) {
    kept = kept.filter((c) => c.oi >= query.minOpenInterest!);
  }
  if (query.maxContracts && kept.length > query.maxContracts) {
    kept = [...kept]
      .sort((a, b) => a.expiry.localeCompare(b.expiry) || b.oi - a.oi)
      .slice(0, query.maxContracts);
    warnings.push(`contracts truncated to --max-contracts ${query.maxContracts}`);
  }
  if (missingGreeks > 0) {
    warnings.push(`${missingGreeks} contract(s) had no gamma and could not be reconstructed; excluded`);
  }
  if (gammaFromBlackScholes > 0) {
    warnings.push(`${gammaFromBlackScholes} contract(s) used a Black-Scholes gamma fallback`);
  }
  if (missingOpenInterest > 0) {
    warnings.push(`${missingOpenInterest} contract(s) had no open_interest field (treated as 0)`);
  }
  if (collected.truncated) {
    warnings.push("snapshot pagination was capped (--max-pages/--max-items); results are partial");
  }

  return {
    underlying,
    spot,
    expirations,
    contracts: kept,
    missingGreeks,
    gammaFromBlackScholes,
    missingOpenInterest,
    pages: collected.pages,
    requests: client.requests,
    truncated: collected.truncated,
    warnings,
  };
}

/* ------------------------------------------------------------ offline mode */

/**
 * Load a saved chain snapshot from disk. Accepts either the raw API response
 * (`{ results: [...] }`) or a bare array of snapshot rows.
 */
export function parseSnapshotFile(text: string): OptionSnapshotResult[] {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as OptionSnapshotResult[];
  const obj = parsed as OptionChainSnapshotResponse;
  if (obj && Array.isArray(obj.results)) return obj.results;
  throw new Error("snapshot file must be a JSON array or an object with a `results` array");
}

export function normalizeOffline(
  rows: OptionSnapshotResult[],
  opts: { underlying: string; asOf: string; now: Date; spot: number; rate: number; gammaFallback?: boolean; expirations?: string[]; dte?: number; strikeRangePct?: number; minOpenInterest?: number },
): { contracts: Contract[]; expirations: ExpiryInfo[]; missingGreeks: number; gammaFromBlackScholes: number; missingOpenInterest: number } {
  const ctx = { underlying: opts.underlying, asOf: opts.asOf, now: opts.now, spot: opts.spot, rate: opts.rate, gammaFallback: opts.gammaFallback ?? true };
  const all: Contract[] = [];
  let missingGreeks = 0;
  let gammaFromBlackScholes = 0;
  let missingOpenInterest = 0;

  for (const row of rows) {
    const c = toContract(row, ctx);
    if (!c) continue;
    if (c.gamma === null) {
      missingGreeks++;
      continue;
    }
    if (c.gammaSource === "black-scholes") gammaFromBlackScholes++;
    if (c.oiMissing) missingOpenInterest++;
    all.push(c);
  }

  const uniq = new Set(all.map((c) => c.expiry));
  let expirations = [...uniq].sort().map((expiry) => ({ expiry, dte: daysBetween(opts.asOf, expiry) }));
  if (opts.expirations?.length) {
    const wanted = new Set(opts.expirations);
    expirations = expirations.filter((e) => wanted.has(e.expiry));
  } else if (opts.dte !== undefined) {
    const max = opts.dte;
    expirations = expirations.filter((e) => e.dte >= 0 && e.dte <= max);
  }

  const wanted = new Set(expirations.map((e) => e.expiry));
  let contracts = all.filter((c) => wanted.has(c.expiry));
  if (opts.strikeRangePct && opts.strikeRangePct > 0) {
    const lo = opts.spot * (1 - opts.strikeRangePct);
    const hi = opts.spot * (1 + opts.strikeRangePct);
    contracts = contracts.filter((c) => c.strike >= lo && c.strike <= hi);
  }
  if (opts.minOpenInterest && opts.minOpenInterest > 0) {
    contracts = contracts.filter((c) => c.oi >= opts.minOpenInterest!);
  }

  return { contracts, expirations, missingGreeks, gammaFromBlackScholes, missingOpenInterest };
}
