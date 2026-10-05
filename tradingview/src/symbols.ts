/**
 * Symbol resolution.
 *
 * TradingView data is addressed as `EXCHANGE:SYMBOL`. Humans (and most prompts)
 * write bare names: `USDT.D`, `US10Y`, `CNH1!`, `BTCUSD`, `AAPL`. This module
 * turns those into a concrete, ordered list of candidate symbols:
 *
 *   1. explicit    — input already contains `:` (or `--exchange` was given)
 *   2. alias       — a curated table of high-traffic macro / crypto / futures names
 *   3. search      — TradingView's symbol autocomplete, best hit first
 *   4. unresolved  — nothing matched; report it and use EXCHANGE:SYMBOL
 *
 * Continuous-futures inputs (`CNH1!`, `ES1!`) are reconstructed because
 * `searchMarkets` strips the `1!` suffix and returns the plain contract root.
 */

import { searchMarkets } from "@mathieuc/tradingview/data";
import { withRetry } from "./util.ts";

export type SearchHit = {
  id: string;
  symbol: string;
  exchange: string;
  fullExchange?: string;
  description?: string;
  type?: string;
  currency?: string;
  country?: string;
};

export type ResolutionSource = "explicit" | "alias" | "search" | "unresolved";
export type Confidence = "high" | "medium" | "low";

export type Resolution = {
  input: string;
  /** Best candidate, or null when nothing could be resolved. */
  symbol: string | null;
  source: ResolutionSource;
  confidence: Confidence;
  /** Ordered fallbacks to try when `symbol` is rejected by the server. */
  alternatives: string[];
  /** Upstream search hits (empty for explicit/alias input). */
  candidates: SearchHit[];
  notes: string[];
};

/**
 * Curated aliases: bare name -> Exchange-qualified TradingView symbol.
 * Every target below is verified against a live `getQuote` call (see
 * references/symbols.md). Keep keys uppercase.
 */
