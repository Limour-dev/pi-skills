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

/** Price/volume fields belong to `candles`, never to the indicator row's own columns. */
export const PRICE_FIELDS = new Set(["open", "high", "low", "close", "volume"]);

/** Levenshtein edit distance, iterative with two rows (no allocation blow-up). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Nearest known field for a mistyped one, or `null` when nothing is close.
 * The threshold stays tight so a genuinely unrelated name does not get a
 * misleading "did you mean".
 */
export function nearestField(name: string, known: readonly string[], maxDistance = 2): string | null {
  let best: string | null = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of known) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= maxDistance ? best : null;
}
