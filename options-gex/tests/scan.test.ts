/** Scan selection, projection and concurrency tests (no network). */

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanEntry, scanTicker, selectExpirations, type LoadedSnapshot, type SnapshotLoader } from "../src/scan.ts";
import type { Snapshot } from "../src/types.ts";

function makeSnapshot(exp: string, netGex: number, spot = 100): Snapshot {
  return {
    source: "rest",
    url: `https://example.test/${exp}`,
    ticker: "TEST",
    selected_exp: exp,
    spot,
    gamma_flip: spot - 1,
    call_wall: spot + 2,
    put_wall: spot - 2,
    max_pain: spot,
    net_gex: netGex,
    implied_move_pct: 1.2,
    stm_iv: 20,
    pc_oi_ratio: 1.1,
    bullish_score: 60,
    insights: [],
    expiration_dates: [],
    strikes: [],
    net_by_strike: {},
    warnings: [],
    meta: { status: 200, latency_ms: 1, from_cache: false },
  };
}

test("selectExpirations keeps only the requested window, ascending", () => {
  const dates = ["2026-10-05", "2026-10-07", "2026-10-12", "2026-10-20"];
  assert.deepEqual(selectExpirations(dates, "2026-10-05", 7, 12), [
    "2026-10-05",
    "2026-10-07",
    "2026-10-12",
  ]);
  assert.deepEqual(selectExpirations(dates, "2026-10-05", 1, 12), ["2026-10-05"]);
  assert.deepEqual(selectExpirations(dates, "2026-10-05", 30, 2), ["2026-10-05", "2026-10-07"]);
});

test("scanEntry projects the compact scalar schema", () => {
  const entry = scanEntry(makeSnapshot("2026-10-09", -1_500_000_000), "2026-10-05");
  assert.equal(entry.exp, "2026-10-09");
  assert.equal(entry.dte, 4);
  assert.equal(entry.net_gex_usd, "-$1.50B");
  assert.equal(entry.regime, "negative");
  assert.equal(entry.spot_vs_flip, "above");
  assert.equal(entry.bullish_score, 60);
  assert.equal("insights" in entry, false);
});

test("scanTicker pins the calendar, scans the window and reports sign flips", async () => {
  const dates = ["2026-10-05", "2026-10-07", "2026-10-09", "2026-10-20"];
  const gex: Record<string, number> = {
    "2026-10-05": 500,
    "2026-10-07": 400,
    "2026-10-09": -900,
  };
  const calls: string[] = [];
  const load: SnapshotLoader = async (ticker, exp) => {
    assert.equal(ticker, "TEST");
    calls.push(exp ?? "nearest");
    const snapshot = makeSnapshot(exp ?? "2026-10-05", gex[exp ?? "2026-10-05"]);
    snapshot.expiration_dates = dates;
    return { snapshot, extraWarnings: [] } satisfies LoadedSnapshot;
  };

  const result = await scanTicker("TEST", load, {
    dte: 7,
    today: "2026-10-05",
    concurrency: 2,
    maxExpirations: 12,
  });

  assert.equal(result.expirations_scanned, 3);
  assert.deepEqual(
    result.scan.map((row) => row.exp),
    ["2026-10-05", "2026-10-07", "2026-10-09"],
  );
  assert.deepEqual(result.sign_flips, [
    { from_exp: "2026-10-07", to_exp: "2026-10-09", from: 400, to: -900 },
  ]);
  assert.equal(result.errors.length, 0);
  // The first fetch pins the calendar; the remaining two are fetched once each.
  assert.equal(calls.length, 3);
});

test("scanTicker records per-expiry failures and never exceeds the concurrency cap", async () => {
  const dates = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
  let inFlight = 0;
  let peak = 0;
  const load: SnapshotLoader = async (_ticker, exp) => {
    if (exp === "2026-10-06") throw new Error("boom");
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const snapshot = makeSnapshot(exp ?? "2026-10-05", 100);
    snapshot.expiration_dates = dates;
    return { snapshot, extraWarnings: [] };
  };

  const result = await scanTicker("TEST", load, {
    dte: 7,
    today: "2026-10-05",
    concurrency: 2,
    maxExpirations: 12,
  });

  assert.equal(result.expirations_scanned, 3);
  assert.deepEqual(result.errors, [{ exp: "2026-10-06", error: "boom" }]);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});
