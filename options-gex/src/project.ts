/**
 * Projection: turn a full `Snapshot` into the small, token-bounded JSON the
 * commands print. A REST payload is 35 KB (gamma) to 80 KB (all greeks); the
 * agent should never see more than a few KB of it.
 */

import type { Insight, Provenance, SeriesUnits, Snapshot } from "./types.ts";
import { formatUsd, pctChange, round } from "./num.ts";

export const DEFAULT_TOP = 40;

export interface SelectOptions {
  top?: number;
  topBy?: "abs" | "nearest";
  strikeRangePct?: number;
}

export interface Selection {
  mode: "top_abs" | "top_nearest" | "strike_range";
  requested: number;
  returned: number;
  available: number;
  strike_range_pct?: number;
  note?: string;
}

export interface Series {
  units: SeriesUnits;
  label: string;
  data: Record<string, number>;
}

export function provenance(snapshot: Snapshot, extraWarnings: string[] = []): Provenance {
  const out: Provenance = {
    source: snapshot.source,
    url: snapshot.url,
    ticker: snapshot.ticker,
    selected_exp: snapshot.selected_exp,
    warnings: [...snapshot.warnings, ...extraWarnings],
  };
  if (snapshot.requested_exp) out.requested_exp = snapshot.requested_exp;
  if (snapshot.updated_at) out.updated_at = snapshot.updated_at;
  if (snapshot.updated_local) out.updated_local = snapshot.updated_local;
  if (snapshot.market_session) out.market_session = snapshot.market_session;
  if (snapshot.oi_source) out.oi_source = snapshot.oi_source;
  out.http_status = snapshot.meta.status;
  out.latency_ms = snapshot.meta.latency_ms;
  if (snapshot.meta.from_cache !== undefined) out.from_cache = snapshot.meta.from_cache;
  return out;
}

export function levelBlock(snapshot: Snapshot): Record<string, unknown> {
  const levels: Record<string, unknown> = {
    spot: snapshot.spot,
    net_gex: snapshot.net_gex,
    net_gex_usd: snapshot.net_gex === undefined ? undefined : formatUsd(snapshot.net_gex),
    gamma_flip: snapshot.gamma_flip ?? null,
    spot_vs_flip: spotVersusFlip(snapshot)?.spot_side ?? null,
    call_wall: snapshot.call_wall,
    call_wall_oi: snapshot.call_wall_oi,
    put_wall: snapshot.put_wall,
    put_wall_oi: snapshot.put_wall_oi,
    max_pain: snapshot.max_pain,
    min_iv_strike: snapshot.min_iv_strike,
    bullish_score: snapshot.bullish_score,
    implied_move_abs: snapshot.implied_move_abs,
    implied_move_pct: snapshot.implied_move_pct,
    stm_iv: snapshot.stm_iv,
    pc_oi_ratio: snapshot.pc_oi_ratio,
    total_call_oi: snapshot.total_call_oi,
    total_put_oi: snapshot.total_put_oi,
    total_call_vol: snapshot.total_call_vol,
    total_put_vol: snapshot.total_put_vol,
    forward_price: snapshot.forward_price,
  };
  return defined(levels);
}

function defined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface Distance {
  spot_side: "above" | "below";
  abs: number;
  pct: number;
}

export function spotVersusFlip(snapshot: Snapshot): Distance | undefined {
  const flip = snapshot.gamma_flip;
  if (flip === undefined || flip === null) return undefined;
  return {
    spot_side: snapshot.spot >= flip ? "above" : "below",
    abs: round(Math.abs(snapshot.spot - flip), 2),
    pct: pctChange(snapshot.spot, flip) ?? 0,
  };
}

export function distanceTo(snapshot: Snapshot, level: number | undefined): Distance | undefined {
  if (level === undefined) return undefined;
  return {
    spot_side: snapshot.spot >= level ? "above" : "below",
    abs: round(Math.abs(snapshot.spot - level), 2),
    pct: pctChange(snapshot.spot, level) ?? 0,
  };
}

/** The dollar GEX series when available, otherwise the gamma exposure table. */
export function gexSeries(snapshot: Snapshot): Series | undefined {
  if (snapshot.gex_by_strike) {
    return {
      units: "usd_gex",
      label: "net GEX by strike in USD; the sum over all strikes equals net_gex",
      data: snapshot.gex_by_strike,
    };
  }
  const gamma = snapshot.net_by_strike.gamma;
  if (gamma) {
    return {
      units: "exposure_units",
      label:
        "gamma net exposure by strike in the upstream's exposure units — NOT dollar GEX " +
        "(the MCP text does not expose gex_by_strike)",
      data: gamma,
    };
  }
  return undefined;
}

