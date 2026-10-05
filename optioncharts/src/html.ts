/**
 * HTML fragment parsing.
 *
 * Two jobs:
 *  1. pull `var <name> = <JSON>;` locals out of a fragment with a
 *     string-aware brace/bracket matcher (a regex alone truncates on nested
 *     objects, and the same variable name can appear twice with different types
 *     — `chart_data` is a list *and* a dict in the same fragment);
 *  2. turn the upstream `<table>` markup into header + cell rows, keeping the
 *     first href of every cell (the expiry id `2026-10-09:w` is only in there)
 *     and detecting the paywall lock icon.
 */

import { ParseError } from "./errors.ts";
import type { Table, TableCell } from "./types.ts";

export interface ExtractOptions {
  /** Restrict to `{` objects or `[` arrays when the same name appears as both. */
  expect?: "dict" | "list";
}

/**
 * Find `var|let|const <varname> = <JSON>` and return the parsed value.
 *
 * The matcher walks the text character by character, tracking JSON string state
 * so braces inside string values (`"contract_display_name"`) cannot unbalance
 * the depth counter.
 */
export function extractJson(html: string, varname: string, options: ExtractOptions = {}): unknown {
  const pattern = new RegExp(`(?:var|let|const)\\s+${escapeRegExp(varname)}\\s*=\\s*`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const start = match.index + match[0].length;
    const open = html[start];
    if (open !== "{" && open !== "[") continue;
    if (options.expect === "dict" && open !== "{") continue;
    if (options.expect === "list" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < html.length; index += 1) {
      const char = html[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          const literal = html.slice(start, index + 1);
          try {
            return JSON.parse(literal);
          } catch (error) {
            throw new ParseError(`failed to parse ${varname}: ${(error as Error).message}`, {
              varname,
              snippet: literal.slice(0, 200),
            });
          }
        }
      }
    }
  }
  throw new ParseError(`inline variable ${varname} not found in the fragment`, { varname });
}

/** Like `extractJson`, but returns undefined instead of throwing. */
export function tryExtractJson(html: string, varname: string, options: ExtractOptions = {}): unknown {
  try {
    return extractJson(html, varname, options);
  } catch {
    return undefined;
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  plusmn: "±",
  middot: "·",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  deg: "°",
  times: "×",
  Prime: "″",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity] ?? whole;
  });
}

/** Strip scripts/styles/tags and collapse whitespace — used for label scraping. */
export function stripTags(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  return decodeEntities(withoutScripts.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse every `<table>` in a fragment, in document order. */
export function parseTables(html: string): Table[] {
  const tables: Table[] = [];
  const tablePattern = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  for (const match of html.matchAll(tablePattern)) {
    const attributes = match[1];
    const inner = match[2];
    const idMatch = /\bid="([^"]*)"/.exec(attributes);
    const table: Table = { headers: [], rows: [] };
    if (idMatch && idMatch[1]) table.id = idMatch[1];
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    for (const rowMatch of inner.matchAll(rowPattern)) {
      const cells: TableCell[] = [];
      let headerRow = false;
      const cellPattern = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
      for (const cellMatch of rowMatch[1].matchAll(cellPattern)) {
        const tag = cellMatch[1].toLowerCase();
        const content = cellMatch[3];
        if (tag === "th") headerRow = true;
        const hrefMatch = /\bhref="([^"]*)"/.exec(content);
        const cell: TableCell = {
          text: stripTags(content),
          locked: /bi-lock|performPaywallCheck/.test(content),
        };
        if (hrefMatch && hrefMatch[1]) cell.href = decodeEntities(hrefMatch[1]);
        cells.push(cell);
      }
      if (!cells.length) continue;
      if (headerRow && !table.headers.length) {
        table.headers = cells.map((cell) => cell.text);
        continue;
      }
      table.rows.push(cells);
    }
    tables.push(table);
  }
  return tables;
}

/** Find the first `<table>` (optionally by id match) — most endpoints render one. */
export function firstTable(html: string, idIncludes?: string): Table | undefined {
  const tables = parseTables(html);
  if (idIncludes) return tables.find((table) => table.id?.includes(idIncludes));
  return tables[0];
}

/** Read every `value="YYYY-MM-DD:w|m"` occurrence (expiry checkboxes). */
export function extractExpiryIds(html: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(/value="(\d{4}-\d{2}-\d{2}:[wm])"/g)) ids.add(match[1]);
  for (const match of html.matchAll(/expiration_dates=(\d{4}-\d{2}-\d{2}%3A[wm]|\d{4}-\d{2}-\d{2}:[wm])/g)) {
    ids.add(decodeURIComponent(match[1]));
  }
  return [...ids];
}

/** `Oct 09, 2026 (4 days) (w)` → `{dte: 4, kind: "weekly"}`. */
export function parseExpiryLabel(label: string): { dte?: number; kind?: "weekly" | "monthly" } {
  const out: { dte?: number; kind?: "weekly" | "monthly" } = {};
  const dteMatch = /\((\d+)\s*days?\)/.exec(label);
  if (dteMatch) out.dte = Number.parseInt(dteMatch[1], 10);
  const kindMatch = /\((w|m)\)\s*$/.exec(label.trim());
  if (kindMatch) out.kind = kindMatch[1] === "w" ? "weekly" : "monthly";
  return out;
}

/** `1,234` → 1234, `10.82%` → 10.82, `$77.10` → 77.1, `-`/lock/`n/a` → null. */
export function parseNumber(text: string | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[$,\s]/g, "").replace(/[%x]$/i, "");
  if (!cleaned || cleaned === "-" || cleaned === "—") return null;
  const match = /-?\d+(?:\.\d+)?/.exec(cleaned);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** `±0.55 (0.71%)` → `{abs: 0.55, pct: 0.71}`. */
export function parsePlusMinus(text: string | undefined): { abs: number | null; pct: number | null } {
  if (!text) return { abs: null, pct: null };
  const abs = parseNumber(text.replace(/^[±+]/, ""));
  const pctMatch = /\(([-\d.,]+)\s*%\)/.exec(text);
  const pct = pctMatch ? parseNumber(pctMatch[1]) : null;
  return { abs, pct };
}

/** `77.50 +0.52%` → `{value: 77.5, pct: 0.52}`. */
export function parseLevelWithPct(text: string | undefined): {
  value: number | null;
  pct: number | null;
} {
  if (!text) return { value: null, pct: null };
  const pctMatch = /([+-]?\d+(?:\.\d+)?)\s*%/.exec(text);
  return {
    value: parseNumber(text.replace(/[+-]\d+(?:\.\d+)?\s*%.*$/, "")),
    pct: pctMatch ? Number.parseFloat(pctMatch[1]) : null,
  };
}

/** `0.40 (0.52%)` → `{abs: 0.40, pct: 0.52}`. */
export function parseDiffDisplay(text: string | undefined): {
  abs: number | null;
  pct: number | null;
} {
  if (!text) return { abs: null, pct: null };
  const pctMatch = /\(\s*([+-]?\d+(?:\.\d+)?)\s*%/.exec(text);
  return {
    abs: parseNumber(text.replace(/\(.*$/, "")),
    pct: pctMatch ? Number.parseFloat(pctMatch[1]) : null,
  };
}
