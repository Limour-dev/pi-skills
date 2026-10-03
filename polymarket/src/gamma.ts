/**
 * Gamma API — discovery and metadata.
 *
 * https://gamma-api.polymarket.com
 *
 * Two important quirks of this API, both handled by `normalizeMarket`:
 *   - `outcomes`, `outcomePrices` and `clobTokenIds` come back as JSON-encoded
 *     *strings* (`"[\"Yes\",\"No\"]"`), not arrays. They need a second parse.
 *   - Numeric fields are inconsistently string vs number (`volume` is a string,
 *     `volumeNum` is a number).
 */
import { GAMMA, getJson, qs, NotFoundError } from "./http.ts";

export type OutcomeToken = {
  outcome: string;
  tokenId: string | null;
  price: number | null;
};

export type Market = Record<string, unknown> & {
  id: string;
  question?: string;
  slug?: string;
  conditionId?: string;
  outcomeTokens: OutcomeToken[];
};

export type Event = Record<string, unknown> & {
  id: string;
  slug?: string;
  title?: string;
  markets?: Market[];
};

/** Parse a value that is either already an array or a JSON-encoded array string. */
export function parseMaybeJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through: treat as a single value */
    }
    return [s];
  }
  return [];
}

export function normalizeMarket(raw: Record<string, unknown>): Market {
  const outcomes = parseMaybeJsonArray(raw.outcomes);
  const prices = parseMaybeJsonArray(raw.outcomePrices);
  const tokenIds = parseMaybeJsonArray(raw.clobTokenIds);
  const outcomeTokens: OutcomeToken[] = outcomes.map((outcome, i) => ({
    outcome,
    tokenId: tokenIds[i] ?? null,
    price: prices[i] !== undefined ? Number(prices[i]) : null,
  }));
  return { ...raw, outcomeTokens } as Market;
}

export function normalizeEvent(raw: Record<string, unknown>): Event {
  const markets = Array.isArray(raw.markets)
    ? (raw.markets as Record<string, unknown>[]).map(normalizeMarket)
    : undefined;
  return { ...raw, markets } as Event;
}

export type ListOptions = {
  limit?: number;
  /** Fetch every page (keyset cursor) instead of a single page. */
  all?: boolean;
  closed?: boolean;
  tagId?: string;
  order?: string;
  ascending?: boolean;
  /** Keep only rows matching this predicate. Applied while paginating so `limit` still counts matches. */
  filter?: (row: Record<string, unknown>) => boolean;
};

/**
 * Sort fields accepted by the Gamma listing endpoints. The API answers an
 * unknown field with a generic 404, so the CLI validates locally to produce a
 * useful error instead. Kept to fields verified against the live API.
 */
export const EVENT_ORDER_FIELDS = [
  "id",
  "volume",
  "volume24hr",
  "volume1wk",
  "volume1mo",
  "volume1yr",
  "liquidity",
  "openInterest",
  "competitive",
  "startDate",
  "endDate",
  "closedTime",
  "createdAt",
  "updatedAt",
] as const;

export const MARKET_ORDER_FIELDS = [
  "id",
  "question",
  "slug",
  "volume",
  "volumeNum",
  "volume24hr",
  "volume1wk",
  "volume1mo",
  "volume1yr",
  "liquidity",
  "liquidityNum",
  "openInterest",
  "competitive",
  "oneHourPriceChange",
  "oneDayPriceChange",
  "oneWeekPriceChange",
  "oneMonthPriceChange",
  "lastTradePrice",
  "bestBid",
  "bestAsk",
  "spread",
  "negRisk",
  "active",
  "closed",
  "startDate",
  "endDate",
  "closedTime",
  "createdAt",
  "updatedAt",
] as const;

type KeysetResponse = { events?: Record<string, unknown>[]; markets?: Record<string, unknown>[]; next_cursor?: string };

async function keyset(
  resource: "events" | "markets",
  opts: ListOptions,
): Promise<Record<string, unknown>[]> {
  const limit = opts.limit ?? 20;
  const pageSize = Math.min(Math.max(limit, 20), 100);
  const out: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    if (++pages > (opts.all ? 1000 : 20)) break; // safety cap
    const url =
      `${GAMMA}/${resource}/keyset` +
      qs({
        limit: pageSize,
        closed: opts.closed,
        tag_id: opts.tagId,
        order: opts.order,
        ascending: opts.ascending,
        after_cursor: cursor,
      });
    const res = await getJson<KeysetResponse>(url);
    const rows = res[resource] ?? [];
    for (const row of rows) {
      if (opts.filter && !opts.filter(row)) continue;
      out.push(row);
      if (out.length >= limit) break;
    }
    cursor = res.next_cursor;
    if (!cursor || rows.length === 0) break;
    if (out.length >= limit) break;
    // Without --all or a local filter, one page is the contract; otherwise keep
    // paging until `limit` matches so filters do not under-fill the result.
    if (!opts.all && !opts.filter) break;
  }
  return out.slice(0, limit);
}

export async function listEvents(opts: ListOptions = {}): Promise<Event[]> {
  const rows = await keyset("events", opts);
  return rows.map(normalizeEvent);
}

export async function listMarkets(opts: ListOptions = {}): Promise<Market[]> {
  const rows = await keyset("markets", opts);
  return rows.map(normalizeMarket);
}

