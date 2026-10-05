/**
 * Normalisation tests: fixture payloads → flat rows with stable field names.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extractJson } from "../src/html.ts";
import {
  chainRows,
  expectedMovePoints,
  exposurePayload,
  greekRows,
  maxPainRows,
  priceFromWidget,
  seriesRows,
  statsRows,
  tickerInfo,
} from "../src/normalize.ts";
import { CHAIN_COLUMNS, STATS_COLUMNS } from "../src/endpoints.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("seriesRows flattens open interest with the expiry and side split out", () => {
  const payload = extractJson(fixture("tlt-open-interest.html"), "chart_data", { expect: "dict" });
  const rows = seriesRows(payload, "open_interest");
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.slice(0, 3).map((row) => [row.expiration, row.option_type, row.strike, row.open_interest]),
    [
      ["2026-10-09:w", "CALL", 65, 0],
      ["2026-10-09:w", "CALL", 70, 0],
      ["2026-10-09:w", "CALL", 71, 0],
    ],
  );
  assert.equal(rows[3].option_type, "PUT");
});

test("seriesRows exposes IV as both decimal and percent", () => {
  const payload = extractJson(fixture("tlt-skew.html"), "chart_data", { expect: "dict" });
  const rows = seriesRows(payload, "implied_volatility");
  assert.equal(rows.length, 6);
  assert.equal(rows[0].contract_symbol, "TLT261009C00065000");
  assert.equal(rows[0].iv_pct, 73.6705);
  assert.ok(Math.abs((rows[0].implied_volatility as number) - 0.7367048) < 1e-6);
});

test("seriesRows flattens volume", () => {
  const payload = extractJson(fixture("tlt-volume.html"), "chart_data", { expect: "dict" });
  const rows = seriesRows(payload, "volume");
  assert.equal(rows.length, 6);
  assert.equal(typeof rows[0].volume, "number");
});

test("greekRows flattens all_chart_data per greek", () => {
  const payload = extractJson(fixture("tlt-greeks.html"), "all_chart_data");
  const rows = greekRows(payload);
  assert.deepEqual([...new Set(rows.map((row) => row.greek))].sort(), ["delta", "gamma", "theta", "vega"]);
  assert.equal(rows.length, 8);
  const delta = rows.find((row) => row.greek === "delta");
  assert.ok(delta);
  assert.equal(delta?.strike, 65);
  assert.equal(Math.round(Number(delta?.value) * 100) / 100, 0.99);
  const filtered = greekRows(payload, ["gamma"]);
  assert.deepEqual([...new Set(filtered.map((row) => row.greek))], ["gamma"]);
});

test("exposurePayload keeps the upstream per-strike exposure fields", () => {
  const payload = extractJson(fixture("tlt-gamma-exposure.html"), "chart_exposure_data");
  const exposure = exposurePayload(payload);
  assert.ok(exposure);
  assert.equal(exposure.net_exposure, 24985140.36);
  assert.equal(exposure.put_exposure, -55834471.87);
  assert.equal(exposure.exposure_by_strike_series.length, 47);
  const strike = exposure.exposure_by_strike_series.find((row) => row.strike === 78);
  assert.ok(strike);
  assert.ok(strike.net_exposure > 0);
});

test("maxPainRows covers every expiry and rounds float noise", () => {
  const payload = extractJson(fixture("tlt-max-pain.html"), "chart_data", { expect: "list" });
  const rows = maxPainRows(payload);
  assert.deepEqual(
    rows.map((row) => row.expiration_date_id),
    ["2026-10-05:w", "2026-10-07:w"],
  );
  assert.equal(rows[0].max_pain, 77.5);
  assert.equal(rows[0].max_pain_diff, 0.4);
  assert.equal(rows[0].max_pain_diff_pct, 0.52);
});

test("expectedMovePoints returns chronological cone points", () => {
  const payload = extractJson(fixture("tlt-expected-move.html"), "expectedMoveConeData");
  const points = expectedMovePoints(payload);
  assert.equal(points.length, 4);
  assert.equal(points[0].iso, "2026-10-06T03:59:59.000Z");
  assert.equal(points[0].em_amt, 0.55);
  assert.equal(points[0].low, 76.55);
  assert.ok(points[3].t > points[0].t);
  // The UTC stamp is the NEXT day: each point is a session close in ET.
  assert.equal(points[0].et_date, "2026-10-05");
  assert.equal(points[0].et_time, "23:59:59");
  // DST-safe: the winter point (04:59:59Z) maps back to 2029-01-19 ET.
  assert.equal(points[3].et_date, "2029-01-19");
});

test("chainRows reads both sides of the chain", () => {
  const rows = chainRows(fixture("tlt-chain.html"), [...CHAIN_COLUMNS]);
  assert.equal(rows.length, 4);
  assert.deepEqual([...new Set(rows.map((row) => row.option_type))].sort(), ["CALL", "PUT"]);
  assert.equal(rows[0].strike, 65);
  assert.equal(rows[0].bid, 12.4);
  assert.equal(rows[0].iv_pct, 51.25);
  assert.equal(rows[0].delta, 0.99);
});

test("priceFromWidget reads price, change, name and statuses", () => {
  const widget = priceFromWidget(fixture("tlt-price.html"), "TLT");
  assert.equal(widget.price, 77.1);
  assert.equal(widget.change, -0.38);
  assert.equal(widget.change_pct, -0.49);
  assert.equal(widget.currency, "USD");
  assert.equal(widget.name, "iShares 20+ Year Treasury Bond ETF");
  assert.equal(widget.market_status, "Market Open");
  assert.match(String(widget.options_delay), /15-min Delayed/);
  assert.match(String(widget.as_of), /^Oct 05, 9:42 AM EDT$/);
});

test("tickerInfo expands scaled volumes", () => {
  const info = tickerInfo(fixture("tlt-ticker-info.html"));
  assert.equal(info.dividend_yield_pct, 4.85);
  assert.equal(info.average_volume, 47850000);
  assert.equal(info.volume, 3630000);
  assert.equal(info.high_today, 77.72);
  assert.equal(info.week52_low, 76.76);
});

test("statsRows keeps the free-tier columns intact for a live-shaped table", () => {
  const { rows, locked } = statsRows(fixture("tlt-stats.html"), [...STATS_COLUMNS]);
  assert.equal(locked.length, 0);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].expiration, "2026-10-07:w");
  assert.equal(rows[1].dte, 2);
  assert.equal(rows[1].iv_pct, 13.45);
  assert.equal(rows[2].oi_total, 224932);
  assert.equal(rows[2].expected_move_pct, 1.51);
});
