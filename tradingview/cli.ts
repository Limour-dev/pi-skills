#!/usr/bin/env node
/**
 * tradingview — read-only TradingView OHLCV candles with a local SQLite cache.
 *
 * Wraps `getCandles` from `@mathieuc/tradingview` and resolves bare symbol
 * names (`USDT.D`, `US10Y`, `CNH1!`, `BTCUSD`) to exchange-qualified
 * TradingView symbols before fetching.
 *
 * Every request reads the cached bars first, fetches only the missing
 * older/newer slices, and writes the new bars back for next time. Only closed
 * bars are ever fetched, returned or stored — the still-forming bar is left
 * alone.
 *
 * Two commands share that loader:
 *   - `candles`    — raw OHLCV;
 *   - `indicators` — the 大道至简 indicator set (src/indicators.ts), the only
 *                    indicators this skill computes.
 *
 * Read-only: nothing here places orders or edits any account state.
 */

import { getCandles, type Candle } from "@mathieuc/tradingview/data";
import { bool, list, num, parseArgs, str, unknownFlags, type Flags } from "./src/args.ts";
import {
  defaultCachePath,
  openCache,
  readCandles,
  writeCandles,
  type Cache,
  type CacheKey,
} from "./src/cache.ts";
import {
  DADAO_ZHIJIAN_PARAMS,
  computeDadaoZhiJian,
  warmupBars,
  type IndicatorPoint,
} from "./src/indicators.ts";
import {
  CliError,
  EXIT,
  detectFormat,
  errorPayload,
  exitCodeFor,
  print,
  usageError,
  type Format,
} from "./src/output.ts";
import { knownFields, planSelect, projectRow } from "./src/select.ts";
import {
  resolutionNote,
  resolveSymbols,
  symbolMeta,
  summarizeResolution,
  type Resolution,
  type SymbolMeta,
} from "./src/symbols.ts";
import {
  TIMEFRAME_HELP,
  isBarFinished,
  lastFinishedBarTime,
  normalizeTimeframe,
  parseTime,
  round,
  timeframeSeconds,
  toIso,
  withRetry,
} from "./src/util.ts";

const CLI_VERSION = "2.1.0";
const LIBRARY_VERSION = "4.0.0-rc.0";

// ---------------------------------------------------------------- result type

type CommandResult = {
  /** Payload for --format json. */
  json: unknown;
  /** Tabular payload for csv/table/md; defaults to `json`. */
  rows?: Record<string, unknown>[];
  columns?: string[];
  /** Field inside `json` that mirrors `rows` (projected by --select). */
  rowsField?: string;
};

type Ctx = {
  command: string;
  positional: string[];
  flags: Flags;
  format: Format;
  timeoutMs: number;
  session: "regular" | "extended";
  strict: boolean;
  select: string[];
  quiet: boolean;
  compact: boolean;
};

// ------------------------------------------------------------------- helpers

function errMessage(err: unknown): string {
  if (err === null || err === undefined) return "unknown error";
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String(err);
  return typeof code === "string" ? `${code}: ${message}` : message;
}

/**
 * Apply `--select` to a finished result.
 *
 * Two contracts are enforced here:
 *   1. the tabular payload (`rows` + `columns`) is projected together, so a
 *      csv/table/md header can never carry empty columns;
 *   2. the JSON envelope survives — only the row array (`candles[]` /
 *      `series[]`) is trimmed, keeping symbol/coverage/cache/warnings.
 *
 * Unknown field names warn on stderr and fail under `--strict`, instead of
 * silently emitting blank rows with exit 0.
 */
function finish(ctx: Ctx, result: CommandResult): CommandResult {
  if (ctx.select.length === 0) return result;
  const field = result.rowsField ?? "candles";
  const rows = result.rows ?? [];
  const envelope = (result.json ?? null) as Record<string, unknown> | null;
  const jsonRows =
    envelope && Array.isArray(envelope[field]) ? (envelope[field] as Record<string, unknown>[]) : undefined;
  const known = knownFields(rows.length > 0 ? rows : jsonRows);
  const plan = planSelect(ctx.select, known);

  if (plan.unknown.length > 0) {
    const message = `unknown --select field(s): ${plan.unknown.join(", ")}. Available: ${known.join(", ")}`;
    if (ctx.strict) throw usageError(message);
    process.stderr.write(`warning: ${message}\n`);
  }
  if (plan.effective.length === 0) {
    throw usageError(`--select matched no output field. Available: ${known.join(", ")}`);
  }

  result.rows = rows.map((row) => projectRow(row, plan.effective));
  result.columns = plan.effective;
  if (envelope && jsonRows) envelope[field] = jsonRows.map((row) => projectRow(row, plan.effective));
  return result;
}