export const ALIASES: Record<string, string> = {
  // --- crypto dominance & total market cap (values are PERCENT / USD) ---
  "BTC.D": "CRYPTOCAP:BTC.D",
  "ETH.D": "CRYPTOCAP:ETH.D",
  "USDT.D": "CRYPTOCAP:USDT.D",
  "USDC.D": "CRYPTOCAP:USDC.D",
  "OTHERS.D": "CRYPTOCAP:OTHERS.D",
  TOTAL: "CRYPTOCAP:TOTAL",
  TOTAL2: "CRYPTOCAP:TOTAL2",
  TOTAL3: "CRYPTOCAP:TOTAL3",

  // --- US treasuries (TVC yields, percent) ---
  US01Y: "TVC:US01Y",
  US1Y: "TVC:US01Y",
  US02Y: "TVC:US02Y",
  US2Y: "TVC:US02Y",
  US03Y: "TVC:US03Y",
  US3Y: "TVC:US03Y",
  US05Y: "TVC:US05Y",
  US5Y: "TVC:US05Y",
  US07Y: "TVC:US07Y",
  US7Y: "TVC:US07Y",
  US10Y: "TVC:US10Y",
  US20Y: "TVC:US20Y",
  US30Y: "TVC:US30Y",
  US03M: "TVC:US03MY", // yield, not the 98.99 discount price of TVC:US03M
  US3M: "TVC:US03MY",
  US06M: "TVC:US06MY",
  US6M: "TVC:US06MY",

  // --- other macro benchmarks ---
  DXY: "TVC:DXY",
  VIX: "TVC:VIX",
  GOLD: "TVC:GOLD",
  XAUUSD: "OANDA:XAUUSD",
  SILVER: "TVC:SILVER",
  XAGUSD: "OANDA:XAGUSD",
  WTI: "TVC:USOIL",
  USOIL: "TVC:USOIL",
  BRENT: "TVC:UKOIL",
  UKOIL: "TVC:UKOIL",
  SPX: "SP:SPX",
  SP500: "SP:SPX",
  NDX: "NASDAQ:NDX",
  NAS100: "NASDAQ:NDX",
  NI225: "TVC:NI225",
  JP10Y: "TVC:JP10Y",
  CN10Y: "TVC:CN10Y",
  CN02Y: "TVC:CN02Y",
  CN2Y: "TVC:CN02Y",

  // --- FX ---
  EURUSD: "FX:EURUSD",
  GBPUSD: "FX:GBPUSD",
  USDJPY: "FX:USDJPY",
  AUDUSD: "FX:AUDUSD",
  USDCNH: "FX:USDCNH",
  USDCNY: "FX_IDC:USDCNY",

  // --- crypto spot ---
  BTCUSD: "BITSTAMP:BTCUSD",
  ETHUSD: "BITSTAMP:ETHUSD",
  BTCUSDT: "BINANCE:BTCUSDT",
  ETHUSDT: "BINANCE:ETHUSDT",
  SOLUSDT: "BINANCE:SOLUSDT",
  BTCUSDC: "BINANCE:BTCUSDC",

  // --- bare crypto tickers (Binance USDT spot) ---
  // A bare ticker like `SOL` or `LINK` must never land on `CRYPTOCAP:*`
  // (market cap, ≈10^10) or an unrelated equity (e.g. `NASDAQ:LINK`). These
  // point at the deepest USDT spot pair; say `EXCHANGE:SYMBOL` to override.
  // Verified with live daily candles on 2026-10-05 (references/symbols.md).
  BTC: "BINANCE:BTCUSDT",
  ETH: "BINANCE:ETHUSDT",
  SOL: "BINANCE:SOLUSDT",
  XRP: "BINANCE:XRPUSDT",
  ADA: "BINANCE:ADAUSDT",
  DOGE: "BINANCE:DOGEUSDT",
  AVAX: "BINANCE:AVAXUSDT",
  DOT: "BINANCE:DOTUSDT",
  LINK: "BINANCE:LINKUSDT",
  LTC: "BINANCE:LTCUSDT",
  BCH: "BINANCE:BCHUSDT",
  TRX: "BINANCE:TRXUSDT",
  SHIB: "BINANCE:SHIBUSDT",
  PEPE: "BINANCE:PEPEUSDT",
  UNI: "BINANCE:UNIUSDT",
  AAVE: "BINANCE:AAVEUSDT",
  NEAR: "BINANCE:NEARUSDT",
  ATOM: "BINANCE:ATOMUSDT",
  FIL: "BINANCE:FILUSDT",
  ETC: "BINANCE:ETCUSDT",
  XLM: "BINANCE:XLMUSDT",
  ICP: "BINANCE:ICPUSDT",
  APT: "BINANCE:APTUSDT",
  ARB: "BINANCE:ARBUSDT",
  OP: "BINANCE:OPUSDT",
  SUI: "BINANCE:SUIUSDT",
  SEI: "BINANCE:SEIUSDT",
  INJ: "BINANCE:INJUSDT",
  WIF: "BINANCE:WIFUSDT",
  BONK: "BINANCE:BONKUSDT",
  FET: "BINANCE:FETUSDT",
  TIA: "BINANCE:TIAUSDT",
  STX: "BINANCE:STXUSDT",
  IMX: "BINANCE:IMXUSDT",
  CRV: "BINANCE:CRVUSDT",
  ZEC: "BINANCE:ZECUSDT",
  DASH: "BINANCE:DASHUSDT",
  XTZ: "BINANCE:XTZUSDT",
  ALGO: "BINANCE:ALGOUSDT",
  VET: "BINANCE:VETUSDT",
  GALA: "BINANCE:GALAUSDT",
  ENS: "BINANCE:ENSUSDT",
  LDO: "BINANCE:LDOUSDT",
  SAND: "BINANCE:SANDUSDT",
  MANA: "BINANCE:MANAUSDT",

  // --- continuous futures front month (CME group) ---
  "CNH1!": "CME:CNH1!",
  "ES1!": "CME_MINI:ES1!",
  "NQ1!": "CME_MINI:NQ1!",
  "YM1!": "CBOT:YM1!",
  "CL1!": "NYMEX:CL1!",
  "NG1!": "NYMEX:NG1!",
  "GC1!": "COMEX:GC1!",
  "SI1!": "COMEX:SI1!",
  "ZN1!": "CBOT:ZN1!",
  "6E1!": "CME:6E1!",
  "6J1!": "CME:6J1!",
  "BTC1!": "CME:BTC1!",
};

