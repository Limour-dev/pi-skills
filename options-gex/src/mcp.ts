/**
 * MCP fallback channel: `POST https://mcp.sellthenews.org/mcp`, tool
 * `get_options_data`.
 *
 * The reply is a Streamable-HTTP SSE envelope whose payload is **plain text**.
 * Errors are inconsistent: parameter validation sets `isError:true`, while an
 * invalid expiry format or an unknown ticker return ordinary-looking text with
 * `isError` undefined. The parser therefore classifies on both.
 */

import { CliError, DataUnavailableError, UsageError } from "./errors.ts";
import { httpGet, type RequestOptions } from "./http.ts";
import type { Insight, HttpMeta } from "./types.ts";
import { parseScaled, strikeKey } from "./num.ts";

export const DEFAULT_MCP_URL = "https://mcp.sellthenews.org/mcp";

export function mcpUrl(): string {
  return process.env.OPTIONS_GEX_MCP_URL || DEFAULT_MCP_URL;
}

export interface McpCallOptions extends RequestOptions {
  ticker: string;
  expiration?: string;
  greeks?: string;
  maxStrikes?: number;
}

export interface McpResult {
  text: string;
  isError: boolean;
  url: string;
  meta: HttpMeta;
}

interface Envelope {
  text: string;
  isError: boolean;
}

function parseEnvelope(body: string): Envelope {
  const payloads: unknown[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      payloads.push(JSON.parse(trimmed));
    } catch {
      /* fall through to SSE parsing */
    }
  }
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      /* ignore keep-alive fragments */
    }
  }

  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    const envelope = payload as {
      error?: { code?: number; message?: string };
      result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    };
    if (envelope.error) {
      const code = envelope.error.code ?? "?";
      throw new CliError(`MCP JSON-RPC error ${code}: ${envelope.error.message ?? "unknown error"}`, {
        details: { code: envelope.error.code },
      });
    }
    const content = envelope.result?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    return { text, isError: envelope.result?.isError === true };
  }

  throw new CliError("could not decode an MCP response envelope", {
    details: { body: body.slice(0, 300) },
  });
}

/** Turn the upstream's text-only failures into the right exit code. */
export function classifyMcpText(text: string): CliError | null {
  const head = text.trim();
  if (!head) return new CliError("empty MCP response");
  if (/^MCP error -32602/i.test(head)) {
    return new UsageError(firstLine(head), { mcp: true });
  }
  if (/^Invalid expiration date format/i.test(head)) {
    return new UsageError(head.split("\n")[0]);
  }
  if (/^No options data available for/i.test(head)) {
    return new DataUnavailableError(head.split("\n")[0]);
  }
  if (!/^=== Options Data:/.test(head)) {
    return new CliError(`unexpected MCP response: ${firstLine(head)}`);
  }
  return null;
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim();
}

export async function callOptionsData(options: McpCallOptions): Promise<McpResult> {
  const url = mcpUrl();
  const args: Record<string, unknown> = { ticker: options.ticker };
  if (options.expiration) args.expiration = options.expiration;
  if (options.greeks) args.greeks = options.greeks;
  if (options.maxStrikes !== undefined) args.maxStrikes = options.maxStrikes;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_options_data", arguments: args },
  });

  const response = await httpGet(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    noCache: true,
  });

  if (response.status === 405) {
    throw new CliError("MCP endpoint rejected POST (HTTP 405)", { details: { url } });
  }
  if (!response.status.toString().startsWith("2") && response.status >= 400) {
    throw new CliError(`MCP endpoint returned HTTP ${response.status}`, {
      details: { url, status: response.status, body: response.body.slice(0, 300) },
    });
  }

  const envelope = parseEnvelope(response.body);
  if (envelope.isError) {
    const classified = classifyMcpText(envelope.text) ?? new CliError(firstLine(envelope.text));
    throw classified;
  }
  const classified = classifyMcpText(envelope.text);
  if (classified) throw classified;

  return { text: envelope.text, isError: false, url, meta: response };
}

export interface ParsedGreekTable {
  greek: string;
  nearest?: number;
  values: Record<string, number>;
}

export interface ParsedMcpLevels {
  gamma_flip?: number | null;
  call_wall?: number;
  call_wall_oi?: number;
  put_wall?: number;
  put_wall_oi?: number;
  max_pain?: number;
  min_iv_strike?: number;
  net_gex?: number;
  bullish_score?: number;
  implied_move_abs?: number;
  implied_move_pct?: number;
  stm_iv?: number;
  pc_oi_ratio?: number;
  total_call_oi?: number;
  total_put_oi?: number;
  total_call_vol?: number;
  total_put_vol?: number;
}

export interface ParsedMcpText {
  ticker: string;
  spot: number;
  selected_exp: string;
  updated_local?: string;
  expiration_dates: string[];
  expiration_count?: number;
  levels: ParsedMcpLevels;
  insights: Insight[];
  greeks: ParsedGreekTable[];
  warnings: string[];
}

const INSIGHT_RE = /^\s*\[([A-Z ]+)\]\s*(.*)$/;
const GREEK_HEADER_RE = /^--- ([A-Z]+) Net Exposure by Strike(?: \(nearest (\d+) to spot\))? ---$/;
const STRIKE_RE = /^\s*\$([0-9.]+):\s*(-?[0-9.,]+[KMB]?)\s*$/;

function num(text: string): number {
  return Number.parseFloat(text.replace(/,/g, ""));
}