function candleRow(candle: Candle, volumeReliable: boolean): Record<string, unknown> {
  return {
    time: candle.time,
    time_iso: toIso(candle.time),
    open: round(candle.open, 8),
    high: round(candle.high, 8),
    low: round(candle.low, 8),
    close: round(candle.close, 8),
    volume: volumeReliable ? candle.volume : null,
  };
}

function indicatorRow(point: IndicatorPoint): Record<string, unknown> {
  return {
    time: point.time,
    time_iso: toIso(point.time),
    kc1_mid: round(point.kc1_mid, 8),
    kc1_upper: round(point.kc1_upper, 8),
    kc1_lower: round(point.kc1_lower, 8),
    ema_high: round(point.ema_high, 8),
    ema_low: round(point.ema_low, 8),
    kc2_mid: round(point.kc2_mid, 8),
    kc2_upper: round(point.kc2_upper, 8),
    kc2_lower: round(point.kc2_lower, 8),
    kc_low_mid: round(point.kc_low_mid, 8),
    kc_low_upper: round(point.kc_low_upper, 8),
    kc_low_lower: round(point.kc_low_lower, 8),
    median_200: round(point.median_200, 8),
    macd: round(point.macd, 8),
    macd_signal: round(point.macd_signal, 8),
    macd_hist: round(point.macd_hist, 8),
  };
}