/** Preferred exchanges, most specific first, when several hits match. */
const EXCHANGE_PRIORITY = [
  "TVC",
  "SP",
  "NASDAQ",
  "NYSE",
  "AMEX",
  "ARCA",
  "CBOE",
  "CME_MINI",
  "CME",
  "COMEX",
  "NYMEX",
  "CBOT",
  "BINANCE",
  "BITSTAMP",
  "COINBASE",
  "CRYPTO",
  "INDEX",
  "FX",
  "FX_IDC",
  "OANDA",
];

/** Preferred instrument types, most specific first (crypto.futures are futures). */
const TYPE_PRIORITY = [
  "index",
  "bond",
  "crypto",
  "forex",
  "futures",
  "fund",
  "stock",
  "cfd",
  "economic",
  "spot",
];

/**
 * Exchanges that publish derived indices rather than tradeable prices.
 * `CRYPTOCAP:SOL` is a total market cap in USD (≈10^10), not the SOL price
 * (≈10^2) — the exact trap that made a bare `SOL` lookup return wrong-magnitude
 * data. Search hits on these lose to any real exchange unless the user writes
 * the prefix explicitly.
 */
export const INDEX_EXCHANGES = new Set(["CRYPTOCAP", "INDEX"]);

const INDEX_PENALTY = 260;

export type ResolveOptions = {
  exchange?: string;
  type?: string;
  limit?: number;
  /** Disable the search step (alias + explicit only). */
  noFallback?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const cache = new Map<string, Resolution>();

function cacheKey(input: string, opts: ResolveOptions): string {
  return `${input}|${opts.exchange ?? ""}|${opts.type ?? ""}|${opts.noFallback ? "1" : "0"}`;
}

function isSearchHit(v: unknown): v is SearchHit {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as SearchHit).id === "string" &&
    typeof (v as SearchHit).symbol === "string"
  );
}

function scoreHit(hit: SearchHit, input: string, base: string): number {
  let score = 0;
  const upper = input.toUpperCase();
  const upperBase = base.toUpperCase();
  if (hit.id.toUpperCase() === upper) score += 400;
  if (hit.symbol.toUpperCase() === upperBase) score += 160;
  else if (hit.symbol.toUpperCase().startsWith(upperBase)) score += 40;

  const exchange = hit.exchange.toUpperCase();
  const priority = EXCHANGE_PRIORITY.indexOf(exchange);
  score += priority === -1 ? -20 : (EXCHANGE_PRIORITY.length - priority) * 3;

  // Derived indices must never silently win a price lookup (see INDEX_EXCHANGES).
  if (INDEX_EXCHANGES.has(exchange) && !upper.startsWith(exchange)) score -= INDEX_PENALTY;

  const type = (hit.type ?? "").toLowerCase();
  const ti = TYPE_PRIORITY.indexOf(type);
  score += ti === -1 ? -5 : (TYPE_PRIORITY.length - ti) * 2;

  // OTC / pink-sheet equities are a common low-quality autocomplete match.
  if (hit.exchange.toUpperCase() === "OTC") score -= 120;
  return score;
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) if (v && !out.includes(v)) out.push(v);
  return out;
}

export async function resolveSymbol(input: string, opts: ResolveOptions = {}): Promise<Resolution> {
  const trimmed = input.trim();
  const key = cacheKey(trimmed, opts);
  const cached = cache.get(key);
  if (cached) return cached;

  let result: Resolution;
  if (trimmed.includes(":")) {
    result = {
      input: trimmed,
      symbol: trimmed,
      source: "explicit",
      confidence: "high",
      alternatives: [],
      candidates: [],
      notes: [],
    };
  } else if (opts.exchange) {
    // `--exchange X` is a candidate filter, not a hard `X:SYMBOL` forge: search
    // inside X first (SOL → BINANCE:SOLUSDT) and only fall back to the literal
    // `X:SYMBOL` when autocomplete has nothing on that venue.
    const exchange = opts.exchange.toUpperCase();
    if (opts.noFallback) {
      result = {
        input: trimmed,
        symbol: `${exchange}:${trimmed}`,
        source: "explicit",
        confidence: "high",
        alternatives: [],
        candidates: [],
        notes: [`--exchange ${exchange}: search disabled by --strict/--no-fallback`],
      };
    } else {
      const searched = await searchResolve(trimmed, { ...opts, noFallback: false });
      if (searched.symbol) {
        result = {
          ...searched,
          notes: [...searched.notes, `--exchange ${exchange}: picked the best ${exchange} candidate`],
        };
      } else {
        result = {
          input: trimmed,
          symbol: `${exchange}:${trimmed}`,
          source: "explicit",
          confidence: "low",
          alternatives: searched.alternatives,
          candidates: searched.candidates,
          notes: [`--exchange ${exchange}: no ${exchange} candidate for '${trimmed}'; passed through as ${exchange}:${trimmed}`],
        };
      }
    }
  } else {
    const alias = ALIASES[trimmed.toUpperCase()];
    if (alias) {
      result = {
        input: trimmed,
        symbol: alias,
        source: "alias",
        confidence: "high",
        alternatives: [],
        candidates: [],
        notes: [],
      };
    } else {
      result = await searchResolve(trimmed, opts);
    }
  }

  cache.set(key, result);
  return result;
}

