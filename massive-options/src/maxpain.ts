/**
 * Max pain: the strike at which the total dollar value of expiring in-the-money
 * options is smallest — i.e. the settlement price that costs option holders the
 * most and option writers the least.
 *
 *   pain(S) = Σ_calls OI·max(0, S − K) + Σ_puts OI·max(0, K − S), × multiplier
 *
 * Candidate settlement prices are the strikes actually listed in the chain
 * (the conventional definition). The result is an output of *reported open
 * interest*, so it inherits the same staleness caveat as GEX: OI is the end of
 * the previous session and long/short is not netted.
 */

import type { Contract } from "./types.ts";

export interface PainPoint {
  strike: number;
  /** Total dollars paid out to holders if the underlying settles here. */
  pain: number;
  callItm: number;
  putItm: number;
  callOi: number;
  putOi: number;
}

export interface MaxPainGroup {
  /** Expiration date, or `ALL` for the cross-expiry aggregate. */
  expiry: string;
  dte: number | null;
  maxPain: number | null;
  painAtMaxPain: number | null;
  /** Signed distance from spot in percent. */
  distancePct: number | null;
  callOi: number;
  putOi: number;
  contracts: number;
  /** Five cheapest settlement prices, ascending pain. */
  top: PainPoint[];
  /** Full pain curve across every listed strike. */
  curve: PainPoint[];
}

export interface MaxPainReport {
  underlying: string;
  spot: number;
  unit: "USD notional payout";
  multiplier: number | "per-contract";
  expirations: MaxPainGroup[];
  total: MaxPainGroup;
  contractsUsed: number;
  contractsSkipped: number;
}

export interface MaxPainOptions {
  spot: number;
  multiplier?: number;
}

function buildGroup(key: string, dte: number | null, contracts: Contract[], opts: MaxPainOptions): MaxPainGroup {
  const callOiByStrike = new Map<number, number>();
  const putOiByStrike = new Map<number, number>();
  let callOi = 0;
  let putOi = 0;

  for (const c of contracts) {
    if (c.oi <= 0) continue;
    if (c.type === "call") {
      callOiByStrike.set(c.strike, (callOiByStrike.get(c.strike) ?? 0) + c.oi);
      callOi += c.oi;
    } else if (c.type === "put") {
      putOiByStrike.set(c.strike, (putOiByStrike.get(c.strike) ?? 0) + c.oi);
      putOi += c.oi;
    }
  }

  const strikes = [...new Set([...callOiByStrike.keys(), ...putOiByStrike.keys()])].sort((a, b) => a - b);

  const curve: PainPoint[] = strikes.map((S) => {
    let callItm = 0;
    for (const [K, oi] of callOiByStrike) {
      if (K < S) callItm += oi * (S - K);
    }
    let putItm = 0;
    for (const [K, oi] of putOiByStrike) {
      if (K > S) putItm += oi * (K - S);
    }
    return {
      strike: S,
      pain: (callItm + putItm) * multiplierOf(contracts, opts),
      callItm,
      putItm,
      callOi: callOiByStrike.get(S) ?? 0,
      putOi: putOiByStrike.get(S) ?? 0,
    };
  });

  const ranked = [...curve].sort((a, b) => a.pain - b.pain || a.strike - b.strike);
  const best = ranked[0] ?? null;

  return {
    expiry: key,
    dte,
    maxPain: best ? best.strike : null,
    painAtMaxPain: best ? best.pain : null,
    distancePct: best && opts.spot > 0 ? ((best.strike - opts.spot) / opts.spot) * 100 : null,
    callOi,
    putOi,
    contracts: contracts.filter((c) => c.oi > 0).length,
    top: ranked.slice(0, 5),
    curve,
  };
}

/** Per-contract multiplier: the explicit flag, or the chain's convention. */
function multiplierOf(contracts: Contract[], opts: MaxPainOptions): number {
  if (opts.multiplier !== undefined) return opts.multiplier;
  if (contracts.length > 0) return contracts[0]!.sharesPerContract || 100;
  return 100;
}

export function computeMaxPain(contracts: Contract[], opts: MaxPainOptions): MaxPainReport {
  const usable = contracts.filter((c) => c.oi > 0);
  const byExpiry = new Map<string, Contract[]>();
  for (const c of usable) {
    const arr = byExpiry.get(c.expiry);
    if (arr) arr.push(c);
    else byExpiry.set(c.expiry, [c]);
  }

  const expirations = [...byExpiry.keys()].sort();
  const groups = expirations.map((e) => {
    const rows = byExpiry.get(e)!;
    return buildGroup(e, Math.min(...rows.map((r) => r.dte)), rows, opts);
  });

  const all = usable;
  const total = all.length > 0 ? buildGroup("ALL", Math.min(...all.map((r) => r.dte)), all, opts) : buildGroup("ALL", null, [], opts);

  return {
    underlying: contracts[0]?.underlying ?? "",
    spot: opts.spot,
    unit: "USD notional payout",
    multiplier: opts.multiplier ?? "per-contract",
    expirations: groups,
    total,
    contractsUsed: usable.length,
    contractsSkipped: contracts.length - usable.length,
  };
}