function dedupeSorted(candles: readonly Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// ------------------------------------------------------- cache-aware fetching

type ChartOptions = {
  chartType?: string;
  currency?: string;
  adjustment?: string;
};

async function fetchRange(
  symbol: string,
  timeframe: string,
  from: number,
  to: number,
  ctx: Ctx,
  options: ChartOptions,
): Promise<Candle[]> {
  return withRetry(() =>
    getCandles({
      symbol,
      timeframe: timeframe as never,
      from,
      to,
      ...(options.chartType ? { chartType: options.chartType as never } : {}),
      ...(options.currency ? { currency: options.currency } : {}),
      ...(options.adjustment ? { adjustment: options.adjustment as never } : {}),
      session: ctx.session,
      timeoutMs: Math.max(ctx.timeoutMs, 20_000),
    }),
  );
}

type LoadResult = {
  candles: Candle[];
  cachedBefore: number;
  fetched: number;
};

/**
 * Every closed bar of `key` in `[from, to]`.
 *
 * Reads the SQLite cache first, then fetches only the missing head (older than
 * the cached start) and tail (newer than the cached end) slices. Fetched bars
 * are written back so the next request needs less network.
 */
async function loadCandles(
  db: Cache | null,
  key: CacheKey,
  from: number,
  to: number,
  nowSec: number,
  ctx: Ctx,
  options: ChartOptions,
  warnings: string[],
): Promise<LoadResult> {
  const cached = db ? readCandles(db, key, from, to) : [];
  const missing: Array<[number, number]> = [];
  if (cached.length === 0) {
    missing.push([from, to]);
  } else {
    if (cached[0].time > from) missing.push([from, cached[0].time]);
    if (cached.at(-1)!.time < to) missing.push([cached.at(-1)!.time, to]);
  }

  const fetched: Candle[] = [];
  let lastError: unknown = null;
  for (const [lo, hi] of missing) {
    if (hi < lo) continue;
    try {
      // Upstream treats `to` as exclusive, so +1 keeps a bar sitting exactly on
      // the boundary (and stops a sub-bar slice from coming back empty).
      const batch = await fetchRange(key.symbol, key.timeframe, lo, hi + 1, ctx, options);
      const closed = batch.filter((c) => c.time <= hi && isBarFinished(c.time, key.timeframe, nowSec));
      fetched.push(...closed);
      if (db) writeCandles(db, key, closed);
    } catch (err) {
      lastError = err;
      const code = (err as { code?: unknown } | null)?.code;
      // An incremental slice can legitimately be empty (weekend/holiday); only
      // surface unexpected failures on a warm cache.
      if (cached.length === 0 || (code !== "NO_DATA" && code !== "NOT_FOUND")) {
        warnings.push(`refresh ${lo}..${hi} failed: ${errMessage(err)}`);
      }
    }
  }

  const merged = db ? readCandles(db, key, from, to) : [...cached, ...fetched];
  if (merged.length === 0 && lastError) throw lastError;
  return { candles: dedupeSorted(merged), cachedBefore: cached.length, fetched: fetched.length };
}

// ----------------------------------------------------------- shared loading

type SeriesRequest = {
  input: string;
  timeframe: string;
  count: number;
  fromRaw?: string;
  toRaw?: string;
  chartType?: string;
  currency?: string;
  adjustment?: string;
  noCache: boolean;
  cachePath: string;
  /** Extra bars fetched before the requested window for indicator warmup. */
  warmup: number;
};

type LoadedSeries = {
  input: string;
  res: Resolution;
  meta: SymbolMeta;
  timeframe: string;
  nowSec: number;
  /** User-visible window start (seconds), or null when `--from` was absent. */
  windowFrom: number | null;
  effTo: number;
  /** Every closed bar loaded in `[fetchFrom, effTo]`, warmup included. */
  bars: Candle[];
  cachedBefore: number;
  fetched: number;
  warnings: string[];
  cachePath: string;
  noCache: boolean;
};

/**
 * Resolve a symbol and load closed bars, including `warmup` extra bars before
 * the requested window so indicators are already at full strength there.
 */
async function loadSeries(ctx: Ctx, req: SeriesRequest): Promise<LoadedSeries> {
  const nowSec = Math.floor(Date.now() / 1000);
  // Only closed bars are allowed. `effTo` is the newest bar that can already
  // have completed, so the in-progress bar is never even requested.
  const reqTo = req.toRaw ? Math.floor(parseTime(req.toRaw, "--to").getTime() / 1000) : nowSec;
  const effTo = Math.min(reqTo, lastFinishedBarTime(nowSec, req.timeframe));
  const step = timeframeSeconds(req.timeframe) ?? 31 * 86_400;

  const windowFrom = req.fromRaw ? Math.floor(parseTime(req.fromRaw, "--from").getTime() / 1000) : null;
  if (windowFrom !== null && windowFrom > effTo) {
    throw new CliError(
      `empty range for ${req.input}: --from is newer than --to (or than the newest closed bar)`,
      EXIT.notFound,
    );
  }

  // Without --from, ask for a window generously wider than `count` so market
  // gaps (weekends, holidays) cannot leave us short of the requested bars.
  const fetchCount = req.count + Math.max(0, req.warmup);
  const fetchFrom =
    windowFrom !== null ? windowFrom - Math.max(0, req.warmup) * step : effTo - Math.ceil(fetchCount * step * 3);

  const [res] = (await resolveSymbols([req.input], {
    exchange: str(ctx.flags, "exchange"),
    type: str(ctx.flags, "type"),
    noFallback: bool(ctx.flags, "no-fallback") || ctx.strict,
  })) as Resolution[];
  if (!res.symbol) throw new CliError(`unresolved symbol '${req.input}'`, EXIT.notFound, res.candidates);

  if (!ctx.quiet) {
    process.stderr.write(`${summarizeResolution(res)}\n`);
    const note = resolutionNote(res);
    if (note) process.stderr.write(`note: ${note}\n`);
    for (const n of res.notes) process.stderr.write(`note: ${n}\n`);
  }

  const meta = symbolMeta(res.symbol, res.candidates[0]?.type);
  const key: CacheKey = {
    symbol: res.symbol,
    timeframe: req.timeframe,
    variant: [req.chartType ?? "", req.currency ?? "", req.adjustment ?? "splits", ctx.session].join("|"),
  };
  const options: ChartOptions = {
    ...(req.chartType ? { chartType: req.chartType } : {}),
    ...(req.currency ? { currency: req.currency } : {}),
    ...(req.adjustment ? { adjustment: req.adjustment } : {}),
  };

  const warnings: string[] = [];
  let result: LoadResult;
  if (req.noCache) {
    result = await loadCandles(null, key, fetchFrom, effTo, nowSec, ctx, options, warnings);
  } else {
    const db = openCache(req.cachePath);
    try {
      result = await loadCandles(db, key, fetchFrom, effTo, nowSec, ctx, options, warnings);
    } finally {
      db.close();
    }
  }

  if (warnings.length > 0 && !ctx.quiet) for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  // Defensive: keep the requested window and closed bars only.
  const bars = result.candles.filter(
    (c) => c.time >= fetchFrom && c.time <= effTo && isBarFinished(c.time, req.timeframe, nowSec),
  );

  return {
    input: req.input,
    res,
    meta,
    timeframe: req.timeframe,
    nowSec,
    windowFrom,
    effTo,
    bars,
    cachedBefore: result.cachedBefore,
    fetched: result.fetched,
    warnings,
    cachePath: req.cachePath,
    noCache: req.noCache,
  };
}

function cacheBlock(loaded: LoadedSeries): Record<string, unknown> {
  return loaded.noCache
    ? { enabled: false }
    : { enabled: true, path: loaded.cachePath, reused: loaded.cachedBefore, fetched: loaded.fetched };
}

/** Freshness so a caller can tell "conservative" apart from "cache is stale". */
function freshnessBlock(lastBarTime: number | null, nowSec: number, timeframe: string): Record<string, unknown> {
  if (lastBarTime === null) return {};
  const step = timeframeSeconds(timeframe) ?? 31 * 86_400;
  const age = nowSec - lastBarTime;
  return { last_bar_age: age, stale: age > step * 2 };
}

function chartOptions(ctx: Ctx): Pick<SeriesRequest, "chartType" | "currency" | "adjustment" | "noCache" | "cachePath"> {
  return {
    chartType: str(ctx.flags, "chart-type"),
    currency: str(ctx.flags, "currency"),
    adjustment: str(ctx.flags, "adjustment"),
    noCache: bool(ctx.flags, "no-cache"),
    cachePath: str(ctx.flags, "cache") ?? defaultCachePath(),
  };
}

// ------------------------------------------------------------------- candles

const CANDLE_COLUMNS = ["time_iso", "open", "high", "low", "close", "volume"];

async function cmdCandles(ctx: Ctx): Promise<CommandResult> {
  const input = ctx.positional[0];
  if (!input) throw usageError("candles needs a symbol, e.g. `candles BTCUSD --tf 1D --count 30`");

  const timeframe = normalizeTimeframe(str(ctx.flags, "tf") ?? str(ctx.flags, "timeframe"), "D");
  const count = Math.max(1, num(ctx.flags, "count", 100));

  const loaded = await loadSeries(ctx, {
    input,
    timeframe,
    count,
    fromRaw: str(ctx.flags, "from"),
    toRaw: str(ctx.flags, "to"),
    warmup: 0,
    ...chartOptions(ctx),
  });

  const selected = loaded.bars
    .filter((c) => loaded.windowFrom === null || c.time >= loaded.windowFrom)
    .slice(loaded.windowFrom === null ? -count : 0);
  const coverage =
    selected.length > 0
      ? { first: toIso(selected[0].time), last: toIso(selected[selected.length - 1].time) }
      : null;

  const ordered = bool(ctx.flags, "newest-first") ? [...selected].reverse() : selected;
  const rows = ordered.map((c) => candleRow(c, loaded.meta.volume_reliable));

  return finish(ctx, {
    json: {
      input,
      symbol: loaded.res.symbol,
      resolved_from: loaded.res.source,
      symbol_kind: loaded.meta.kind,
      unit: loaded.meta.unit,
      volume_reliable: loaded.meta.volume_reliable,
      timeframe,
      count: rows.length,
      coverage,
      as_of: toIso(loaded.nowSec),
      ...freshnessBlock(selected.length > 0 ? selected[selected.length - 1].time : null, loaded.nowSec, timeframe),
      cache: cacheBlock(loaded),
      ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings } : {}),
      ...(loaded.res.notes.length > 0 ? { notes: loaded.res.notes } : {}),
      candles: rows,
    },
    rows,
    columns: CANDLE_COLUMNS,
  });
}

