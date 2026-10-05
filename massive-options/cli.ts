#!/usr/bin/env node
/**
 * massive-options — short-dated option GEX / max pain from the Massive REST API.
 *
 * The ONLY supported entry point is this CLI, invoked through bash:
 *   node cli.ts gex SPY --dte 7
 *   node cli.ts max-pain SPY --expiries 2026-10-09
 *
 * Output contract:
 *   stdout → result JSON (pretty; `--format compact|table` to change)
 *   stderr → warnings, retry notices, errors
 *   exit   → 0 ok · 1 runtime error · 2 usage error · 3 auth/entitlement · 4 rate limited
 */

import { readFileSync } from "node:fs";

import {
  AuthError,
  DEFAULT_BASE_URL,
  EntitlementError,
  KEYS_URL,
  MassiveClient,
  MassiveError,
  RateLimitError,
} from "./src/api.ts";
import {
  CHAIN_ENDPOINT,
  CHAIN_PLAN_HINT,
  CONTRACTS_ENDPOINT,
  etToday,
  fetchChain,
  listExpiries,
  normalizeOffline,
  parseSnapshotFile,
  resolveSpot,
  type ChainLoad,
  type SpotInfo,
} from "./src/chain.ts";
import { SIGN_MODES, computeGex, contractGex, type SignMode } from "./src/gex.ts";
import { computeMaxPain } from "./src/maxpain.ts";
import { fmtCompact, fmtInt, fmtNum, fmtPct, fmtPrice, table, toJson } from "./src/format.ts";
import type { Contract } from "./src/types.ts";

const VERSION = "1.0.0";

/* ------------------------------------------------------------------- args */

type Flags = Record<string, string | boolean>;

interface Parsed {
  command: string;
  positional: string[];
  flags: Flags;
}

