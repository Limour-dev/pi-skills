#!/usr/bin/env node
/**
 * optioncharts — weekly options data (and greeks/exposure) from optioncharts.io.
 *
 * There is no JSON API upstream: the site is Rails + htmx and every chart is an
 * HTML fragment with the data inlined as `var <name> = <JSON>;`. This CLI issues
 * the right fragment GET and extracts that JSON, then projects it into one
 * stable document per command.
 *
 * Output goes to stdout (`--format pretty|compact|csv`); errors go to stderr as
 * JSON unless `--json-errors` is set. Exit codes: 0 ok · 1 runtime · 2 usage ·
 * 3 data unavailable · 4 rate limited · 5 silent expiry fallback (--strict-exp).
 */

import { readFileSync } from "node:fs";

import { Client } from "./src/http.ts";
import { ExpiryService } from "./src/endpoints.ts";
import { EXIT, CliError, UsageError, errorPayload } from "./src/errors.ts";
import { render, type OutputFormat } from "./src/format.ts";
import {
  runCommand,
  type CommandName,
  type CommandOptions,
  type Context,
} from "./src/commands.ts";

const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const COMMANDS: CommandName[] = [
  "spot",
  "info",
  "expiries",
  "gex",
  "dex",
  "oi",
  "volume",
  "skew",
  "greeks",
  "max-pain",
  "em",
  "stats",
  "chain",
  "scan",
  "probe",
  "raw",
];

const USAGE = `optioncharts ${VERSION} — options data from optioncharts.io (no API key)

Usage:
  optioncharts <command> <TICKER> [TICKER...] [flags]

Commands:
  spot      TICKER...   real-time spot, change, market/option-delay status
  info      TICKER...   key stats: dividend yield, average volume, day/52w range
  expiries  TICKER...   listed expiries with the :w/:m suffix the API requires
  gex       TICKER...   gamma exposure by strike + call/put walls + net exposure
  dex       TICKER...   delta exposure by strike (same shape as gex)
  oi        TICKER...   open interest by strike (+ per-expiry totals)
  volume    TICKER...   volume by strike
  skew      TICKER...   implied volatility by strike
  greeks    TICKER...   delta/gamma/theta/vega/rho/iv by strike
  max-pain  TICKER...   max pain for every listed expiry (one request)
  em        TICKER...   expected-move cone points
  stats     TICKER...   per-expiry chain statistics (PCR, OI, IV, EM, max pain)
  chain     TICKER...   option chain table (calls + puts)
  scan      TICKER...   weekly scan: one row per expiry inside --dte (+ --gex)
  probe                 endpoint reachability and latency
  raw       TICKER      dump the inline JSON (or --html) of one fragment

Expiry selection:
  --exp YYYY-MM-DD[:w|:m]  repeatable; resolves a bare date to its :w/:m id
  --dte N                  keep expiries <= N days out (a ceiling, not exactly N)
  --weekly-only            keep :w expiries (weekly, i.e. non-third-Friday)
  --monthly-only           keep :m expiries
  --all-expiries           use every matching expiry instead of the nearest one
  --max-exp N              cap expiries per ticker (scan default 8)
  --strict-exp             (default) exit 5 when the server answers for another expiry
  --allow-exp-fallback     downgrade that silent expiry fallback to a warning

Data shaping:
  --option-type all|call|put   (default all)
  --strike-range all|MIN,MAX   (default all)
  --type open_interest|volume  gex/dex weighting (default open_interest)
  --normalize none|pct|sigma   gex/dex cross-ticker scale (sigma adds spot/EM requests)
  --view list|straddle         chain layout (default list)
  --top N                      keep the N largest |value| rows (greeks default 40)
  --limit N                    expected-move points to print (default 24, 0 = all)
  --columns a,b,c              stats/chain columns
  --greek delta,gamma          greeks to include
  --gex                        scan: add walls + net exposure per expiry
  --concurrency N              scan fan-out (default 2)

Offline / plumbing:
  --from-file PATH         parse a saved fragment instead of fetching (1 request)
  --no-cache               bypass the 60-second local fragment cache
  --timeout MS             per-request timeout (default 30000)
  --endpoint NAME          raw: which fragment to dump
  --var NAME               raw: which inline variable(s) to extract
  --param k=v              raw: extra query parameters (repeatable)
  --html                   raw: print the fragment instead of the JSON
  --format pretty|compact|csv
  --units                  csv: annotate headers with units (net_exposure[usd_per_1pct_move])
  --json-errors            errors as JSON on stdout (still non-zero exit)
  -h, --help / --version
`;

