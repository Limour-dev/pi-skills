/**
 * Output formatting and error/exit-code handling.
 *
 * Commands print JSON by default (pretty, or one line with --compact).
 * `--format csv|table|md` (and the `--csv` / `--table` / `--md` shorthands)
 * switch to tabular rendering for humans.
 */

import type { Flags } from "./args.ts";
import { bool, str } from "./args.ts";
import { TradingViewError } from "@mathieuc/tradingview/data";

export type Format = "json" | "csv" | "table" | "md";

/** Process exit codes. Chosen so scripts can react without parsing stderr. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  notFound: 3,
  auth: 4,
  timeout: 5,
  network: 6,
  deps: 69,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const TV_ERROR_CODES: Record<string, ExitCode> = {
  INVALID_ARGUMENT: EXIT.usage,
  SYMBOL_ERROR: EXIT.notFound,
  NO_DATA: EXIT.notFound,
  NOT_FOUND: EXIT.notFound,
  QUOTE_ERROR: EXIT.notFound,
  // A series error is a resolution/permission refusal (e.g. seconds or a
  // custom resolution on an anonymous session), not an unknown symbol.
  SERIES_ERROR: EXIT.auth,
  STUDY_ERROR: EXIT.auth,
  AUTH_ERROR: EXIT.auth,
  TIMEOUT: EXIT.timeout,
  ABORTED: EXIT.timeout,
  DISCONNECTED: EXIT.network,
  CONNECTION_ERROR: EXIT.network,
  HTTP_ERROR: EXIT.network,
  PROTOCOL_ERROR: EXIT.network,
  PARSE_ERROR: EXIT.network,
  CALLBACK_ERROR: EXIT.error,
  CRITICAL_ERROR: EXIT.error,
};

/** Human-readable code names for errors raised by this CLI. */
const CLI_CODE_NAMES: Record<ExitCode, string> = {
  [EXIT.ok]: "OK",
  [EXIT.error]: "ERROR",
  [EXIT.usage]: "USAGE",
  [EXIT.notFound]: "NOT_FOUND",
  [EXIT.auth]: "AUTH_ERROR",
  [EXIT.timeout]: "TIMEOUT",
  [EXIT.network]: "NETWORK_ERROR",
  [EXIT.deps]: "MISSING_DEPENDENCY",
};

export class CliError extends Error {
  code: ExitCode;
  details?: unknown;
  constructor(message: string, code: ExitCode = EXIT.error, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

export function usageError(message: string): CliError {
  return new CliError(message, EXIT.usage);
}

export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof CliError) return err.code;
  if (err instanceof TradingViewError) return TV_ERROR_CODES[err.code] ?? EXIT.error;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return TV_ERROR_CODES[code] ?? EXIT.error;
  return EXIT.error;
}

export function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof TradingViewError) {
    const payload: Record<string, unknown> = {
      code: err.code,
      message: err.message,
      hint: tvHint(err.code),
    };
    if (err.details !== undefined) payload.details = err.details;
    return { error: payload };
  }
  if (err instanceof CliError) {
    const payload: Record<string, unknown> = { code: CLI_CODE_NAMES[err.code] ?? "ERROR", message: err.message };
    if (err.details !== undefined) payload.details = err.details;
    return { error: payload };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "ERROR", message } };
}

function tvHint(code: string): string | undefined {
  switch (code) {
    case "SYMBOL_ERROR":
    case "QUOTE_ERROR":
      return "Symbol not found. Pass an EXCHANGE:SYMBOL, e.g. `candles BINANCE:BTCUSDT`, or check the alias table in references/symbols.md.";
    case "NO_DATA":
      return "No closed bars in the requested range. Widen the range or lower --count.";
    case "SERIES_ERROR":
      return "The server refused this series, usually because the timeframe needs a paid account (seconds, or 360/480/720 minutes). Retry with --tf 240 or --tf D; see references/commands.md for the supported list.";
    case "TIMEOUT":
      return "Raise --timeout, or retry: the TradingView websocket did not answer in time.";
    case "CONNECTION_ERROR":
    case "DISCONNECTED":
      return "TradingView dropped or rate-limited the connection (HTTP 429 under bursts). The CLI retries automatically; re-run if it persists.";
    default:
      return undefined;
  }
}

/** Resolve the requested output format. */
export function detectFormat(f: Flags): Format {
  if (bool(f, "csv")) return "csv";
  if (bool(f, "table")) return "table";
  if (bool(f, "md")) return "md";
  const explicit = str(f, "format");
  if (explicit === "json" || explicit === "csv" || explicit === "table" || explicit === "md") {
    return explicit;
  }
  return "json";
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(8)));
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function csvCell(v: unknown): string {
  const s = scalar(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export type PrintOptions = {
  format?: Format;
  compact?: boolean;
  /** Column order for csv/table when the payload is a flat record or array. */
  columns?: string[];
};

function rowsOf(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    if (data.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))) {
      return data as Record<string, unknown>[];
    }
    return null;
  }
  if (data !== null && typeof data === "object") return [data as Record<string, unknown>];
  return null;
}

/**
 * Column order for csv/table/md.
 *
 * An explicit list (e.g. the candle columns, or a narrowed `--select`) is
 * intersected with the keys actually present in the rows so a projection can
 * never render blank columns. When there are no rows yet the explicit list is
 * kept as the header.
 */
export function columnsOf(rows: Record<string, unknown>[], explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) {
    if (rows.length === 0) return explicit;
    const present = new Set<string>();
    for (const row of rows) for (const key of Object.keys(row)) present.add(key);
    const narrowed = explicit.filter((key) => present.has(key));
    return narrowed.length > 0 ? narrowed : explicit;
  }
  const seen: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) if (!seen.includes(k)) seen.push(k);
  }
  return seen;
}

function renderCsv(rows: Record<string, unknown>[], explicit?: string[]): string {
  const cols = columnsOf(rows, explicit);
  const lines = [cols.join(",")];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(","));
  return lines.join("\n");
}

function renderMd(rows: Record<string, unknown>[], explicit?: string[]): string {
  const cols = columnsOf(rows, explicit);
  const head = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${cols.map((c) => scalar(row[c]).replaceAll("|", "\\|")).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function renderTable(rows: Record<string, unknown>[], explicit?: string[]): string {
  if (rows.length === 0) return "(no rows)";
  if (Array.isArray(rows) === false) return "";
  const cols = columnsOf(rows, explicit);
  const cells = rows.map((row) => cols.map((c) => scalar(row[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  const lines = [fmt(cols), fmt(widths.map((w) => "─".repeat(w)))];
  for (const r of cells) lines.push(fmt(r));
  return lines.join("\n");
}

/** Print a payload in the requested format to stdout. */
export function print(data: unknown, opts: PrintOptions = {}): void {
  const format = opts.format ?? "json";
  const rows = rowsOf(data);
  let text: string;
  if (format === "json") {
    text = opts.compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  } else if (rows === null) {
    // A non-tabular payload (e.g. a nested object) degrades to JSON.
    text = opts.compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  } else if (format === "csv") {
    text = renderCsv(rows, opts.columns);
  } else if (format === "md") {
    text = renderMd(rows, opts.columns);
  } else {
    text = renderTable(rows, opts.columns);
  }
  process.stdout.write(text + "\n");
}
