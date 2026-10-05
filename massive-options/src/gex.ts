/**
 * Gamma exposure (GEX) analytics.
 *
 * Definition used here — the industry-standard "dollar gamma per 1% move":
 *
 *   GEX_contract = gamma × open_interest × shares_per_contract × spot² × 0.01
 *
 * `gamma` is ∂delta/∂S, so `gamma × OI × 100` is the dollar change in dealer
 * delta per $1 move in the underlying; scaling by `spot² × 0.01` restates it as
 * the dollars of delta that must be re-hedged per **1% move**. Positive GEX
 * means dealer hedging dampens moves (they sell rallies, buy dips); negative
 * GEX means hedging amplifies them.
 *
 * Sign convention: calls `+`, puts `−` under the default `dealer` mode (the
 * usual "long call gamma / short put gamma" assumption). `--sign-mode` switches
 * to `absolute` (all positive) or `inverse`.
 *
 * Caveat to repeat when reporting: GEX aggregates *reported open interest*
 * under a dealer-intermediation assumption. Open interest is the end of the
 * previous session, not a live position report.
 */

import type { Contract } from "./types.ts";

export type SignMode = "dealer" | "absolute" | "inverse";

export const SIGN_MODES: SignMode[] = ["dealer", "absolute", "inverse"];

export function signFor(type: Contract["type"], mode: SignMode): number {
  if (mode === "absolute") return 1;
  if (mode === "inverse") return type === "put" ? 1 : type === "call" ? -1 : 0;
  return type === "call" ? 1 : type === "put" ? -1 : 0;
}

export interface GexOptions {
  spot: number;
  /** Contract multiplier override; defaults to each contract's shares_per_contract. */
  multiplier?: number;
  signMode?: SignMode;
}

export interface StrikeExposure {
  strike: number;
  /** Signed net GEX in USD per 1% move (calls + puts under the chosen mode). */
  gex: number;
  /** Signed contribution of call open interest gamma. */
  callGex: number;
  /** Signed contribution of put open interest gamma. */
  putGex: number;
  /** Unsigned call gamma exposure (used for the call wall). */
  callExposure: number;
  /** Unsigned put gamma exposure (used for the put wall). */
  putExposure: number;
  callOi: number;
  putOi: number;
  netOi: number;
  /** Contracts contributing at this strike. */
  contracts: number;
  /** Running signed GEX from the lowest strike upwards. */
  cumulativeGex: number;
}

export interface WallLevel {
  strike: number;
  /** Unsigned exposure of the dominant side, USD per 1% move. */
  exposure: number;
  /** Signed net GEX at that strike. */
  netGex: number;
  /** Distance from spot in percent (negative = below spot). */
  distancePct: number;
}

export interface GexGroup {
  /** Expiration date, or `ALL` for the cross-expiry aggregate. */
  expiry: string;
  dte: number | null;
  /** Expirations contributing to this group. */
  expirations: string[];
  gex: number;
  callGex: number;
  putGex: number;
  callOi: number;
  putOi: number;
  putCallOiRatio: number;
  contracts: number;
  /** Strike where cumulative GEX flips sign, linearly interpolated. */
  zeroGamma: number | null;
  /** Nearest listed strike at which cumulative GEX turns non-negative. */
  zeroGammaStrike: number | null;
  /** Largest call gamma concentration. */
  callWall: WallLevel | null;
  /** Largest put gamma concentration. */
  putWall: WallLevel | null;
  /** Largest |net GEX| strikes, descending. */
  topExposures: StrikeExposure[];
  strikes: StrikeExposure[];
}

export interface GexReport {
  underlying: string;
  spot: number;
  unit: "USD per 1% move";
  signMode: SignMode;
  multiplier: number | "per-contract";
  expirations: GexGroup[];
  total: GexGroup;
  contractsUsed: number;
  contractsSkipped: number;
}

interface Bucket {
  callGex: number;
  putGex: number;
  callExposure: number;
  putExposure: number;
  callOi: number;
  putOi: number;
  contracts: number;
}

/** GEX of a single contract in USD per 1% move (unsigned). */
export function contractGex(c: Contract, spot: number, multiplier?: number): number {
  const m = multiplier ?? c.sharesPerContract ?? 100;
  const gamma = c.gamma ?? 0;
  return gamma * c.oi * m * spot * spot * 0.01;
}

function newBucket(): Bucket {
  return { callGex: 0, putGex: 0, callExposure: 0, putExposure: 0, callOi: 0, putOi: 0, contracts: 0 };
}

function add(buckets: Map<number, Bucket>, c: Contract, gex: number, sign: number): void {
  let b = buckets.get(c.strike);
  if (!b) {
    b = newBucket();
    buckets.set(c.strike, b);
  }
  b.contracts += 1;
  if (c.type === "put") {
    b.putGex += gex * sign;
    b.putExposure += gex;
    b.putOi += c.oi;
  } else {
    b.callGex += gex * sign;
    b.callExposure += gex;
    b.callOi += c.oi;
  }
}

