/**
 * Normalisation: upstream payload shapes → flat, stable rows.
 *
 * Upstream shapes are irregular by endpoint:
 *   - `open_interest` / `volume` / `volatility_skew` → `{ "<exp>:calls": [ {strike, ...} ] }`
 *   - `greeks`                                       → `{ delta: { "<exp>:calls": [...] }, ... }`
 *   - `gamma_exposure` / `delta_exposure`            → one `chart_exposure_data` object
 *   - `option_chain_statistics` / `option_chain`     → an HTML `<table>`
 *   - `max_pain`                                     → a list covering **all** expiries
 */

import {
  parseDiffDisplay,
  parseLevelWithPct,
  parseNumber,
  parsePlusMinus,
  parseTables,
  stripTags,
} from "./html.ts";
import type {
  ChainRow,
  ExpectedMovePoint,
  ExposurePayload,
  ExposureStrike,
  MaxPainRow,
  PriceWidget,
  StatsRow,
  Table,
} from "./types.ts";

export type SeriesMetric = "open_interest" | "volume" | "implied_volatility";

export interface SeriesRow {
  expiration: string;
  option_type: "CALL" | "PUT";
  strike: number;
  contract_symbol: string | null;
  [metric: string]: unknown;
}

function sideOf(side: string): "CALL" | "PUT" {
  return side === "puts" ? "PUT" : "CALL";
}

export function splitExpirySideKey(key: string): { expiration: string; side: "CALL" | "PUT" } | null {
  const match = /^(\d{4}-\d{2}-\d{2}:[wm]):(calls|puts)$/.exec(key);
  if (!match) return null;
  return { expiration: match[1], side: sideOf(match[2]) };
}

/** Flatten an `{ "<exp>:calls": [ {strike, <metric>, ...} ] }` payload. */
export function seriesRows(payload: unknown, metric: SeriesMetric): SeriesRow[] {
  const rows: SeriesRow[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return rows;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const split = splitExpirySideKey(key);
    if (!split || !Array.isArray(value)) continue;
    for (const raw of value) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const strike = typeof row.strike === "number" ? row.strike : parseNumber(String(row.strike));
      if (strike === null) continue;
      const out: SeriesRow = {
        expiration: split.expiration,
        option_type: split.side,
        strike,
        contract_symbol: typeof row.contract_symbol === "string" ? row.contract_symbol : null,
      };
      const rawValue = row[metric];
      const numeric =
        typeof rawValue === "number" ? rawValue : rawValue === null || rawValue === undefined ? null : parseNumber(String(rawValue));
      out[metric] = numeric;
      if (metric === "implied_volatility" && typeof numeric === "number") {
        out.iv_pct = round(numeric * 100, 4);
      }
      rows.push(out);
    }
  }
  return rows;
}

export interface GreekRow {
  greek: string;
  expiration: string;
  option_type: "CALL" | "PUT";
  strike: number;
  value: number | null;
  implied_volatility: number | null;
  iv_pct: number | null;
  contract_symbol: string | null;
}

/** Flatten `all_chart_data = { delta: { "<exp>:calls": [...] }, ... }`. */
export function greekRows(payload: unknown, greeks?: string[]): GreekRow[] {
  const rows: GreekRow[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return rows;
  const perGreek = payload as Record<string, unknown>;
  for (const [greek, value] of Object.entries(perGreek)) {
    if (greeks?.length && !greeks.includes(greek)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, series] of Object.entries(value as Record<string, unknown>)) {
      const split = splitExpirySideKey(key);
      if (!split || !Array.isArray(series)) continue;
      for (const raw of series) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const strike = typeof row.strike === "number" ? row.strike : parseNumber(String(row.strike));
        if (strike === null) continue;
        const iv = typeof row.implied_volatility === "number" ? row.implied_volatility : null;
        const cell = row[greek];
        rows.push({
          greek,
          expiration: split.expiration,
          option_type: split.side,
          strike,
          value: typeof cell === "number" ? cell : null,
          implied_volatility: iv,
          iv_pct: iv === null ? null : round(iv * 100, 4),
          contract_symbol: typeof row.contract_symbol === "string" ? row.contract_symbol : null,
        });
      }
    }
  }
  return rows;
}

