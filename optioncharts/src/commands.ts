/**
 * Command implementations: fetch → normalise → one stable JSON document.
 *
 * Every data command accepts one or more tickers and answers with the same
 * envelope:
 *
 * ```json
 * { "provenance": {...}, "tickers": [ { "ticker": "TLT", ... } ] }
 * ```
 *
 * A ticker that fails (invalid symbol, missing fragment) is reported inside its
 * own entry instead of aborting the run; the process only exits non-zero when
 * *every* requested ticker failed.
 */

import { CliError, DataUnavailableError, ExpFallbackError, UsageError, EXIT } from "./errors.ts";
import {
  CHARTS,
  CHAIN_COLUMNS,
  ExpiryService,
  STATS_COLUMNS,
  checkExpiryFallback,
  expiryIdsFromSymbols,
  payloadExpiries,
  fetchChart,
  fetchChain,
  fetchPriceWidget,
  fetchStatistics,
  fetchTickerInfo,
  filterExpiries,
} from "./endpoints.ts";
import { extractExpiryIds, stripTags, tryExtractJson } from "./html.ts";
import type { Client } from "./http.ts";
import {
  availableGreeks,
  CHAIN_FIELDS,
  chainRows,
  expectedMovePoints,
  exposurePayload,
  greekRows,
  maxPainRows,
  priceFromWidget,
  seriesRows,
  statsRows,
  tickerInfo,
  type GreekRow,
  type SeriesRow,
} from "./normalize.ts";
import type { ExpiryEntry, FetchResult } from "./types.ts";

export type CommandName =
  | "spot"
  | "info"
  | "expiries"
  | "gex"
  | "dex"
  | "oi"
  | "volume"
  | "skew"
  | "greeks"
  | "max-pain"
  | "em"
  | "stats"
  | "chain"
  | "scan"
  | "probe"
  | "raw";

export interface CommandOptions {
  ticker: string;
  exps: string[];
  allExpiries?: boolean;
  dte?: number;
  weeklyOnly?: boolean;
  monthlyOnly?: boolean;
  maxExp?: number;
  optionType: "all" | "call" | "put";
  strikeRange: string;
  exposureType: "open_interest" | "volume";
  top?: number;
  limit?: number;
  columns?: string[];
  view: "list" | "straddle";
  greeks?: string[];
  strictExp: boolean;
  concurrency: number;
  withGex?: boolean;
  withSpot?: boolean;
  endpoint?: string;
  rawHtml?: boolean;
  rawParams?: Record<string, string>;
  rawVars?: string[];
}

export interface CsvBlock {
  headers: string[];
  rows: Array<Array<string | number | null>>;
}

export interface CommandResult {
  doc: unknown;
  csv?: CsvBlock;
  /** Set when some ticker failed but others produced data (worst failure wins). */
  exitCode?: number;
}

export interface Context {
  client: Client;
  expiries: ExpiryService;
  options: CommandOptions;
}

/** `Aug 03, 2026` for a `YYYY-MM-DD` string; `undefined` for bad input. */
function weekdayOf(date: string): string | undefined {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getUTCDay()];
}

function provenance(result: FetchResult, client: Client, ticker: string, warnings: string[]) {
  return {
    source: "optioncharts.io",
    ticker,
    endpoint: new URL(result.url).pathname,
    url: result.url,
    status: result.status,
    fetched_at: result.fetched_at,
    latency_ms: result.latency_ms,
    from_cache: result.from_cache,
    requests_this_run: client.requests,
    warnings,
  };
}

const DELAY_NOTE =
  "optioncharts.io serves options data 15 minutes delayed (OPRA); spot prices are real-time (Polygon.io)";

/** Map a day-count-carrying entry list to the flat shape the CLI prints. */
export function expiryView(entry: ExpiryEntry) {
  return {
    exp: entry.exp_id,
    date: entry.date,
    weekday: weekdayOf(entry.date),
    kind: entry.kind,
    dte: entry.dte ?? null,
    display: entry.display ?? null,
  };
}

function topRows<T extends Record<string, unknown>>(rows: T[], key: string, top?: number): T[] {
  if (!top || top <= 0 || rows.length <= top) return rows;
  return [...rows]
    .sort((a, b) => Math.abs(Number(b[key] ?? 0)) - Math.abs(Number(a[key] ?? 0)))
    .slice(0, top);
}