export function selectStrikes(
  snapshot: Snapshot,
  data: Record<string, number>,
  options: SelectOptions = {},
): { strikes: number[]; selection: Selection } {
  const available = Object.keys(data)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (options.strikeRangePct !== undefined) {
    const pct = options.strikeRangePct;
    const strikes = available.filter((strike) => Math.abs(strike - snapshot.spot) <= (snapshot.spot * pct) / 100);
    return {
      strikes,
      selection: {
        mode: "strike_range",
        requested: pct,
        returned: strikes.length,
        available: available.length,
        strike_range_pct: pct,
      },
    };
  }

  const top = options.top ?? DEFAULT_TOP;
  const topBy = options.topBy ?? "abs";
  const scored = available.map((strike) => ({
    strike,
    score: topBy === "nearest" ? Math.abs(strike - snapshot.spot) : Math.abs(data[String(strike)] ?? 0),
  }));
  scored.sort((a, b) =>
    topBy === "nearest" ? a.score - b.score || a.strike - b.strike : b.score - a.score || a.strike - b.strike,
  );
  const picked = scored.slice(0, top).map((entry) => entry.strike);
  picked.sort((a, b) => a - b);
  return {
    strikes: picked,
    selection: {
      mode: topBy === "nearest" ? "top_nearest" : "top_abs",
      requested: top,
      returned: picked.length,
      available: available.length,
      note:
        top >= available.length
          ? "all available strikes returned"
          : topBy === "nearest"
            ? "nearest to spot"
            : "largest |exposure|",
    },
  };
}

export function seriesRows(
  strikes: number[],
  data: Record<string, number>,
): Array<{ strike: number; value: number; value_pretty: string }> {
  return strikes.map((strike) => {
    const value = data[String(strike)] ?? 0;
    return { strike, value: round(value, 4), value_pretty: formatUsd(value) };
  });
}

/**
 * Estimate the zero-gamma level from the cumulative GEX curves.
 *
 * The upstream's own `gamma_flip` is computed on a finer grid than the strikes
 * it publishes, so the two can differ; this is a cross-check, not a replacement.
 */
export function zeroGammaEstimate(snapshot: Snapshot): number | undefined {
  const points = cumulativePoints(snapshot);
  if (points.length < 2) return undefined;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev.cum === 0) return prev.strike;
    if (Math.sign(prev.cum) !== Math.sign(curr.cum)) {
      const span = curr.cum - prev.cum;
      if (span === 0) return curr.strike;
      const t = -prev.cum / span;
      return round(prev.strike + t * (curr.strike - prev.strike), 2);
    }
  }
  return undefined;
}

function cumulativePoints(snapshot: Snapshot): Array<{ strike: number; cum: number }> {
  const call = snapshot.cum_call_gex_by_strike;
  const put = snapshot.cum_put_gex_by_strike;
  if (call && put) {
    return Object.keys(call)
      .map(Number)
      .filter((n) => Number.isFinite(n) && put[String(n)] !== undefined)
      .sort((a, b) => a - b)
      .map((strike) => ({ strike, cum: (call[String(strike)] ?? 0) + (put[String(strike)] ?? 0) }));
  }
  if (snapshot.gex_by_strike) {
    let cum = 0;
    return Object.keys(snapshot.gex_by_strike)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
      .map((strike) => {
        cum += snapshot.gex_by_strike?.[String(strike)] ?? 0;
        return { strike, cum };
      });
  }
  return [];
}

export type Command =
  | "gex"
  | "levels"
  | "walls"
  | "max-pain"
  | "flip"
  | "skew"
  | "expiries"
  | "raw"
  | "probe";

export interface ProjectOptions extends SelectOptions {
  greeks?: string[];
  include?: string[];
  today?: string;
  dte?: number;
}

export function projectLevels(snapshot: Snapshot, extraWarnings: string[] = []): Record<string, unknown> {
  return {
    provenance: provenance(snapshot, extraWarnings),
    levels: levelBlock(snapshot),
    insights: snapshot.insights.map(insightLine),
  };
}

function insightLine(insight: Insight): Record<string, unknown> {
  return defined({ type: insight.type, title: insight.title, text: insight.text });
}