// ---------------------------------------------------------------- indicators

const INDICATOR_COLUMNS = [
  "time_iso",
  "kc1_mid",
  "kc1_upper",
  "kc1_lower",
  "ema_high",
  "ema_low",
  "kc2_mid",
  "kc2_upper",
  "kc2_lower",
  "kc_low_mid",
  "kc_low_upper",
  "kc_low_lower",
  "median_200",
  "macd",
  "macd_signal",
  "macd_hist",
];

async function cmdIndicators(ctx: Ctx): Promise<CommandResult> {
  const input = ctx.positional[0];
  if (!input) throw usageError("indicators needs a symbol, e.g. `indicators BTCUSD --tf 1D --count 30`");

  const timeframe = normalizeTimeframe(str(ctx.flags, "tf") ?? str(ctx.flags, "timeframe"), "D");
  const count = Math.max(1, num(ctx.flags, "count", 100));
  const warmup = Math.max(0, Math.floor(num(ctx.flags, "warmup", warmupBars())));

  const loaded = await loadSeries(ctx, {
    input,
    timeframe,
    count,
    fromRaw: str(ctx.flags, "from"),
    toRaw: str(ctx.flags, "to"),
    warmup,
    ...chartOptions(ctx),
  });

  const points = computeDadaoZhiJian(loaded.bars, DADAO_ZHIJIAN_PARAMS);
  const inWindow = points.filter((_, i) => loaded.windowFrom === null || loaded.bars[i].time >= loaded.windowFrom);
  const trimmed = loaded.windowFrom === null ? inWindow.slice(-count) : inWindow;
  const coverage =
    trimmed.length > 0 ? { first: toIso(trimmed[0].time), last: toIso(trimmed[trimmed.length - 1].time) } : null;

  const ordered = bool(ctx.flags, "newest-first") ? [...trimmed].reverse() : trimmed;
  const rows = ordered.map(indicatorRow);

  return finish(ctx, {
    json: {
      input,
      symbol: loaded.res.symbol,
      resolved_from: loaded.res.source,
      symbol_kind: loaded.meta.kind,
      unit: loaded.meta.unit,
      volume_reliable: loaded.meta.volume_reliable,
      timeframe,
      indicator: "dadao_zhijian",
      indicator_title: "大道至简",
      params: DADAO_ZHIJIAN_PARAMS,
      warmup_bars: warmup,
      count: rows.length,
      coverage,
      as_of: toIso(loaded.nowSec),
      ...freshnessBlock(trimmed.length > 0 ? trimmed[trimmed.length - 1].time : null, loaded.nowSec, timeframe),
      cache: cacheBlock(loaded),
      ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings } : {}),
      ...(loaded.res.notes.length > 0 ? { notes: loaded.res.notes } : {}),
      series: rows,
    },
    rows,
    columns: INDICATOR_COLUMNS,
    rowsField: "series",
  });
}

