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
 * Read-only: nothing here places orders or edits any account state.
 */

import { getCandles, type Candle } from "@mathieuc/tradingview/data";
import { bool, list, num, parseArgs, str, type Flags } from "./src/args.ts";
import {
  defaultCachePath,
  openCache,
  readCandles,
  writeCandles,
  type Cache,
  type CacheKey,
} from "./src/cache.ts";
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
import { resolveSymbols, summarizeResolution, type Resolution } from "./src/symbols.ts";
import {
  isBarFinished,
  lastFinishedBarTime,
  normalizeTimeframe,
  parseTime,
  round,
  timeframeSeconds,
  toIso,
  withRetry,
} from "./src/util.ts";

const CLI_VERSION = "2.0.0";
const LIBRARY_VERSION = "4.0.0-rc.0";

// ---------------------------------------------------------------- result type

type CommandResult = {
  /** Payload for --format json. */
  json: unknown;
  /** Tabular payload for csv/table/md; defaults to `json`. */
  rows?: Record<string, unknown>[];
  columns?: string[];
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

function projectRow(row: Record<string, unknown>, select: string[]): Record<string, unknown> {
  if (select.length === 0) return row;
  const out: Record<string, unknown> = {};
  for (const key of select) if (key in row) out[key] = row[key];
  return out;
}

function finish(ctx: Ctx, result: CommandResult): CommandResult {
  if (ctx.select.length > 0) {
    const source = result.rows ?? (Array.isArray(result.json) ? (result.json as Record<string, unknown>[]) : undefined);
    if (source) result.rows = source.map((r) => projectRow(r, ctx.select));
  }
  return result;
}

function candleRow(c: Candle): Record<string, unknown> {
  return {
    time: c.time,
    time_iso: toIso(c.time),
    open: round(c.open, 8),
    high: round(c.high, 8),
    low: round(c.low, 8),
    close: round(c.close, 8),
    volume: c.volume,
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

// ------------------------------------------------------------------- candles

async function cmdCandles(ctx: Ctx): Promise<CommandResult> {
  const input = ctx.positional[0];
  if (!input) throw usageError("candles needs a symbol, e.g. `candles BTCUSD --tf 1D --count 30`");

  const timeframe = normalizeTimeframe(str(ctx.flags, "tf") ?? str(ctx.flags, "timeframe"), "D");
  const count = Math.max(1, num(ctx.flags, "count", 100));
  const fromRaw = str(ctx.flags, "from");
  const toRaw = str(ctx.flags, "to");
  const chartType = str(ctx.flags, "chart-type");
  const currency = str(ctx.flags, "currency");
  const adjustment = str(ctx.flags, "adjustment");
  const newestFirst = bool(ctx.flags, "newest-first");
  const noCache = bool(ctx.flags, "no-cache");
  const cachePath = str(ctx.flags, "cache") ?? defaultCachePath();

  const nowSec = Math.floor(Date.now() / 1000);
  // Only closed bars are allowed. `effTo` is the newest bar that can already
  // have completed, so the in-progress bar is never even requested.
  const reqTo = toRaw ? Math.floor(parseTime(toRaw, "--to").getTime() / 1000) : nowSec;
  const effTo = Math.min(reqTo, lastFinishedBarTime(nowSec, timeframe));

  // Without --from, ask for a window generously wider than `count` so market
  // gaps (weekends, holidays) cannot leave us short of the requested bars.
  const step = timeframeSeconds(timeframe) ?? 31 * 86_400;
  const reqFrom = fromRaw
    ? Math.floor(parseTime(fromRaw, "--from").getTime() / 1000)
    : effTo - Math.ceil(count * step * 3);
  if (reqFrom > effTo) {
    throw new CliError(
      `empty range for ${input}: --from is newer than --to (or than the newest closed bar)`,
      EXIT.notFound,
    );
  }

  const [res] = (await resolveSymbols([input], {
    exchange: str(ctx.flags, "exchange"),
    type: str(ctx.flags, "type"),
    noFallback: bool(ctx.flags, "no-fallback") || ctx.strict,
  })) as Resolution[];
  if (!res.symbol) throw new CliError(`unresolved symbol '${input}'`, EXIT.notFound, res.candidates);
  if (!ctx.quiet) process.stderr.write(`${summarizeResolution(res)}\n`);

  const key: CacheKey = {
    symbol: res.symbol,
    timeframe,
    variant: [chartType ?? "", currency ?? "", adjustment ?? "splits", ctx.session].join("|"),
  };
  const options: ChartOptions = {
    ...(chartType ? { chartType } : {}),
    ...(currency ? { currency } : {}),
    ...(adjustment ? { adjustment } : {}),
  };

  const warnings: string[] = [];
  let result: LoadResult;
  if (noCache) {
    result = await loadCandles(null, key, reqFrom, effTo, nowSec, ctx, options, warnings);
  } else {
    const db = openCache(cachePath);
    try {
      result = await loadCandles(db, key, reqFrom, effTo, nowSec, ctx, options, warnings);
    } finally {
      db.close();
    }
  }

  // Defensive: keep the requested window and closed bars only.
  const selected = result.candles
    .filter((c) => c.time >= reqFrom && c.time <= effTo && isBarFinished(c.time, timeframe, nowSec))
    .slice(fromRaw ? 0 : -count);
  const coverage =
    selected.length > 0
      ? { first: toIso(selected[0].time), last: toIso(selected[selected.length - 1].time) }
      : null;

  const ordered = newestFirst ? [...selected].reverse() : selected;
  const rows = ordered.map(candleRow);
  if (warnings.length > 0 && !ctx.quiet) for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  return finish(ctx, {
    json: {
      input,
      symbol: res.symbol,
      resolved_from: res.source,
      timeframe,
      count: rows.length,
      coverage,
      cache: noCache
        ? { enabled: false }
        : { enabled: true, path: cachePath, reused: result.cachedBefore, fetched: result.fetched },
      ...(warnings.length > 0 ? { warnings } : {}),
      candles: rows,
    },
    rows,
    columns: ["time_iso", "open", "high", "low", "close", "volume"],
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

const HELP = `tradingview — read-only TradingView candles with a SQLite cache

Usage: tradingview candles <SYMBOL> [flags]

Commands
  candles <SYM>             closed OHLCV bars (--tf, --count, --from, --to)
  version                   versions and cache location
  help                      this text

Candle flags
  --tf, --timeframe TF  1 5 15 60 240 (minutes), D W M, aliases 1m 1h 4h 1d 1w 1mo (default D)
  --count N             most recent closed bars (default 100); ignored with --from
  --from T              oldest bar (ISO, Unix seconds, or -7d / -12h / -30m)
  --to T                newest bar (default: newest closed bar)
  --newest-first        reverse the output order
  --chart-type TYPE     HeikinAshi, Renko, LineBreak, Kagi, PointAndFigure, Range
  --currency EUR        convert prices
  --adjustment A        splits (default) / dividends / none
  --no-cache            bypass the SQLite cache (always hit the network)
  --cache PATH          cache database location (default $TV_CACHE_DB or the XDG cache dir)

Output flags
  --format json|csv|table|md   output format (default json)
  --compact                    one-line JSON
  --select a,b,c               keep only these output fields
  --exchange EXCHANGE          force an exchange for a bare symbol
  --type stock|crypto|forex|... restrict symbol search to a market type
  --session regular|extended   trading session
  --timeout MS                 per-call timeout (default 15000; candles use >=20000)
  --strict / --no-fallback     do not fall back to symbol search
  --quiet                      suppress the stderr resolution/warning notes
  --help                       this text

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
  tradingview candles BINANCE:BTCUSDT --tf 1h --count 24 --cache ~/tv.sqlite
`;

// ------------------------------------------------------------------ dispatch

type CommandFn = (ctx: Ctx) => Promise<CommandResult>;

const COMMANDS: Record<string, CommandFn> = {
  candles: cmdCandles,
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
  const payload =
    ctx.select.length > 0 && result.rows ? result.rows : ctx.format === "json" ? result.json : result.rows ?? result.json;
  print(payload, { format: ctx.format, compact: ctx.compact, columns: result.columns });
}

main().catch((err: unknown) => {
  process.stderr.write(JSON.stringify(errorPayload(err)) + "\n");
  process.exit(exitCodeFor(err));
});