async function searchResolve(input: string, opts: ResolveOptions): Promise<Resolution> {
  if (opts.noFallback) {
    return {
      input,
      symbol: null,
      source: "unresolved",
      confidence: "low",
      alternatives: [],
      candidates: [],
      notes: ["--no-fallback: unknown bare symbol, pass EXCHANGE:SYMBOL or --exchange"],
    };
  }

  const continuous = /^(.+?)(\d+)!$/.exec(input);
  const queryText = continuous ? continuous[1] : input;
  const monthNumber = continuous ? continuous[2] : null;
  const base = continuous ? continuous[1] : input;

  let hits: SearchHit[] = [];
  try {
    const found = await withRetry(() =>
      searchMarkets(queryText, {
        ...(opts.type ? { type: opts.type as never } : {}),
        ...(opts.exchange ? { exchange: opts.exchange } : {}),
      }),
    );
    hits = found.filter(isSearchHit).slice(0, 12);
  } catch {
    hits = [];
  }

  const notes: string[] = [];
  // Prefer hits whose contract root matches exactly (search strips `1!`).
  const rootMatches = continuous
    ? hits.filter((h) => h.symbol.toUpperCase() === base.toUpperCase())
    : hits;
  const pool = rootMatches.length > 0 ? rootMatches : hits;

  if (continuous && rootMatches.length > 0 && monthNumber) {
    notes.push(`continuous futures: reconstructed ${base}${monthNumber}! from search hits`);
    const primary = `${rootMatches[0].exchange}:${base}${monthNumber}!`;
    const alternatives = rootMatches.slice(1).map((h) => `${h.exchange}:${base}${monthNumber}!`);
    return {
      input,
      symbol: primary,
      source: "search",
      confidence: "medium",
      alternatives: dedupe(alternatives),
      candidates: hits,
      notes,
    };
  }

  const ranked = [...pool].sort((a, b) => scoreHit(b, input, base) - scoreHit(a, input, base));
  if (ranked.length === 0) {
    return {
      input,
      symbol: null,
      source: "unresolved",
      confidence: "low",
      alternatives: [],
      candidates: [],
      notes: ["no symbol matched; pass an explicit EXCHANGE:SYMBOL"],
    };
  }

  const top = ranked[0];
  const exact = top.symbol.toUpperCase() === base.toUpperCase();
  const primary = continuous && monthNumber ? `${top.exchange}:${base}${monthNumber}!` : top.id;
  const alternatives = ranked
    .slice(1)
    .map((h) => (continuous && monthNumber ? `${h.exchange}:${base}${monthNumber}!` : h.id));

  return {
    input,
    symbol: primary,
    source: "search",
    confidence: exact ? "high" : "medium",
    alternatives: dedupe(alternatives).slice(0, 4),
    candidates: ranked.slice(0, 5),
    notes,
  };
}

/** Resolve many inputs, preserving order. */
export async function resolveSymbols(
  inputs: string[],
  opts: ResolveOptions = {},
): Promise<Resolution[]> {
  const out: Resolution[] = [];
  for (const input of inputs) out.push(await resolveSymbol(input, opts));
  return out;
}

/** Human-readable form of one resolution. */
export function summarizeResolution(r: Resolution): string {
  if (!r.symbol) return `${r.input}: unresolved`;
  const extra = r.alternatives.length > 0 ? ` (+${r.alternatives.length} alt)` : "";
  return `${r.input} -> ${r.symbol} [${r.source}/${r.confidence}]${extra}`;
}

