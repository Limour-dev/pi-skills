/** REST normalisation, projection and number-format regression tests. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fromRest, snapshotFromFileBody } from "../src/normalize.ts";
import { levelBlock, projectGex, selectStrikes, zeroGammaAssessment, zeroGammaEstimate } from "../src/project.ts";
import { cleanNoise, formatUsd, parseScaled, scaleNumber } from "../src/num.ts";
import { DataUnavailableError } from "../src/errors.ts";
import { GREEK_ORDER, type HttpMeta, type RestChain, type Snapshot } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const META: HttpMeta = { status: 200, latency_ms: 12, from_cache: false };

function readJson(name: string): RestChain {
  return JSON.parse(readFileSync(join(FIX, name), "utf8")) as RestChain;
}

function snap(name: string, requestedExp?: string): Snapshot {
  return fromRest(readJson(name), { url: `file://${name}`, meta: META, requestedExp });
}

test("number scaling matches the upstream text rendering", () => {
  assert.equal(formatUsd(544926340.3235289), "$544.93M");
  assert.equal(formatUsd(-1544151621.4830704), "-$1.54B");
  assert.equal(formatUsd(-19669824.96), "-$19.67M");
  assert.equal(formatUsd(0), "$0");
  assert.equal(scaleNumber(16300), "16.30K");
  assert.equal(parseScaled("544.93M"), 544_930_000);
  assert.equal(parseScaled("-520.0K"), -520_000);
  assert.equal(parseScaled("-3.44M"), -3_440_000);
  assert.equal(parseScaled("538"), 538);
  assert.ok(Number.isNaN(parseScaled("n/a")));
});

test("SPY 2026-10-05 gamma fixture normalises to the documented levels", () => {
  const snapshot = snap("spy-2026-10-05-gamma.json");
  assert.equal(snapshot.source, "rest");
  assert.equal(snapshot.ticker, "SPY");
  assert.equal(snapshot.selected_exp, "2026-10-05");
  assert.equal(snapshot.market_session, "pre");
  assert.equal(snapshot.oi_source, "oi");
  assert.equal(snapshot.spot, 769.65);
  assert.equal(snapshot.gamma_flip, 765.79);
  assert.equal(snapshot.call_wall, 770);
  assert.equal(snapshot.call_wall_oi, 3563);
  assert.equal(snapshot.put_wall, 765);
  assert.equal(snapshot.put_wall_oi, 2714);
  assert.equal(snapshot.max_pain, 763);
  assert.equal(snapshot.min_iv_strike, 773);
  assert.equal(snapshot.bullish_score, 75);
  assert.deepEqual(snapshot.warnings, []);

  const levels = levelBlock(snapshot);
  assert.equal(levels.net_gex_usd, "$544.93M");
  assert.equal(levels.spot_vs_flip, "above");
});

test("per-strike GEX sums to net_gex", () => {
  const snapshot = snap("spy-2026-10-05-gamma.json");
  const sum = Object.values(snapshot.gex_by_strike ?? {}).reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - (snapshot.net_gex ?? 0)) < 1e-3);
  assert.equal(Object.keys(snapshot.gex_by_strike ?? {}).length, 151);
  assert.deepEqual(snapshot.strikes.slice(0, 3), [550, 555, 560]);
});

test("a requested but unavailable expiry produces a fallback warning", () => {
  const snapshot = snap("rest-fallback.json", "2019-01-18");
  assert.equal(snapshot.requested_exp, "2019-01-18");
  assert.equal(snapshot.selected_exp, "2026-10-05");
  assert.equal(snapshot.warnings.length, 1);
  assert.match(snapshot.warnings[0], /requested exp 2019-01-18/);
});

test("the `expiration` REST parameter is ignored (nearest expiry wins)", () => {
  // Captured with ?ticker=SPY&expiration=2026-10-16 — the server ignored the parameter.
  const snapshot = snap("rest-ignored-expiration-param.json");
  assert.equal(snapshot.selected_exp, "2026-10-05");
});

test("ok:false REST bodies raise DataUnavailableError (exit 3)", () => {
  const errors = JSON.parse(readFileSync(join(FIX, "rest-errors.json"), "utf8")) as {
    ticker_required: { body: unknown };
    not_found: { body: unknown };
  };
  for (const key of ["ticker_required", "not_found"] as const) {
    assert.throws(
      () =>
        snapshotFromFileBody(JSON.stringify(errors[key].body), {
          url: "file://errors",
          meta: META,
        }),
      (error: unknown) => error instanceof DataUnavailableError && error.exitCode === 3,
    );
  }
});

test("greeks=all exposes all six tables in the upstream order", () => {
  const snapshot = snap("spy-all-greeks.json");
  assert.deepEqual(Object.keys(snapshot.net_by_strike), [...GREEK_ORDER]);
  // Positive/negative/net are reconciled by the server; the CLI only keeps net.
  assert.ok(Math.abs(snapshot.net_by_strike.gamma["770"] - 16266.86) < 1e-6);
});

test("near-zero floating-point noise is cleaned to zero", () => {
  const snapshot = snap("spy-all-greeks.json");
  // Raw payload has -1.33e-7 at 560 and -4.05e-6 at 550.
  assert.equal(snapshot.net_by_strike.gamma["560"], 0);
  assert.equal(snapshot.net_by_strike.gamma["550"], 0);
  const cleaned = cleanNoise({ a: -1.33e-7, b: -25.3, c: 0 });
  assert.equal(cleaned.record.a, 0);
  assert.equal(cleaned.record.b, -25.3);
  assert.equal(cleaned.removed, 1);
});

test("zero-gamma estimate comes from the cumulative curves", () => {
  const positive = snap("spy-2026-10-05-gamma.json");
  assert.equal(zeroGammaEstimate(positive), 770.73);
  const projected = projectGex(positive, { top: 2 });
  assert.equal(projected.zero_gamma_estimate, 770.73);
  assert.equal(projected.zero_gamma_estimate_delta, 4.94);

  // The negative-gamma expiry never crosses zero on the published strike grid.
  const negative = snap("spy-2026-10-16-gamma.json");
  assert.equal(negative.net_gex, -1544151621.4830704);
  assert.equal(negative.gamma_flip, 774.62);
  assert.equal(zeroGammaEstimate(negative), undefined);
});

test("the zero-gamma cross-check is graded by its distance from gamma_flip", () => {
  const positive = snap("spy-2026-10-05-gamma.json");
  const high = zeroGammaAssessment(positive);
  assert.equal(high?.reliability, "high");
  assert.equal(high?.delta, 4.94);
  assert.match(String(high?.note), /small delta is expected/);

  // SPY 10-09 diverged from gamma_flip by ~2.2% of spot in the live scan.
  const diverging = { ...positive, gamma_flip: 750 };
  const low = zeroGammaAssessment(diverging);
  assert.equal(low?.reliability, "low");
  assert.match(String(low?.note), /coarse cross-check only/);
  assert.ok((low?.delta_pct_of_spot ?? 0) > 1);
});

test("strike selection ranks by absolute exposure by default", () => {
  const snapshot = snap("spy-2026-10-05-gamma.json");
  const { strikes, selection } = selectStrikes(snapshot, snapshot.gex_by_strike ?? {}, { top: 5 });
  assert.equal(selection.mode, "top_abs");
  assert.equal(strikes.length, 5);
  assert.ok(strikes.includes(770));
  assert.ok(strikes.includes(775));

  const near = selectStrikes(snapshot, snapshot.gex_by_strike ?? {}, { top: 3, topBy: "nearest" });
  assert.deepEqual(near.strikes, [769, 770, 771]);

  const ranged = selectStrikes(snapshot, snapshot.gex_by_strike ?? {}, { strikeRangePct: 0.5 });
  for (const strike of ranged.strikes) {
    assert.ok(Math.abs(strike - snapshot.spot) <= snapshot.spot * 0.005);
  }
});
