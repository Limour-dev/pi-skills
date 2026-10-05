/**
 * Indicator math tests. Everything runs offline and asserts the Pine
 * semantics documented in `src/indicators.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DADAO_ZHIJIAN_PARAMS,
  computeDadaoZhiJian,
  ema,
  hlcc4,
  keltnerChannels,
  macd,
  rollingMedian,
  sma,
  trueRange,
  warmupBars,
} from "../src/indicators.ts";

const EPS = 1e-9;

function approx(actual: number | null, expected: number, message?: string): void {
  assert.ok(actual !== null, `expected ${expected}, got null`);
  assert.ok(Math.abs(actual - expected) <= EPS, message ?? `${actual} != ${expected}`);
}

test("sma holds na until the window is full", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(sma([1, 2], 5), [null, null]);
});

test("ema seeds with the SMA of the first length values, then recurses", () => {
  // length 3 -> alpha = 0.5; seed at index 2 is mean(1,2,3) = 2.
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);

  // length 2 -> alpha = 2/3; seed at index 1 is mean(1,2) = 1.5.
  const out = ema([1, 2, 4], 2);
  assert.equal(out[0], null);
  approx(out[1], 1.5);
  approx(out[2], (2 / 3) * 4 + (1 / 3) * 1.5);
});

test("rollingMedian averages the two middle values on an even window", () => {
  assert.deepEqual(rollingMedian([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.deepEqual(rollingMedian([5, 1, 3], 3), [null, null, 3]);
});

test("trueRange uses the previous close", () => {
  const tr = trueRange([10, 12, 11], [8, 11, 10], [9, 11, 10.5]);
  approx(tr[0], 2); // first bar: high - low
  approx(tr[1], 3); // max(1, |12-9|, |11-9|)
  approx(tr[2], 1); // max(1, |11-11|, |10-11|)
});

test("a flat market collapses the Keltner bands onto the basis", () => {
  const flat = new Array(20).fill(100);
  const kc = keltnerChannels(flat, flat, flat, flat, 5, 2);
  approx(kc.basis[19], 100);
  approx(kc.upper[19], 100);
  approx(kc.lower[19], 100);
});

test("Keltner bands are symmetric around the basis", () => {
  const close = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const high = close.map((c) => c + 1);
  const low = close.map((c) => c - 1);
  const kc = keltnerChannels(close, high, low, close, 5, 2.75);
  for (let i = 0; i < close.length; i++) {
    if (kc.upper[i] === null) continue;
    approx(
      (kc.upper[i] as number) - (kc.basis[i] as number),
      (kc.basis[i] as number) - (kc.lower[i] as number),
    );
  }
});

test("macd signal is the SMA of the macd line and hist is doubled", () => {
  const close = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const result = macd(close, 12, 26, 9);
  const expectedSignal = sma(result.macd, 9);
  for (let i = 0; i < close.length; i++) {
    assert.deepEqual(result.signal[i], expectedSignal[i]);
    if (result.hist[i] !== null) {
      approx(result.hist[i] as number, 2 * ((result.macd[i] as number) - (result.signal[i] as number)));
    }
  }
  assert.equal(result.macd[24], null);
  assert.notEqual(result.macd[25], null);
  assert.equal(result.signal[32], null);
  assert.notEqual(result.signal[33], null);
});

test("hlcc4 weights the close twice", () => {
  assert.deepEqual(hlcc4([10], [6], [8]), [(10 + 6 + 8 + 8) / 4]);
});

test("the 大道至简 set warms up exactly like the Pine script", () => {
  const n = 260;
  const candles = Array.from({ length: n }, (_, i) => ({
    time: i * 86_400,
    open: 100,
    high: 101 + (i % 3),
    low: 99 - (i % 2),
    close: 100 + Math.sin(i / 7),
  }));
  const points = computeDadaoZhiJian(candles, DADAO_ZHIJIAN_PARAMS);

  assert.equal(points.length, n);
  assert.equal(points[48].kc1_mid, null);
  assert.notEqual(points[49].kc1_mid, null);
  assert.equal(points[198].median_200, null);
  assert.notEqual(points[199].median_200, null);
  assert.equal(points[32].macd_signal, null);
  assert.notEqual(points[33].macd_signal, null);

  const last = points[n - 1];
  assert.ok((last.kc1_upper as number) > (last.kc1_mid as number));
  assert.ok((last.kc1_lower as number) < (last.kc1_mid as number));
  assert.ok((last.kc2_upper as number) > (last.kc2_mid as number));
  assert.ok((last.kc_low_upper as number) > (last.kc_low_mid as number));
});

test("warmup covers the longest indicator window", () => {
  assert.equal(warmupBars(), 300);
});

test("the indicator rows carry the input bar's OHLCV", () => {
  const candles = [
    { time: 0, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: 86_400, open: 11, high: 13, low: 10, close: 12 },
  ];
  const points = computeDadaoZhiJian(candles);
  assert.equal(points.length, 2);
  assert.deepEqual(
    points.map(({ open, high, low, close, volume }) => ({ open, high, low, close, volume })),
    [
      { open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { open: 11, high: 13, low: 10, close: 12, volume: null },
    ],
  );
});
