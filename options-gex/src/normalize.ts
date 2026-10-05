/**
 * Normalise both channels into one `Snapshot`.
 *
 * Everything downstream (selection, projection, formatting) only sees a
 * `Snapshot`, so a REST JSON reply and an MCP text reply stay interchangeable.
 */

import { CliError, DataUnavailableError } from "./errors.ts";
import type { HttpMeta, RestChain, RestExpiration, Snapshot } from "./types.ts";
import { GREEK_ORDER } from "./types.ts";
import { cleanNoise, numberRecord, strikesOf } from "./num.ts";
import { classifyMcpText, parseOptionsText, type ParsedMcpText } from "./mcp.ts";

export interface SnapshotContext {
  url: string;
  meta: HttpMeta;
  requestedExp?: string;
  requestedGreeks?: string;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fallbackWarning(requested: string | undefined, selected: string): string | undefined {
  if (!requested || requested === selected) return undefined;
  return (
    `requested exp ${requested} is not available (or was ignored); ` +
    `the server returned ${selected}`
  );
}

/** REST JSON → Snapshot. Throws when `ok` is not true. */
export function fromRest(chain: RestChain, context: SnapshotContext): Snapshot {
  const expiration: RestExpiration = chain.expiration ?? {};
  const spot = finite(expiration.spot);
  if (spot === undefined) {
    throw new CliError("REST response has no numeric `spot`", { details: { url: context.url } });
  }
  const selected_exp = chain.selected_exp ?? "";
  if (!selected_exp) {
    throw new CliError("REST response has no `selected_exp`", { details: { url: context.url } });
  }
  const ticker = chain.ticker ?? "";

  const warnings: string[] = [];
  const fallback = fallbackWarning(context.requestedExp, selected_exp);
  if (fallback) warnings.push(fallback);

  const oiSource = typeof expiration.oi_source === "string" ? expiration.oi_source : undefined;
  if (oiSource && oiSource !== "oi") {
    warnings.push(
      `oi_source is "${oiSource}" (not "oi"): per-strike OI and OI-derived levels may be volume-based`,
    );
  }
  if (expiration.gamma_flip === null) {
    warnings.push("gamma_flip is null for this expiry");
  }

  const gexByStrike = numberRecord(expiration.gex_by_strike);
  const cumCall = numberRecord(expiration.cum_call_gex_by_strike);
  const cumPut = numberRecord(expiration.cum_put_gex_by_strike);

  const netByStrike: Record<string, Record<string, number>> = {};
  const exposure = expiration.greeks_exposure;
  if (exposure && typeof exposure === "object") {
    for (const greek of GREEK_ORDER) {
      const block = exposure[greek];
      const net = block ? numberRecord(block.net) : undefined;
      if (!net) continue;
      const cleaned = cleanNoise(net);
      netByStrike[greek] = cleaned.record;
    }
  }

  const strikes =
    Array.isArray(expiration.strikes) && expiration.strikes.length
      ? [...expiration.strikes].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      : strikesOf(gexByStrike ?? expiryKeys(netByStrike));

  return {
    source: "rest",
    url: context.url,
    ticker,
    selected_exp,
    requested_exp: context.requestedExp,
    updated_at: chain.updated_at,
    market_session: typeof expiration.market_session === "string" ? expiration.market_session : undefined,
    oi_source: oiSource,
    spot,
    forward_price: finite(expiration.forward_price),
    implied_move_abs: finite(expiration.implied_move_abs),
    implied_move_pct: finite(expiration.implied_move_pct),
    stm_iv: finite(expiration.stm_iv),
    pc_oi_ratio: finite(expiration.pc_oi_ratio),
    total_call_oi: finite(expiration.total_call_oi),
    total_put_oi: finite(expiration.total_put_oi),
    total_call_vol: finite(expiration.total_call_vol),
    total_put_vol: finite(expiration.total_put_vol),
    call_wall: finite(expiration.call_wall),
    call_wall_oi: finite(expiration.call_wall_oi),
    put_wall: finite(expiration.put_wall),
    put_wall_oi: finite(expiration.put_wall_oi),
    max_pain: finite(expiration.max_pain),
    gamma_flip: expiration.gamma_flip === null ? null : finite(expiration.gamma_flip),
    min_iv_strike: finite(expiration.min_iv_strike),
    net_gex: finite(expiration.net_gex),
    bullish_score: finite(expiration.bullish_score),
    insights: Array.isArray(expiration.insights) ? expiration.insights : [],
    expiration_dates: Array.isArray(chain.expiration_dates) ? chain.expiration_dates : [],
    strikes,
    gex_by_strike: gexByStrike,
    cum_call_gex_by_strike: cumCall,
    cum_put_gex_by_strike: cumPut,
    net_by_strike: netByStrike,
    call_oi_by_strike: numberRecord(expiration.call_oi_by_strike),
    put_oi_by_strike: numberRecord(expiration.put_oi_by_strike),
    call_vol_by_strike: numberRecord(expiration.call_vol_by_strike),
    put_vol_by_strike: numberRecord(expiration.put_vol_by_strike),
    option_mid_by_strike: expiration.option_mid_by_strike
      ? {
          call: numberRecord(expiration.option_mid_by_strike.call),
          put: numberRecord(expiration.option_mid_by_strike.put),
        }
      : undefined,
    warnings,
    meta: context.meta,
  };
}

function expiryKeys(net: Record<string, Record<string, number>>): Record<string, number> | undefined {
  const first = Object.values(net)[0];
  if (!first) return undefined;
  const out: Record<string, number> = {};
  for (const key of Object.keys(first)) out[key] = 0;
  return out;
}

/** MCP text → Snapshot. */
export function fromMcp(parsed: ParsedMcpText, context: SnapshotContext): Snapshot {
  const warnings = [...parsed.warnings];
  warnings.push(
    "values come from the MCP text rendering and are rounded/scaled (e.g. net_gex); " +
      "use --source rest for exact figures",
  );
  const fallback = fallbackWarning(context.requestedExp, parsed.selected_exp);
  if (fallback) warnings.push(fallback);
  if (parsed.expiration_count !== undefined && parsed.expiration_dates.length < parsed.expiration_count) {
    warnings.push(
      `MCP lists only ${parsed.expiration_dates.length} of ${parsed.expiration_count} expirations; ` +
        "use --source rest for the full calendar",
    );
  }

  const netByStrike: Record<string, Record<string, number>> = {};
  const tables = parsed.greeks.length
    ? parsed.greeks
    : [{ greek: "gamma", values: {} }];
  for (const table of tables) {
    const cleaned = cleanNoise(table.values);
    netByStrike[table.greek] = cleaned.record;
  }

  const strikes = strikesOf(netByStrike.gamma ?? Object.values(netByStrike)[0]);
  const levels = parsed.levels;

  return {
    source: "mcp",
    url: context.url,
    ticker: parsed.ticker,
    selected_exp: parsed.selected_exp,
    requested_exp: context.requestedExp,
    updated_local: parsed.updated_local,
    spot: parsed.spot,
    implied_move_abs: levels.implied_move_abs,
    implied_move_pct: levels.implied_move_pct,
    stm_iv: levels.stm_iv,
    pc_oi_ratio: levels.pc_oi_ratio,
    total_call_oi: levels.total_call_oi,
    total_put_oi: levels.total_put_oi,
    total_call_vol: levels.total_call_vol,
    total_put_vol: levels.total_put_vol,
    call_wall: levels.call_wall,
    call_wall_oi: levels.call_wall_oi,
    put_wall: levels.put_wall,
    put_wall_oi: levels.put_wall_oi,
    max_pain: levels.max_pain,
    gamma_flip: levels.gamma_flip,
    min_iv_strike: levels.min_iv_strike,
    net_gex: levels.net_gex,
    bullish_score: levels.bullish_score,
    insights: parsed.insights,
    expiration_dates: parsed.expiration_dates,
    expiration_count: parsed.expiration_count,
    strikes,
    net_by_strike: netByStrike,
    warnings,
    meta: context.meta,
  };
}

/** Convenience: parse raw MCP text straight into a Snapshot. */
export function snapshotFromMcpText(text: string, context: SnapshotContext): Snapshot {
  return fromMcp(parseOptionsText(text), context);
}

/** Read a snapshot from an offline fixture body (JSON or MCP text). */
export function snapshotFromFileBody(
  body: string,
  context: SnapshotContext & { url?: string },
): Snapshot {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    // MCP JSON-RPC envelope saved to disk.
    if (parsed.result && typeof parsed.result === "object") {
      const result = parsed.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      const text = (result.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      const failure = classifyMcpText(text);
      if (failure) throw failure;
      return snapshotFromMcpText(text, context);
    }
    if (parsed.ok !== true) {
      const message =
        typeof parsed.error === "string" && parsed.error ? parsed.error : "options data unavailable";
      throw new DataUnavailableError(message, { url: context.url });
    }
    return fromRest(parsed as RestChain, context);
  }
  return snapshotFromMcpText(body, context);
}