// ------------------------------------------------------------------- version

function cmdVersion(): CommandResult {
  return {
    json: {
      cli: CLI_VERSION,
      library: LIBRARY_VERSION,
      node: process.version,
      cache: defaultCachePath(),
    },
  };
}

// ---------------------------------------------------------------------- help

const HELP = `tradingview — read-only TradingView candles + the 大道至简 indicator set

Usage: tradingview <command> <SYMBOL> [flags]

Commands
  candles <SYM>             closed OHLCV bars (--tf, --count, --from, --to)
  indicators <SYM>          the 大道至简 indicator set on those bars
  version                   versions and cache location
  help                      this text

Candle flags (shared)
  --tf, --timeframe TF  ${TIMEFRAME_HELP} (default D)
  --count N             most recent closed bars (default 100); ignored with --from
  --from T              oldest bar (ISO, Unix seconds, or -7d / -12h / -30m)
  --to T                newest bar (default: newest closed bar)
  --newest-first        reverse the output order
  --chart-type TYPE     HeikinAshi, Renko, LineBreak, Kagi, PointAndFigure, Range
  --currency EUR        convert prices
  --adjustment A        splits (default) / dividends / none
  --no-cache            bypass the SQLite cache (always hit the network)
  --cache PATH          cache database location (default $TV_CACHE_DB or the XDG cache dir)

Indicator flags
  --warmup N            extra bars fetched before the window so the indicator
                        values there are already converged (default 300)

Output flags
  --format json|csv|table|md   output format (default json)
  --compact                    one-line JSON
  --select a,b,c               keep only these output fields
  --exchange EXCHANGE          search for a bare symbol inside this exchange
  --type stock|crypto|forex|... restrict symbol search to a market type
  --session regular|extended   trading session
  --timeout MS                 per-call timeout (default 15000; candles use >=20000)
  --strict / --no-fallback     no symbol search; unknown flags/select fields error
  --quiet                      suppress the stderr resolution/warning notes
  --help                       this text

Indicators
  Only the 大道至简 set is computed: ta.kc(close, 50, 2.75), ta.kc(close, 50,
  3.75), ta.kc(low, 50, 3.75), ta.ema(high, 50), ta.ema(low, 50),
  ta.median(hlcc4, 200) and MACD(12, 26, 9) with hist = 2 * (macd - signal).
  No other indicator is available.

Cache
  Every request reads cached bars first, fetches only the missing older/newer
  slices, and stores the result back. Only closed bars are cached — the bar
  still forming is never requested, returned or stored.

Symbols
  Bare names work: USDT.D, US10Y, CNH1!, BTCUSD, DXY, VIX, ES1!...
  Otherwise pass EXCHANGE:SYMBOL, e.g. BINANCE:BTCUSDT.

Examples
  tradingview candles BTCUSD --tf 1D --count 30 --format csv
  tradingview candles USDT.D --tf 4h --from -30d
  tradingview indicators BTCUSD --tf 1D --count 30 --select time_iso,macd,macd_hist
  tradingview indicators BINANCE:SOLUSDT --tf 4h --count 50 --format table
`;