/** Resolve `--exp` / `--dte` / `--weekly-only` into the expiries to request. */
async function selectChartExpiries(ctx: Context, ticker: string): Promise<{ ids: string[]; entries: ExpiryEntry[]; warnings: string[] }> {
  const warnings: string[] = [];
  const options = ctx.options;
  if (options.exps.length) {
    const { expiries, corrections } = await ctx.expiries.resolve(ticker, options.exps);
    let selected = expiries;
    if (options.dte !== undefined || options.weeklyOnly || options.monthlyOnly) {
      selected = filterExpiries(selected, {
        dte: options.dte,
        weeklyOnly: options.weeklyOnly,
        monthlyOnly: options.monthlyOnly,
      });
      if (!selected.length) {
        throw new UsageError(
          `no --exp entry for ${ticker} matches dte<=${options.dte ?? "-"} / ` +
            `${options.weeklyOnly ? "weekly-only" : options.monthlyOnly ? "monthly-only" : "unfiltered"}`,
        );
      }
    }
    for (const correction of corrections) {
      warnings.push(`${correction.requested} → ${correction.used} (${correction.why})`);
    }
    return { ids: selected.map((entry) => entry.exp_id), entries: selected, warnings };
  }

  const entries = await ctx.expiries.entries(ticker);
  const candidates = filterExpiries(entries, {
    dte: options.dte,
    weeklyOnly: options.weeklyOnly,
    monthlyOnly: options.monthlyOnly,
  });
  if (!candidates.length) {
    throw new DataUnavailableError(
      `no listed expiry for ${ticker} matches the dte/kind filter`,
      { ticker },
    );
  }
  const selected = options.allExpiries ? candidates : candidates.slice(0, 1);
  return { ids: selected.map((entry) => entry.exp_id), entries: selected, warnings };
}

/**
 * GEX/DEX per-strike rows are the sum over the requested expiries, and the free
 * tier collapses the per-expiry breakdown to one row — spell that out.
 */
function multiExpiryNote(ids: string[]): string | null {
  if (ids.length < 2) return null;
  return `${ids.length} expiries requested: the per-strike series is summed across them (the per-expiry ` +
    `breakdown is a paid feature on optioncharts.io) — request one expiry at a time for a clean series`;
}

function perExpiryNote(count: number): string | null {
  return count > 1
    ? `the free tier collapses the per-expiry summary to 1 row (paid feature); per-strike rows are still per-expiry`
    : null;
}

/* ------------------------------------------------------------------ commands */

async function cmdSpot(ctx: Context, ticker: string): Promise<Record<string, unknown>> {
  const result = await fetchPriceWidget(ctx.client, ticker);
  const widget = priceFromWidget(result.body, ticker);
  const warnings = [DELAY_NOTE];
  return {
    ticker,
    ...widget,
    price_source: "Polygon.io (real-time, per the page tooltip)",
    note: "extended-hours (pre/post) prices are only present in the widget when a session is active",
    provenance: provenance(result, ctx.client, ticker, warnings),
  };
}

async function cmdInfo(ctx: Context, ticker: string): Promise<Record<string, unknown>> {
  const result = await fetchTickerInfo(ctx.client, ticker);
  const info = tickerInfo(result.body);
  return {
    ticker,
    ...info,
    volume_units: "shares (upstream renders 3.63M etc., expanded here)",
    provenance: provenance(result, ctx.client, ticker, []),
  };
}

async function cmdExpiries(
  ctx: Context,
  ticker: string,
): Promise<{ payload: Record<string, unknown>; csv: CsvBlock }> {
  const entries = await ctx.expiries.entries(ticker);
  const result = ctx.expiries.lastFetch(ticker);
  const filtered = filterExpiries(entries, {
    dte: ctx.options.dte,
    weeklyOnly: ctx.options.weeklyOnly,
    monthlyOnly: ctx.options.monthlyOnly,
    max: ctx.options.maxExp,
  });
  const warnings: string[] = [];
  if (ctx.options.dte === undefined) {
    warnings.push(
      "expiration_dates must always carry the :w / :m suffix — a bare date silently answers for another expiry",
    );
  }
  if (entries.length >= 30) {
    warnings.push(
      "the expiry checkbox list looks capped at 30 entries: `stats` reads the full per-expiry table, " +
        "and a date past the list gets its :w/:m suffix inferred from the third-Friday rule",
    );
  }
  const views = filtered.map(expiryView);
  return {
    payload: {
      ticker,
      count: views.length,
      total_available: entries.length,
      expirations: views,
      provenance: provenance(
        result ?? {
          url: `https://optioncharts.io/async/options_charts/open_interest?ticker=${ticker}`,
          params: {},
          status: 200,
          latency_ms: 0,
          from_cache: true,
          fetched_at: new Date().toISOString(),
          body: "",
        },
        ctx.client,
        ticker,
        warnings,
      ),
    },
    csv: {
      headers: ["ticker", "exp", "date", "weekday", "kind", "dte", "display"],
      rows: views.map((view) => [
        ticker,
        view.exp,
        view.date,
        view.weekday ?? null,
        view.kind,
        view.dte,
        view.display,
      ]),
    },
  };
}