const REPEATABLE = new Set(["expiry", "expiries"]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Flags = {};
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") {
      flags.help = true;
    } else if (a === "-v" || a === "--version") {
      flags.version = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (name.startsWith("no-")) {
        flags[name.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        if (REPEATABLE.has(name) && flags[name] !== undefined) {
          flags[name] = `${String(flags[name])},${next}`;
        } else {
          flags[name] = next;
        }
        i++;
      } else {
        flags[name] = true;
      }
    } else if (!command) {
      command = a;
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

function str(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function num(flags: Flags, name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number (got "${v}")`);
  return n;
}

function bool(flags: Flags, name: string, dflt = false): boolean {
  const v = flags[name];
  if (v === undefined) return dflt;
  if (typeof v === "boolean") return v;
  return v !== "false" && v !== "0";
}

function csv(flags: Flags, name: string): string[] | undefined {
  const v = str(flags, name);
  if (!v) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

class UsageError extends Error {}

/* ------------------------------------------------------------------ usage */

function usage(): string {
  return `massive-options ${VERSION} — short-dated option GEX, max pain and chains.

Usage:
  massive-options gex       <UNDERLYING> [flags]   Gamma exposure by expiry and strike
  massive-options max-pain  <UNDERLYING> [flags]   Max-pain strike per expiry
  massive-options chain     <UNDERLYING> [flags]   Normalised option chain (OI, greeks, quotes)
  massive-options expiries  <UNDERLYING> [flags]   Expiration dates inside the horizon
  massive-options spot      <UNDERLYING> [flags]   Underlying price and its source
  massive-options contract  <OPTIONS_TICKER>       Contract reference + previous-day bar
  massive-options probe     [flags]                Which endpoints the API key can reach

Selection (defaults target ~1 week out):
  --dte N               Horizon in calendar days from today (default 7; 0 = 0DTE only)
  --expiry YYYY-MM-DD   Restrict to one expiry (repeatable / comma separated)
  --expiries A,B        Restrict to several expiries
  --as-of YYYY-MM-DD    Reference date for DTE maths (default: today, US/Eastern)
  --strike-range PCT    Keep strikes within ±PCT of spot (e.g. 0.2 = ±20%)
  --min-oi N            Drop contracts below N open interest
  --max-contracts N     Hard cap on contracts kept
  --max-expiries N      Keep only the N nearest expirations

Analytics:
  --sign-mode MODE      dealer (calls +, puts -) | absolute | inverse   [dealer]
  --multiplier N        Contract multiplier (default: shares_per_contract, usually 100)
  --rate R              Risk-free rate for the gamma fallback             [0.04]
  --no-gamma-fallback   Do not reconstruct missing gammas with Black-Scholes
  --spot PRICE          Override the underlying price
  --top N               Rows in strike/expiry tables                       [10]

Data access:
  --api-key K           Massive API key (else MASSIVE_API_KEY)
  --base-url URL        API base (else MASSIVE_BASE_URL)   [${DEFAULT_BASE_URL}]
  --from-file PATH      Read a saved /v3/snapshot/options response instead of the API
  --prefer-delayed      Skip the plan-gated stock snapshot when pricing the underlying
  --max-pages N         Pagination cap for the chain snapshot              [20]
  --max-retries N       Retries for 429/5xx                                [3]
  --max-wait MS         Cap on a single backoff wait                       [60000]
  --timeout MS          Per-request timeout                                [30000]

Output:
  --format MODE         json (pretty) | compact | table                    [json]
  --compact             Same as --format compact
  --table               Same as --format table
  -h, --help / -v, --version

Examples:
  massive-options gex SPY --dte 7 --format table
  massive-options gex QQQ --dte 0 --sign-mode absolute
  massive-options max-pain SPY --expiries 2026-10-09,2026-10-16
  massive-options chain TSLA --dte 2 --strike-range 0.1 --limit 30 --format table
  massive-options expiries AAPL --dte 14

Exit codes: 0 ok · 1 runtime error · 2 usage error · 3 auth/entitlement · 4 rate limited`;
}

/* --------------------------------------------------------------- helpers */

interface Meta {
  generatedAt: string;
  baseUrl: string;
  requests: number;
  pages?: number;
  warnings: string[];
}

function emit(data: unknown, flags: Flags, textTable?: string): void {
  const format = str(flags, "format") ?? (bool(flags, "compact") ? "compact" : bool(flags, "table") ? "table" : "json");
  if (format === "table") {
    if (!textTable) throw new UsageError("this command has no table output; use --format json");
    console.log(textTable);
    return;
  }
  if (format === "compact" || format === "json") {
    console.log(toJson(data, format === "compact"));
    return;
  }
  throw new UsageError(`--format must be json, compact or table (got "${format}")`);
}

function warnAll(warnings: string[]): void {
  for (const w of warnings) console.error(`warning: ${w}`);
}

function makeClient(flags: Flags): MassiveClient {
  const apiKey = str(flags, "api-key") ?? process.env.MASSIVE_API_KEY ?? process.env.POLY_API_KEY;
  if (!apiKey) {
    throw new AuthError("No Massive API key configured.", {
      hint: `set MASSIVE_API_KEY (or pass --api-key). Create a key at ${KEYS_URL}`,
    });
  }
  return new MassiveClient({
    apiKey,
    baseUrl: str(flags, "base-url") ?? process.env.MASSIVE_BASE_URL ?? DEFAULT_BASE_URL,
    timeoutMs: num(flags, "timeout") ?? 30_000,
    maxRetries: num(flags, "max-retries") ?? 3,
    maxWaitMs: num(flags, "max-wait") ?? 60_000,
    onRetry: (info) =>
      console.error(
        info.status === 0
          ? `retrying (${info.attempt}) after a network error in ${info.waitMs}ms`
          : `rate limited (HTTP ${info.status}); retrying in ${info.waitMs}ms (attempt ${info.attempt})`,
      ),
  });
}

interface Selection {
  dte: number;
  expires: string[];
  asOf: string;
  strikeRangePct?: number;
  minOi?: number;
  maxContracts?: number;
  spotOverride?: number;
}

function readSelection(flags: Flags): Selection {
  const expires = [...(csv(flags, "expiry") ?? []), ...(csv(flags, "expiries") ?? [])];
  return {
    dte: num(flags, "dte") ?? 7,
    expires,
    asOf: str(flags, "as-of") ?? etToday(),
    strikeRangePct: num(flags, "strike-range"),
    minOi: num(flags, "min-oi"),
    maxContracts: num(flags, "max-contracts"),
    spotOverride: num(flags, "spot"),
  };
}

interface LoadedChain extends ChainLoad {
  meta: Meta;
  offline: boolean;
}

/** Load the chain from the API, or from `--from-file` for offline analysis. */
async function loadChain(flags: Flags, underlying: string, selection: Selection): Promise<LoadedChain> {
  const fromFile = str(flags, "from-file");
  const gammaFallback = bool(flags, "gamma-fallback", true);
  const rate = num(flags, "rate") ?? 0.04;
  const warnings: string[] = [];

  if (fromFile) {
    let rows;
    try {
      rows = parseSnapshotFile(readFileSync(fromFile, "utf8"));
    } catch (err) {
      throw new UsageError(`could not read --from-file ${fromFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const fileSpot = rows.find((r) => (r.underlying_asset?.price ?? 0) > 0)?.underlying_asset;
    const spotPrice = selection.spotOverride ?? fileSpot?.price;
    if (!spotPrice) {
      throw new UsageError("offline mode needs a spot price: pass --spot PRICE (the file carried no underlying price)");
    }
    const spot: SpotInfo = {
      price: spotPrice,
      source: selection.spotOverride ? "flag" : "file",
      timeframe: (fileSpot?.timeframe ?? "UNKNOWN").toUpperCase(),
      asOf: fileSpot?.last_updated ? new Date(fileSpot.last_updated / 1e6).toISOString() : selection.asOf,
    };
    const asOf = selection.asOf;
    const norm = normalizeOffline(rows, {
      underlying,
      asOf,
      now: new Date(),
      spot: spotPrice,
      rate,
      gammaFallback,
      expirations: selection.expires.length ? selection.expires : undefined,
      dte: selection.expires.length ? undefined : selection.dte,
      strikeRangePct: selection.strikeRangePct,
      minOpenInterest: selection.minOi,
    });
    if (selection.maxContracts && norm.contracts.length > selection.maxContracts) {
      norm.contracts = [...norm.contracts].sort((a, b) => a.expiry.localeCompare(b.expiry) || b.oi - a.oi).slice(0, selection.maxContracts);
      warnings.push(`contracts truncated to --max-contracts ${selection.maxContracts}`);
    }
    if (!gammaFallback) warnings.push("gamma fallback disabled (--no-gamma-fallback)");
    if (norm.gammaFromBlackScholes > 0) warnings.push(`${norm.gammaFromBlackScholes} contract(s) used a Black-Scholes gamma fallback`);
    if (rows.length === 0) warnings.push("snapshot file contained no rows");
    return {
      underlying,
      spot,
      expirations: norm.expirations,
      contracts: norm.contracts,
      missingGreeks: norm.missingGreeks,
      gammaFromBlackScholes: norm.gammaFromBlackScholes,
      missingOpenInterest: norm.missingOpenInterest,
      pages: 0,
      requests: 0,
      truncated: false,
      warnings,
      offline: true,
      meta: {
        generatedAt: new Date().toISOString(),
        baseUrl: `file:${fromFile}`,
        requests: 0,
        warnings,
      },
    };
  }

  const client = makeClient(flags);
  const load = await fetchChain(client, underlying, {
    dte: selection.dte,
    asOf: selection.asOf,
    expirations: selection.expires.length ? selection.expires : undefined,
    maxExpiries: num(flags, "max-expiries"),
    strikeRangePct: selection.strikeRangePct,
    minOpenInterest: selection.minOi,
    maxContracts: selection.maxContracts,
    maxPages: num(flags, "max-pages") ?? 20,
    spot: selection.spotOverride,
    gammaFallback,
    rate,
  });
  if (!gammaFallback) load.warnings.push("gamma fallback disabled (--no-gamma-fallback)");
  return {
    ...load,
    offline: false,
    meta: {
      generatedAt: new Date().toISOString(),
      baseUrl: client.baseUrl,
      requests: client.requests,
      pages: load.pages,
      warnings: load.warnings,
    },
  };
}

function selectionEcho(sel: Selection, load: LoadedChain): Record<string, unknown> {
  return {
    dte: sel.dte,
    asOf: sel.asOf,
    expirations: load.expirations.map((e) => e.expiry),
    strikeRangePct: sel.strikeRangePct ?? null,
    minOpenInterest: sel.minOi ?? null,
    contracts: load.contracts.length,
  };
}

function provenance(load: LoadedChain, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: load.offline ? "file" : CHAIN_ENDPOINT(load.underlying),
    dataTimeframe: load.spot.timeframe,
    openInterestNote: "open interest is the end of the previous trading session",
    ...extra,
  };
}

function gm(v: number | null | undefined): string {
  return fmtCompact(v);
}

/* ---------------------------------------------------------------- tables */

function gexTable(report: ReturnType<typeof computeGex>, top: number): string {
  const rows = [...report.expirations, report.total].map((g) => [
    g.expiry === "ALL" ? "ALL" : g.expiry,
    g.dte === null ? "-" : String(g.dte),
    fmtInt(g.contracts),
    gm(g.gex),
    gm(g.callGex),
    gm(g.putGex),
    fmtNum(g.putCallOiRatio, 2),
    g.callWall ? `${g.callWall.strike} (${fmtPct(g.callWall.distancePct, 1)})` : "n/a",
    g.putWall ? `${g.putWall.strike} (${fmtPct(g.putWall.distancePct, 1)})` : "n/a",
    g.zeroGamma === null ? "n/a" : fmtNum(g.zeroGamma, 2),
  ]);

  const blocks = [
    `spot ${fmtPrice(report.spot)} · ${report.contractsUsed} contracts · GEX in USD per 1% move · sign mode ${report.signMode}`,
    table(["expiry", "dte", "contracts", "net GEX", "call GEX", "put GEX", "P/C OI", "call wall", "put wall", "zero gamma"], rows),
    "",
    "largest strikes by |net GEX|",
    table(
      ["strike", "net GEX", "call GEX", "put GEX", "call OI", "put OI", "distance"],
      report.total.topExposures.slice(0, top).map((s) => [
        fmtNum(s.strike, 2),
        gm(s.gex),
        gm(s.callGex),
        gm(s.putGex),
        fmtInt(s.callOi),
        fmtInt(s.putOi),
        fmtPct(report.spot > 0 ? ((s.strike - report.spot) / report.spot) * 100 : 0, 2),
      ]),
    ),
  ];
  return blocks.join("\n");
}

function maxPainTable(report: ReturnType<typeof computeMaxPain>, top: number): string {
  const rows = [...report.expirations, report.total].map((g) => [
    g.expiry === "ALL" ? "ALL" : g.expiry,
    g.dte === null ? "-" : String(g.dte),
    fmtInt(g.contracts),
    g.maxPain === null ? "n/a" : fmtNum(g.maxPain, 2),
    gm(g.painAtMaxPain),
    fmtPct(g.distancePct, 2),
    fmtInt(g.callOi),
    fmtInt(g.putOi),
  ]);
  const blocks = [
    `spot ${fmtPrice(report.spot)} · max pain = strike with the smallest total ITM payout · ${report.contractsUsed} contracts with OI`,
    table(["expiry", "dte", "contracts", "max pain", "payout there", "vs spot", "call OI", "put OI"], rows),
    "",
    "cheapest settlements",
    table(
      ["expiry", "strike", "payout", "call ITM pts", "put ITM pts"],
      [...report.expirations, report.total]
        .flatMap((g) => g.top.slice(0, top).map((p) => [g.expiry, fmtNum(p.strike, 2), gm(p.pain), gm(p.callItm), gm(p.putItm)]))
        .slice(0, top * 2),
    ),
  ];
  return blocks.join("\n");
}

function chainTable(contracts: Contract[], spot: number, limit: number): string {
  const rows = contracts.slice(0, limit).map((c) => [
    c.expiry,
    String(c.dte),
    fmtNum(c.strike, 2),
    c.type,
    fmtInt(c.oi),
    fmtInt(c.volume),
    fmtPrice(c.mid ?? c.lastPrice),
    c.iv === null ? "n/a" : `${(c.iv * 100).toFixed(1)}%`,
    c.gamma === null ? "n/a" : c.gamma.toFixed(5),
    gm(contractGex(c, spot)),
    fmtPct(spot > 0 ? ((c.strike - spot) / spot) * 100 : 0, 1),
    c.ticker,
  ]);
  return [
    `spot ${fmtPrice(spot)} · ${contracts.length} contracts${contracts.length > limit ? ` (showing ${limit})` : ""}`,
    table(["expiry", "dte", "strike", "type", "OI", "volume", "mid", "IV", "gamma", "GEX", "dist", "ticker"], rows),
  ].join("\n");
}

/* -------------------------------------------------------------- commands */

async function cmdGex(flags: Flags, underlying: string): Promise<number> {
  const sel = readSelection(flags);
  const load = await loadChain(flags, underlying, sel);
  if (load.contracts.length === 0) {
    throw new MassiveError(`No contracts with open interest and greeks for ${underlying} in the selected horizon.`, {
      hint: `widen --dte (currently ${sel.dte}) or drop --min-oi/--strike-range filters`,
    });
  }
  const signMode = (str(flags, "sign-mode") ?? "dealer") as SignMode;
  if (!SIGN_MODES.includes(signMode)) throw new UsageError(`--sign-mode must be one of ${SIGN_MODES.join(", ")}`);

  const report = computeGex(load.contracts, {
    spot: load.spot.price,
    signMode,
    multiplier: num(flags, "multiplier"),
  });
  warnAll(load.warnings);

  const payload = {
    underlying: load.underlying,
    spot: load.spot,
    selection: selectionEcho(sel, load),
    formula: "gex = gamma * open_interest * shares_per_contract * spot^2 * 0.01",
    unit: report.unit,
    signMode: report.signMode,
    expirations: report.expirations,
    total: report.total,
    contractsUsed: report.contractsUsed,
    contractsSkipped: report.contractsSkipped,
    provenance: provenance(load, { formulaNote: "USD of dealer delta to re-hedge per 1% move" }),
    meta: { ...load.meta, warnings: load.warnings },
  };
  emit(payload, flags, gexTable(report, num(flags, "top") ?? 10));
  return 0;
}

async function cmdMaxPain(flags: Flags, underlying: string): Promise<number> {
  const sel = readSelection(flags);
  const load = await loadChain(flags, underlying, sel);
  if (load.contracts.length === 0) {
    throw new MassiveError(`No contracts with open interest for ${underlying} in the selected horizon.`, {
      hint: `widen --dte (currently ${sel.dte}) or drop --min-oi/--strike-range filters`,
    });
  }
  const report = computeMaxPain(load.contracts, {
    spot: load.spot.price,
    multiplier: num(flags, "multiplier"),
  });
  warnAll(load.warnings);

  const payload = {
    underlying: load.underlying,
    spot: load.spot,
    selection: selectionEcho(sel, load),
    formula: "pain(S) = sum_calls OI*max(0,S-K) + sum_puts OI*max(0,K-S), x shares_per_contract",
    unit: report.unit,
    expirations: report.expirations.map((g) => ({ ...g, curve: undefined, curveNote: "full curve omitted; use --format json on a single --expiry for it" })),
    total: { ...report.total, curve: report.total.curve },
    contractsUsed: report.contractsUsed,
    contractsSkipped: report.contractsSkipped,
    provenance: provenance(load),
    meta: { ...load.meta, warnings: load.warnings },
  };
  emit(payload, flags, maxPainTable(report, num(flags, "top") ?? 5));
  return 0;
}

async function cmdChain(flags: Flags, underlying: string): Promise<number> {
  const sel = readSelection(flags);
  const load = await loadChain(flags, underlying, sel);
  const limit = num(flags, "limit") ?? 250;
  const contracts = load.contracts.map((c) => ({
    ...c,
    gex: contractGex(c, load.spot.price, num(flags, "multiplier")),
    moneynessPct: load.spot.price > 0 ? ((c.strike - load.spot.price) / load.spot.price) * 100 : null,
  }));
  warnAll(load.warnings);
  const payload = {
    underlying: load.underlying,
    spot: load.spot,
    selection: selectionEcho(sel, load),
    contracts: contracts.slice(0, limit),
    shown: Math.min(limit, contracts.length),
    provenance: provenance(load),
    meta: { ...load.meta, warnings: load.warnings },
  };
  emit(payload, flags, chainTable(load.contracts, load.spot.price, limit));
  return 0;
}

async function cmdExpiries(flags: Flags, underlying: string): Promise<number> {
  const sel = readSelection(flags);
  const client = makeClient(flags);
  const spot = sel.spotOverride ?? (await resolveSpot(client, underlying, { asOf: sel.asOf })).price;
  const list = await listExpiries(client, underlying, {
    dte: sel.dte,
    asOf: sel.asOf,
    expirations: sel.expires.length ? sel.expires : undefined,
    maxExpiries: num(flags, "max-expiries"),
    spot,
  });
  const payload = {
    underlying,
    asOf: sel.asOf,
    horizonDays: sel.dte,
    expirations: list.map((e) => ({ expiry: e.expiry, dte: e.dte, weekday: new Date(`${e.expiry}T12:00:00Z`).toUTCString().slice(0, 3) })),
    provenance: { source: CONTRACTS_ENDPOINT, note: "from the options contract reference index (no open interest)" },
    meta: { generatedAt: new Date().toISOString(), baseUrl: client.baseUrl, requests: client.requests, warnings: [] },
  };
  const text = [
    `${underlying} · as of ${sel.asOf} · ${sel.dte}-day horizon · ${list.length} expiration(s)`,
    table(["expiry", "dte", "weekday"], payload.expirations.map((e) => [e.expiry, String(e.dte), e.weekday])),
  ].join("\n");
  emit(payload, flags, text);
  return 0;
}

async function cmdSpot(flags: Flags, underlying: string): Promise<number> {
  const client = makeClient(flags);
  const sel = readSelection(flags);
  const spot = await resolveSpot(client, underlying, {
    asOf: sel.asOf,
    preferDelayed: bool(flags, "prefer-delayed"),
    override: sel.spotOverride,
  });
  const payload = {
    underlying,
    ...spot,
    provenance: {
      note:
        spot.source === "previous-close"
          ? `delayed previous-day close from /v2/aggs/ticker/${underlying}/prev`
          : spot.source === "stock-snapshot"
            ? "real-time stock snapshot"
            : spot.source,
    },
    meta: { generatedAt: new Date().toISOString(), baseUrl: client.baseUrl, requests: client.requests, warnings: [] },
  };
  const text = `${underlying} ${fmtPrice(spot.price)} (${spot.source}${spot.timeframe ? `, ${spot.timeframe}` : ""})`;
  emit(payload, flags, text);
  return 0;
}

async function cmdContract(flags: Flags, ticker: string): Promise<number> {
  const client = makeClient(flags);
  const encoded = encodeURIComponent(ticker);
  const ref = await client.rawGet<{ results?: Record<string, unknown> }>(`/v3/reference/options/contracts/${encoded}`);
  let prev: unknown = null;
  let prevError: string | null = null;
  try {
    prev = await client.rawGet(`/v2/aggs/ticker/${encoded}/prev`);
  } catch (err) {
    prevError = err instanceof MassiveError ? err.message : String(err);
  }
  const payload = {
    ticker,
    reference: ref.results ?? null,
    previousDay: prev,
    previousDayError: prevError,
    meta: { generatedAt: new Date().toISOString(), baseUrl: client.baseUrl, requests: client.requests, warnings: [] },
  };
  emit(payload, flags);
  return 0;
}

interface ProbeResult {
  name: string;
  path: string;
  ok: boolean;
  status: "ok" | "not-entitled" | "error";
  error?: string;
  needed_for?: string;
}

async function cmdProbe(flags: Flags): Promise<number> {
  const client = makeClient(flags);
  const targets: { name: string; path: string; needed_for?: string }[] = [
    { name: "options-chain-snapshot", path: CHAIN_ENDPOINT("SPY"), needed_for: "GEX and max pain (open interest + greeks)" },
    { name: "option-contract-snapshot", path: "/v3/snapshot/options/SPY/O:SPY261009C00600000", needed_for: "single-contract OI + greeks" },
    { name: "options-contracts-reference", path: CONTRACTS_ENDPOINT, needed_for: "expiration discovery" },
    { name: "stock-snapshot", path: "/v2/snapshot/locale/us/markets/stocks/tickers/SPY", needed_for: "real-time underlying price" },
    { name: "stock-previous-bar", path: "/v2/aggs/ticker/SPY/prev", needed_for: "delayed underlying price" },
    { name: "market-status", path: "/v1/marketstatus/now", needed_for: "market hours context" },
  ];

  const results: ProbeResult[] = [];
  for (const t of targets) {
    const params: Record<string, string | number> = {};
    if (t.name === "options-contracts-reference") params.underlying_ticker = "SPY";
    if (t.path.startsWith("/v3/") || t.path.startsWith("/v2/snapshot")) params.limit = 1;
    try {
      await client.rawGet(t.path, params);
      results.push({ name: t.name, path: t.path, ok: true, status: "ok", needed_for: t.needed_for });
    } catch (err) {
      if (err instanceof AuthError || err instanceof EntitlementError) {
        results.push({
          name: t.name,
          path: t.path,
          ok: false,
          status: "not-entitled",
          error: err.message,
          needed_for: t.needed_for,
        });
      } else {
        results.push({
          name: t.name,
          path: t.path,
          ok: false,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          needed_for: t.needed_for,
        });
      }
    }
  }

  const chainOk = results.find((r) => r.name === "options-chain-snapshot")?.ok ?? false;
  const payload = {
    baseUrl: client.baseUrl,
    endpoints: results,
    gexAvailable: chainOk,
    verdict: chainOk
      ? "The key can read the option chain snapshot: gex and max-pain work with live data."
      : `The key cannot read the option chain snapshot, so gex/max-pain cannot be computed from live data. ${CHAIN_PLAN_HINT[0]!.toUpperCase()}${CHAIN_PLAN_HINT.slice(1)}.`,
    workarounds: chainOk
      ? []
      : [
          "expiries/spot/contract still work (reference + aggregate endpoints)",
          "use `gex --from-file snapshot.json --spot <price>` with a saved /v3/snapshot/options response",
        ],
    meta: { generatedAt: new Date().toISOString(), requests: client.requests, warnings: [] },
  };
  const text = [
    table(
      ["endpoint", "path", "state", "needed for"],
      results.map((r) => [r.name, r.path, r.ok ? "ok" : r.status, r.needed_for ?? ""]),
    ),
    "",
    payload.verdict,
  ].join("\n");
  emit(payload, flags, text);
  return 0;
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(`massive-options ${VERSION}`);
    return 0;
  }
  if (flags.help || command === "help" || command === "") {
    console.log(usage());
    return command === "" && !flags.help ? 2 : 0;
  }

  switch (command) {
    case "gex":
    case "gamma":
    case "gamma-exposure": {
      const u = positional[0];
      if (!u) throw new UsageError("gex requires an underlying ticker (e.g. `gex SPY`)");
      return cmdGex(flags, u.toUpperCase());
    }
    case "max-pain":
    case "maxpain": {
      const u = positional[0];
      if (!u) throw new UsageError("max-pain requires an underlying ticker (e.g. `max-pain SPY`)");
      return cmdMaxPain(flags, u.toUpperCase());
    }
    case "chain": {
      const u = positional[0];
      if (!u) throw new UsageError("chain requires an underlying ticker (e.g. `chain SPY`)");
      return cmdChain(flags, u.toUpperCase());
    }
    case "expiries":
    case "expirations": {
      const u = positional[0];
      if (!u) throw new UsageError("expiries requires an underlying ticker (e.g. `expiries SPY`)");
      return cmdExpiries(flags, u.toUpperCase());
    }
    case "spot":
    case "price": {
      const u = positional[0];
      if (!u) throw new UsageError("spot requires an underlying ticker (e.g. `spot SPY`)");
      return cmdSpot(flags, u.toUpperCase());
    }
    case "contract": {
      const t = positional[0];
      if (!t) throw new UsageError("contract requires an option ticker (e.g. `contract O:SPY261009C00600000`)");
      return cmdContract(flags, t);
    }
    case "probe":
    case "doctor":
      return cmdProbe(flags);
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n\n${usage()}`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof AuthError || err instanceof EntitlementError) {
      console.error(`error: ${err.detail}`);
      process.exitCode = 3;
      return;
    }
    if (err instanceof RateLimitError) {
      console.error(`error: ${err.detail}`);
      process.exitCode = 4;
      return;
    }
    if (err instanceof MassiveError) {
      console.error(`error: ${err.detail}`);
      process.exitCode = 1;
      return;
    }
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
