/**
 * CLI argument/option parsers. Throw CliUsageError (a plain Error) so the
 * user gets a clean message instead of a stack trace.
 */

/** A clean, user-facing usage error (no stack trace). */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Parse a required positive integer ID (feed/entry/category/user IDs). */
export function parseId(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliUsageError(`expected a positive integer ID, got "${value}"`);
  }
  return n;
}

/** Parse an integer option (offset, limit, timestamps, …). */
export function parseIntOption(value: string): number {
  if (value.trim() === "") {
    throw new CliUsageError("expected an integer, got an empty value");
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new CliUsageError(`expected an integer, got "${value}"`);
  }
  return n;
}

/** Parse a boolean option: true/1/yes or false/0/no. */
export function parseBoolOption(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  throw new CliUsageError(`expected true or false, got "${value}"`);
}

/**
 * Parse a time arg for --before/--after into a Unix timestamp (seconds).
 * Accepts: a pure Unix timestamp, an ISO-8601 date/datetime, or a relative
 * duration like "7d", "2h", "30m", "90s", or "now".
 */
export function parseTimeOption(value: string): number {
  const v = value.trim();
  if (v === "") throw new CliUsageError("expected a time value, got an empty string");

  // Pure integer → Unix timestamp (seconds).
  if (/^[+-]?\d+$/.test(v)) {
    const n = Number(v);
    // Reject timestamps that are clearly in milliseconds (13+ digits) for safety.
    if (Math.abs(n) >= 1e12) {
      throw new CliUsageError(`timestamp "${v}" looks like milliseconds; use a Unix timestamp in seconds`);
    }
    return n;
  }

  // Relative durations in the past: 7d / 2h / 30m / 90s.
  const rel = /^([+-]?\d+)([dhms])$/i.exec(v);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const seconds = unit === "d" ? 86_400 : unit === "h" ? 3_600 : unit === "m" ? 60 : 1;
    return Math.floor(Date.now() / 1000) + amount * seconds;
  }
  if (v.toLowerCase() === "now") return Math.floor(Date.now() / 1000);

  // ISO-8601 date / datetime (e.g. 2026-08-01 or 2026-08-01T12:00:00Z).
  const parsed = Date.parse(v);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);

  throw new CliUsageError(
    `invalid time "${value}" (expected a Unix timestamp, ISO date, "now", or a relative duration like "7d")`,
  );
}

/** Split a comma-separated option value into trimmed, non-empty parts. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}