async function cmdExposure(
  ctx: Context,
  ticker: string,
  chart: "gamma_exposure" | "delta_exposure",
): Promise<{ payload: Record<string, unknown>; csv: CsvBlock }> {
  const { ids, warnings } = await selectChartExpiries(ctx, ticker);
  const response = await fetchChart(ctx.client, {
    chart,
    ticker,
    expiries: ids,
    optionType: ctx.options.optionType,
    strikeRange: ctx.options.strikeRange,
    exposureType: ctx.options.exposureType,
  });
  // With several expiries the free tier collapses the per-expiry breakdown to one row, so a
  // "missing" expiry there is explained by multiExpiryNote instead of being flagged again.
  warnings.push(
    ...checkExpiryFallback(response.data, ids, ctx.options.strictExp, ticker, {
      ignoreMissing: ids.length > 1,
    }),
  );
  const aggregated = multiExpiryNote(ids);
  if (aggregated) warnings.push(aggregated);
  const note = perExpiryNote(
    Array.isArray((response.data as { exposure_by_expiration_series?: unknown[] })?.exposure_by_expiration_series)
      ? ((response.data as { exposure_by_expiration_series: unknown[] }).exposure_by_expiration_series.length)
      : 0,
  );
  if (note) warnings.push(note);
  const exposure = exposurePayload(response.data);
  if (!exposure) {
    throw new DataUnavailableError(`no ${chart} payload for ${ticker}`, { ticker });
  }
  const label = chart === "gamma_exposure" ? "GEX" : "DEX";
  const byStrike = topRows(
    exposure.exposure_by_strike_series.map((row) => ({ ...row })),
    "net_exposure",
    ctx.options.top,
  );
  const byExpiry = exposure.exposure_by_expiration_series.map((row) => ({
    expiration: row.expiration_date_id,
    net_exposure: row.net_exposure,
    call_exposure: row.call_exposure ?? null,
    put_exposure: row.put_exposure ?? null,
    call_wall: row.call_wall,
    put_wall: row.put_wall,
    gamma_zero_level: row.gamma_zero_level,
  }));
  return {
    payload: {
      ticker,
      exposure: label,
      type: ctx.options.exposureType,
      expiries: ids,
      requested_expiries: ctx.options.exps,
      unit: "usd_per_1pct_move",
      unit_note:
        `${label} is dollar gamma/delta per 1% underlying move (the upstream "exposure" unit) — ` +
        `do NOT label it as notional or absolute dollars`,
      net_exposure: exposure.net_exposure,
      call_exposure: exposure.call_exposure,
      put_exposure: exposure.put_exposure,
      call_wall: exposure.call_wall,
      put_wall: exposure.put_wall,
      wall_note:
        "call_wall / put_wall come from the inline JSON and are real even though the site's UI shows them locked",
      gamma_zero_level: byExpiry[0]?.gamma_zero_level ?? null,
      gamma_zero_level_note:
        "null on the free tier (the server never computes it anonymously); recompute a flip level locally from `greeks` × open interest if you need one",
      exposure_by_expiration: byExpiry,
      gex_by_strike: byStrike,
      exposure_by_strike_count: exposure.exposure_by_strike_series.length,
      returned_expiries: payloadExpiries(response.data),
      provenance: provenance(response.result, ctx.client, ticker, warnings),
    },
    csv: {
      headers: ["ticker", "expiry", "strike", "call_exposure", "put_exposure", "net_exposure"],
      rows: byStrike.map((row) => [
        ticker,
        ids.join("+"),
        row.strike,
        row.call_exposure,
        row.put_exposure,
        row.net_exposure,
      ]),
    },
  };
}

type SeriesKind = "open_interest" | "volume" | "skew";

const SERIES_CONFIG: Record<SeriesKind, { chart: "open_interest" | "volume" | "volatility_skew"; metric: string; column: string }> = {
  open_interest: { chart: "open_interest", metric: "open_interest", column: "open_interest" },
  volume: { chart: "volume", metric: "volume", column: "volume" },
  skew: { chart: "volatility_skew", metric: "implied_volatility", column: "iv_pct" },
};