interface Flags {
  values: Map<string, string[]>;
  bools: Set<string>;
}

const BOOL_FLAGS = new Set([
  "weekly-only",
  "monthly-only",
  "all-expiries",
  "strict-exp",
  "allow-exp-fallback",
  "gex",
  "spot",
  "no-cache",
  "html",
  "units",
  "json-errors",
  "help",
  "version",
]);

const VALUE_FLAGS = new Set([
  "exp",
  "dte",
  "max-exp",
  "option-type",
  "strike-range",
  "type",
  "normalize",
  "view",
  "top",
  "limit",
  "columns",
  "greek",
  "concurrency",
  "from-file",
  "timeout",
  "endpoint",
  "var",
  "param",
  "format",
]);

function parseArgs(argv: string[]): { positionals: string[]; flags: Flags } {
  const flags: Flags = { values: new Map(), bools: new Set() };
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const trimmed = token.replace(/^--?/, "");
    const equals = trimmed.indexOf("=");
    let name = equals >= 0 ? trimmed.slice(0, equals) : trimmed;
    let value = equals >= 0 ? trimmed.slice(equals + 1) : undefined;
    if (name === "h") name = "help";
    if (name === "v") name = "version";
    if (BOOL_FLAGS.has(name)) {
      if (value !== undefined) throw new UsageError(`--${name} takes no value`);
      flags.bools.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown flag --${name}`);
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`--${name} needs a value`);
      value = next;
      index += 1;
    }
    const list = flags.values.get(name) ?? [];
    list.push(value);
    flags.values.set(name, list);
  }
  return { positionals, flags };
}

function numberOf(flags: Flags, name: string): number | undefined {
  const raw = flags.values.get(name)?.[0];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} needs a number, got ${raw}`);
  return value;
}

function oneOf<T extends string>(flags: Flags, name: string, allowed: readonly T[], fallback: T): T {
  const raw = flags.values.get(name)?.[0];
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new UsageError(`--${name} must be one of ${allowed.join("|")}, got ${raw}`);
  }
  return raw as T;
}

function listOf(flags: Flags, name: string): string[] | undefined {
  const raw = flags.values.get(name);
  if (!raw) return undefined;
  return raw.flatMap((value) => value.split(",")).map((item) => item.trim()).filter(Boolean);
}

