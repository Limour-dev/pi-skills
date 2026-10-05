/** Output helpers: compact JSON and aligned text tables for humans. */

export function toJson(data: unknown, compact: boolean): string {
  return compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
}

/** 1234567 -> "1.23M"; keeps sign, 3 significant-ish digits. */
export function fmtCompact(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(dp)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(dp)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(dp)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(dp)}K`;
  if (abs === 0) return "0";
  return `${sign}${abs.toFixed(abs < 1 ? 3 : dp)}`;
}

export function fmtNum(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return v.toFixed(dp);
}

export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return Math.round(v).toLocaleString("en-US");
}

export function fmtPct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}

export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return v.toFixed(2);
}

/** Right-align numeric-looking cells, left-align the rest. */
function isNumericCell(s: string): boolean {
  return /^[-+]?[\d,]*\.?\d+[A-Za-z%]*$/.test(s.trim()) || s.trim() === "n/a" || s.trim() === "0";
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const align = headers.map((_, i) => rows.every((r) => isNumericCell(r[i] ?? "")) && i > 0);
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => {
        const w = widths[i] ?? c.length;
        return align[i] ? c.padStart(w) : c.padEnd(w);
      })
      .join("  ")
      .trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export function bulletList(items: string[]): string {
  return items.map((i) => `• ${i}`).join("\n");
}