async function cmdSeries(
  ctx: Context,
  ticker: string,
  kind: SeriesKind,
): Promise<{ payload: Record<string, unknown>; csv: CsvBlock }> {
  const config = SERIES_CONFIG[kind];
  const { ids, warnings } = await selectChartExpiries(ctx, ticker);
  const response = await fetchChart(ctx.client, {
    chart: config.chart,
    ticker,
    expiries: ids,
    optionType: ctx.options.optionType,
    strikeRange: ctx.options.strikeRange,
  });
  warnings.push(...checkExpiryFallback(response.data, ids, ctx.options.strictExp, ticker));
  const rows = topRows(
    seriesRows(response.data, config.metric as "open_interest" | "volume" | "implied_volatility") as unknown as Array<
      Record<string, unknown>
    >,
    config.metric,
    ctx.options.top,
  ) as unknown as SeriesRow[];
  const payloadExpiryList = [...new Set(rows.map((row) => row.expiration))].sort();
  const payload: Record<string, unknown> = {
    ticker,
    metric: config.metric,
    expiries: payloadExpiryList.length ? payloadExpiryList : ids,
    requested_expiries: ctx.options.exps,
    row_count: rows.length,
    returned_expiries: payloadExpiries(response.data),
    rows,
    provenance: provenance(response.result, ctx.client, ticker, warnings),
  };
  if (kind === "open_interest" && Array.isArray(response.summary)) {
    payload.summary = response.summary;
    payload.summary_note = "per-expiry open-interest totals, one row per requested expiry";
  }
  if (kind === "skew") {
    payload.iv_note = "implied_volatility is the upstream decimal (0.5125 = 51.25%); iv_pct is ×100";
  }
  const headers =
    kind === "skew"
      ? ["ticker", "expiration", "option_type", "strike", "iv_pct", "implied_volatility", "contract_symbol"]
      : ["ticker", "expiration", "option_type", "strike", config.column, "contract_symbol"];
  return {
    payload,
    csv: {
      headers,
      rows: rows.map((row) =>
        kind === "skew"
          ? [
              ticker,
              row.expiration,
              row.option_type,
              row.strike,
              (row.iv_pct as number | null) ?? null,
              (row.implied_volatility as number | null) ?? null,
              row.contract_symbol ?? null,
            ]
          : [
              ticker,
              row.expiration,
              row.option_type,
              row.strike,
              row[config.metric] as number | null,
              row.contract_symbol ?? null,
            ],
      ),
    },
  };
}

async function cmdGreeks(
  ctx: Context,
  ticker: string,
): Promise<{ payload: Record<string, unknown>; csv: CsvBlock }> {
  const { ids, warnings } = await selectChartExpiries(ctx, ticker);
  const response = await fetchChart(ctx.client, {
    chart: "greeks",
    ticker,
    expiries: ids,
    optionType: ctx.options.optionType,
  });
  warnings.push(...checkExpiryFallback(response.data, ids, ctx.options.strictExp, ticker));
  const available = availableGreeks(response.data);
  const rows = topRows(
    greekRows(response.data, ctx.options.greeks) as unknown as Array<Record<string, unknown>>,
    "value",
    ctx.options.top,
  ) as unknown as GreekRow[];
  const locked = [...new Set(rows.filter((row) => row.value === null).map((row) => row.greek))];
  if (locked.length) {
    warnings.push(`${locked.join(", ")} are null on the free tier (paid feature)`);
  }
  return {
    payload: {
      ticker,
      expiries: ids,
      requested_expiries: ctx.options.exps,
      available_greeks: available,
      null_greeks_on_free_tier: locked,
      row_count: rows.length,
      returned_expiries: payloadExpiries(response.data),
      rows,
      provenance: provenance(response.result, ctx.client, ticker, warnings),
    },
    csv: {
      headers: ["ticker", "greek", "expiration", "option_type", "strike", "value", "iv_pct", "contract_symbol"],
      rows: rows.map((row) => [
        ticker,
        row.greek,
        row.expiration,
        row.option_type,
        row.strike,
        row.value,
        row.iv_pct,
        row.contract_symbol,
      ]),
    },
  };
}

async function cmdMaxPain(
  ctx: Context,
  ticker: string,
): Promise<{ payload: Record<string, unknown>; csv: CsvBlock }> {
  const response = await fetchChart(ctx.client, { chart: "max_pain", ticker });
  const rows = maxPainRows(response.data);
  const filtered = filterExpiries(
    rows.map((row) => ({
      exp_id: row.expiration_date_id,
      date: row.expiration_date_id.split(":")[0],
      kind: row.expiration_date_id.endsWith(":m") ? ("monthly" as const) : ("weekly" as const),
    })),
    { dte: ctx.options.dte, weeklyOnly: ctx.options.weeklyOnly, monthlyOnly: ctx.options.monthlyOnly, max: ctx.options.maxExp },
  );
  const allowed = new Set(filtered.map((entry) => entry.exp_id));
  const selected = rows.filter((row) => allowed.has(row.expiration_date_id));
  const warnings = [
    "max_pain is served for every listed expiry in a single request; max_pain_diff_pct is vs the current spot",
  ];
  return {
    payload: {
      ticker,
      count: selected.length,
      all_expiries_returned: rows.length,
      rows: selected,
      provenance: provenance(response.result, ctx.client, ticker, warnings),
    },
    csv: {
      headers: ["ticker", "expiration", "max_pain", "diff", "diff_pct", "diff_display"],
      rows: selected.map((row) => [
        ticker,
        row.expiration_date_id,
        row.max_pain,
        row.max_pain_diff,
        row.max_pain_diff_pct,
        row.max_pain_diff_display ?? null,
      ]),
    },
  };
}