function buildOptions(flags: Flags, command: CommandName): CommandOptions {
  const params: Record<string, string> = {};
  for (const entry of flags.values.get("param") ?? []) {
    const equals = entry.indexOf("=");
    if (equals <= 0) throw new UsageError(`--param expects key=value, got ${entry}`);
    params[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  const top = numberOf(flags, "top");
  return {
    ticker: "",
    // `--exp A:w,B:w` and repeated `--exp A:w --exp B:w` are both accepted.
    exps: (flags.values.get("exp") ?? [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
    allExpiries: flags.bools.has("all-expiries"),
    dte: numberOf(flags, "dte"),
    weeklyOnly: flags.bools.has("weekly-only"),
    monthlyOnly: flags.bools.has("monthly-only"),
    maxExp: numberOf(flags, "max-exp"),
    optionType: oneOf(flags, "option-type", ["all", "call", "put"], "all"),
    strikeRange: flags.values.get("strike-range")?.[0] ?? "all",
    exposureType: oneOf(flags, "type", ["open_interest", "volume"], "open_interest"),
    normalize: oneOf<"none" | "pct" | "sigma">(flags, "normalize", ["none", "pct", "sigma"], "none"),
    top: top ?? (command === "greeks" ? 40 : undefined),
    limit: numberOf(flags, "limit"),
    columns: listOf(flags, "columns"),
    view: oneOf(flags, "view", ["list", "straddle"], "list"),
    greeks: listOf(flags, "greek"),
    // Silent expiry fallback is a hard error by default: it is the one failure mode where
    // the numbers look plausible but belong to a different expiry.
    strictExp: !flags.bools.has("allow-exp-fallback"),
    concurrency: numberOf(flags, "concurrency") ?? 2,
    withGex: flags.bools.has("gex"),
    withSpot: flags.bools.has("spot"),
    endpoint: flags.values.get("endpoint")?.[0],
    rawHtml: flags.bools.has("html"),
    rawParams: Object.keys(params).length ? params : undefined,
    rawVars: listOf(flags, "var"),
  };
}

/**
 * Flags that only apply to some commands: say so on stderr instead of silently
 * ignoring them (an agent must never believe `--top` narrowed the rows).
 */
const FLAG_COMMANDS: Record<string, CommandName[]> = {
  top: ["gex", "dex", "oi", "volume", "skew", "greeks"],
  gex: ["scan"],
  spot: ["scan"],
  limit: ["em"],
  view: ["chain"],
  greek: ["greeks"],
  columns: ["stats", "chain"],
  type: ["gex", "dex", "scan"],
  normalize: ["gex", "dex"],
};

function noteIgnoredFlags(command: CommandName, flags: Flags): void {
  for (const [flag, commands] of Object.entries(FLAG_COMMANDS)) {
    const present = flags.values.has(flag) || flags.bools.has(flag);
    if (present && !commands.includes(command)) {
      process.stderr.write(`note: --${flag} has no effect on \`${command}\`\n`);
    }
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { positionals, flags } = parseArgs(argv);

  if (flags.bools.has("version")) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (flags.bools.has("help") || !positionals.length) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }

  const command = positionals[0] as CommandName;
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`unknown command ${positionals[0]}; try --help`);
  }
  const tickers = positionals
    .slice(1)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (command !== "probe" && !tickers.length) {
    throw new UsageError(`${command} needs at least one TICKER`);
  }
  if (command === "raw" && tickers.length > 1) {
    throw new UsageError("raw takes exactly one TICKER");
  }

  const format = oneOf<OutputFormat>(flags, "format", ["pretty", "compact", "csv"], "pretty");
  if (flags.bools.has("units") && format !== "csv") {
    process.stderr.write("note: --units only affects --format csv\n");
  }
  const client = new Client({
    timeoutMs: numberOf(flags, "timeout"),
    noCache: flags.bools.has("no-cache"),
    fromFile: flags.values.get("from-file")?.[0],
  });
  const options = buildOptions(flags, command);
  noteIgnoredFlags(command, flags);
  const ctx: Context = { client, expiries: new ExpiryService(client), options };

  if (command === "raw" && flags.values.get("endpoint") === undefined && !flags.bools.has("html")) {
    throw new UsageError("raw needs --endpoint NAME (an /async/... path is also accepted)");
  }

  const result = await runCommand(command, command === "probe" ? ["SPY"] : tickers, ctx);
  process.stdout.write(`${render(result.doc, format, result.csv, flags.bools.has("units"))}\n`);
  return result.exitCode ?? EXIT.ok;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const jsonErrors = process.argv.includes("--json-errors");
    const payload = errorPayload(error);
    const text = `${JSON.stringify(payload)}\n`;
    if (jsonErrors) process.stdout.write(text);
    else process.stderr.write(text);
    if (error instanceof CliError) {
      if (error.code === "usage") process.stderr.write(`run \`optioncharts --help\` for usage\n`);
      process.exitCode = error.exitCode;
    } else {
      process.exitCode = EXIT.error;
    }
  });