export function projectGex(
  snapshot: Snapshot,
  options: ProjectOptions = {},
  extraWarnings: string[] = [],
): Record<string, unknown> {
  const series = gexSeries(snapshot);
  const out: Record<string, unknown> = {
    provenance: provenance(snapshot, extraWarnings),
    units: series?.units ?? null,
    series_label: series?.label ?? "no per-strike exposure series available",
    levels: levelBlock(snapshot),
  };
  if (series) {
    const { strikes, selection } = selectStrikes(snapshot, series.data, options);
    out.selection = selection;
    out.gex_by_strike = seriesRows(strikes, series.data);
  } else {
    out.gex_by_strike = [];
  }
  const estimate = zeroGammaEstimate(snapshot);
  if (estimate !== undefined) {
    const flip = snapshot.gamma_flip;
    out.zero_gamma_estimate = estimate;
    if (typeof flip === "number") {
      out.zero_gamma_estimate_delta = round(estimate - flip, 2);
    }
  }
  out.insights = snapshot.insights.map(insightLine);
  return out;
}

export function projectWalls(snapshot: Snapshot, extraWarnings: string[] = []): Record<string, unknown> {
  return {
    provenance: provenance(snapshot, extraWarnings),
    spot: snapshot.spot,
    call_wall: snapshot.call_wall,
    call_wall_oi: snapshot.call_wall_oi,
    call_wall_distance: distanceTo(snapshot, snapshot.call_wall),
    put_wall: snapshot.put_wall,
    put_wall_oi: snapshot.put_wall_oi,
    put_wall_distance: distanceTo(snapshot, snapshot.put_wall),
    net_gex: snapshot.net_gex,
  };
}

export function projectMaxPain(snapshot: Snapshot, extraWarnings: string[] = []): Record<string, unknown> {
  return {
    provenance: provenance(snapshot, extraWarnings),
    spot: snapshot.spot,
    max_pain: snapshot.max_pain,
    max_pain_distance: distanceTo(snapshot, snapshot.max_pain),
    net_gex: snapshot.net_gex,
    pc_oi_ratio: snapshot.pc_oi_ratio,
  };
}

export function projectFlip(snapshot: Snapshot, extraWarnings: string[] = []): Record<string, unknown> {
  const versus = spotVersusFlip(snapshot);
  const estimate = zeroGammaEstimate(snapshot);
  const out: Record<string, unknown> = {
    provenance: provenance(snapshot, extraWarnings),
    spot: snapshot.spot,
    gamma_flip: snapshot.gamma_flip ?? null,
    spot_vs_flip: versus?.spot_side ?? null,
    distance_abs: versus?.abs,
    distance_pct: versus?.pct,
    net_gex: snapshot.net_gex,
    regime:
      snapshot.net_gex === undefined
        ? undefined
        : snapshot.net_gex >= 0
          ? "positive net GEX — dealers long gamma (mean-reverting, vol-suppressing)"
          : "negative net GEX — dealers short gamma (trend-amplifying, vol-expanding)",
  };
  if (estimate !== undefined) {
    out.zero_gamma_estimate = estimate;
    out.zero_gamma_method =
      "first zero crossing of cum_call_gex_by_strike + cum_put_gex_by_strike, linearly interpolated";
    if (typeof snapshot.gamma_flip === "number") {
      out.zero_gamma_estimate_delta = round(estimate - snapshot.gamma_flip, 2);
      out.zero_gamma_note =
        "the upstream gamma_flip uses a finer strike grid than the published strikes, so a small delta is expected";
    }
  } else if (snapshot.source === "mcp") {
    out.zero_gamma_note = "the MCP text does not expose cumulative GEX, so no independent estimate is possible";
  }
  return defined(out);
}

export function projectSkew(
  snapshot: Snapshot,
  options: ProjectOptions = {},
  extraWarnings: string[] = [],
): Record<string, unknown> {
  const requested = options.greeks?.length ? options.greeks : ["vanna", "charm"];
  const tables: Record<string, unknown> = {};
  for (const greek of requested) {
    const data = snapshot.net_by_strike[greek];
    if (!data) {
      tables[greek] = null;
      continue;
    }
    const { strikes, selection } = selectStrikes(snapshot, data, options);
    tables[greek] = { selection, rows: seriesRows(strikes, data) };
  }
  return {
    provenance: provenance(snapshot, extraWarnings),
    units: "exposure_units",
    levels: defined({
      spot: snapshot.spot,
      stm_iv: snapshot.stm_iv,
      pc_oi_ratio: snapshot.pc_oi_ratio,
      net_gex: snapshot.net_gex,
    }),
    greeks: tables,
  };
}