async function cmdExpectedMove(
  ctx: Context,
  ticker: string,
): Promise<{ payload: Record<string, unknown>; csv: CsvBlock }> {
  const response = await fetchChart(ctx.client, { chart: "expected_move", ticker });
  const points = expectedMovePoints(response.data);
  const limit = ctx.options.limit ?? 24;
  const selected = limit > 0 ? points.slice(0, limit) : points;
  const warnings = [
    "expectedMoveConeData holds ~838 points (one per day); the cone widens with time to expiry",
  ];
  return {
    payload: {
      ticker,
      point_count: points.length,
      points_returned: selected.length,
      points: selected,
      expected_move_by_expiry_note:
        "per-expiry expected move / IV lives in `stats` (column expected_move, iv) — this command returns the cone",
      provenance: provenance(response.result, ctx.client, ticker, warnings),
    },
    csv: {
      headers: ["ticker", "t", "iso", "em_amt", "em_pct", "low", "high", "avg_iv"],
      rows: selected.map((point) => [
        ticker,
        point.t,
        point.iso,
        point.em_amt,
        point.em_pct,
        point.low,
        point.high,
        point.avg_iv,
      ]),
    },
  };
}

async function cmdStats(
  ctx: Context,
  ticker: string,
): Promise<{ payload: Record<string, unknown>; csv: CsvBlock }> {
  const columns = ctx.options.columns?.length ? ctx.options.columns : [...STATS_COLUMNS];
  const result = await fetchStatistics(ctx.client, ticker, columns);
  const { rows, locked } = statsRows(result.body, columns);
  const warnings: string[] = [];
  if (locked.length) {
    warnings.push(`${locked.join(", ")} are locked on the free tier (cells render a lock icon → null)`);
  }
  const filtered = rows.filter((row) => {
    if (ctx.options.dte !== undefined && row.dte !== null && row.dte > ctx.options.dte) return false;
    if (ctx.options.weeklyOnly && row.kind !== "weekly") return false;
    if (ctx.options.monthlyOnly && row.kind !== "monthly") return false;
    return true;
  });
  const capped = ctx.options.maxExp && ctx.options.maxExp > 0 ? filtered.slice(0, ctx.options.maxExp) : filtered;
  const headers = ["ticker", ...columns];
  return {
    payload: {
      ticker,
      count: capped.length,
      total_expiries: rows.length,
      columns,
      locked_columns: locked,
      rows: capped,
      provenance: provenance(result, ctx.client, ticker, warnings),
    },
    csv: {
      headers,
      rows: capped.map((row) => [
        ticker,
        ...columns.map((column) => statsCsvValue(row, column)),
      ]),
    },
  };

}

/** CSV column key → the normalised `StatsRow` field it lives in. */
function statsCsvValue(row: Record<string, unknown>, column: string): string | number | null {
  switch (column) {
    case "expiration":
      return String(row.expiration ?? "");
    case "kind":
      return String(row.kind ?? "");
    case "iv":
      return (row.iv_pct as number | null) ?? null;
    case "expected_move":
      return (row.expected_move_abs as number | null) ?? null;
    case "expected_move_pct":
      return (row.expected_move_pct as number | null) ?? null;
    default: {
      const value = row[column];
      if (value === undefined || value === null) return null;
      if (typeof value === "object") return JSON.stringify(value);
      return value as string | number;
    }
  }
}

async function cmdChain(
  ctx: Context,
  ticker: string,
): Promise<{ payload: Record<string, unknown>; csv: CsvBlock }> {
  const columns = ctx.options.columns?.length ? ctx.options.columns : [...CHAIN_COLUMNS];
  const { ids, warnings } = await selectChartExpiries(ctx, ticker);
  const result = await fetchChain(ctx.client, {
    ticker,
    expiries: ids,
    optionType: ctx.options.optionType,
    view: ctx.options.view,
    strikeRange: ctx.options.strikeRange,
    columns,
  });
  const rows = chainRows(result.body, columns);
  const fragmentExpiries = [...new Set([...extractExpiryIds(result.body), ...expiryIdsFromSymbols(result.body)])];
  const missing = ids.filter((exp) => !fragmentExpiries.includes(exp));
  if (missing.length) {
    const message =
      `${ticker}: the chain fragment never mentions ${missing.join(",")} — it may be serving a different expiry`;
    if (ctx.options.strictExp) throw new ExpFallbackError(message, { ticker, requested: ids });
    warnings.push(message);
  }
  return {
    payload: {
      ticker,
      view: ctx.options.view,
      expiries: ids,
      columns,
      row_count: rows.length,
      rows,
      provenance: provenance(result, ctx.client, ticker, warnings),
    },
    csv: {
      headers: ["ticker", "expiration", "option_type", ...columns],
      rows: rows.map((row) => [
        ticker,
        ids.join("+"),
        row.option_type,
        ...columns.map(
          (column) =>
            (row as unknown as Record<string, number | null>)[CHAIN_FIELDS[column] ?? column] ?? null,
        ),
      ]),
    },
  };
}

export interface ScanRow extends Record<string, unknown> {
  expiration: string;
}

