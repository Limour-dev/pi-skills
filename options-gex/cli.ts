#!/usr/bin/env node
/**
 * options-gex — short-dated US option positioning (GEX) from the Sell The News
 * options dashboard.
 *
 * Primary channel: `GET /api/options/chain` (native JSON).
 * Fallback channel: MCP `get_options_data` (text, parsed with a regex grammar).
 *
 * Everything prints JSON to stdout (`--format pretty|compact|table`); errors go
 * to stderr unless `--json-errors` is set. Exit codes: 0 ok, 1 runtime,
 * 2 usage, 3 data unavailable, 4 rate limited, 5 silent expiry fallback.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CliError,
  DataUnavailableError,
  ExpFallbackError,
  UsageError,
  errorPayload,
  EXIT,
} from "./src/errors.ts";
import { fetchChain, assertExpiryFormat, chainUrl, apiBase } from "./src/rest.ts";
import { callOptionsData, mcpUrl, parseOptionsText } from "./src/mcp.ts";
import { fromMcp, fromRest, snapshotFromFileBody } from "./src/normalize.ts";
import { scanTicker, type SnapshotLoader, type TickerScan } from "./src/scan.ts";
import {
  DEFAULT_TOP,
  projectExpiries,
  projectFlip,
  projectGex,
  projectLevels,
  projectMaxPain,
  projectRaw,
  projectSkew,
  projectWalls,
  type Command,
  type ProjectOptions,
} from "./src/project.ts";
import { render, type OutputFormat } from "./src/format.ts";
import { GREEK_PARAMS, type HttpMeta, type Snapshot } from "./src/types.ts";
import { utcToday } from "./src/num.ts";

const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

type Flags = Map<string, string | boolean>;

const VALUE_FLAGS = new Set([
  "exp",
  "expiration",
  "greeks",
  "top",
  "top-by",
  "strike-range",
  "dte",
  "include",
  "source",
  "max-strikes",
  "format",
  "from-file",
  "timeout",
  "max-retries",
  "today",
  "tickers",
  "concurrency",
  "max-exp",
]);
const BOOLEAN_FLAGS = new Set(["no-cache", "no-insights", "json-errors", "strict-exp", "verbose", "help", "version"]);

const COMMANDS: Command[] = ["gex", "levels", "walls", "max-pain", "flip", "skew", "expiries", "raw", "scan", "probe"];

const HELP = `options-gex ${VERSION} — short-dated option positioning (GEX) from the Sell The News dashboard

usage: options-gex <command> <TICKER> [TICKER...] [flags]

commands:
  gex        key levels + per-strike GEX (or gamma net exposure) table
  levels     key levels only — smallest output
  walls      call wall / put wall with OI and distance from spot
  max-pain   max pain strike with distance from spot
  flip       gamma flip, where spot sits relative to it, zero-gamma cross-check
  skew       vanna + charm net exposure by strike
  expiries   listed expirations (with day count)
  raw        projected snapshot: levels + per-strike tables + optional dictionaries
  scan       one compact row per expiry inside --dte, for one or more tickers
  probe      check REST and MCP reachability, latency and rate-limit headers

flags:
  --exp YYYY-MM-DD       target expiry; omitted → nearest. (REST param is \`exp\`)
  --greeks LIST          gamma,delta,theta,vega,vanna,charm or all (default gamma)
  --top N                strikes per table (default ${DEFAULT_TOP})
  --top-by abs|nearest   rank --top by |exposure| (default) or distance to spot
  --strike-range PCT     return strikes within ±PCT% of spot (overrides --top)
  --dte N                expiries/scan: keep expirations within N days (scan default 7)
  --concurrency N        scan: in-flight requests, 1..8 (default 3)
  --max-exp N            scan: cap expiries per ticker (default 12)
  --tickers A,B,C        scan: extra tickers (same as positional)
  --include LIST         raw: extra dictionaries — oi, vol, mid
  --source rest|mcp|auto channel (default auto: REST first, MCP on failure)
  --max-strikes N        MCP fallback only: strikes per table (1..200, default 40)
  --format pretty|compact|table
  --from-file PATH       read a saved response or fixture instead of the network
  --timeout SEC          per-request timeout (default 20)
  --max-retries N        retries for network errors, 5xx and 429 (default 2)
  --no-cache             bypass the local 60s cache and the upstream cache
  --strict-exp           exit 5 when the server silently falls back to another expiry
  --json-errors          print errors as JSON on stdout
  --no-insights          omit the upstream English insights from the output
  --today YYYY-MM-DD     override today's date (for \`expiries\` day counts)
  --verbose              log request details to stderr
  -h, --help / --version

exit codes: 0 ok · 1 runtime error · 2 usage error · 3 data unavailable ·
            4 rate limited · 5 silent expiry fallback (--strict-exp)`;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      let key = arg.slice(2);
      let value: string | boolean = true;
      const eq = key.indexOf("=");
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (eq < 0) {
        if (BOOLEAN_FLAGS.has(key)) {
          value = true;
        } else if (VALUE_FLAGS.has(key)) {
          const next = argv[i + 1];
          if (next === undefined || (next.startsWith("-") && next !== "-")) {
            throw new UsageError(`--${key} requires a value`);
          }
          value = next;
          i += 1;
        } else {
          throw new UsageError(`unknown flag --${key}`);
        }
      }
      flags.set(key, value);
      continue;
    }
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "-v" || arg === "-V") {
      flags.set("version", true);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`unknown flag ${arg}`);
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function bool(flags: Flags, key: string): boolean {
  const value = flags.get(key);
  return value === true || value === "true";
}

function numberFlag(flags: Flags, key: string): number | undefined {
  const raw = str(flags, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${key} must be a number (got "${raw}")`);
  return value;
}

function enumFlag<T extends string>(flags: Flags, key: string, allowed: readonly T[]): T | undefined {
  const raw = str(flags, key);
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new UsageError(`--${key} must be one of ${allowed.join(", ")} (got "${raw}")`);
  }
  return raw as T;
}

interface RunOptions {
  command: Command;
  ticker: string;
  tickers: string[];
  exp?: string;
  greeks?: string;
  greekList: string[];
  format: OutputFormat;
  source: "rest" | "mcp" | "auto";
  fromFile?: string;
  timeoutMs: number;
  maxRetries: number;
  noCache: boolean;
  strictExp: boolean;
  jsonErrors: boolean;
  verbose: boolean;
  maxStrikes: number;
  project: ProjectOptions;
  insights: boolean;
  concurrency: number;
  maxExpirations: number;
}

function buildOptions(command: Command, positionalTickers: string[], flags: Flags): RunOptions {
  const exp = str(flags, "exp") ?? str(flags, "expiration");
  if (exp !== undefined) assertExpiryFormat(exp);

  const flagTickers = (str(flags, "tickers") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const tickers: string[] = [];
  for (const candidate of [...positionalTickers, ...flagTickers]) {
    if (!tickers.some((seen) => seen.toUpperCase() === candidate.toUpperCase())) tickers.push(candidate);
  }
  if (command !== "scan" && tickers.length > 1) {
    throw new UsageError(
      "multiple tickers are only supported by `scan` (e.g. options-gex scan TLT SPY QQQ)",
    );
  }
  if (command === "scan" && tickers.length === 0) {
    throw new UsageError("scan requires at least one TICKER (e.g. options-gex scan TLT SPY QQQ)");
  }
  const ticker = tickers[0] ?? "SPY";

  const defaultGreeks = command === "skew" ? "vanna,charm" : "gamma";
  const greeksArg = str(flags, "greeks") ?? defaultGreeks;
  const greekList = parseGreekArg(greeksArg);

  const format = enumFlag(flags, "format", ["pretty", "compact", "table"] as const) ?? "pretty";
  const source = enumFlag(flags, "source", ["rest", "mcp", "auto"] as const) ?? "auto";
  const top = numberFlag(flags, "top");
  if (top !== undefined && (!Number.isInteger(top) || top < 1)) {
    throw new UsageError(`--top must be a positive integer (got ${top})`);
  }
  const strikeRange = numberFlag(flags, "strike-range");
  if (strikeRange !== undefined && strikeRange <= 0) {
    throw new UsageError(`--strike-range must be positive (got ${strikeRange})`);
  }
  const dte = numberFlag(flags, "dte");
  if (dte !== undefined && dte < 0) throw new UsageError(`--dte must be >= 0 (got ${dte})`);
  const concurrency = numberFlag(flags, "concurrency") ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new UsageError(`--concurrency must be an integer 1..8 (got ${concurrency})`);
  }
  const maxExpirations = numberFlag(flags, "max-exp") ?? 12;
  if (!Number.isInteger(maxExpirations) || maxExpirations < 1) {
    throw new UsageError(`--max-exp must be a positive integer (got ${maxExpirations})`);
  }
  const timeoutSec = numberFlag(flags, "timeout") ?? 20;
  if (timeoutSec <= 0) throw new UsageError(`--timeout must be positive (got ${timeoutSec})`);
  const maxRetries = numberFlag(flags, "max-retries") ?? 2;
  if (maxRetries < 0) throw new UsageError(`--max-retries must be >= 0 (got ${maxRetries})`);
  const maxStrikes = numberFlag(flags, "max-strikes") ?? 40;
  if (!Number.isInteger(maxStrikes) || maxStrikes < 1 || maxStrikes > 200) {
    throw new UsageError(`--max-strikes must be an integer 1..200 (got ${maxStrikes})`);
  }
  const topBy = enumFlag(flags, "top-by", ["abs", "nearest"] as const);
  const include = str(flags, "include")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (include) {
    for (const item of include) {
      if (!["oi", "vol", "mid"].includes(item)) {
        throw new UsageError(`--include must be a comma list of oi, vol, mid (got "${item}")`);
      }
    }
  }
  const today = str(flags, "today") ?? utcToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new UsageError(`--today must be YYYY-MM-DD (got "${today}")`);

  return {
    command,
    ticker,
    tickers,
    exp,
    greeks: greeksArg,
    greekList,
    format,
    source,
    fromFile: str(flags, "from-file"),
    timeoutMs: timeoutSec * 1000,
    maxRetries,
    noCache: bool(flags, "no-cache"),
    strictExp: bool(flags, "strict-exp"),
    jsonErrors: bool(flags, "json-errors"),
    insights: !bool(flags, "no-insights"),
    verbose: bool(flags, "verbose"),
    maxStrikes,
    concurrency,
    maxExpirations,
    project: {
      top,
      topBy,
      strikeRangePct: strikeRange,
      greeks: greekList,
      include,
      today,
      dte: command === "scan" ? (dte ?? 7) : dte,
    },
  };
}

function parseGreekArg(raw: string): string[] {
  if (raw === "" || raw === "all") return [...GREEK_PARAMS];
  const list = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return [...GREEK_PARAMS];
  for (const greek of list) {
    if (!(GREEK_PARAMS as readonly string[]).includes(greek)) {
      throw new UsageError(`--greeks must be a comma list of ${GREEK_PARAMS.join(", ")} or all (got "${greek}")`);
    }
  }
  return list;
}

interface Loaded {
  snapshot: Snapshot;
  extraWarnings: string[];
}

async function loadOne(
  options: RunOptions,
  ticker: string,
  requestedExp: string | undefined,
  log: (msg: string) => void,
): Promise<Loaded> {

  if (options.fromFile) {
    const path = resolve(options.fromFile);
    const body = readFileSync(path, "utf8");
    const meta: HttpMeta = { status: 0, latency_ms: 0, from_cache: false };
    const snapshot = snapshotFromFileBody(body, {
      url: `file://${path}`,
      meta,
      requestedExp,
      requestedGreeks: options.greeks,
    });
    log(`read ${path} (source ${snapshot.source})`);
    return { snapshot, extraWarnings: [] };
  }

  const useRest = options.source === "rest" || options.source === "auto";
  const useMcp = options.source === "mcp" || options.source === "auto";
  let restError: unknown;

  if (useRest) {
    try {
      log(`GET ${chainUrl(ticker, requestedExp, options.greeks)} (source rest)`);
      const result = await fetchChain({
        ticker,
        exp: requestedExp,
        greeks: options.greeks,
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries,
        noCache: options.noCache,
      });
      log(`rest ok: HTTP ${result.meta.status} in ${result.meta.latency_ms}ms`);
      const snapshot = fromRest(result.chain, {
        url: result.url,
        meta: result.meta,
        requestedExp,
        requestedGreeks: options.greeks,
      });
      return { snapshot, extraWarnings: [] };
    } catch (error) {
      if (!useMcp || error instanceof UsageError) throw error;
      restError = error;
      log(`rest failed: ${error instanceof Error ? error.message : String(error)} — falling back to mcp`);
    }
  }

  if (useMcp) {
    try {
      log(`POST ${mcpUrl()} get_options_data (source mcp)`);
      const result = await callOptionsData({
        ticker,
        expiration: requestedExp,
        greeks: options.greeks,
        maxStrikes: options.maxStrikes,
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries,
      });
      log(`mcp ok: HTTP ${result.meta.status} in ${result.meta.latency_ms}ms`);
      const snapshot = fromMcp(parseOptionsText(result.text), {
        url: result.url,
        meta: result.meta,
        requestedExp,
        requestedGreeks: options.greeks,
      });
      const extraWarnings: string[] = [];
      if (restError) {
        extraWarnings.push(
          `REST channel unavailable (${restError instanceof Error ? restError.message : String(restError)}); ` +
            "this snapshot came from the MCP text fallback",
        );
      }
      return { snapshot, extraWarnings };
    } catch (error) {
      if (restError) {
        if (restError instanceof CliError && !(restError instanceof DataUnavailableError)) throw restError;
        throw restError;
      }
      throw error;
    }
  }

  throw restError instanceof Error ? restError : new CliError("no data source available");
}

function loadSnapshot(options: RunOptions, log: (msg: string) => void): Promise<Loaded> {
  const requestedExp = options.command === "expiries" ? undefined : options.exp;
  return loadOne(options, options.ticker, requestedExp, log);
}

function checkExpFallback(options: RunOptions, snapshot: Snapshot): void {
  if (!options.strictExp) return;
  if (snapshot.requested_exp && snapshot.selected_exp !== snapshot.requested_exp) {
    throw new ExpFallbackError(
      `silent expiry fallback: requested ${snapshot.requested_exp}, server returned ${snapshot.selected_exp}`,
      { requested_exp: snapshot.requested_exp, selected_exp: snapshot.selected_exp },
    );
  }
}

async function runProbe(options: RunOptions, log: (msg: string) => void): Promise<Record<string, unknown>> {
  const rest: Record<string, unknown> = { url: chainUrl("SPY"), endpoint: `${apiBase()}/api/options/chain` };
  let restOk = false;
  try {
    const started = Date.now();
    const result = await fetchChain({
      ticker: "SPY",
      timeoutMs: options.timeoutMs,
      maxRetries: 0,
      noCache: options.noCache,
    });
    restOk = true;
    rest.ok = true;
    rest.latency_ms = Date.now() - started;
    rest.http_status = result.meta.status;
    rest.selected_exp = result.chain.selected_exp;
    rest.spot = result.chain.expiration?.spot;
    rest.cf_cache = result.meta.cf_cache;
    rest.ratelimit = result.meta.ratelimit;
    rest.expirations = result.chain.expiration_dates?.length;
  } catch (error) {
    rest.ok = false;
    rest.error = error instanceof Error ? error.message : String(error);
    rest.exit_code = error instanceof CliError ? error.exitCode : EXIT.error;
  }

  const mcp: Record<string, unknown> = { url: mcpUrl(), tool: "get_options_data" };
  let mcpOk = false;
  try {
    const started = Date.now();
    const result = await callOptionsData({
      ticker: "SPY",
      greeks: "gamma",
      maxStrikes: 1,
      timeoutMs: options.timeoutMs,
      maxRetries: 0,
    });
    mcpOk = true;
    mcp.ok = true;
    mcp.latency_ms = Date.now() - started;
    mcp.http_status = result.meta.status;
    mcp.text_bytes = result.text.length;
  } catch (error) {
    mcp.ok = false;
    mcp.error = error instanceof Error ? error.message : String(error);
    mcp.exit_code = error instanceof CliError ? error.exitCode : EXIT.error;
  }

  log(`probe: rest=${restOk ? "ok" : "fail"} mcp=${mcpOk ? "ok" : "fail"}`);
  return {
    ok: restOk || mcpOk,
    checked_at: new Date().toISOString(),
    rest,
    mcp,
    note: restOk
      ? "REST is reachable — use it as the primary channel"
      : mcpOk
        ? "REST is down but MCP works — pass --source mcp"
        : "neither channel responded",
    exit_code: restOk || mcpOk ? EXIT.ok : EXIT.error,
  };
}

async function runScan(options: RunOptions, log: (msg: string) => void): Promise<Record<string, unknown>> {
  const load: SnapshotLoader = (ticker, exp) => loadOne(options, ticker, exp, log);
  const scanOptions = {
    dte: options.project.dte ?? 7,
    exp: options.exp,
    today: options.project.today ?? utcToday(),
    concurrency: options.concurrency,
    maxExpirations: options.maxExpirations,
  };
  const tickers: TickerScan[] = [];
  for (const ticker of options.tickers) {
    log(`scan ${ticker} --dte ${scanOptions.dte} --max-exp ${scanOptions.maxExpirations}`);
    tickers.push(await scanTicker(ticker, load, scanOptions));
  }
  if (options.strictExp && options.exp) {
    for (const result of tickers) {
      const first = result.scan[0];
      if (first && first.exp !== options.exp) {
        throw new ExpFallbackError(
          `silent expiry fallback: requested ${options.exp}, server returned ${first.exp}`,
          { requested_exp: options.exp, selected_exp: first.exp },
        );
      }
    }
  }
  return {
    generated_at: new Date().toISOString(),
    today: scanOptions.today,
    dte_max: scanOptions.dte,
    concurrency: scanOptions.concurrency,
    tickers,
  };
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (bool(flags, "version") || positional[0] === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (bool(flags, "help") || positional.length === 0 || positional[0] === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const command = positional[0] as Command;
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`unknown command "${positional[0]}"\n\n${HELP}`);
  }

  const hasTickerArg = Boolean(positional[1]) || str(flags, "tickers") !== undefined;
  if (command !== "probe" && command !== "scan" && !hasTickerArg) {
    throw new UsageError(`${command} requires a TICKER (e.g. options-gex ${command} SPY)`);
  }

  const options = buildOptions(command, positional.slice(1), flags);
  const log = (message: string) => {
    if (options.verbose) process.stderr.write(`[options-gex] ${message}\n`);
  };

  if (str(flags, "dte") !== undefined && command !== "expiries" && command !== "scan") {
    process.stderr.write(
      "options-gex: note: --dte only applies to `expiries` and `scan`; ignored by this command\n",
    );
  }

  let data: Record<string, unknown>;
  if (command === "probe") {
    data = await runProbe(options, log);
    if (data.exit_code !== EXIT.ok) process.exitCode = EXIT.error;
  } else if (command === "scan") {
    data = await runScan(options, log);
  } else {
    const { snapshot, extraWarnings } = await loadSnapshot(options, log);
    checkExpFallback(options, snapshot);
    const view = options.insights ? snapshot : { ...snapshot, insights: [] };
    data = project(command, view, options, extraWarnings);
  }

  process.stdout.write(`${render(data, options.format, command)}\n`);
}

function project(
  command: Command,
  snapshot: Snapshot,
  options: RunOptions,
  extraWarnings: string[],
): Record<string, unknown> {
  switch (command) {
    case "gex":
      return projectGex(snapshot, options.project, extraWarnings);
    case "levels":
      return projectLevels(snapshot, extraWarnings);
    case "walls":
      return projectWalls(snapshot, extraWarnings);
    case "max-pain":
      return projectMaxPain(snapshot, extraWarnings);
    case "flip":
      return projectFlip(snapshot, extraWarnings);
    case "skew":
      return projectSkew(snapshot, options.project, extraWarnings);
    case "expiries":
      return projectExpiries(snapshot, options.project, extraWarnings);
    case "raw":
      return projectRaw(snapshot, options.project, extraWarnings);
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main().catch((error: unknown) => {
  const jsonErrors = process.argv.includes("--json-errors");
  if (jsonErrors) {
    process.stdout.write(`${JSON.stringify(errorPayload(error), null, 2)}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`options-gex: ${message}\n`);
    if (error instanceof UsageError) process.stderr.write(`\nrun \`options-gex --help\` for usage\n`);
  }
  process.exitCode = error instanceof CliError ? error.exitCode : EXIT.error;
});