/** Parse the `=== Options Data: … ===` text body opened by `get_options_data`. */
export function parseOptionsText(text: string): ParsedMcpText {
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];
  const levels: ParsedMcpLevels = {};
  const insights: Insight[] = [];
  const greeks: ParsedGreekTable[] = [];
  const expiration_dates: string[] = [];
  let expiration_count: number | undefined;
  let ticker = "";
  let spot = Number.NaN;
  let selected_exp = "";
  let updated_local: string | undefined;
  let section: "none" | "levels" | "insights" | "greek" = "none";
  let current: ParsedGreekTable | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;

    const header = /^===\s*Options Data:\s*(\S+)\s*===$/.exec(line);
    if (header) {
      ticker = header[1];
      continue;
    }
    if (line.startsWith("Spot Price:")) {
      spot = Number.parseFloat(line.slice("Spot Price:".length).replace(/[$,]/g, ""));
      continue;
    }
    if (line.startsWith("Selected Expiration:")) {
      selected_exp = line.slice("Selected Expiration:".length).trim();
      continue;
    }
    if (line.startsWith("Updated:")) {
      updated_local = line.slice("Updated:".length).trim();
      continue;
    }
    if (line.startsWith("Available Expirations:")) {
      const rest = line.slice("Available Expirations:".length).trim();
      const more = /\(\+(\d+)\s+more/.exec(rest);
      if (more) expiration_count = Number.parseInt(more[1], 10) + rest.split(",").length;
      const listed = rest.replace(/\s*\(.*\)\s*$/, "");
      for (const part of listed.split(",")) {
        const value = part.trim();
        if (value) expiration_dates.push(value);
      }
      continue;
    }
    if (line === "--- Key Levels ---") {
      section = "levels";
      current = undefined;
      continue;
    }
    if (line === "--- Insights ---") {
      section = "insights";
      current = undefined;
      continue;
    }
    const greekHeader = GREEK_HEADER_RE.exec(line);
    if (greekHeader) {
      section = "greek";
      current = {
        greek: greekHeader[1].toLowerCase(),
        nearest: greekHeader[2] ? Number.parseInt(greekHeader[2], 10) : undefined,
        values: {},
      };
      greeks.push(current);
      continue;
    }

    if (section === "levels") {
      const kv = /^\s*([A-Za-z /-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].trim();
      const value = kv[2].trim();
      switch (key) {
        case "Gamma Flip":
          if (/^N\/A$/i.test(value)) {
            levels.gamma_flip = null;
            warnings.push("gamma_flip is N/A in the MCP text (no flip level)");
          } else {
            levels.gamma_flip = num(value.replace("$", ""));
          }
          break;
        case "Call Wall": {
          const m = /\$?([\d.,]+)\s*\(OI\s*([\d,]+)\)/.exec(value);
          if (m) {
            levels.call_wall = num(m[1]);
            levels.call_wall_oi = num(m[2]);
          }
          break;
        }
        case "Put Wall": {
          const m = /\$?([\d.,]+)\s*\(OI\s*([\d,]+)\)/.exec(value);
          if (m) {
            levels.put_wall = num(m[1]);
            levels.put_wall_oi = num(m[2]);
          }
          break;
        }
        case "Max Pain":
          levels.max_pain = num(value.replace("$", ""));
          break;
        case "Min IV Strike":
          levels.min_iv_strike = num(value.replace("$", ""));
          break;
        case "Net GEX":
          levels.net_gex = parseScaled(value.replace("$", ""));
          break;
        case "Bullish Score":
          levels.bullish_score = Number.parseInt(value, 10);
          break;
        case "Implied Move": {
          const m = /±?\$?([\d.,]+)\s*\(([\d.,]+)%\)/.exec(value);
          if (m) {
            levels.implied_move_abs = num(m[1]);
            levels.implied_move_pct = num(m[2]);
          }
          break;
        }
        case "Short-Term IV":
          levels.stm_iv = Number.parseFloat(value.replace("%", ""));
          break;
        case "P/C OI Ratio":
          levels.pc_oi_ratio = Number.parseFloat(value);
          break;
        case "Total OI": {
          const m = /Call\s*([\d,]+)\s*\/\s*Put\s*([\d,]+)/.exec(value);
          if (m) {
            levels.total_call_oi = num(m[1]);
            levels.total_put_oi = num(m[2]);
          }
          break;
        }
        case "Total Vol": {
          const m = /Call\s*([\d,]+)\s*\/\s*Put\s*([\d,]+)/.exec(value);
          if (m) {
            levels.total_call_vol = num(m[1]);
            levels.total_put_vol = num(m[2]);
          }
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (section === "insights") {
      const m = INSIGHT_RE.exec(line);
      if (!m) continue;
      const body = m[2];
      const colon = body.indexOf(": ");
      const title = colon >= 0 ? body.slice(0, colon).trim() : body.trim();
      const textPart = colon >= 0 ? body.slice(colon + 2).trim() : "";
      insights.push({ type: m[1].trim(), title, text: textPart });
      continue;
    }

    if (section === "greek" && current) {
      const m = STRIKE_RE.exec(line);
      if (!m) continue;
      const strike = Number.parseFloat(m[1]);
      const value = parseScaled(m[2]);
      if (!Number.isFinite(strike) || !Number.isFinite(value)) continue;
      current.values[strikeKey(strike)] = value;
    }
  }

  if (!ticker) throw new CliError("MCP text is missing the `=== Options Data: … ===` header");
  if (!selected_exp) throw new CliError("MCP text is missing `Selected Expiration`");
  if (!Number.isFinite(spot)) throw new CliError("MCP text is missing `Spot Price`");

  return {
    ticker,
    spot,
    selected_exp,
    updated_local,
    expiration_dates,
    expiration_count,
    levels,
    insights,
    greeks,
    warnings,
  };
}
