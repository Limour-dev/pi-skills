/**
 * Output formatting: `pretty` JSON (default), single-line `compact`, or `csv`.
 *
 * CSV exists because most of these payloads are per-strike / per-expiry tables
 * an agent (or a spreadsheet) can consume without a JSON parser; `json` stays
 * the default so units and provenance never get lost in a flat table.
 */

import type { CsvBlock } from "./commands.ts";

export type OutputFormat = "pretty" | "compact" | "csv";

export function render(doc: unknown, format: OutputFormat, csv?: CsvBlock): string {
  if (format === "csv") {
    if (!csv) return JSON.stringify(doc);
    return renderCsv(csv);
  }
  if (format === "compact") return JSON.stringify(doc);
  return JSON.stringify(doc, null, 2);
}

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? String(value) : value;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function renderCsv(csv: CsvBlock): string {
  const lines = [csv.headers.map(csvField).join(",")];
  for (const row of csv.rows) lines.push(row.map(csvField).join(","));
  return lines.join("\n");
}
