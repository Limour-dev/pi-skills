/**
 * Pure-Node re-implementation of the "大道至简" indicator set.
 *
 * The set is a direct port of the Pine Script® indicator by l834159672. It is
 * the *only* indicator set this skill computes: see SKILL.md ("指标白名单").
 *
 * Everything here follows TradingView's documented `ta.*` semantics so the
 * values match the Pine script bar for bar:
 *
 *   - `ta.sma(src, length)`   — arithmetic mean, `na` until `length` bars.
 *   - `ta.ema(src, length)`   — `alpha = 2 / (length + 1)`, seeded with the SMA
 *                               of the first `length` values, then recursive.
 *   - `ta.median(src, length)`— rolling statistical median; for an even window
 *                               the mean of the two middle values.
 *   - `ta.tr`                 — `max(high-low, |high-close[1]|, |low-close[1]|)`;
 *                               the first bar falls back to `high-low`.
 *   - `ta.kc(src, length, mult)` — basis = EMA(src, length); span = ta.tr;
 *                               bands = basis ± EMA(span, length) * mult.
 *   - `ta.macd` via the script's own formula: `hist = 2 * (macd - signal)`.
 *
 * Every function returns one entry per input bar and uses `null` for `na`, so
 * the caller can round and serialize without worrying about `NaN`.
 */

export type Numeric = number | null;
export type NumericSeries = Numeric[];

/** Minimal OHLCV shape; the library `Candle` satisfies it. */
export type Ohlcv = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertLength(length: number): void {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`length must be a positive integer, got ${length}`);
  }
}

/** `ta.sma`: arithmetic mean over the last `length` bars. */
export function sma(values: readonly Numeric[], length: number): NumericSeries {
  assertLength(length);
  const out: NumericSeries = new Array(values.length).fill(null);
  let sum = 0;
  let invalid = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (isNum(value)) sum += value;
    else invalid++;
    if (i >= length) {
      const dropped = values[i - length];
      if (isNum(dropped)) sum -= dropped;
      else invalid--;
    }
    if (i >= length - 1 && invalid === 0) out[i] = sum / length;
  }
  return out;
}

/**
 * `ta.ema`: `alpha = 2 / (length + 1)`.
 *
 * Matches Pine's seed rule — the first non-`na` output is the SMA of the first
 * `length` values, every later value recurses on the previous EMA.
 */
export function ema(values: readonly Numeric[], length: number): NumericSeries {
  assertLength(length);
  const alpha = 2 / (length + 1);
  const seed = sma(values, length);
  const out: NumericSeries = new Array(values.length).fill(null);
  let previous: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (previous === null) {
      const s = seed[i];
      if (isNum(s)) {
        previous = s;
        out[i] = s;
      }
      continue;
    }
    const value = values[i];
    previous = isNum(value) ? alpha * value + (1 - alpha) * previous : null;
    out[i] = previous;
  }
  return out;
}

/** `ta.median`: rolling statistical median over the last `length` bars. */
export function rollingMedian(values: readonly Numeric[], length: number): NumericSeries {
  assertLength(length);
  const out: NumericSeries = new Array(values.length).fill(null);
  const half = length >> 1;
  for (let i = length - 1; i < values.length; i++) {
    const window: number[] = [];
    let complete = true;
    for (let j = i - length + 1; j <= i; j++) {
      const value = values[j];
      if (!isNum(value)) {
        complete = false;
        break;
      }
      window.push(value);
    }
    if (!complete) continue;
    window.sort((a, b) => a - b);
    out[i] = length % 2 === 1 ? window[half] : (window[half - 1] + window[half]) / 2;
  }
  return out;
}

/** `ta.tr`: true range in absolute price units. */
export function trueRange(
  high: readonly Numeric[],
  low: readonly Numeric[],
  close: readonly Numeric[],
): NumericSeries {
  const out: NumericSeries = new Array(high.length).fill(null);
  for (let i = 0; i < high.length; i++) {
    const h = high[i];
    const l = low[i];
    if (!isNum(h) || !isNum(l)) continue;
    const previousClose = i > 0 ? close[i - 1] : null;
    out[i] = isNum(previousClose)
      ? Math.max(h - l, Math.abs(h - previousClose), Math.abs(l - previousClose))
      : h - l;
  }
  return out;
}

export type KeltnerChannels = {
  basis: NumericSeries;
  upper: NumericSeries;
  lower: NumericSeries;
};

/**
 * `ta.kc(src, length, mult)` with its default `useTrueRange = true`:
 * `basis ± EMA(ta.tr, length) * mult`. Pass `false` to use `high - low`.
 */
export function keltnerChannels(
  src: readonly Numeric[],
  high: readonly Numeric[],
  low: readonly Numeric[],
  close: readonly Numeric[],
  length: number,
  mult: number,
  useTrueRange = true,
): KeltnerChannels {
  const basis = ema(src, length);
  const span: NumericSeries = useTrueRange
    ? trueRange(high, low, close)
    : high.map((h, i) => (isNum(h) && isNum(low[i]) ? h - (low[i] as number) : null));
  const range = ema(span, length);
  const upper: NumericSeries = new Array(src.length).fill(null);
  const lower: NumericSeries = new Array(src.length).fill(null);
  for (let i = 0; i < src.length; i++) {
    const b = basis[i];
    const r = range[i];
    if (isNum(b) && isNum(r)) {
      upper[i] = b + r * mult;
      lower[i] = b - r * mult;
    }
  }
  return { basis, upper, lower };
}