async function cmdScan(ctx: Context, ticker: string): Promise<{ payload: Record<string, unknown>; csv: CsvBlock }> {
  const options = ctx.options;
  const maxExp = options.maxExp ?? 8;
  const result = await fetchStatistics(ctx.client, ticker, [...STATS_COLUMNS]);
  const { rows } = statsRows(result.body, [...STATS_COLUMNS]);
  const warnings: string[] = [];
  const candidates = rows.filter((row) => {
    if (options.dte !== undefined && row.dte !== null && row.dte > options.dte) return false;
    if (options.weeklyOnly && row.kind !== "weekly") return false;
    if (options.monthlyOnly && row.kind !== "monthly") return false;
    if (options.exps.length) {
      const dates = options.exps.map((item) => item.split(":")[0]);
      if (!dates.includes(row.expiration.split(":")[0])) return false;
    }
    return true;
  });
  const selected = candidates.slice(0, maxExp);
  if (candidates.length > selected.length) {
    warnings.push(
      `${candidates.length} expiries matched but --max-exp ${maxExp} kept the ${selected.length} nearest`,
    );
  }

  const scanRows: ScanRow[] = selected.map((row) => ({ ...row }));
  if (options.withGex) {
    for (const row of scanRows) {
      try {
        const response = await fetchChart(ctx.client, {
          chart: "gamma_exposure",
          ticker,
          expiries: [String(row.expiration)],
          optionType: "all",
          strikeRange: options.strikeRange,
          exposureType: options.exposureType,
        });
        const returned = payloadExpiries(response.data);
        row.gex_expiry = returned.join(",") || String(row.expiration);
        if (returned.length && !returned.includes(String(row.expiration))) {
          row.expiry_fallback = true;
          warnings.push(
            `${String(row.expiration)}: the server answered for ${returned.join(",")} instead — the ` +
              "exposure fields on that row belong to the expiry in gex_expiry",
          );
        }
        const exposure = exposurePayload(response.data);
        if (!exposure) continue;
        row.net_exposure = exposure.net_exposure;
        row.call_exposure = exposure.call_exposure;
        row.put_exposure = exposure.put_exposure;
        row.call_wall = exposure.call_wall;
        row.put_wall = exposure.put_wall;
        row.gamma_zero_level = exposure.exposure_by_expiration_series[0]?.gamma_zero_level ?? null;
      } catch (error) {
        warnings.push(
          `gex for ${String(row.expiration)} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  let spot: number | null = null;
  if (options.withSpot) {
    try {
      const price = await fetchPriceWidget(ctx.client, ticker);
      spot = priceFromWidget(price.body, ticker).price;
    } catch (error) {
      warnings.push(`spot lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const signFlips: Array<Record<string, unknown>> = [];
  for (let index = 1; index < scanRows.length; index += 1) {
    const previous = Number(scanRows[index - 1].net_exposure);
    const current = Number(scanRows[index].net_exposure);
    if (Number.isFinite(previous) && Number.isFinite(current) && Math.sign(previous) !== Math.sign(current)) {
      signFlips.push({
        from: scanRows[index - 1].expiration,
        to: scanRows[index].expiration,
        from_net_exposure: previous,
        to_net_exposure: current,
      });
    }
  }

  const unitNote = options.withGex
    ? "net_exposure / call_exposure / put_exposure are USD per 1% move (upstream exposure unit)"
    : "pass --gex to add walls and exposure (one extra request per expiry)";
  if (!options.withGex) warnings.push(unitNote);

  return {
    payload: {
      ticker,
      spot,
      dte_filter: options.dte ?? null,
      weekly_only: Boolean(options.weeklyOnly),
      expirations_scanned: scanRows.length,
      total_expiries: rows.length,
      exposure_unit: "usd_per_1pct_move",
      rows: scanRows,
      sign_flips: signFlips,
      provenance: provenance(result, ctx.client, ticker, warnings),
    },
    csv: {
      headers: [
        "ticker",
        "expiration",
        "kind",
        "dte",
        "volume_total",
        "volume_pcr",
        "oi_total",
        "oi_pcr",
        "iv_pct",
        "expected_move_abs",
        "expected_move_pct",
        "max_pain",
        "max_pain_diff_pct",
        "net_exposure",
        "call_wall",
        "put_wall",
        "gex_expiry",
        "expiry_fallback",
      ],
      rows: scanRows.map((row) => [
        ticker,
        String(row.expiration),
        String(row.kind ?? ""),
        (row.dte as number | null) ?? null,
        (row.volume_total as number | null) ?? null,
        (row.volume_pcr as number | null) ?? null,
        (row.oi_total as number | null) ?? null,
        (row.oi_pcr as number | null) ?? null,
        (row.iv_pct as number | null) ?? null,
        (row.expected_move_abs as number | null) ?? null,
        (row.expected_move_pct as number | null) ?? null,
        (row.max_pain as number | null) ?? null,
        (row.max_pain_diff_pct as number | null) ?? null,
        (row.net_exposure as number | null) ?? null,
        (row.call_wall as number | null) ?? null,
        (row.put_wall as number | null) ?? null,
        (row.gex_expiry as string | null) ?? null,
        row.expiry_fallback === true ? "true" : "",
      ]),
    },
  };
}

/** `probe`: which fragments answer right now, and how fast. */
export async function probe(client: Client): Promise<Record<string, unknown>> {
  const checks: Array<{ name: string; run: () => Promise<FetchResult>; expect: string }> = [
    {
      name: "price_widget",
      expect: "stock_price_widget (keep-alive for spot)",
      run: () => client.get("/async/stock_price_widget", { ticker: "SPY" }),
    },
    {
      name: "open_interest",
      expect: "chart_data (expiry list + OI rows)",
      run: () => client.get(CHARTS.open_interest.path, { ticker: "SPY" }),
    },
    {
      name: "gamma_exposure",
      expect: "chart_exposure_data (walls, net exposure)",
      run: async () => {
        const expiry = extractExpiryIds(
          (await client.get(CHARTS.open_interest.path, { ticker: "SPY" })).body,
        )[0];
        return client.get(CHARTS.gamma_exposure.path, {
          ticker: "SPY",
          expiration_dates: expiry,
          option_type: "all",
          strike_range: "all",
          gamma_exposure_type: "open_interest",
        });
      },
    },
    {
      name: "chain_statistics",
      expect: "option_chain_statistics table",
      run: () => client.get("/async/option_chain_statistics", {
        ticker: "SPY",
        expiration_dates: "all",
        columns: "expiration,oi_total,iv,dte",
      }),
    },
  ];

  const results: Array<Record<string, unknown>> = [];
  for (const check of checks) {
    const started = Date.now();
    try {
      const result = await check.run();
      results.push({
        name: check.name,
        ok: result.status === 200 && !/Could not find options data/i.test(result.body),
        status: result.status,
        latency_ms: result.latency_ms || Date.now() - started,
        bytes: result.body.length,
        expect: check.expect,
      });
    } catch (error) {
      results.push({
        name: check.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        expect: check.expect,
      });
    }
  }
  const ok = results.some((result) => result.ok === true);
  return {
    ok,
    checked_at: new Date().toISOString(),
    base_url: client.base,
    requests: client.requests,
    endpoints: results,
    notes: [
      "the site has no JSON API: every endpoint is an htmx HTML fragment with the data inlined as `var x = {...}`",
      "options data is 15 minutes delayed; spot comes from Polygon.io in real time",
      "terms-of-service risk for bulk scraping/redistribution is the caller's to assess",
    ],
  };
}

function inlineVarNames(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*[\[{]/g)) names.add(match[1]);
  return [...names];
}

const RAW_PATHS: Record<string, string> = {
  open_interest: CHARTS.open_interest.path,
  volume: CHARTS.volume.path,
  volatility_skew: CHARTS.volatility_skew.path,
  greeks: CHARTS.greeks.path,
  max_pain: CHARTS.max_pain.path,
  expected_move: CHARTS.expected_move.path,
  probability_distribution: CHARTS.probability_distribution.path,
  gamma_exposure: CHARTS.gamma_exposure.path,
  delta_exposure: CHARTS.delta_exposure.path,
  option_chain: "/async/option_chain",
  option_chain_statistics: "/async/option_chain_statistics",
  ticker_info: "/async/options_ticker_info",
  stock_price_widget: "/async/stock_price_widget",
};

async function cmdRaw(
  ctx: Context,
  ticker: string,
): Promise<{ payload: Record<string, unknown>; csv?: CsvBlock }> {
  const name = ctx.options.endpoint;
  if (!name) {
    throw new UsageError(`raw needs --endpoint; known: ${Object.keys(RAW_PATHS).join(", ")}`);
  }
  const path = RAW_PATHS[name] ?? (name.startsWith("/") ? name : undefined);
  if (!path) {
    throw new UsageError(`unknown --endpoint ${name}; known: ${Object.keys(RAW_PATHS).join(", ")}`);
  }
  const params: Record<string, string | undefined> = { ticker };
  if (ctx.options.exps.length) {
    const { expiries } = await ctx.expiries.resolve(ticker, ctx.options.exps);
    params.expiration_dates = expiries.map((entry) => entry.exp_id).join(",");
  }
  if (ctx.options.rawParams) Object.assign(params, ctx.options.rawParams);
  const result = await ctx.client.get(path, params);
  const variables = inlineVarNames(result.body);
  const payload: Record<string, unknown> = {
    ticker,
    endpoint: name,
    url: result.url,
    params: result.params,
    status: result.status,
    latency_ms: result.latency_ms,
    from_cache: result.from_cache,
    bytes: result.body.length,
    inline_variables: variables,
    provenance: provenance(result, ctx.client, ticker, [
      "inline variable names are template implementation details and may change without notice — " +
        "a missing variable surfaces as a parse_error, never as silently empty data",
    ]),
  };
  if (ctx.options.rawHtml) {
    payload.html = result.body;
  } else {
    const wanted = ctx.options.rawVars?.length ? ctx.options.rawVars : variables;
    const json: Record<string, unknown> = {};
    for (const variable of wanted) {
      const value = tryExtractJson(result.body, variable);
      if (value === undefined) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      json[variable] = value;
    }
    if (!Object.keys(json).length) {
      payload.text_preview = stripTags(result.body).slice(0, 500);
      payload.hint = "no JSON locals found — pass --html to inspect the fragment";
    } else {
      payload.json = json;
    }
  }
  return { payload };
}

/* -------------------------------------------------------------------- runner */

export async function runCommand(
  name: CommandName,
  tickers: string[],
  ctx: Context,
): Promise<CommandResult> {
  if (name === "probe") {
    return { doc: await probe(ctx.client) };
  }
  const payloads: Array<Record<string, unknown>> = [];
  const csvRows: Array<Array<string | number | null>> = [];
  let csvHeaders: string[] | undefined;
  const failures: Array<{ ticker: string; code: string; message: string }> = [];

  for (const ticker of tickers) {
    try {
      let result: { payload: Record<string, unknown>; csv?: CsvBlock };
      switch (name) {
        case "spot":
          result = { payload: await cmdSpot(ctx, ticker) };
          break;
        case "info":
          result = { payload: await cmdInfo(ctx, ticker) };
          break;
        case "expiries":
          result = await cmdExpiries(ctx, ticker);
          break;
        case "gex":
          result = await cmdExposure(ctx, ticker, "gamma_exposure");
          break;
        case "dex":
          result = await cmdExposure(ctx, ticker, "delta_exposure");
          break;
        case "oi":
          result = await cmdSeries(ctx, ticker, "open_interest");
          break;
        case "volume":
          result = await cmdSeries(ctx, ticker, "volume");
          break;
        case "skew":
          result = await cmdSeries(ctx, ticker, "skew");
          break;
        case "greeks":
          result = await cmdGreeks(ctx, ticker);
          break;
        case "max-pain":
          result = await cmdMaxPain(ctx, ticker);
          break;
        case "em":
          result = await cmdExpectedMove(ctx, ticker);
          break;
        case "stats":
          result = await cmdStats(ctx, ticker);
          break;
        case "chain":
          result = await cmdChain(ctx, ticker);
          break;
        case "scan":
          result = await cmdScan(ctx, ticker);
          break;
        case "raw":
          result = await cmdRaw(ctx, ticker);
          break;
        default:
          throw new UsageError(`unknown command ${name}`);
      }
      payloads.push(result.payload);
      if (result.csv) {
        csvHeaders = result.csv.headers;
        csvRows.push(...result.csv.rows);
      }
    } catch (error) {
      const cliError = error instanceof CliError ? error : null;
      failures.push({
        ticker,
        code: cliError?.code ?? "runtime",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!payloads.length && failures.length) {
    const first = failures[0];
    const source = tickers.length === 1 ? null : { failures };
    throw new CliError(first.message, {
      code: (first.code as CliError["code"]) ?? "runtime",
      exitCode: exitCodeFor(first.code),
      details: source ?? undefined,
    });
  }

  const doc: Record<string, unknown> = {
    source: "optioncharts.io",
    generated_at: new Date().toISOString(),
    command: name,
    tickers: payloads,
  };
  if (failures.length) doc.failures = failures;
  const csv = csvHeaders ? { headers: csvHeaders, rows: csvRows } : undefined;
  return { doc, csv, exitCode: partialExitCode(failures) };
}

/** Stable exit code for one failure, reused for single- and multi-ticker runs. */
function exitCodeFor(code: string): number {
  switch (code) {
    case "exp_fallback":
      return EXIT.expFallback;
    case "rate_limited":
      return EXIT.rateLimited;
    case "unavailable":
      return EXIT.unavailable;
    case "usage":
      return EXIT.usage;
    default:
      return EXIT.error;
  }
}

/**
 * Partial failures still print their data, so the exit code is the worst failure
 * (an expiry fallback must not look like a clean run in a pipeline).
 */
function partialExitCode(failures: Array<{ code: string }>): number | undefined {
  const codes = failures.map((failure) => exitCodeFor(failure.code));
  if (!codes.length) return undefined;
  if (codes.includes(EXIT.expFallback)) return EXIT.expFallback;
  if (codes.includes(EXIT.rateLimited)) return EXIT.rateLimited;
  if (codes.includes(EXIT.unavailable)) return EXIT.unavailable;
  if (codes.includes(EXIT.usage)) return EXIT.usage;
  return EXIT.error;
}