// ---------------------------------------------------------------- unit metadata

export type SymbolKind =
  | "crypto_dominance"
  | "crypto_marketcap"
  | "crypto_spot"
  | "crypto_futures"
  | "treasury_yield"
  | "macro_index"
  | "index"
  | "forex"
  | "futures"
  | "equity"
  | string;

export type SymbolUnit = "percent" | "usd" | "price" | "unknown";

export type SymbolMeta = {
  /** What the series represents. */
  kind: SymbolKind;
  /** How to read a value: a percentage, a USD aggregate, or a quoted price. */
  unit: SymbolUnit;
  /** False for derived indices, whose volume is meaningless or inconsistent. */
  volume_reliable: boolean;
};

const CRYPTO_EXCHANGES = new Set([
  "BINANCE",
  "BITSTAMP",
  "COINBASE",
  "OKX",
  "KRAKEN",
  "MEXC",
  "BYBIT",
  "KUCOIN",
  "CRYPTO",
  "GATEIO",
  "HTX",
  "BITFINEX",
]);
const FX_EXCHANGES = new Set(["FX", "FX_IDC", "OANDA"]);
const FUTURES_EXCHANGES = new Set(["CME", "CME_MINI", "COMEX", "NYMEX", "CBOT", "EUREX", "ICEUS", "BMFBOVESPA"]);
const EQUITY_EXCHANGES = new Set(["SP", "NASDAQ", "NYSE", "AMEX", "ARCA", "CBOE", "BATS"]);
const YIELD_SYMBOL = /^US\d{2}M?Y$/;

/**
 * Unit/semantics of a resolved symbol.
 *
 * `resolved_from: search` used to leave the caller guessing whether a number
 * was a price, a percent or a USD aggregate. These fields are shipped in the
 * output envelope so a reading no longer depends on memorising an alias table.
 */
export function symbolMeta(symbol: string, hitType?: string): SymbolMeta {
  const colon = symbol.indexOf(":");
  const exchange = (colon === -1 ? "" : symbol.slice(0, colon)).toUpperCase();
  const base = (colon === -1 ? symbol : symbol.slice(colon + 1)).toUpperCase();

  if (exchange === "CRYPTOCAP") {
    return base.endsWith(".D")
      ? { kind: "crypto_dominance", unit: "percent", volume_reliable: false }
      : { kind: "crypto_marketcap", unit: "usd", volume_reliable: false };
  }
  if (exchange === "TVC") {
    return YIELD_SYMBOL.test(base)
      ? { kind: "treasury_yield", unit: "percent", volume_reliable: false }
      : { kind: "macro_index", unit: "price", volume_reliable: false };
  }
  if (INDEX_EXCHANGES.has(exchange)) {
    return { kind: "index", unit: "price", volume_reliable: false };
  }
  if (FX_EXCHANGES.has(exchange)) return { kind: "forex", unit: "price", volume_reliable: true };
  if (FUTURES_EXCHANGES.has(exchange)) return { kind: "futures", unit: "price", volume_reliable: true };
  if (CRYPTO_EXCHANGES.has(exchange)) {
    const type = (hitType ?? "").toLowerCase();
    const derivatives = type === "swap" || type === "futures";
    return { kind: derivatives ? "crypto_futures" : "crypto_spot", unit: "price", volume_reliable: true };
  }
  if (EQUITY_EXCHANGES.has(exchange)) return { kind: "equity", unit: "price", volume_reliable: true };
  return { kind: hitType ? `unknown_${hitType}` : "unknown", unit: "unknown", volume_reliable: true };
}

/** Explicit stderr note when a resolution lands on a derived index. */
export function resolutionNote(r: Resolution): string | null {
  if (!r.symbol || r.source !== "search") return null;
  const exchange = r.symbol.slice(0, r.symbol.indexOf(":")).toUpperCase();
  if (!INDEX_EXCHANGES.has(exchange)) return null;
  const what = exchange === "CRYPTOCAP" ? "a market-cap/dominance index" : "a synthetic index";
  return `${r.symbol} is ${what}, not a price series; pass an explicit EXCHANGE:SYMBOL (e.g. BINANCE:SOLUSDT) for prices.`;
}
