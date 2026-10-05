/** Unit tests for the GEX / max-pain maths and the snapshot normalisation. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  blackScholesGamma,
  daysBetween,
  etToday,
  normalizeIv,
  normalizeOffline,
  parseSnapshotFile,
} from "../src/chain.ts";
import { computeGex, contractGex, signFor } from "../src/gex.ts";
import { computeMaxPain } from "../src/maxpain.ts";
import type { Contract, OptionSnapshotResult } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const AS_OF = "2026-10-02";
const NOW = new Date("2026-10-02T14:00:00Z");
const SPOT = 100;

function chain(dte: number, extra: Partial<Parameters<typeof normalizeOffline>[1]> = {}) {
  const rows = parseSnapshotFile(readFileSync(join(HERE, "fixtures/snapshot-test.json"), "utf8"));
  return normalizeOffline(rows, { underlying: "TEST", asOf: AS_OF, now: NOW, spot: SPOT, rate: 0.04, dte, ...extra });
}

function row(partial: Partial<OptionSnapshotResult>): OptionSnapshotResult {
  return partial as OptionSnapshotResult;
}

/* ------------------------------------------------------------ GEX formula */

test("contractGex follows gamma * OI * multiplier * spot^2 * 0.01", () => {
  const c: Contract = {
    ticker: "O:TEST261009C00100000",
    underlying: "TEST",
    expiry: "2026-10-09",
    dte: 7,
    strike: 100,
    type: "call",
    oi: 200,
    oiMissing: false,
    volume: 0,
    gamma: 0.06,
    gammaSource: "snapshot",
    delta: null,
    theta: null,
    vega: null,
    iv: 0.3,
    bid: null,
    ask: null,
    mid: null,
    lastPrice: null,
    sharesPerContract: 100,
    timeframe: "DELAYED",
    breakEvenPrice: null,
  };
  assert.equal(contractGex(c, 100), 120_000);
  assert.equal(contractGex(c, 100, 10), 12_000);
});

test("sign modes", () => {
  assert.equal(signFor("call", "dealer"), 1);
  assert.equal(signFor("put", "dealer"), -1);
  assert.equal(signFor("put", "absolute"), 1);
  assert.equal(signFor("call", "inverse"), -1);
  assert.equal(signFor("other", "dealer"), 0);
});

test("GEX for the ~1-week chain matches hand-computed values", () => {
  const c = chain(7);
  assert.equal(c.contracts.length, 6, "only the 2026-10-09 expiry is inside a 7-day window");
  assert.deepEqual(
    c.expirations.map((e) => e.expiry),
    ["2026-10-09"],
  );

  const report = computeGex(c.contracts, { spot: SPOT });
  assert.equal(report.total.gex, 14_000);
  assert.equal(report.total.callGex, 145_000);
  assert.equal(report.total.putGex, -131_000);
  assert.equal(report.total.callOi, 350);
  assert.equal(report.total.putOi, 570);
  assert.ok(Math.abs(report.total.putCallOiRatio - 570 / 350) < 1e-12);

  // Per-strike net exposure, lowest strike first
  assert.deepEqual(
    report.total.strikes.map((s) => [s.strike, s.gex]),
    [
      [95, -10_000],
      [100, 20_000],
      [105, 4_000],
    ],
  );

  // Gamma flip between 95 (cum -10k) and 100 (cum +10k) => 97.5
  assert.equal(report.total.zeroGammaStrike, 100);
  assert.ok(Math.abs((report.total.zeroGamma ?? 0) - 97.5) < 1e-9);

  assert.equal(report.total.callWall?.strike, 100);
  assert.equal(report.total.callWall?.exposure, 120_000);
  assert.equal(report.total.putWall?.strike, 100);
  assert.equal(report.total.putWall?.exposure, 100_000);
  assert.ok(Math.abs((report.total.callWall?.distancePct ?? 0)) < 1e-9);
});