export function availableGreeks(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload as Record<string, unknown>);
}

/** `chart_exposure_data` — GEX / DEX in **USD per 1% move**, not dollar notional. */
export function exposurePayload(payload: unknown): ExposurePayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const strikes: ExposureStrike[] = Array.isArray(raw.exposure_by_strike_series)
    ? (raw.exposure_by_strike_series as ExposureStrike[])
    : [];
  return {
    ticker: String(raw.ticker ?? ""),
    call_exposure: numeric(raw.call_exposure),
    put_exposure: numeric(raw.put_exposure),
    net_exposure: numeric(raw.net_exposure),
    call_wall: nullableNumber(raw.call_wall),
    put_wall: nullableNumber(raw.put_wall),
    exposure_by_strike_series: strikes,
    exposure_by_expiration_series: Array.isArray(raw.exposure_by_expiration_series)
      ? (raw.exposure_by_expiration_series as ExposurePayload["exposure_by_expiration_series"])
      : [],
  };
}

function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = parseNumber(value === null || value === undefined ? undefined : String(value));
  return parsed ?? 0;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value === null || value === undefined) return null;
  return parseNumber(String(value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Column keys the statistics endpoint accepts → the shape the CLI emits. */
const STATS_NUMERIC: Record<string, string> = {
  volume_total: "volume_total",
  volume_pcr: "volume_pcr",
  oi_total: "oi_total",
  oi_pcr: "oi_pcr",
  volume_calls: "volume_calls",
  volume_puts: "volume_puts",
  oi_calls: "oi_calls",
  oi_puts: "oi_puts",
  dte: "dte",
  contracts_total: "contracts_total",
  gex: "gex",
  dex: "dex",
};

export interface StatsResult {
  rows: StatsRow[];
  locked: string[];
}

/**
 * Parse the `option_chain_statistics` table.
 *
 * Cells are mapped **positionally** against the requested `columns` list (the
 * server renders headers in request order) and cross-checked against the header
 * text; a locked cell (paywall icon) becomes `null` plus a `locked` warning
 * instead of a wrong number.
 */
export function statsRows(html: string, columns: readonly string[]): StatsResult {
  const table = parseTables(html)[0];
  const rows: StatsRow[] = [];
  const locked: string[] = [];
  if (!table) return { rows, locked };
  for (const cells of table.rows) {
    const row: StatsRow = { expiration: "", kind: "weekly", dte: null };
    columns.forEach((column, index) => {
      const cell = cells[index];
      if (!cell) return;
      if (cell.locked) {
        row[column] = null;
        if (!locked.includes(column)) locked.push(column);
        return;
      }
      switch (column) {
        case "expiration": {
          const id = expiryFromHref(cell.href) ?? expiryFromText(cell.text);
          if (id) {
            row.expiration = id.exp_id;
            row.kind = id.kind;
          }
          break;
        }
        case "iv":
          row.iv_pct = parseNumber(cell.text);
          break;
        case "expected_move": {
          const parsed = parsePlusMinus(cell.text);
          row.expected_move_abs = parsed.abs;
          row.expected_move_pct = parsed.pct;
          break;
        }
        case "max_pain": {
          const parsed = parseLevelWithPct(cell.text);
          row.max_pain = parsed.value;
          row.max_pain_diff_pct = parsed.pct;
          break;
        }
        case "dte":
          row.dte = parseNumber(cell.text);
          break;
        default: {
          const key = STATS_NUMERIC[column];
          if (key) row[key] = parseNumber(cell.text);
          else if (cell.text) row[column] = cell.text;
        }
      }
    });
    if (!row.expiration) continue;
    rows.push(row);
  }
  return { rows, locked };
}

/** `/options/TLT/option-chain?expiration_dates=2026-10-09:w` → canonical expiry. */
export function expiryFromHref(href: string | undefined): { exp_id: string; kind: "weekly" | "monthly" } | null {
  if (!href) return null;
  const match = /expiration_dates=(\d{4}-\d{2}-\d{2})(?:%3A|:)([wm])/.exec(href);
  if (!match) return null;
  return { exp_id: `${match[1]}:${match[2]}`, kind: match[2] === "m" ? "monthly" : "weekly" };
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** `Oct 05, 2026 (0 days) (w)` → canonical expiry (fallback when no href). */
export function expiryFromText(text: string): { exp_id: string; kind: "weekly" | "monthly" } | null {
  const match = /([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4}).*?\((w|m)\)/s.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  const date = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return { exp_id: `${date}:${match[4]}`, kind: match[4] === "m" ? "monthly" : "weekly" };
}

/** Chain column key → the normalised `ChainRow` field it is stored in. */
export const CHAIN_FIELDS: Record<string, string> = { iv: "iv_pct" };

/** Parse the call/put tables of an option-chain fragment into flat rows. */
export function chainRows(html: string, columns: readonly string[]): ChainRow[] {
  const tables = parseTables(html);
  const rows: ChainRow[] = [];
  for (const table of tables) {
    const side = table.id?.includes("put") ? "PUT" : table.id?.includes("call") ? "CALL" : null;
    if (!side) continue;
    for (const cells of table.rows) {
      const row: ChainRow = {
        option_type: side,
        strike: null,
        bid: null,
        ask: null,
        volume: null,
        oi: null,
        iv_pct: null,
        delta: null,
      };
      let touched = false;
      columns.forEach((column, index) => {
        const cell = cells[index];
        if (!cell || cell.locked) return;
        const value = parseNumber(cell.text);
        if (value !== null) touched = true;
        (row as unknown as Record<string, number | null>)[CHAIN_FIELDS[column] ?? column] = value;
      });
      if (touched) rows.push(row);
    }
  }
  return rows;
}

/** `max_pain` returns every listed expiry in one request. */
export function maxPainRows(payload: unknown): MaxPainRow[] {
  if (!Array.isArray(payload)) return [];
  const rows: MaxPainRow[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const exp = typeof item.expiration_date_id === "string" ? item.expiration_date_id : null;
    if (!exp) continue;
    const diff = parseDiffDisplay(
      typeof item.max_pain_to_price_display === "string" ? item.max_pain_to_price_display : undefined,
    );
    rows.push({
      expiration_date_id: exp,
      expiration_date_display:
        typeof item.expiration_date_display === "string" ? item.expiration_date_display : undefined,
      max_pain:
        typeof item.y === "number" ? item.y : nullableNumber(item.max_pain_display ?? item.max_pain),
      max_pain_diff:
        typeof item.max_pain_to_price_diff === "number" ? round(item.max_pain_to_price_diff, 4) : round(diff.abs ?? 0, 4),
      max_pain_diff_display:
        typeof item.max_pain_to_price_display === "string" ? item.max_pain_to_price_display : undefined,
      max_pain_diff_pct: diff.pct === null ? null : round(diff.pct, 4),
    });
  }
  return rows;
}

/** Expected-move cone: one point per timestamp (838 points on a live ticker). */
export function expectedMovePoints(payload: unknown): ExpectedMovePoint[] {
  if (!Array.isArray(payload)) return [];
  const rows: ExpectedMovePoint[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const t = typeof item.t === "number" ? item.t : null;
    if (t === null) continue;
    const date = new Date(t);
    rows.push({
      t,
      iso: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      em_amt: nullableNumber(item.em_amt),
      em_pct: nullableNumber(item.em_pct),
      low: nullableNumber(item.low),
      high: nullableNumber(item.high),
      avg_iv: nullableNumber(item.avg_iv),
    });
  }
  return rows;
}

/** The price widget is small server-rendered HTML, not JSON. */
export function priceFromWidget(html: string, ticker: string): PriceWidget {
  const text = stripTags(html);
  const nameMatch =
    /<span class="tw-text-3xl tw-font-semibold tw-whitespace-nowrap">([^<]*)<\/span>/.exec(html);
  const priceMatch = /<span class="tw-text-3xl tw-font-semibold">\s*([\d.,]+)\s*<\/span>/.exec(html);
  const currencyMatch =
    /<span class="tw-text-3xl tw-font-semibold">[\s\S]{0,80}?<span class="tw-text-sm tw-ml-1 tw-text-gray-500">\s*([A-Z]{3})\s*<\/span>/.exec(
      html,
    );
  const changeMatch = /<span class="tw-text-lg tw-ml-3 tw-whitespace-nowrap"[^>]*>\s*([^<]*?)\s*<\/span>/.exec(html);
  const asOfMatch = /<span>As of ([^<]+)<\/span>/.exec(html);
  const statuses = [...html.matchAll(/<span class="tw-text-gray-500" style="font-size: 0\.7rem[^"]*">\s*([^<]*?)\s*<\/span>/g)].map(
    (match) => match[1],
  );
  let change: number | null = null;
  let changePct: number | null = null;
  if (changeMatch) {
    const parts = changeMatch[1].replace(/[()]/g, " ").trim().split(/\s+/);
    change = parseNumber(parts[0]);
    changePct = parseNumber(parts[1]);
  }
  const widget: PriceWidget = {
    ticker,
    price: priceMatch ? parseNumber(priceMatch[1]) : parseNumber(/\$?\d[\d.,]*/.exec(text)?.[0]),
    change,
    change_pct: changePct,
  };
  if (nameMatch && nameMatch[1]) widget.name = nameMatch[1].trim();
  if (currencyMatch && currencyMatch[1]) widget.currency = currencyMatch[1];
  if (asOfMatch && asOfMatch[1]) widget.as_of = asOfMatch[1].trim();
  if (statuses[0]) widget.market_status = statuses[0];
  if (statuses[1]) widget.options_delay = statuses[1];
  return widget;
}

export interface TickerInfo {
  dividend_yield_pct: number | null;
  average_volume: number | null;
  high_today: number | null;
  low_today: number | null;
  open_price: number | null;
  volume: number | null;
  week52_high: number | null;
  week52_low: number | null;
  [extra: string]: number | null;
}

const INFO_FIELDS: Record<string, keyof TickerInfo> = {
  "Dividend Yield": "dividend_yield_pct",
  "Average Volume": "average_volume",
  "High Today": "high_today",
  "Low Today": "low_today",
  "Open Price": "open_price",
  Volume: "volume",
  "52 Week High": "week52_high",
  "52 Week Low": "week52_low",
};

/** Parse `options_ticker_info`: label/value div pairs. */
export function tickerInfo(html: string): TickerInfo {
  const info: TickerInfo = {
    dividend_yield_pct: null,
    average_volume: null,
    high_today: null,
    low_today: null,
    open_price: null,
    volume: null,
    week52_high: null,
    week52_low: null,
  };
  const pattern =
    /<div class="tw-text-sm tw-text-gray-500 tw-mb-1">([^<]*)<\/div>\s*<div class="tw-font-bold tw-text-base">\s*([^<]*?)\s*<\/div>/g;
  for (const match of html.matchAll(pattern)) {
    const label = match[1].trim();
    const key = INFO_FIELDS[label];
    if (!key) continue;
    info[key] = parseScaleNumber(match[2]);
  }
  return info;
}

/** `47.85M` → 47850000, `3.63M` → 3630000, `4.85%` → 4.85, `$77.72` → 77.72. */
export function parseScaleNumber(text: string): number | null {
  if (!text) return null;
  const match = /(-?\d[\d,]*(?:\.\d+)?)\s*([KMBT])?/i.exec(text.replace(/[$,\s]/g, ""));
  if (!match) return null;
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return null;
  const scale: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const suffix = match[2]?.toUpperCase();
  return suffix && scale[suffix] ? base * scale[suffix] : base;
}

export { round };

/** Tables are easier to keep around than raw HTML in callers. */
export type { Table };
