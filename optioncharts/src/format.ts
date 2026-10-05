/**
 * Output formatting: `pretty` JSON (default), single-line `compact`, or `csv`.
 *
 * CSV exists because most of these payloads are per-strike / per-expiry tables
 * an agent (or a spreadsheet) can consume without a JSON parser; `json` stays
 * the default so units and provenance never get lost in a flat table.
 */

import type { CsvBlock } from "./commands.ts";

export type OutputFormat = "pretty" | "compact" | "csv";

export function render(doc: unknown, format: OutputFormat, csv?: CsvBlock, units = false): string {
  if (format === "csv") {
    if (!csv) return JSON.stringify(doc);
    return renderCsv(units ? withUnits(csv) : csv);
  }
  if (format === "compact") return JSON.stringify(doc);
  return JSON.stringify(doc, null, 2);
}

/**
 * Column-name → unit hints for `--format csv --units`. A raw CSV is easy to
 * misread (column 14 of `scan --gex` is `net_exposure`, which is USD per 1% move,
 * not a dollar notional), so `--units` renders each header as `column[unit]`
 * instead of forcing the caller to keep a mental map.
 */
const COLUMN_UNITS: Record<string, string> = {
  volume_total: "contracts",
  volume_calls: "contracts",
  volume_puts: "contracts",
  oi_total: "contracts",
  oi_calls: "contracts",
  oi_puts: "contracts",
  contracts_total: "contracts",
  open_interest: "contracts",
  volume: "contracts",
  oi: "contracts",
  iv: "pct",
  iv_pct: "pct",
  implied_volatility: "decimal",
  volume_pcr: "ratio",
  oi_pcr: "ratio",
  expected_move_abs: "abs_price",
  expected_move_pct: "pct",
  em_amt: "abs_price",
  em_pct: "pct",
  max_pain: "abs_price",
  max_pain_diff_pct: "pct",
  net_exposure: "usd_per_1pct_move",
  call_exposure: "usd_per_1pct_move",
  put_exposure: "usd_per_1pct_move",
  share_of_abs_total_pct: "pct",
  sigma_pos: "sigma",
  delta: "decimal",
  gamma: "decimal",
  theta: "decimal",
  vega: "decimal",
  rho: "decimal",
  avg_iv: "pct",
};

function withUnits(csv: CsvBlock): CsvBlock {
  return {
    headers: csv.headers.map((header) => {
      const unit = COLUMN_UNITS[header];
      return unit ? `${header}[${unit}]` : header;
    }),
    rows: csv.rows,
  };
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