test("GEX across two expiries aggregates and moves the flip level", () => {
  const c = chain(60);
  assert.equal(c.expirations.length, 2);
  const report = computeGex(c.contracts, { spot: SPOT });
  assert.equal(report.total.gex, 8_000); // 14_000 (Oct) + -6_000 (Nov)
  assert.equal(report.total.expirations.length, 2);
  assert.ok(Math.abs((report.total.zeroGamma ?? 0) - (95 + 5 * (10_000 / 13_000))) < 1e-9);
});

test("sign modes change the net total but not the walls", () => {
  const c = chain(7);
  const dealer = computeGex(c.contracts, { spot: SPOT, signMode: "dealer" });
  const absolute = computeGex(c.contracts, { spot: SPOT, signMode: "absolute" });
  const inverse = computeGex(c.contracts, { spot: SPOT, signMode: "inverse" });

  assert.equal(absolute.total.gex, 276_000);
  assert.equal(inverse.total.gex, -14_000);
  assert.deepEqual(
    dealer.total.topExposures.map((s) => s.strike),
    absolute.total.topExposures.map((s) => s.strike),
  );
});

test("contracts without open interest are skipped, not treated as exposure", () => {
  const c = chain(7);
  const withZeroOi = c.contracts.map((x) => (x.strike === 105 && x.type === "call" ? { ...x, oi: 0 } : x));
  const report = computeGex(withZeroOi, { spot: SPOT });
  assert.equal(report.total.gex, 14_000 - 5_000);
  assert.equal(report.contractsSkipped, 1);
});

/* ------------------------------------------------------------ max pain */

test("max pain picks the strike with the smallest ITM payout", () => {
  const c = chain(7);
  const report = computeMaxPain(c.contracts, { spot: SPOT });
  assert.equal(report.total.maxPain, 100);
  assert.equal(report.total.painAtMaxPain, 60_000);
  assert.deepEqual(
    report.total.top.map((p) => [p.strike, p.pain]),
    [
      [100, 60_000],
      [95, 145_000],
      [105, 200_000],
    ],
  );
  assert.equal(report.total.callOi, 350);
  assert.equal(report.total.putOi, 570);
  assert.equal(report.expirations[0]?.expiry, "2026-10-09");
});

test("max pain aggregates both expiries when the horizon allows", () => {
  const c = chain(60);
  const report = computeMaxPain(c.contracts, { spot: SPOT });
  assert.equal(report.expirations.length, 2);
  assert.equal(report.total.maxPain, 100);
  assert.equal(report.total.painAtMaxPain, 60_000);
  // 110 only has calls, so settling there is the most expensive outcome
  assert.equal(report.total.curve.at(-1)?.strike, 110);
  assert.equal(report.total.curve.at(-1)?.pain, 385_000);
});

test("max pain with an explicit multiplier", () => {
  const c = chain(7);
  const report = computeMaxPain(c.contracts, { spot: SPOT, multiplier: 10 });
  assert.equal(report.total.painAtMaxPain, 6_000);
});

/* -------------------------------------------------- greeks & normalisation */

test("blackScholesGamma is positive, peaks at the money and decays away", () => {
  const atm = blackScholesGamma(100, 100, 7 / 365, 0.3, 0.04);
  const otm = blackScholesGamma(100, 120, 7 / 365, 0.3, 0.04);
  const itm = blackScholesGamma(100, 80, 7 / 365, 0.3, 0.04);
  assert.ok(atm && atm > 0);
  assert.ok(atm > otm! && atm > itm!);
  assert.equal(blackScholesGamma(100, 100, 0, 0.3), null);
  assert.equal(blackScholesGamma(100, 100, 7 / 365, 0), null);
});

test("normalizeIv accepts decimals and percentage points, rejects junk", () => {
  assert.equal(normalizeIv(0.3049), 0.3049);
  assert.equal(normalizeIv(5), 0.05);
  assert.equal(normalizeIv(0), null);
  assert.equal(normalizeIv(-1), null);
  assert.equal(normalizeIv(12), 0.12, "percentage points above 3 are scaled down");
  assert.equal(normalizeIv(1200), null, "an implausible result is refused");
  assert.equal(normalizeIv(undefined), null);
});