function mkGroup(
  key: string,
  dte: number | null,
  groupExpirations: string[],
  buckets: Map<number, Bucket>,
  opts: GexOptions,
): GexGroup {
  const strikes = [...buckets.keys()].sort((a, b) => a - b);

  let cumulative = 0;
  let callGex = 0;
  let putGex = 0;
  let callOi = 0;
  let putOi = 0;
  let contracts = 0;

  const rows: StrikeExposure[] = strikes.map((strike) => {
    const b = buckets.get(strike)!;
    const gex = b.callGex + b.putGex;
    cumulative += gex;
    callGex += b.callGex;
    putGex += b.putGex;
    callOi += b.callOi;
    putOi += b.putOi;
    contracts += b.contracts;
    return {
      strike,
      gex,
      callGex: b.callGex,
      putGex: b.putGex,
      callExposure: b.callExposure,
      putExposure: b.putExposure,
      callOi: b.callOi,
      putOi: b.putOi,
      netOi: b.callOi - b.putOi,
      contracts: b.contracts,
      cumulativeGex: cumulative,
    };
  });

  // Gamma flip: first strike (ascending) at which cumulative GEX turns >= 0.
  let zeroGamma: number | null = null;
  let zeroGammaStrike: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.cumulativeGex < 0) continue;
    zeroGammaStrike = row.strike;
    const prev = rows[i - 1];
    if (prev && prev.cumulativeGex < 0) {
      const span = row.cumulativeGex - prev.cumulativeGex;
      const frac = span !== 0 ? -prev.cumulativeGex / span : 0;
      zeroGamma = prev.strike + (row.strike - prev.strike) * frac;
    } else {
      zeroGamma = row.strike;
    }
    break;
  }

  const pct = (strike: number): number => (opts.spot > 0 ? ((strike - opts.spot) / opts.spot) * 100 : 0);

  const bestCall = rows.reduce<StrikeExposure | null>(
    (best, r) => (r.callExposure > (best?.callExposure ?? 0) ? r : best),
    null,
  );
  const bestPut = rows.reduce<StrikeExposure | null>(
    (best, r) => (r.putExposure > (best?.putExposure ?? 0) ? r : best),
    null,
  );

  return {
    expiry: key,
    dte,
    expirations: groupExpirations,
    gex: cumulative,
    callGex,
    putGex,
    callOi,
    putOi,
    putCallOiRatio: callOi > 0 ? putOi / callOi : 0,
    contracts,
    zeroGamma,
    zeroGammaStrike,
    callWall:
      bestCall && bestCall.callExposure > 0
        ? { strike: bestCall.strike, exposure: bestCall.callExposure, netGex: bestCall.gex, distancePct: pct(bestCall.strike) }
        : null,
    putWall:
      bestPut && bestPut.putExposure > 0
        ? { strike: bestPut.strike, exposure: bestPut.putExposure, netGex: bestPut.gex, distancePct: pct(bestPut.strike) }
        : null,
    topExposures: [...rows].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 10),
    strikes: rows,
  };
}

/** Compute per-expiry and cross-expiry GEX for an already-filtered chain. */
export function computeGex(contracts: Contract[], opts: GexOptions): GexReport {
  const signMode = opts.signMode ?? "dealer";
  const byExpiry = new Map<string, Map<number, Bucket>>();
  const aggregate = new Map<number, Bucket>();
  let used = 0;
  let skipped = 0;

  for (const c of contracts) {
    if (c.gamma === null || c.oi <= 0) {
      skipped++;
      continue;
    }
    used++;
    const gex = contractGex(c, opts.spot, opts.multiplier);
    const sign = signFor(c.type, signMode);
    let bucket = byExpiry.get(c.expiry);
    if (!bucket) {
      bucket = new Map();
      byExpiry.set(c.expiry, bucket);
    }
    add(bucket, c, gex, sign);
    add(aggregate, c, gex, sign);
  }

  const expirations = [...byExpiry.keys()].sort();
  const groups = expirations.map((e) =>
    mkGroup(
      e,
      contracts.filter((c) => c.expiry === e).reduce<number | null>((min, c) => (min === null || c.dte < min ? c.dte : min), null),
      [e],
      byExpiry.get(e)!,
      opts,
    ),
  );
  const dtes = contracts.map((c) => c.dte);
  const total = mkGroup("ALL", dtes.length ? Math.min(...dtes) : null, expirations, aggregate, opts);

  return {
    underlying: contracts[0]?.underlying ?? "",
    spot: opts.spot,
    unit: "USD per 1% move",
    signMode,
    multiplier: opts.multiplier ?? "per-contract",
    expirations: groups,
    total,
    contractsUsed: used,
    contractsSkipped: skipped,
  };
}
