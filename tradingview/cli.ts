#!/usr/bin/env node
/**
 * tradingview — read-only TradingView market-data CLI.
 *
 * Wraps the `@mathieuc/tradingview` v4 data API and resolves bare symbol names
 * (`USDT.D`, `US10Y`, `CNH1!`, `BTCUSD`) to exchange-qualified TradingView
 * symbols before fetching. Commands print JSON to stdout; errors go to stderr
 * with a meaningful exit code. Read-only: nothing here places orders or edits
 * any account state.
 */

import {
  getCandles,
  getHotlist,
  getIndicatorData,
  getQuote,
  getQuotes,
  getScreener,
  getSymbolInfo,
  getTechnicalAnalysis,
  getWatchlists,
  searchMarkets,
  watchCandles,
  watchQuotes,
} from "@mathieuc/tradingview/data";
import type {
  Candle,
  HotlistKind,
  QuoteData,
  ScreenerFilter,
  ScreenerResult,
  StudyValue,
  SymbolInfo,
  TechnicalAnalysis,
  Watchlist,
} from "@mathieuc/tradingview/data";

import { list, num, parseArgs, str, bool, type Flags } from "./src/args.ts";
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
import { credentials, hasCredentials } from "./src/creds.ts";
import { ALIASES, resolveSymbols, type Resolution } from "./src/symbols.ts";
import { normalizeTimeframe, parseTime, ratingLabel, round, toIso, withRetry } from "./src/util.ts";

const CLI_VERSION = "1.0.0";
const LIBRARY_VERSION = "4.0.0-rc.0";

// ---------------------------------------------------------------- result type

