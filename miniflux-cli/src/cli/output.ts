/**
 * Output helpers: JSON for data, plain text for messages and OPML.
 */

/**
 * Output helpers: JSON for data, plain text for messages and OPML.
 */
import type { EntryFilters } from "../api/types.ts";

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function printText(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

export function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

/**
 * Sanitize a parsed JSON payload before printing: blank out Go zero-value
 * timestamps ("0001-01-01T00:00:00Z") so they don't pollute the output.
 */
export function sanitizeZeroDates(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(sanitizeZeroDates);
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = v === "0001-01-01T00:00:00Z" ? null : sanitizeZeroDates(v);
    }
    return out;
  }
  return data;
}

/**
 * Compact an entry list payload: keep only a small set of fields per entry.
 * `--compact` style output to cut token usage on large listings.
 */
export function compactEntries(data: unknown, opts: { plainText?: boolean } = {}): unknown {
  if (data && typeof data === "object" && "entries" in (data as Record<string, unknown>)) {
    const obj = data as Record<string, unknown>;
    const entries = Array.isArray(obj.entries) ? obj.entries : [];
    return {
      total: obj.total,
      entries: entries.map((e) => compactEntry(e as Record<string, unknown>, opts)),
    };
  }
  if (Array.isArray(data)) return data.map((e) => compactEntry(e as Record<string, unknown>, opts));
  return data;
}

function compactEntry(e: Record<string, unknown>, opts: { plainText?: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["id", "title", "feed_id", "published_at", "status", "starred"]) {
    if (e[k] !== undefined) out[k] = e[k];
  }
  if (e.feed && typeof e.feed === "object") {
    const f = e.feed as Record<string, unknown>;
    out.feed = f.title !== undefined ? { id: f.id, title: f.title } : undefined;
    if (out.feed === undefined) delete out.feed;
  }
  if (opts.plainText && typeof e.content === "string") {
    out.content = stripHtml(e.content as string);
  }
  return out;
}

/** Strip HTML tags from a content string (for --plain-text). */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a --fields option into the set of entry fields to keep.
 * Unknown fields are ignored; empty input means "keep all".
 */
export function parseFieldsOption(value: string | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  const fields = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (fields.length === 0) return undefined;
  return new Set(fields);
}

/**
 * Keep only the requested fields on an entry (or entry list) JSON payload.
 * Returns the (possibly unmodified) value when no fields were requested.
 */
export function selectEntryFields(data: unknown, fields: Set<string>): unknown {
  if (Array.isArray(data)) return data.map((e) => pick(e as Record<string, unknown>, fields));
  if (data && typeof data === "object" && "entries" in (data as Record<string, unknown>)) {
    const obj = data as Record<string, unknown>;
    return {
      total: obj.total,
      entries: (Array.isArray(obj.entries) ? obj.entries : []).map((e) =>
        pick(e as Record<string, unknown>, fields),
      ),
    };
  }
  return data;
}

function pick(e: Record<string, unknown>, fields: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(e)) {
    if (fields.has(k)) out[k] = e[k];
  }
  return out;
}

/**
 * Resolve the printed status for an entry list, defaulting to unread when the
 * user did not pass --status (documents Miniflux's implicit default).
 */
export function effectiveStatus(filters: EntryFilters): string {
  const s = filters.status;
  if (s === undefined) return "unread";
  return Array.isArray(s) ? s.join(",") : s;
}