/** Legacy offset listing — useful for `order`/`ascending` combos keyset does not take. */
export async function listMarketsLegacy(opts: ListOptions = {}): Promise<Market[]> {
  const url =
    `${GAMMA}/markets` +
    qs({
      limit: opts.limit ?? 20,
      closed: opts.closed,
      tag_id: opts.tagId,
      order: opts.order,
      ascending: opts.ascending,
    });
  const rows = await getJson<Record<string, unknown>[]>(url);
  const markets = rows.map(normalizeMarket);
  return opts.filter ? markets.filter((m) => opts.filter!(m as Record<string, unknown>)) : markets;
}

/** Look up markets by outcome token id(s) or condition id(s). */
export async function findMarkets(opts: {
  tokenIds?: string[];
  conditionIds?: string[];
  limit?: number;
}): Promise<Market[]> {
  const url =
    `${GAMMA}/markets` +
    qs({
      clob_token_ids: opts.tokenIds?.join(","),
      condition_ids: opts.conditionIds?.join(","),
      limit: opts.limit ?? 20,
    });
  const rows = await getJson<Record<string, unknown>[]>(url);
  return (Array.isArray(rows) ? rows : []).map(normalizeMarket);
}


export async function getEventById(id: string): Promise<Event> {
  return normalizeEvent(await getJson<Record<string, unknown>>(`${GAMMA}/events/${encodeURIComponent(id)}`));
}

export async function getEventBySlug(slug: string): Promise<Event> {
  return normalizeEvent(
    await getJson<Record<string, unknown>>(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`),
  );
}

export async function getMarketById(id: string): Promise<Market> {
  return normalizeMarket(await getJson<Record<string, unknown>>(`${GAMMA}/markets/${encodeURIComponent(id)}`));
}

export async function getMarketBySlug(slug: string): Promise<Market> {
  return normalizeMarket(
    await getJson<Record<string, unknown>>(`${GAMMA}/markets/slug/${encodeURIComponent(slug)}`),
  );
}

export type SearchResults = {
  events?: Event[];
  tags?: Record<string, unknown>[];
  profiles?: Record<string, unknown>[];
};

export async function publicSearch(query: string, limitPerType = 5): Promise<SearchResults> {
  const raw = await getJson<Record<string, unknown>>(
    `${GAMMA}/public-search` + qs({ q: query, limit_per_type: limitPerType }),
  );
  const out: SearchResults = { ...raw };
  if (Array.isArray(raw.events)) out.events = (raw.events as Record<string, unknown>[]).map(normalizeEvent);
  return out;
}

/**
 * List tags. `/tags` caps at 100 results and has no search parameter, so a
 * `search` term falls back to an exact slug lookup before giving up.
 */
export async function listTags(opts: { limit?: number; search?: string } = {}): Promise<Record<string, unknown>[]> {
  const tags = await getJson<Record<string, unknown>[]>(`${GAMMA}/tags` + qs({ limit: opts.limit ?? 100 }));
  if (!opts.search) return tags;
  const needle = opts.search.toLowerCase();
  const local = tags.filter(
    (t) =>
      String(t.label ?? "").toLowerCase().includes(needle) ||
      String(t.slug ?? "").toLowerCase().includes(needle),
  );
  if (local.length > 0) return local;
  try {
    return [await getTagBySlug(needle.trim().replace(/\s+/g, "-"))];
  } catch {
    return [];
  }
}

export async function getTagBySlug(slug: string): Promise<Record<string, unknown>> {
  return getJson<Record<string, unknown>>(`${GAMMA}/tags/slug/${encodeURIComponent(slug)}`);
}

/** Tags related to a tag slug — the cheapest way to explore a topic area. */
export async function getRelatedTags(slug: string, limit = 20): Promise<Record<string, unknown>[]> {
  const rows = await getJson<Record<string, unknown>[]>(
    `${GAMMA}/tags/slug/${encodeURIComponent(slug)}/related-tags/tags`
  );
  return Array.isArray(rows) ? rows.slice(0, limit) : [];
}

/** Accept a numeric tag id or a tag slug and return the numeric id the APIs need. */
export async function resolveTagId(tagOrSlug: string): Promise<string> {
  if (/^\d+$/.test(tagOrSlug)) return tagOrSlug;
  let tag: Record<string, unknown>;
  try {
    tag = await getTagBySlug(tagOrSlug);
  } catch (e) {
    if (e instanceof NotFoundError) throw new NotFoundError(`no tag with slug "${tagOrSlug}"`);
    throw e;
  }
  if (tag.id == null) throw new NotFoundError(`tag has no id: ${tagOrSlug}`);
  return String(tag.id);
}

export async function getComments(opts: {
  parentEntityType?: string;
  parentEntityId?: string;
  limit?: number;
} = {}): Promise<Record<string, unknown>> {
  return getJson<Record<string, unknown>>(
    `${GAMMA}/comments` +
      qs({
        parent_entity_type: opts.parentEntityType,
        parent_entity_id: opts.parentEntityId,
        limit: opts.limit ?? 20,
      }),
  );
}

/** Public trader profile. Note: this lives on Gamma, not the Data API. */
export async function getPublicProfile(address: string): Promise<Record<string, unknown>> {
  return getJson<Record<string, unknown>>(`${GAMMA}/public-profile` + qs({ address }));
}

/**
 * The parent event embedded in a market payload (Gamma includes a trimmed
 * `events` array on every market). Comments are Event-scoped, so this is how a
 * market reference becomes a commentable entity.
 */
export function embeddedEvent(market: Market): Event | undefined {
  const evs = market.events;
  if (!Array.isArray(evs) || evs.length === 0) return undefined;
  const e = evs[0] as Record<string, unknown>;
  return { ...e, id: String(e.id ?? ""), markets: undefined } as Event;
}

export { NotFoundError };
