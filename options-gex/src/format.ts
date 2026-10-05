/** Output formatting: `pretty` JSON (default), single-line `compact`, or `table`. */

import type { Command } from "./project.ts";

export type OutputFormat = "pretty" | "compact" | "table";

export function render(data: unknown, format: OutputFormat, command: Command): string {
  if (format === "compact") return JSON.stringify(data);
  if (format === "table") return renderTable(command, data);
  return JSON.stringify(data, null, 2);
}

type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "-";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  return String(value);
}

function scalarLines(obj: Obj, prefix = ""): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isPlainObject(value) || Array.isArray(value)) continue;
    lines.push(`${prefix}${key}: ${scalar(value)}`);
  }
  return lines;
}

function provenanceLine(data: Obj): string {
  const p = data.provenance as Obj | undefined;
  if (!p) return "";
  const parts = [String(p.ticker ?? "?"), `exp ${p.selected_exp ?? "?"}`, `source ${p.source ?? "?"}`];
  if (p.updated_at) parts.push(`updated ${p.updated_at}`);
  if (p.updated_local) parts.push(`updated ${p.updated_local}`);
  if (p.market_session) parts.push(`session ${p.market_session}`);
  if (p.from_cache) parts.push("cached");
  const warnings = Array.isArray(p.warnings) ? (p.warnings as string[]) : [];
  const lines = [parts.join("  ")];
  for (const warning of warnings) lines.push(`! ${warning}`);
  return lines.join("\n");
}

function columnTable(rows: Array<Array<string | number>>, headers: string[]): string {
  const width = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const formatRow = (row: Array<string | number>) =>
    row.map((cell, i) => String(cell).padStart(width[i])).join("  ");
  return [formatRow(headers), ...rows.map(formatRow)].join("\n");
}

function seriesBlock(label: string, rows: Array<{ strike: number; value_pretty: string }>): string[] {
  if (!rows.length) return [`${label}: (none)`];
  const table = columnTable(
    rows.map((row) => [row.strike, row.value_pretty]),
    ["strike", "value"],
  );
  return [`${label}:`, table];
}

function renderTable(command: Command, data: unknown): string {
  if (!isPlainObject(data)) return JSON.stringify(data, null, 2);
  const head = provenanceLine(data);
  const blocks: string[] = [];

  switch (command) {
    case "gex": {
      blocks.push(...scalarLines((data.levels as Obj) ?? {}));
      const selection = data.selection as Obj | undefined;
      if (selection) blocks.push(`selection: ${JSON.stringify(selection)}`);
      blocks.push(...seriesBlock("gex_by_strike", (data.gex_by_strike as Array<{ strike: number; value_pretty: string }>) ?? []));
      break;
    }
    case "skew": {
      blocks.push(...scalarLines((data.levels as Obj) ?? {}));
      const greeks = (data.greeks as Obj) ?? {};
      for (const [greek, table] of Object.entries(greeks)) {
        if (!isPlainObject(table)) {
          blocks.push(`${greek}: (unavailable)`);
          continue;
        }
        blocks.push(...seriesBlock(greek, (table.rows as Array<{ strike: number; value_pretty: string }>) ?? []));
      }
      break;
    }
    case "raw": {
      blocks.push(...scalarLines((data.levels as Obj) ?? {}));
      blocks.push(...seriesBlock("gex_by_strike", (data.gex_by_strike as Array<{ strike: number; value_pretty: string }>) ?? []));
      const greeks = (data.greeks_exposure as Obj) ?? {};
      for (const [greek, table] of Object.entries(greeks)) {
        if (isPlainObject(table)) {
          blocks.push(...seriesBlock(greek, (table.rows as Array<{ strike: number; value_pretty: string }>) ?? []));
        }
      }
      break;
    }
    case "expiries": {
      const rows = (data.expirations as Array<{ exp: string; weekday?: string; dte?: number }>) ?? [];
      blocks.push(`count: ${data.count}  total_available: ${data.total_available}`);
      blocks.push(
        columnTable(
          rows.map((row) => [row.exp, row.weekday ?? "-", row.dte ?? "-"]),
          ["exp", "day", "dte"],
        ),
      );
      break;
    }
    case "levels":
    case "walls":
    case "max-pain":
    case "flip":
    case "probe": {
      blocks.push(...scalarLines(data));
      for (const [key, value] of Object.entries(data)) {
        if (key === "provenance" || key === "insights") continue;
        if (isPlainObject(value)) blocks.push(`${key}: ${JSON.stringify(value)}`);
      }
      const insights = data.insights as Array<{ type?: string; title?: string; text?: string }> | undefined;
      if (Array.isArray(insights)) {
        for (const insight of insights) {
          blocks.push(`[${insight.type ?? "?"}] ${insight.title ?? ""}: ${insight.text ?? ""}`);
        }
      }
      break;
    }
    default:
      return JSON.stringify(data, null, 2);
  }

  const body = blocks.filter(Boolean).join("\n");
  return head ? `${head}\n${body}` : body;
}