test("missing gammas are reconstructed from IV (and can be disabled)", () => {
  const rows = [
    row({
      details: { ticker: "O:TEST261009C00120000", contract_type: "call", expiration_date: "2026-10-09", strike_price: 120, shares_per_contract: 100 },
      implied_volatility: 0.25,
      open_interest: 10,
      underlying_asset: { price: SPOT, ticker: "TEST", timeframe: "DELAYED" },
    }),
    row({
      details: { ticker: "O:TEST261009C00130000", contract_type: "call", expiration_date: "2026-10-09", strike_price: 130, shares_per_contract: 100 },
      open_interest: 5,
      underlying_asset: { price: SPOT, ticker: "TEST", timeframe: "DELAYED" },
    }),
  ];
  const fallback = normalizeOffline(rows, { underlying: "TEST", asOf: AS_OF, now: NOW, spot: SPOT, rate: 0.04 });
  assert.equal(fallback.contracts.length, 1, "the contract with neither gamma nor IV is dropped");
  assert.equal(fallback.gammaFromBlackScholes, 1);
  assert.equal(fallback.missingGreeks, 1);
  assert.equal(fallback.contracts[0]?.gammaSource, "black-scholes");
  assert.ok((fallback.contracts[0]?.gamma ?? 0) > 0);

  const noFallback = normalizeOffline(rows, { underlying: "TEST", asOf: AS_OF, now: NOW, spot: SPOT, rate: 0.04, gammaFallback: false });
  assert.equal(noFallback.contracts.length, 0);
  assert.equal(noFallback.missingGreeks, 2);
});

test("missing open interest is reported rather than fabricated", () => {
  const rows = [
    row({
      details: { ticker: "O:TEST261009C00140000", contract_type: "call", expiration_date: "2026-10-09", strike_price: 140, shares_per_contract: 100 },
      greeks: { gamma: 0.01 },
      underlying_asset: { price: SPOT, ticker: "TEST", timeframe: "DELAYED" },
    }),
  ];
  const c = normalizeOffline(rows, { underlying: "TEST", asOf: AS_OF, now: NOW, spot: SPOT, rate: 0.04 });
  assert.equal(c.missingOpenInterest, 1);
  assert.equal(c.contracts[0]?.oi, 0);
  assert.equal(computeGex(c.contracts, { spot: SPOT }).contractsUsed, 0);
});

test("strike range and min-OI filters", () => {
  const wide = chain(7, { strikeRangePct: 0.06 });
  assert.deepEqual(
    wide.contracts.map((c) => c.strike).sort((a, b) => a - b),
    [95, 95, 100, 100, 105, 105],
  );
  const narrow = chain(7, { strikeRangePct: 0.01 });
  assert.deepEqual([...new Set(narrow.contracts.map((c) => c.strike))], [100]);

  const bigOi = chain(7, { minOpenInterest: 200 });
  assert.deepEqual(
    [...new Set(bigOi.contracts.map((c) => c.strike))].sort((a, b) => a - b),
    [95, 100],
  );
});

/* --------------------------------------------------------- small helpers */

test("date helpers", () => {
  assert.equal(daysBetween("2026-10-02", "2026-10-09"), 7);
  assert.equal(daysBetween("2026-10-02", "2026-10-02"), 0);
  assert.equal(etToday(new Date("2026-10-02T23:30:00Z")), "2026-10-02");
  assert.equal(etToday(new Date("2026-10-03T02:00:00Z")), "2026-10-02", "ET is still on the previous day");
});

test("parseSnapshotFile accepts a bare array too", () => {
  const rows = parseSnapshotFile('[{"details":{"ticker":"x"}}]');
  assert.equal(rows.length, 1);
  assert.throws(() => parseSnapshotFile('{"nope":1}'));
});
