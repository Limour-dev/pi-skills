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

/**
 * `--units` annotates without renaming (OC-05): the original header names stay
 * addressable and each unit-bearing column gets a parallel `unit_<name>` column,
 * so one reader can handle both `--format csv` and `--format csv --units`.
 */
function withUnits(csv: CsvBlock): CsvBlock {
  const annotated = csv.headers
    .map((header) => ({ header, unit: COLUMN_UNITS[header] }))
    .filter((entry): entry is { header: string; unit: string } => entry.unit !== undefined);
  if (!annotated.length) return csv;
  return {
    headers: [...csv.headers, ...annotated.map((entry) => `unit_${entry.header}`)],
    rows: csv.rows.map((row) => [...row, ...annotated.map((entry) => entry.unit)]),
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

/**
 * `--provenance=minimal` (OC-08): keep the comparable snapshot keys and the
 * warnings, drop the constant long explanations that dominate the byte count.
 * `--no-provenance` drops the `provenance` object entirely. `full` is a no-op.
 */
export type ProvenanceMode = "full" | "minimal" | "none";

export function shapeDocument(doc: unknown, mode: ProvenanceMode): unknown {
  if (mode === "full") return doc;
  if (mode === "none") return dropProvenance(doc);
  return stripLongNotes(doc);
}

/** Keep only the machine-comparable provenance keys. */
function minimizeProvenance(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["fetched_at", "status", "from_cache", "requests_this_run", "warnings"]) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

function stripLongNotes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLongNotes);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === "note" || key.endsWith("_note")) continue;
    out[key] = key === "provenance" ? minimizeProvenance(inner) : stripLongNotes(inner);
  }
  return out;
}

function dropProvenance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropProvenance);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === "provenance") continue;
    out[key] = dropProvenance(inner);
  }
  return out;
}
