/**
 * Minimal, dependency-free CLI argument parser.
 *
 * Flags are `--name value` or `--name=value`. Flags listed in BOOLEAN_FLAGS
 * never consume the next token, so `candles --quiet BTCUSD` keeps `BTCUSD` as a
 * positional argument. Unknown flags followed by a non-flag token consume it.
 */

export type FlagValue = string | boolean | string[];
export type Flags = Map<string, FlagValue>;

export type Parsed = {
  positional: string[];
  flags: Flags;
};

const BOOLEAN_FLAGS = new Set([
  "compact",
  "csv",
  "help",
  "json",
  "md",
  "newest-first",
  "no-cache",
  "no-fallback",
  "quiet",
  "strict",
  "table",
  "version",
]);

const REPEATABLE = new Set(["select"]);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(name, true);
    } else if (REPEATABLE.has(name)) {
      const prior = flags.get(name);
      const values = Array.isArray(prior) ? prior : prior === undefined ? [] : [String(prior)];
      values.push(next);
      flags.set(name, values);
      i++;
    } else {
      flags.set(name, next);
      i++;
    }
  }
  return { positional, flags };
}

export function str(f: Flags, key: string): string | undefined {
  const v = f.get(key);
  return typeof v === "string" ? v : undefined;
}

export function num(f: Flags, key: string, dflt: number): number {
  const v = str(f, key);
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function bool(f: Flags, ...keys: string[]): boolean {
  return keys.some((k) => f.get(k) === true || f.get(k) === "true");
}

/** Split comma- or whitespace-separated values, preserving repeatable flags. */
export function list(f: Flags, key: string): string[] {
  const v = f.get(key);
  if (v === undefined) return [];
  const raw = Array.isArray(v) ? v : [String(v)];
  return raw
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}