type CommandResult = {
  /** Payload for --format json. */
  json: unknown;
  /** Tabular payload for csv/table/md; defaults to `json`. */
  rows?: Record<string, unknown>[];
  columns?: string[];
  /** Command already wrote to stdout (streaming). */
  streamed?: boolean;
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

function nowIso(): string {
  return new Date().toISOString();
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

/** Quote row: obvious field names, ISO time next to the raw Unix timestamp. */
function quoteRow(res: Resolution, quote: QuoteData): Record<string, unknown> {
  return {
    input: res.input,
    symbol: res.symbol,
    resolved_from: res.source,
    description: quote.description ?? null,
    exchange: quote.exchange ?? null,
    type: quote.type ?? null,
    currency: quote.currency_code ?? null,
    last: round(quote.lp, 8),
    change: round(quote.ch, 8),
    change_pct: round(quote.chp, 4),
    bid: round(quote.bid, 8),
    ask: round(quote.ask, 8),
    open: round(quote.open_price, 8),
    high: round(quote.high_price, 8),
    low: round(quote.low_price, 8),
    prev_close: round(quote.prev_close_price, 8),
    volume: quote.volume ?? null,
    format: quote.format ?? null,
    update_mode: quote.update_mode ?? null,
    time: quote.lp_time ?? null,
    time_iso: toIso(typeof quote.lp_time === "number" ? quote.lp_time : null),
  };
}

function rawQuoteRow(res: Resolution, quote: QuoteData): Record<string, unknown> {
  return { input: res.input, symbol: res.symbol, resolved_from: res.source, ...quote };
}

function errorRow(res: Resolution, err: unknown): Record<string, unknown> {
  return {
    input: res.input,
    symbol: res.symbol,
    resolved_from: res.source,
    error: errMessage(err),
  };
}

const QUOTE_COLUMNS = [
  "input",
  "symbol",
  "description",
  "last",
  "change",
  "change_pct",
  "bid",
  "ask",
  "time_iso",
];

async function resolveInputs(ctx: Ctx, inputs: string[]): Promise<Resolution[]> {
  return resolveSymbols(inputs, {
    exchange: str(ctx.flags, "exchange"),
    type: str(ctx.flags, "type"),
    noFallback: bool(ctx.flags, "no-fallback") || ctx.strict,
  });
}

// ---------------------------------------------------------------- quote / candles

async function cmdQuote(ctx: Ctx): Promise<CommandResult> {
  const inputs = ctx.positional;
  if (inputs.length === 0) throw usageError("quote needs at least one symbol, e.g. `quote USDT.D US10Y BTCUSD`");
  const resolutions = await resolveInputs(ctx, inputs);
  const raw = bool(ctx.flags, "raw");
  const rows: Record<string, unknown>[] = [];

  const primaries = resolutions.map((r) => r.symbol).filter((s): s is string => s !== null);
  let batch: Record<string, QuoteData> | null = null;
  if (primaries.length > 1 && !ctx.strict) {
    try {
      batch = await withRetry(() => getQuotes({ symbols: primaries, session: ctx.session, timeoutMs: ctx.timeoutMs }));
    } catch {
      batch = null; // one bad symbol rejects the batch; retry per symbol below
    }
  }

  const failures: unknown[] = [];
  for (const res of resolutions) {
    if (!res.symbol) {
      rows.push({ input: res.input, error: "unresolved", hint: "run `tradingview search <text>` or pass EXCHANGE:SYMBOL" });
      continue;
    }
    const batched = batch?.[res.symbol];
    if (batched) {
      rows.push(raw ? rawQuoteRow(res, batched) : quoteRow(res, batched));
      continue;
    }
    const order = ctx.strict ? [res.symbol] : [res.symbol, ...res.alternatives];
    let used: string | null = null;
    let quote: QuoteData | null = null;
    let lastError: unknown = null;
    for (const candidate of order) {
      try {
        quote = await withRetry(() => getQuote({ symbol: candidate, session: ctx.session, timeoutMs: ctx.timeoutMs }));
        used = candidate;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (quote && used) {
      const effective: Resolution = used === res.symbol ? res : { ...res, symbol: used, source: "search" };
      rows.push(raw ? rawQuoteRow(effective, quote) : quoteRow(effective, quote));
    } else {
      failures.push(lastError);
      rows.push(errorRow(res, lastError));
    }
  }

  if (rows.length > 0 && rows.every((r) => "error" in r)) {
    // A rate-limited or dropped connection is retryable, not a bad symbol:
    // surface the transport exit code (6/5) instead of NOT_FOUND when every
    // failure was network-related.
    const transport = failures.map(exitCodeFor).find((c) => c === EXIT.network || c === EXIT.timeout);
    throw new CliError(`no quote for ${inputs.join(", ")}`, transport ?? EXIT.notFound, rows);
  }

  return finish(ctx, {
    json: rows,
    rows,
    columns: raw ? undefined : QUOTE_COLUMNS,
  });
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

async function cmdCandles(ctx: Ctx): Promise<CommandResult> {
  const input = ctx.positional[0];
  if (!input) throw usageError("candles needs a symbol, e.g. `candles BTCUSD --tf 1D --count 30`");
  const timeframe = normalizeTimeframe(str(ctx.flags, "tf") ?? str(ctx.flags, "timeframe"), "D");
  const count = num(ctx.flags, "count", 100);
  const from = str(ctx.flags, "from");
  const to = str(ctx.flags, "to");
  const chartType = str(ctx.flags, "chart-type");
  const currency = str(ctx.flags, "currency");
  const adjustment = str(ctx.flags, "adjustment");
  const newestFirst = bool(ctx.flags, "newest-first");

  const resolutions = await resolveInputs(ctx, [input]);
  const res = resolutions[0];
  const order = ctx.strict || !res.symbol ? [res.symbol] : [res.symbol, ...res.alternatives];

  let candles: Candle[] | null = null;
  let used = res.symbol;
  let lastError: unknown = null;
  for (const candidate of order) {
    if (!candidate) continue;
    try {
      candles = await withRetry(() =>
        getCandles({
          symbol: candidate,
          timeframe: timeframe as never,
          ...(from ? { from: parseTime(from, "--from") } : {}),
          ...(to ? { to: parseTime(to, "--to") } : {}),
          ...(from || to ? {} : { count }),
          ...(chartType ? { chartType: chartType as never } : {}),
          ...(currency ? { currency } : {}),
          ...(adjustment ? { adjustment } : {}),
          session: ctx.session,
          timeoutMs: Math.max(ctx.timeoutMs, 20_000),
        }),
      );
      used = candidate;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!candles) {
    if (!res.symbol) throw new CliError(`unresolved symbol '${input}'`, EXIT.notFound, res.candidates);
    throw lastError instanceof Error ? lastError : new CliError(errMessage(lastError), EXIT.error);
  }

  const rows = candles.map(candleRow);
  if (newestFirst) rows.reverse();
  const coverage = candles.length > 0
    ? { first: toIso(candles[0].time), last: toIso(candles.at(-1)!.time) }
    : null;

  return finish(ctx, {
    json: {
      input,
      symbol: used,
      timeframe,
      count: rows.length,
      coverage,
      candles: rows,
    },
    rows,
    columns: ["time_iso", "open", "high", "low", "close", "volume"],
  });
}

// ----------------------------------------------------------------------- watch

function frame(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function cmdWatch(ctx: Ctx): Promise<CommandResult> {
  const inputs = ctx.positional;
  if (inputs.length === 0) throw usageError("watch needs at least one symbol");
  const kind = (str(ctx.flags, "kind") ?? "quote").toLowerCase();
  const duration = num(ctx.flags, "duration", 0);
  const maxEvents = num(ctx.flags, "max-events", 0);
  const changesOnly = bool(ctx.flags, "changes-only");
  const resolutions = await resolveInputs(ctx, inputs);
  const symbolToInput = new Map<string, string>();
  const symbols: string[] = [];
  for (const res of resolutions) {
    if (!res.symbol) {
      frame({ event: "error", input: res.input, error: "unresolved" });
      continue;
    }
    symbolToInput.set(res.symbol, res.input);
    symbols.push(res.symbol);
  }
  if (symbols.length === 0) throw new CliError("no symbol could be resolved", EXIT.notFound);

  const stopHandlers: Array<() => Promise<void> | void> = [];
  let events = 0;
  let done = false;
  let resolveDone: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const emit = (obj: Record<string, unknown>) => {
    frame({ ts: nowIso(), ...obj });
    events++;
    if (maxEvents > 0 && events >= maxEvents && !done) {
      done = true;
      void Promise.all(stopHandlers.map((s) => s())).then(resolveDone);
    }
  };

  frame({ event: "start", kind, symbols, duration, changes_only: changesOnly, started_at: nowIso() });

  if (kind === "candles" || kind === "candle") {
    const timeframe = normalizeTimeframe(str(ctx.flags, "tf") ?? str(ctx.flags, "timeframe"), "1");
    const count = num(ctx.flags, "count", 50);
    for (const symbol of symbols) {
      const watcher = await withRetry(() =>
        watchCandles(
          { symbol, timeframe: timeframe as never, count, session: ctx.session, timeoutMs: ctx.timeoutMs },
          {
            onData: (snapshot: readonly Candle[]) => {
              const last = snapshot.at(-1);
              if (!last) return;
              emit({
                event: "candle",
                input: symbolToInput.get(symbol) ?? symbol,
                symbol,
                timeframe,
                time: last.time,
                time_iso: toIso(last.time),
                open: last.open,
                high: last.high,
                low: last.low,
                close: last.close,
                volume: last.volume,
              });
            },
            onError: (err: unknown) => frame({ ts: nowIso(), event: "error", symbol, error: errMessage(err) }),
          },
        ),
      );
      stopHandlers.push(() => watcher.stop());
    }
  } else if (kind === "quote" || kind === "quotes") {
    const previous = new Map<string, string>();
    const watcher = await withRetry(() =>
      watchQuotes(
        { symbols, session: ctx.session, timeoutMs: ctx.timeoutMs, fields: "all" },
        {
          onData: (symbol: string, quote: QuoteData) => {
            const signature = `${quote.lp}|${quote.chp}|${quote.bid}|${quote.ask}`;
            if (changesOnly && previous.get(symbol) === signature) return;
            previous.set(symbol, signature);
            emit({
              event: "quote",
              input: symbolToInput.get(symbol) ?? symbol,
              symbol,
              last: quote.lp ?? null,
              change: quote.ch ?? null,
              change_pct: quote.chp ?? null,
              bid: quote.bid ?? null,
              ask: quote.ask ?? null,
              volume: quote.volume ?? null,
              time: quote.lp_time ?? null,
              time_iso: toIso(typeof quote.lp_time === "number" ? quote.lp_time : null),
            });
          },
          onError: (err: unknown) => frame({ ts: nowIso(), event: "error", symbols, error: errMessage(err) }),
        },
      ),
    );
    stopHandlers.push(() => watcher.stop());
  } else {
    throw usageError(`unknown --kind '${kind}'. Use quote (default) or candles.`);
  }

  const shutdown = () => {
    if (done) return;
    done = true;
    void Promise.all(stopHandlers.map((s) => s())).then(resolveDone);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (duration > 0) {
    const timer = setTimeout(shutdown, duration * 1000);
    timer.unref?.();
  }

  await finished;
  frame({ event: "stop", events, stopped_at: nowIso() });
  return { json: null, streamed: true };
}

// ------------------------------------------------------------------ search / info

async function cmdSearch(ctx: Ctx): Promise<CommandResult> {
  const query = ctx.positional.join(" ");
  if (!query) throw usageError("search needs a query, e.g. `search nvidia`");
  const limit = num(ctx.flags, "limit", 15);
  const offset = num(ctx.flags, "offset", 0);
  const hits = await withRetry(() => searchMarkets(query, {
    ...(str(ctx.flags, "type") ? { type: str(ctx.flags, "type") as never } : {}),
    ...(str(ctx.flags, "exchange") ? { exchange: str(ctx.flags, "exchange") as string } : {}),
    ...(str(ctx.flags, "country") ? { country: str(ctx.flags, "country") as string } : {}),
    ...(offset ? { offset } : {}),
  }));
  const rows = hits.slice(0, limit).map((h) => ({
    id: h.id,
    symbol: h.symbol,
    exchange: h.exchange,
    description: h.description,
    type: h.type,
    currency: h.currency ?? null,
    country: h.country ?? null,
  }));
  return finish(ctx, {
    json: { query, total: hits.length, returned: rows.length, results: rows },
    rows,
    columns: ["id", "exchange", "description", "type", "currency"],
  });
}

function infoRow(res: Resolution, info: SymbolInfo): Record<string, unknown> {
  return {
    input: res.input,
    symbol: info.full_name ?? res.symbol,
    name: info.name,
    description: info.description,
    exchange: info.exchange,
    listed_exchange: info.listed_exchange,
    type: info.type,
    currency: info.currency_code,
    timezone: info.timezone,
    session: info.session,
    pricescale: info.pricescale,
    format: (info as { format?: unknown }).format ?? null,
    is_tradable: info.is_tradable,
    has_intraday: info.has_intraday,
    typespecs: info.typespecs ?? null,
  };
}

async function cmdInfo(ctx: Ctx): Promise<CommandResult> {
  const input = ctx.positional[0];
  if (!input) throw usageError("info needs a symbol, e.g. `info USDT.D`");
  const [res] = await resolveSymbols([input], {
    exchange: str(ctx.flags, "exchange"),
    noFallback: bool(ctx.flags, "no-fallback") || ctx.strict,
  });
  if (!res.symbol) throw new CliError(`unresolved symbol '${input}'`, EXIT.notFound, res.candidates);
  const info = await withRetry(() => getSymbolInfo({ symbol: res.symbol!, session: ctx.session, timeoutMs: ctx.timeoutMs }));
  if (bool(ctx.flags, "raw")) return { json: info };
  const row = infoRow(res, info);
  return finish(ctx, { json: row, rows: [row] });
}

// ------------------------------------------------------------------- ta / indicator

function ratingBlock(ta: TechnicalAnalysis | null): Record<string, unknown> | null {
  if (!ta) return null;
  const out: Record<string, unknown> = {};
  for (const [period, rating] of Object.entries(ta)) {
    out[period] = {
      all: rating.All,
      ma: rating.MA,
      other: rating.Other,
      label: ratingLabel(rating.All),
    };
  }
  return out;
}

async function cmdTa(ctx: Ctx): Promise<CommandResult> {
  const input = ctx.positional[0];
  if (!input) throw usageError("ta needs a symbol, e.g. `ta BTCUSD`");
  const [res] = await resolveSymbols([input], {
    exchange: str(ctx.flags, "exchange"),
    noFallback: bool(ctx.flags, "no-fallback") || ctx.strict,
  });
  if (!res.symbol) throw new CliError(`unresolved symbol '${input}'`, EXIT.notFound, res.candidates);
  const symbol = res.symbol;
  const ta = await withRetry(() => getTechnicalAnalysis(symbol));
  const ratings = ratingBlock(ta);
  const json = {
    input,
    symbol: res.symbol,
    as_of: nowIso(),
    scale: "-2 strong sell .. +2 strong buy",
    ratings,
  };
  const rows = ratings
    ? Object.entries(ratings).map(([period, block]) => {
        const b = block as Record<string, unknown>;
        return { period, all: b.all, ma: b.ma, other: b.other, label: b.label };
      })
    : [];
  return finish(ctx, { json, rows, columns: ["period", "all", "ma", "other", "label"] });
}

async function cmdIndicator(ctx: Ctx): Promise<CommandResult> {
  const input = ctx.positional[0];
  if (!input) throw usageError("indicator needs a symbol, e.g. `indicator BTCUSD --indicator STD;RSI`");
  const indicator = str(ctx.flags, "indicator");
  if (!indicator) {
    throw usageError(
      "indicator needs --indicator <id|study>, e.g. --indicator 'STD;RSI' (account) or --indicator 'Volume@tv-basicstudies-241' (anonymous)",
    );
  }
  const timeframe = normalizeTimeframe(str(ctx.flags, "tf") ?? str(ctx.flags, "timeframe"), "60");
  const last = num(ctx.flags, "last", 5);
  const all = bool(ctx.flags, "all");
  let inputs: Record<string, unknown> | undefined;
  const rawInputs = str(ctx.flags, "inputs");
  if (rawInputs) {
    try {
      const parsed = JSON.parse(rawInputs) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      inputs = parsed as Record<string, unknown>;
    } catch (err) {
      throw usageError(`--inputs must be a JSON object: ${errMessage(err)}`);
    }
  }

  const [res] = await resolveSymbols([input], {
    exchange: str(ctx.flags, "exchange"),
    noFallback: bool(ctx.flags, "no-fallback") || ctx.strict,
  });
  if (!res.symbol) throw new CliError(`unresolved symbol '${input}'`, EXIT.notFound, res.candidates);

  const result = await withRetry(() =>
    getIndicatorData({
      symbol: res.symbol!,
      timeframe: timeframe as never,
      indicator,
      ...(inputs ? { inputs } : {}),
      ...(credentials() ? { credentials: credentials() } : {}),
      timeoutMs: Math.max(ctx.timeoutMs, 20_000),
    }),
  );

  const values: StudyValue[] = result.values;
  const plots = new Set<string>();
  for (const row of values) for (const key of Object.keys(row)) if (key !== "$time") plots.add(key);
  const slice = all ? values : values.slice(-Math.max(1, last));
  const rows = slice.map((row) => {
    const time = typeof row.$time === "number" ? row.$time : null;
    return { time, time_iso: toIso(time), ...row };
  });

  return finish(ctx, {
    json: {
      input,
      symbol: res.symbol,
      indicator,
      timeframe,
      candles: result.candles.length,
      bars: values.length,
      plots: [...plots],
      strategy_report:
        result.strategyReport &&
        result.strategyReport.performance &&
        Object.keys(result.strategyReport.performance).length > 0
          ? { currency: result.strategyReport.currency, performance: result.strategyReport.performance }
          : null,
      values: rows,
    },
    rows,
  });
}

// --------------------------------------------------------- screener / hotlist

function flattenScreener(page: ScreenerResult): Record<string, unknown>[] {
  return page.rows.map((row) => ({ symbol: row.symbol, ...row.values }));
}

function parseSort(raw: string | undefined): { sortBy: string; sortOrder: "asc" | "desc" } | undefined {
  if (!raw) return undefined;
  const [field, orderRaw] = raw.split(":");
  if (!field) return undefined;
  const order = orderRaw === "asc" ? "asc" : "desc";
  return { sortBy: field, sortOrder: order };
}

function parseFilter(raw: string | undefined): ScreenerFilter[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
    return parsed as ScreenerFilter[];
  } catch (err) {
    throw usageError(`--filter must be a JSON array of {left, operation, right}: ${errMessage(err)}`);
  }
}

function parseRange(ctx: Ctx, dflt: [number, number]): [number, number] {
  const raw = str(ctx.flags, "range");
  const limit = str(ctx.flags, "limit");
  if (raw) {
    const [a, b] = raw.split(":").map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) return [a, b];
  }
  if (limit !== undefined && Number.isFinite(Number(limit))) return [0, Number(limit)];
  return dflt;
}

async function cmdScreener(ctx: Ctx): Promise<CommandResult> {
  const columns = list(ctx.flags, "columns");
  if (columns.length === 0) {
    throw usageError(
      "screener needs --columns, e.g. --columns 'name,close,change,volume'. Include every field used in --filter/--sort.",
    );
  }
  const page = await withRetry(() => getScreener({
    market: str(ctx.flags, "market") ?? "america",
    columns,
    ...(parseFilter(str(ctx.flags, "filter")) ? { filter: parseFilter(str(ctx.flags, "filter")) } : {}),
    ...(parseSort(str(ctx.flags, "sort")) ? { sort: parseSort(str(ctx.flags, "sort")) } : {}),
    ...(parseRange(ctx, [0, 50]) ? { range: parseRange(ctx, [0, 50]) } : {}),
    ...(list(ctx.flags, "symbols").length > 0 ? { symbols: list(ctx.flags, "symbols") } : {}),
  }, credentials() ? { credentials: credentials() } : {}));
  const rows = flattenScreener(page);
  return finish(ctx, {
    json: { totalCount: page.totalCount, columns, returned: rows.length, rows },
    rows,
    columns: ["symbol", ...columns],
  });
}

async function cmdHotlist(ctx: Ctx): Promise<CommandResult> {
  const kind = (str(ctx.flags, "kind") ?? "gainers") as HotlistKind;
  const valid: HotlistKind[] = ["gainers", "losers", "mostActive", "volumeGainers"];
  if (!valid.includes(kind)) throw usageError(`--kind must be one of ${valid.join(", ")}`);
  const market = str(ctx.flags, "market") ?? "america";
  const columns = list(ctx.flags, "columns");
  const page = await withRetry(() => getHotlist({
    kind,
    market,
    range: parseRange(ctx, [0, 20]),
    ...(columns.length > 0 ? { columns } : {}),
    // Non-stock universes keep a default stock filter unless it is cleared.
    ...(market !== "america" ? { filter: [] } : {}),
  }));
  const rows = flattenScreener(page);
  const cols = ["symbol", ...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k !== "symbol")))];
  return finish(ctx, {
    json: { kind, market, totalCount: page.totalCount, returned: rows.length, rows },
    rows,
    columns: cols,
  });
}

// ------------------------------------------------------------------ watchlists

async function cmdWatchlists(ctx: Ctx): Promise<CommandResult> {
  const creds = credentials();
  if (!creds) {
    throw new CliError(
      "watchlists need account cookies: set TV_SESSION and TV_SIGNATURE in the environment",
      EXIT.auth,
    );
  }
  const lists: Watchlist[] = await getWatchlists({ credentials: creds });
  const brief = bool(ctx.flags, "brief");
  const rows = lists.map((wl) => ({
    id: wl.id,
    name: wl.name,
    symbol_count: Array.isArray(wl.symbols) ? wl.symbols.length : 0,
    ...(brief ? {} : { symbols: wl.symbols }),
  }));
  return finish(ctx, { json: rows, rows });
}

// -------------------------------------------------------------------- resolve

async function cmdResolve(ctx: Ctx): Promise<CommandResult> {
  const inputs = ctx.positional;
  if (inputs.length === 0) throw usageError("resolve needs at least one symbol, e.g. `resolve USDT.D CNH1!`");
  const verify = bool(ctx.flags, "verify");
  const resolutions = await resolveInputs(ctx, inputs);
  const rows: Record<string, unknown>[] = [];
  for (const r of resolutions) {
    const row: Record<string, unknown> = {
      input: r.input,
      symbol: r.symbol,
      source: r.source,
      confidence: r.confidence,
      alternatives: r.alternatives,
      notes: r.notes,
    };
    if (bool(ctx.flags, "candidates") || verify) {
      row.candidates = r.candidates.map((c) => ({ id: c.id, description: c.description, type: c.type }));
    }
    if (verify && r.symbol) {
      const checks: Record<string, unknown>[] = [];
      for (const candidate of [r.symbol, ...r.alternatives]) {
        try {
          const q = await withRetry(() => getQuote({ symbol: candidate, timeoutMs: ctx.timeoutMs }));
          checks.push({ symbol: candidate, ok: true, last: q.lp ?? null, description: q.description ?? null });
        } catch (err) {
          checks.push({ symbol: candidate, ok: false, error: errMessage(err) });
        }
      }
      row.verified = checks;
      const good = checks.find((c) => c.ok === true);
      if (good && typeof good.symbol === "string") row.symbol = good.symbol;
    }
    rows.push(row);
    if (!verify && !ctx.quiet) process.stderr.write(`${r.input} -> ${r.symbol ?? "(unresolved)"} [${r.source}/${r.confidence}]\n`);
  }
  return finish(ctx, { json: rows, rows, columns: ["input", "symbol", "source", "confidence"] });
}

async function cmdAliases(ctx: Ctx): Promise<CommandResult> {
  const rows = Object.entries(ALIASES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, symbol]) => ({ alias, symbol }));
  return finish(ctx, { json: { count: rows.length, aliases: rows }, rows, columns: ["alias", "symbol"] });
}

// ---------------------------------------------------------------------- probe

async function cmdProbe(ctx: Ctx): Promise<CommandResult> {
  const checks: Record<string, unknown> = {};
  let ok = true;

  const timed = async (name: string, fn: () => Promise<unknown>) => {
    const started = Date.now();
    try {
      const value = await fn();
      checks[name] = { ok: true, latency_ms: Date.now() - started, value };
    } catch (err) {
      ok = false;
      checks[name] = { ok: false, latency_ms: Date.now() - started, error: errMessage(err) };
    }
  };

  await timed("quote", async () => {
    const q = await getQuote({ symbol: "BITSTAMP:BTCUSD", timeoutMs: ctx.timeoutMs });
    return { symbol: "BITSTAMP:BTCUSD", last: q.lp ?? null };
  });
  await timed("search", async () => {
    const hits = await searchMarkets("USDT.D");
    return { first: hits[0]?.id ?? null };
  });

  const json = {
    ok,
    cli: CLI_VERSION,
    library: LIBRARY_VERSION,
    node: process.version,
    credentials: hasCredentials(),
    checks,
  };
  return { json };
}

function cmdVersion(): CommandResult {
  return {
    json: {
      cli: CLI_VERSION,
      library: LIBRARY_VERSION,
      node: process.version,
      credentials: hasCredentials(),
    },
  };
}

// ----------------------------------------------------------------------- help

const HELP = `tradingview — read-only TradingView market data

Usage: tradingview <command> [args] [flags]

Commands
  quote <SYM...>            last price, change, bid/ask, day range (batched)
  candles <SYM>             OHLCV bars (--tf, --count, --from, --to, --chart-type)
  watch <SYM...>            stream quotes or candles as NDJSON (--duration, --kind)
  ta <SYM>                  technical ratings across timeframes
  indicator <SYM>           run an indicator (--indicator STD;RSI|Volume@...)
  search <text>             find exchange-qualified symbols
  info <SYM>                symbol metadata (exchange, session, currency...)
  screener                  one scanner page (--columns, --filter, --sort, --market)
  hotlist                   gainers / losers / mostActive / volumeGainers
  watchlists                read-only account watchlists (needs cookies)
  resolve <SYM...>          show how a bare name resolves (--verify)
  aliases                   list the built-in bare-name aliases
  probe                     connectivity + credentials check
  version                   versions and credential status

Flags
  --format json|csv|table|md   output format (default json)
  --compact                    one-line JSON
  --select a,b,c               keep only these output fields
  --exchange EXCHANGE          force an exchange for bare symbols
  --type stock|crypto|...      restrict symbol search to a market type
  --session regular|extended   trading session for quotes/candles
  --timeout MS                 per-call timeout (default 15000)
  --strict                     no search fallback; use only the resolved symbol
  --no-fallback                alias/explicit only, never search
  --raw                        print raw upstream objects
  --quiet                      suppress stderr notes
  --help                       this text

Symbols
  Bare names work: USDT.D, US10Y, CNH1!, BTCUSD, AAPL, DXY, VIX, ES1!...
  Account cookies TV_SESSION + TV_SIGNATURE unlock Pine studies and fuller history.

Examples
  tradingview quote USDT.D US10Y CNH1! BTCUSD --format table
  tradingview candles BTCUSD --tf 1D --count 30 --format csv
  tradingview watch BTCUSD BINANCE:ETHUSDT --duration 20 --changes-only
  tradingview resolve CNH1! --verify
`;

// ------------------------------------------------------------------- dispatch

type CommandFn = (ctx: Ctx) => Promise<CommandResult>;

const COMMANDS: Record<string, CommandFn> = {
  quote: cmdQuote,
  candles: cmdCandles,
  watch: cmdWatch,
  search: cmdSearch,
  info: cmdInfo,
  ta: cmdTa,
  indicator: cmdIndicator,
  screener: cmdScreener,
  hotlist: cmdHotlist,
  watchlists: cmdWatchlists,
  resolve: cmdResolve,
  aliases: cmdAliases,
  probe: cmdProbe,
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
  if (result.streamed) return;
  const tabular = result.rows ?? result.json;
  const payload = ctx.select.length > 0 && result.rows ? result.rows : ctx.format === "json" ? result.json : tabular;
  print(payload, {
    format: ctx.format,
    compact: ctx.compact,
    columns: result.columns,
  });
}

main().catch((err: unknown) => {
  process.stderr.write(JSON.stringify(errorPayload(err)) + "\n");
  process.exit(exitCodeFor(err));
});
