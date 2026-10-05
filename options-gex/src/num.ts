/** Numeric parsing/formatting shared by the REST and MCP channels. */

import { NEAR_ZERO } from "./types.ts";

/** Canonical strike key: `770.0` and `"770"` both become `"770"`. */
export function strikeKey(n: number): string {
  return String(Number(n));
}

export function round(n: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * Re-key a wire dictionary (`{"770.0": 96358554.49}`) by canonical strike
 * strings, dropping unparsable keys.
 */
export function numberRecord(input: unknown): Record<string, number> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const strike = Number.parseFloat(k);
    if (!Number.isFinite(strike)) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[strikeKey(strike)] = v;
  }
  return out;
}

/** Sorted numeric strikes from any strike-keyed record. */
export function strikesOf(record: Record<string, number> | undefined): number[] {
  if (!record) return [];
  return Object.keys(record)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

/**
 * Parse an MCP scaled number: `544.93M`, `-520.0K`, `-3.44M`, `538`, `-0`.
 */
export function parseScaled(text: string): number {
  const cleaned = text.trim().replace(/,/g, "");
  const match = /^(-?\d+(?:\.\d+)?)([KMB])?$/.exec(cleaned);
  if (!match) return Number.NaN;
  const value = Number.parseFloat(match[1]);
  const suffix = match[2];
  if (!suffix) return value;
  const factor = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : 1e9;
  return value * factor;
}

/** `544926340.3235289` → `544.93M`; keeps sign and adds no `$`. */
export function scaleNumber(n: number, decimals = 2): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(decimals)}K`;
  if (abs === 0) return "0";
  return String(round(n, decimals));
}

/** `-19669824.96` → `-$19.67M` (sign before the dollar sign, like the upstream). */
export function formatUsd(n: number, decimals = 2): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${scaleNumber(Math.abs(n), decimals)}`;
}

export function pctChange(value: number, base: number): number | undefined {
  if (!base) return undefined;
  return round(((value - base) / base) * 100, 2);
}

export function daysBetween(fromDate: string, toDate: string): number | undefined {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return Math.round((to - from) / 86_400_000);
}

/** Today's date in UTC as `YYYY-MM-DD`. */
export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface CleanResult {
  record: Record<string, number>;
  removed: number;
}

/**
 * Zero out near-zero floating-point noise (`-1.33e-7`) so it never reaches
 * selection or rendering. Counts how many entries were suppressed.
 */
export function cleanNoise(
  record: Record<string, number>,
  threshold = NEAR_ZERO,
): CleanResult {
  const out: Record<string, number> = {};
  let removed = 0;
  for (const [k, v] of Object.entries(record)) {
    if (v !== 0 && Math.abs(v) < threshold) {
      out[k] = 0;
      removed += 1;
    } else {
      out[k] = v;
    }
  }
  return { record: out, removed };
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