export type MacdResult = { macd: NumericSeries; signal: NumericSeries; hist: NumericSeries };

/**
 * MACD exactly as the Pine script builds it:
 * `macd = ta.ema(src, fast) - ta.ema(src, slow)`, `signal = ta.sma(macd, len)`,
 * `hist = 2 * (macd - signal)`.
 */
export function macd(
  src: readonly Numeric[],
  fastLength: number,
  slowLength: number,
  signalLength: number,
): MacdResult {
  const fast = ema(src, fastLength);
  const slow = ema(src, slowLength);
  const line: NumericSeries = src.map((_, i) => {
    const f = fast[i];
    const s = slow[i];
    return isNum(f) && isNum(s) ? f - s : null;
  });
  const signal = sma(line, signalLength);
  const hist: NumericSeries = line.map((m, i) => {
    const s = signal[i];
    return isNum(m) && isNum(s) ? 2 * (m - s) : null;
  });
  return { macd: line, signal, hist };
}

/** Pine's built-in `hlcc4` = `(high + low + close + close) / 4`. */
export function hlcc4(high: readonly Numeric[], low: readonly Numeric[], close: readonly Numeric[]): NumericSeries {
  return high.map((h, i) => {
    const l = low[i];
    const c = close[i];
    return isNum(h) && isNum(l) && isNum(c) ? (h + l + c + c) / 4 : null;
  });
}

// ------------------------------------------------------------- the indicator

export type DadaoZhiJianParams = {
  kc_length: number;
  kc_mult_inner: number;
  kc_mult_outer: number;
  median_length: number;
  macd_fast: number;
  macd_slow: number;
  macd_signal: number;
};

/** The exact constants used by the Pine script. */
export const DADAO_ZHIJIAN_PARAMS: DadaoZhiJianParams = {
  kc_length: 50,
  kc_mult_inner: 2.75,
  kc_mult_outer: 3.75,
  median_length: 200,
  macd_fast: 12,
  macd_slow: 26,
  macd_signal: 9,
};

/**
 * Bars needed before the requested window so every indicator is at full
 * strength at its left edge (`ta.median` needs 200, the EMAs want more).
 */
export function warmupBars(params: DadaoZhiJianParams = DADAO_ZHIJIAN_PARAMS): number {
  const longest = Math.max(params.median_length, params.kc_length, params.macd_slow + params.macd_signal);
  return longest + 100;
}

export type IndicatorPoint = {
  /**
   * The input bar's OHLCV, carried through unchanged so a caller can read price
   * and indicators from one `indicators` row instead of joining `candles`.
   * These are reachable via `--select`; the default indicator columns do not
   * include them, which keeps existing csv/table consumers stable.
   */
  open: Numeric;
  high: Numeric;
  low: Numeric;
  close: Numeric;
  volume: Numeric;
  time: number;
  /** `ta.kc(close, 50, 2.75)` */
  kc1_mid: Numeric;
  kc1_upper: Numeric;
  kc1_lower: Numeric;
  /** `ta.ema(high, 50)` and `ta.ema(low, 50)` */
  ema_high: Numeric;
  ema_low: Numeric;
  /** `ta.kc(close, 50, 3.75)` */
  kc2_mid: Numeric;
  kc2_upper: Numeric;
  kc2_lower: Numeric;
  /** `ta.kc(low, 50, 3.75)` */
  kc_low_mid: Numeric;
  kc_low_upper: Numeric;
  kc_low_lower: Numeric;
  /** `ta.median(hlcc4, 200)` */
  median_200: Numeric;
  /** MACD(12, 26, 9) with `hist = 2 * (macd - signal)` */
  macd: Numeric;
  macd_signal: Numeric;
  macd_hist: Numeric;
};

/** Compute the whole "大道至简" set, one entry per input bar. */
export function computeDadaoZhiJian(
  candles: readonly Ohlcv[],
  params: DadaoZhiJianParams = DADAO_ZHIJIAN_PARAMS,
): IndicatorPoint[] {
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);

  const kc1 = keltnerChannels(close, high, low, close, params.kc_length, params.kc_mult_inner, true);
  const emaHigh = ema(high, params.kc_length);
  const emaLow = ema(low, params.kc_length);
  const kc2 = keltnerChannels(close, high, low, close, params.kc_length, params.kc_mult_outer, true);
  const kcLow = keltnerChannels(low, high, low, close, params.kc_length, params.kc_mult_outer, true);
  const median = rollingMedian(hlcc4(high, low, close), params.median_length);
  const momentum = macd(close, params.macd_fast, params.macd_slow, params.macd_signal);

  return candles.map((candle, i) => ({
    time: candle.time,
    open: isNum(candle.open) ? candle.open : null,
    high: isNum(candle.high) ? candle.high : null,
    low: isNum(candle.low) ? candle.low : null,
    close: isNum(candle.close) ? candle.close : null,
    volume: isNum(candle.volume) ? candle.volume : null,
    kc1_mid: kc1.basis[i],
    kc1_upper: kc1.upper[i],
    kc1_lower: kc1.lower[i],
    ema_high: emaHigh[i],
    ema_low: emaLow[i],
    kc2_mid: kc2.basis[i],
    kc2_upper: kc2.upper[i],
    kc2_lower: kc2.lower[i],
    kc_low_mid: kcLow.basis[i],
    kc_low_upper: kcLow.upper[i],
    kc_low_lower: kcLow.lower[i],
    median_200: median[i],
    macd: momentum.macd[i],
    macd_signal: momentum.signal[i],
    macd_hist: momentum.hist[i],
  }));
}
