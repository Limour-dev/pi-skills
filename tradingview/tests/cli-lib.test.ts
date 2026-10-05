/**
 * Offline tests for the contract fixes that came out of the USDT.D analysis
 * session: single-sourced timeframes, `--select` narrowing, unknown-flag
 * detection and symbol unit metadata.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, unknownFlags } from "../src/args.ts";
import { columnsOf, renderCsv, renderTable } from "../src/output.ts";
import { PRICE_FIELDS, editDistance, knownFields, nearestField, planSelect, projectRow } from "../src/select.ts";
import { resolutionNote, symbolMeta } from "../src/symbols.ts";
import { TIMEFRAME_HELP, TIMEFRAMES, normalizeTimeframe } from "../src/util.ts";

test("select narrows rows and columns together", () => {
  const rows = [{ time_iso: "2026-10-04T00:00:00.000Z", open: 1, close: 2 }];
  const plan = planSelect(["time_iso", "close"], knownFields(rows));
  assert.deepEqual(plan, { effective: ["time_iso", "close"], unknown: [] });

  const projected = rows.map((row) => projectRow(row, plan.effective));
  assert.deepEqual(projected, [{ time_iso: "2026-10-04T00:00:00.000Z", close: 2 }]);
  assert.deepEqual(columnsOf(projected, plan.effective), ["time_iso", "close"]);
});

test("columnsOf never renders a blank column", () => {
  const rows = [{ time_iso: "2026-10-04T00:00:00.000Z", close: 2 }];
  assert.deepEqual(columnsOf(rows, ["time_iso", "open", "high", "low", "close", "volume"]), ["time_iso", "close"]);
});

test("unknown select fields are separated from the effective ones", () => {
  const plan = planSelect(["time_isoo", "close"], ["time_iso", "close"]);
  assert.deepEqual(plan.unknown, ["time_isoo"]);
  assert.deepEqual(plan.effective, ["close"]);
});

test("unknown flags are detected, known flags are not", () => {
  const bad = parseArgs(["candles", "BTCUSD", "--frobnicate", "--count", "3"]).flags;
  assert.deepEqual(unknownFlags(bad), ["frobnicate"]);

  const good = parseArgs(["indicators", "BTCUSD", "--tf", "4h", "--warmup", "50", "--select", "close"]).flags;
  assert.deepEqual(unknownFlags(good), []);
});

test("timeframes are single-sourced and match the parse error", () => {
  for (const tf of TIMEFRAMES) assert.equal(normalizeTimeframe(tf), tf);
  assert.equal(normalizeTimeframe("4h"), "240");
  assert.equal(normalizeTimeframe("1mo"), "M");
  assert.equal(normalizeTimeframe(undefined, "D"), "D");

  for (const bad of ["360", "480", "720", "1S", "7x"]) {
    assert.throws(
      () => normalizeTimeframe(bad),
      (err: unknown) => err instanceof Error && err.message.includes(TIMEFRAME_HELP),
    );
  }
});

test("symbol metadata exposes unit and volume reliability", () => {
  assert.deepEqual(symbolMeta("CRYPTOCAP:USDT.D"), {
    kind: "crypto_dominance",
    unit: "percent",
    volume_reliable: false,
  });
  assert.deepEqual(symbolMeta("CRYPTOCAP:SOL"), {
    kind: "crypto_marketcap",
    unit: "usd",
    volume_reliable: false,
  });
  assert.deepEqual(symbolMeta("TVC:US10Y"), {
    kind: "treasury_yield",
    unit: "percent",
    volume_reliable: false,
  });
  // The 3M/6M yields use the `MY` suffix (`TVC:US03MY`).
  assert.deepEqual(symbolMeta("TVC:US03MY"), {
    kind: "treasury_yield",
    unit: "percent",
    volume_reliable: false,
  });
  assert.deepEqual(symbolMeta("BINANCE:SOLUSDT", "spot"), {
    kind: "crypto_spot",
    unit: "price",
    volume_reliable: true,
  });
});

test("resolving to a derived index produces an explicit note", () => {
  const note = resolutionNote({
    input: "SOL",
    symbol: "CRYPTOCAP:SOL",
    source: "search",
    confidence: "high",
    alternatives: [],
    candidates: [],
    notes: [],
  });
  assert.match(note ?? "", /market-cap/);

  // A deliberate request needs no warning, only a silent search hit does.
  assert.equal(
    resolutionNote({
      input: "CRYPTOCAP:SOL",
      symbol: "CRYPTOCAP:SOL",
      source: "explicit",
      confidence: "high",
      alternatives: [],
      candidates: [],
      notes: [],
    }),
    null,
  );

  assert.equal(
    resolutionNote({
      input: "BTCUSD",
      symbol: "BITSTAMP:BTCUSD",
      source: "alias",
      confidence: "high",
      alternatives: [],
      candidates: [],
      notes: [],
    }),
    null,
  );
});

test("nearestField points a typo at the closest known field", () => {
  assert.equal(editDistance("time_isoo", "time_iso"), 1);
  assert.equal(nearestField("time_isoo", ["time_iso", "close"]), "time_iso");
  assert.equal(nearestField("kc1_mdi", ["time_iso", "kc1_mid", "kc1_upper"]), "kc1_mid");
  // Unrelated names must not get a misleading suggestion.
  assert.equal(nearestField("totally_other", ["time_iso", "close"]), null);
  assert.ok(PRICE_FIELDS.has("close"));
});

test("price fields are selectable alongside indicators", () => {
  const known = ["time_iso", "open", "high", "low", "close", "volume", "kc1_mid", "macd_hist"];
  const plan = planSelect(["time_iso", "close", "kc1_mid", "macd_hist"], known);
  assert.deepEqual(plan.unknown, []);
  assert.deepEqual(plan.effective, ["time_iso", "close", "kc1_mid", "macd_hist"]);
});

test("tabular output renders null explicitly, not as a blank", () => {
  const rows = [{ time_iso: "2026-10-03T00:00:00.000Z", close: 1, volume: null }];
  const cols = ["time_iso", "close", "volume"];
  assert.equal(renderCsv(rows, cols), "time_iso,close,volume\n2026-10-03T00:00:00.000Z,1,null");
  assert.match(renderTable(rows, cols), /1\s+-\s*$/m);
});