export function projectExpiries(
  snapshot: Snapshot,
  options: ProjectOptions = {},
  extraWarnings: string[] = [],
): Record<string, unknown> {
  const today = options.today;
  const entries = snapshot.expiration_dates.map((exp) => {
    const entry: Record<string, unknown> = { exp };
    if (today) {
      const dte = days(today, exp);
      if (dte !== undefined) entry.dte = dte;
    }
    entry.weekday = weekdayOf(exp);
    return entry;
  });
  const filtered =
    options.dte === undefined
      ? entries
      : entries.filter((entry) => typeof entry.dte === "number" && entry.dte >= 0 && entry.dte <= options.dte!);
  const out: Record<string, unknown> = {
    provenance: provenance(snapshot, extraWarnings),
    spot: snapshot.spot,
    count: filtered.length,
    expirations: filtered,
  };
  if (snapshot.expiration_count !== undefined) {
    out.truncated = snapshot.expiration_count > snapshot.expiration_dates.length;
    out.total_available = snapshot.expiration_count;
  } else {
    out.total_available = snapshot.expiration_dates.length;
  }
  return out;
}

function days(from: string, to: string): number | undefined {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return Math.round((b - a) / 86_400_000);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayOf(date: string): string | undefined {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return undefined;
  return WEEKDAYS[new Date(parsed).getUTCDay()];
}

export function projectRaw(
  snapshot: Snapshot,
  options: ProjectOptions = {},
  extraWarnings: string[] = [],
): Record<string, unknown> {
  const series = gexSeries(snapshot);
  const primaryData = series?.data ?? snapshot.net_by_strike.gamma ?? {};
  const primary = selectStrikes(snapshot, primaryData, options);
  const out: Record<string, unknown> = {
    provenance: provenance(snapshot, extraWarnings),
    levels: levelBlock(snapshot),
    expiration_dates: snapshot.expiration_dates,
    insights: snapshot.insights.map(insightLine),
    greeks_available: Object.keys(snapshot.net_by_strike).sort(),
  };

  if (series) {
    out.units = series.units;
    out.selection = primary.selection;
    out.gex_by_strike = seriesRows(primary.strikes, series.data);
    if (snapshot.cum_call_gex_by_strike && snapshot.cum_put_gex_by_strike) {
      out.cum_gex = primary.strikes.map((strike) => ({
        strike,
        cum_call: round(snapshot.cum_call_gex_by_strike?.[String(strike)] ?? 0, 2),
        cum_put: round(snapshot.cum_put_gex_by_strike?.[String(strike)] ?? 0, 2),
      }));
    }
  }

  const greeks = options.greeks && options.greeks.length ? options.greeks : Object.keys(snapshot.net_by_strike);
  const greekTables: Record<string, unknown> = {};
  for (const greek of greeks) {
    const data = snapshot.net_by_strike[greek];
    if (!data) continue;
    const { strikes, selection } = selectStrikes(snapshot, data, options);
    greekTables[greek] = { selection, rows: seriesRows(strikes, data) };
  }
  if (Object.keys(greekTables).length) out.greeks_exposure = greekTables;

  const include = options.include ?? [];
  if (include.includes("oi")) {
    out.open_interest_by_strike = byStrike(
      snapshot.call_oi_by_strike,
      snapshot.put_oi_by_strike,
      "call",
      "put",
      primary.strikes,
    );
  }
  if (include.includes("vol")) {
    out.volume_by_strike = byStrike(
      snapshot.call_vol_by_strike,
      snapshot.put_vol_by_strike,
      "call",
      "put",
      primary.strikes,
    );
  }
  if (include.includes("mid") && snapshot.option_mid_by_strike) {
    out.option_mid_by_strike = byStrike(
      snapshot.option_mid_by_strike.call,
      snapshot.option_mid_by_strike.put,
      "call",
      "put",
      primary.strikes,
    );
  }
  return out;
}

function byStrike(
  call: Record<string, number> | undefined,
  put: Record<string, number> | undefined,
  callKey: string,
  putKey: string,
  strikes?: number[],
): Array<Record<string, unknown>> {
  const keys =
    strikes ??
    [...new Set([...Object.keys(call ?? {}), ...Object.keys(put ?? {})])]
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  return keys
    .map((strike) => ({
      strike,
      [callKey]: call?.[String(strike)] ?? 0,
      [putKey]: put?.[String(strike)] ?? 0,
    }));
}

