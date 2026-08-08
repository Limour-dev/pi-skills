/**
 * CLI argument/option parsers. Throw commander's InvalidArgumentError so the
 * user gets a clean message instead of a stack trace.
 */
import { InvalidArgumentError } from "commander";

/** Parse a required positive integer ID (feed/entry/category/user IDs). */
export function parseId(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(`expected a positive integer ID, got "${value}"`);
  }
  return n;
}

/** Parse an integer option (offset, limit, timestamps, …). */
export function parseIntOption(value: string): number {
  if (value.trim() === "") {
    throw new InvalidArgumentError("expected an integer, got an empty value");
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new InvalidArgumentError(`expected an integer, got "${value}"`);
  }
  return n;
}

/** Parse a boolean option: true/1/yes or false/0/no. */
export function parseBoolOption(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  throw new InvalidArgumentError(`expected true or false, got "${value}"`);
}