// ------------------------------------------------------------------ dispatch

type CommandFn = (ctx: Ctx) => Promise<CommandResult>;

const COMMANDS: Record<string, CommandFn> = {
  candles: cmdCandles,
  indicators: cmdIndicators,
  version: async () => cmdVersion(),
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);

  if (bool(flags, "version") || positional[0] === "version") {
    print(cmdVersion().json, { compact: bool(flags, "compact") });
    return;
  }
  if (positional.length === 0 || positional[0] === "help" || bool(flags, "help")) {
    process.stdout.write(HELP);
    return;
  }

  // A mistyped flag (`--cout 30`) must not silently become the default.
  const unknown = unknownFlags(flags);
  if (unknown.length > 0) {
    const message = `unknown flag(s): ${unknown.map((f) => `--${f}`).join(", ")}. Run \`tradingview help\` for the flag list.`;
    if (bool(flags, "strict")) throw usageError(message);
    process.stderr.write(`warning: ${message}\n`);
  }

  const command = positional.shift() as string;
  const fn = COMMANDS[command];
  if (!fn) {
    throw usageError(`unknown command '${command}'. Run \`tradingview help\` for the command list.`);
  }

  const ctx: Ctx = {
    command,
    positional,
    flags,
    format: detectFormat(flags),
    timeoutMs: num(flags, "timeout", 15_000),
    session: str(flags, "session") === "extended" ? "extended" : "regular",
    strict: bool(flags, "strict"),
    select: list(flags, "select"),
    quiet: bool(flags, "quiet"),
    compact: bool(flags, "compact"),
  };

  const result = await fn(ctx);
  // JSON keeps the envelope (symbol/coverage/cache/warnings); tabular formats
  // use the projected flat rows.
  const payload = ctx.format === "json" ? result.json : result.rows ?? result.json;
  print(payload, { format: ctx.format, compact: ctx.compact, columns: result.columns });
}

main().catch((err: unknown) => {
  process.stderr.write(JSON.stringify(errorPayload(err)) + "\n");
  process.exit(exitCodeFor(err));
});
