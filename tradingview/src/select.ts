/**
 * `--select` handling.
 *
 * A select list may name fields that do not exist (typos, fields removed from
 * a payload). Rather than silently emitting blank columns, the plan separates
 * the keys that will actually be projected from the unknown ones so the caller
 * can warn (or fail under `--strict`).
 */

/** Keep only `select` keys present in `row`, in the order the user gave. */
export function projectRow(row: Record<string, unknown>, select: readonly string[]): Record<string, unknown> {
  if (select.length === 0) return row;
  const out: Record<string, unknown> = {};
  for (const key of select) if (key in row) out[key] = row[key];
  return out;
}

export type SelectPlan = {
  /** Keys that exist in the payload, in the user's order, de-duplicated. */
  effective: string[];
  /** Keys the payload does not have. */
  unknown: string[];
};

/** Split a select list against the fields actually available. */
export function planSelect(select: readonly string[], known: Iterable<string>): SelectPlan {
  const keys = new Set(known);
  const effective: string[] = [];
  const unknown: string[] = [];
  for (const key of select) {
    if (keys.has(key)) {
      if (!effective.includes(key)) effective.push(key);
    } else if (!unknown.includes(key)) {
      unknown.push(key);
    }
  }
  return { effective, unknown };
}

/** Field names present in the first row (all rows share the same shape). */
export function knownFields(rows: readonly Record<string, unknown>[] | undefined): string[] {
  const first = rows?.[0];
  return first ? Object.keys(first) : [];
}
