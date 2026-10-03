#!/usr/bin/env node
/**
 * polymarket — read-only Polymarket data CLI.
 *
 * Commands print JSON to stdout. Every command that takes an identifier accepts
 * a Gamma id, a slug, a condition id, an outcome token id, or a pasted
 * polymarket.com URL.
 */
import { NotFoundError, ApiError } from "./src/http.ts";
import {
  getComments,
  getEventById,
  getEventBySlug,
  getMarketById,
  getMarketBySlug,
  listEvents,
  listMarkets,
  listMarketsLegacy,
  getRelatedTags,
  listTags,
  resolveTagId,
  getPublicProfile,
  EVENT_ORDER_FIELDS,
  MARKET_ORDER_FIELDS,
  type Event,
  type Market,
} from "./src/gamma.ts";
import {
  getBook,
  getLastTradePrice,
  getPrice,
  getPriceHistoryV1,
  getPriceSummary,
  getSpread,
  getTickSize,
  getServerTime,
  type PriceSide,
} from "./src/clob.ts";
import {
  getActivity,
  getClosedPositions,
  getHolders,
  getLeaderboard,
  getPositions,
  getPriceHistory,
  getTrades,
} from "./src/data.ts";
import { AmbiguousEventError, classify, resolveEvent, resolveMarket, resolveToken } from "./src/resolve.ts";
import { clockSkewMs, watch } from "./src/watch.ts";

// ---------------------------------------------------------------- arg parsing

type Flags = Map<string, string | boolean>;
type Parsed = { positional: string[]; flags: Flags };

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
  "all",
  "closed",
  "open",
  "asc",
  "raw",
  "pretty",
  "help",
  "taker-only",
  "changes-only",
  "yes",
  "brief",
]);

function parseArgs(argv: string[]): Parsed {
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
    } else {
      flags.set(name, next);
      i++;
    }
  }
  return { positional, flags };
}

function str(f: Flags, key: string): string | undefined {
  const v = f.get(key);
  return typeof v === "string" ? v : undefined;
}

function num(f: Flags, key: string, dflt: number): number {
  const v = str(f, key);
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function bool(f: Flags, ...keys: string[]): boolean {
  return keys.some((k) => f.get(k) === true || f.get(k) === "true");
}

const BRIEF_FIELDS = [
  "id",
  "title",
  "question",
  "slug",
  "volume24hr",
  "liquidity",
  "bestBid",
  "bestAsk",
  "outcomeTokens",
  "closed",
  "endDate",
];

/** Pick only the requested top-level keys, leaving nested values untouched. */
function pickFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const f of fields) if (f in obj) picked[f] = obj[f];
  return picked;
}

/**
 * Project `--fields` / `--brief` onto output. List envelopes look like
 * `{ count, <key>: [...] }`: each item is projected while `count` is kept.
 */
function projectOutput(data: unknown, fields: string[]): unknown {
  if (Array.isArray(data)) return data.map((d) => projectOutput(d, fields));
  if (data === null || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;
  if (typeof obj.count === "number") {
    const result: Record<string, unknown> = { count: obj.count };
    for (const [k, v] of Object.entries(obj)) {
      if (k === "count") continue;
      if (Array.isArray(v) && (v.length === 0 || (typeof v[0] === "object" && v[0] !== null))) {
        result[k] = v.map((item) => projectOutput(item, fields));
      } else if (fields.includes(k)) {
        result[k] = v;
      }
    }
    return result;
  }
  return pickFields(obj, fields);
}

function out(data: unknown, flags: Flags): void {
  const explicit = str(flags, "fields");
  const selected = explicit
    ? explicit.split(",").map((s) => s.trim()).filter(Boolean)
    : bool(flags, "brief")
      ? BRIEF_FIELDS
      : undefined;
  const payload = selected ? projectOutput(data, selected) : data;
  process.stdout.write(JSON.stringify(payload, null, bool(flags, "raw") ? 0 : 2) + "\n");
}

// ------------------------------------------------------------------- commands

const USAGE = `polymarket — read-only Polymarket data

Discovery (Gamma API)
  search <query>                     full-text search events/markets/profiles
  events [--limit N] [--tag <id|slug>] [--open|--closed|--all] [--order <field>]
         [--exclude-tag <slug>] [--min-liquidity <n>]
  event <id|slug|url>                one event with its markets
  markets [--limit N] [--tag <id|slug>] [--open|--closed|--all] [--order <field>]
         [--exclude-tag <slug>] [--min-liquidity <n>]
  market <id|slug|url>               one market with outcomes + token ids
  tags [--search <text>] [--related <slug>] [--limit N]
  comments <id|slug|url> [--limit N]

Pricing (CLOB API)
  price <id|slug|url> [--outcome Yes|No|N]
  book <id|slug|url> [--depth N] [--outcome ...]
  history <id|slug|url> [--interval 1d|1w|1m|max] [--bucket <seconds>] [--outcome ...]
  clock                              server time + local clock skew

Activity (Data API)
  trades [--market <id|slug|url>] [--user <addr>] [--limit N] [--side BUY|SELL]
  holders <id|slug|url> [--limit N]
  positions <address> [--limit N] [--sort <field>]
  closed-positions <address> [--limit N]
  activity <address> [--limit N] [--type <type>]
  leaderboard [--period day|week|month|all] [--limit N] [--order pnl|vol]

Real time
  watch <id|slug|url>... [--duration <seconds>] [--frames N]
                         [--events book,price_change] [--changes-only] [--pretty]

Utilities
  resolve <anything>                 show canonical ids/tokens without fetching data
  help

Global flags: --raw, --pretty, --fields <a,b,c> (keep only these top-level fields),
              --brief (preset small field set), --market <n>
`;

async function cmdSearch(p: Parsed): Promise<void> {
  const q = p.positional.join(" ");
  if (!q) throw new Error("usage: polymarket search <query>");
  const limit = num(p.flags, "limit", 5);
  const { publicSearch } = await import("./src/gamma.ts");
  const res = await publicSearch(q, limit);
  out(
    {
      events: (res.events ?? []).map(trimEvent),
      tags: res.tags,
      profiles: res.profiles,
    },
    p.flags,
  );
}

async function cmdEvents(p: Parsed): Promise<void> {
  const opts = await listOpts(p, { kind: "events", defaultOpen: true });
  const events = await listEvents(opts);
  out({ count: events.length, events: events.map(trimEvent) }, p.flags);
}

async function cmdMarkets(p: Parsed): Promise<void> {
  const opts = await listOpts(p, { kind: "markets", defaultOpen: true });
  const order = str(p.flags, "order");
  const markets = order ? await listMarketsLegacy(opts) : await listMarkets(opts);
  out({ count: markets.length, markets: markets.map(trimMarket) }, p.flags);
}

function validateOrder(kind: "events" | "markets", order: string): void {
  const allowed: readonly string[] = kind === "events" ? EVENT_ORDER_FIELDS : MARKET_ORDER_FIELDS;
  if (!allowed.includes(order)) {
    throw new Error(`unknown --order field "${order}" for ${kind}. Supported: ${allowed.join(", ")}`);
  }
}

function firstRef(p: Parsed, usage: string): string {
  if (p.positional.length === 0) throw new Error(`usage: ${usage}`);
  if (p.positional.length > 1) throw new Error(`unexpected argument "${p.positional[1]}" (usage: ${usage})`);
  return p.positional[0];
}

/** Local filters for fields the listing APIs do not expose (or that combine poorly with sorting). */
function buildFilter(opts: {
  excludeTagIds?: string[];
  excludeTagSlugs?: string[];
  minLiquidity?: number;
}): ((row: Record<string, unknown>) => boolean) | undefined {
  const { excludeTagIds, excludeTagSlugs, minLiquidity } = opts;
  if (!excludeTagIds?.length && !excludeTagSlugs?.length && minLiquidity === undefined) return undefined;
  return (row) => {
    if (minLiquidity !== undefined) {
      const liq = Number((row.liquidityNum ?? row.liquidity) ?? 0);
      if (!(liq >= minLiquidity)) return false;
    }
    if (excludeTagIds?.length || excludeTagSlugs?.length) {
      const tags = Array.isArray(row.tags) ? (row.tags as Record<string, unknown>[]) : [];
      const ids = new Set(tags.map((t) => String(t.id ?? "")));
      const slugs = new Set(tags.map((t) => String(t.slug ?? "")));
      if (excludeTagIds?.some((id) => ids.has(id))) return false;
      if (excludeTagSlugs?.some((slug) => slug && slugs.has(slug))) return false;
    }
    return true;
  };
}

async function listOpts(p: Parsed, opts: { kind: "events" | "markets"; defaultOpen?: boolean }) {
  const order = str(p.flags, "order");
  if (order) validateOrder(opts.kind, order);
  const tag = str(p.flags, "tag");

  // Events/markets default to open; `--all` restores the all-states listing.
  const closedFlag = bool(p.flags, "closed");
  const openFlag = bool(p.flags, "open");
  const allStates = bool(p.flags, "all");
  let closed: boolean | undefined;
  if (closedFlag) closed = true;
  else if (openFlag) closed = false;
  else if (allStates) closed = undefined;
  else if (opts.defaultOpen) closed = false;

  const excludeTag = str(p.flags, "exclude-tag");
  const excludeTagSlugs = excludeTag?.split(",").map((s) => s.trim()).filter(Boolean);
  const excludeTagIds = excludeTagSlugs ? await Promise.all(excludeTagSlugs.map((s) => resolveTagId(s))) : undefined;
  const minLiquidity = str(p.flags, "min-liquidity") !== undefined ? num(p.flags, "min-liquidity", 0) : undefined;

  return {
    limit: num(p.flags, "limit", 20),
    all: allStates,
    closed,
    // The listing endpoints only accept a numeric tag id, so a slug is resolved first.
    tagId: tag ? await resolveTagId(tag) : undefined,
    order,
    ascending: bool(p.flags, "asc"),
    filter: buildFilter({ excludeTagIds, excludeTagSlugs, minLiquidity }),
  };
}

/** Shape for list views: drop the huge per-market blobs. */
function trimMarket(m: Market): Record<string, unknown> {
  return {
    id: m.id,
    question: m.question,
    slug: m.slug,
    conditionId: m.conditionId,
    outcomeTokens: m.outcomeTokens,
    bestBid: m.bestBid,
    bestAsk: m.bestAsk,
    volume: m.volumeNum ?? m.volume,
    liquidity: m.liquidityNum ?? m.liquidity,
    volume24hr: m.volume24hr,
    endDate: m.endDate,
    active: m.active,
    closed: m.closed,
    negRisk: m.negRisk,
  };
}

function trimEvent(e: Event): Record<string, unknown> {
  return {
    id: e.id,
    title: e.title,
    slug: e.slug,
    volume: e.volume,
    volume24hr: e.volume24hr,
    liquidity: e.liquidity,
    endDate: e.endDate,
    closed: e.closed,
    negRisk: e.negRisk,
    markets: (e.markets ?? []).map((m) => ({
      id: m.id,
      question: m.question,
      slug: m.slug,
      outcomeTokens: m.outcomeTokens,
      bestBid: m.bestBid,
      bestAsk: m.bestAsk,
    })),
  };
}

async function cmdEvent(p: Parsed): Promise<void> {
  const ref = firstRef(p, "polymarket event <id|slug|url>");
  const event = await resolveEventWithFallback(ref);
  out(event, p.flags);
}

/** Event ids are numeric Gamma ids; try event first, then market, then slug. */
async function resolveEventWithFallback(ref: string): Promise<Event> {
  const c = classify(ref);
  if (c.kind === "event") {
    try {
      return await getEventById(c.id);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
  if (c.kind === "market") {
    // A bare number could be either an event id or a market id. For an `event`
    // command the event namespace wins; fall back to the market's parent event.
    try {
      return await getEventById(c.id);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return await resolveEvent(ref);
    }
  }
  return resolveEvent(ref);
}

async function cmdMarket(p: Parsed): Promise<void> {
  const ref = firstRef(p, "polymarket market <id|slug|url>");
  const { market, event } = await resolveMarket(ref, { market: str(p.flags, "market") });
  out(
    {
      ...market,
      eventRef: event ? { id: event.id, title: event.title, slug: event.slug } : undefined,
    },
    p.flags,
  );
}

async function cmdPrice(p: Parsed): Promise<void> {
  const ref = firstRef(p, "polymarket price <id|slug|url> [--outcome Yes|No|N]");
  const t = await resolveToken(ref, {
    outcome: str(p.flags, "outcome"),
    market: str(p.flags, "market"),
  });
  const summary = await getPriceSummary(t.tokenId);
  out(
    {
      question: t.market.question,
      slug: t.market.slug,
      marketId: t.market.id,
      conditionId: t.market.conditionId,
      outcome: t.outcome,
      ...summary,
    },
    p.flags,
  );
}

async function cmdBook(p: Parsed): Promise<void> {
  const ref = firstRef(p, "polymarket book <id|slug|url> [--depth N]");
  const t = await resolveToken(ref, {
    outcome: str(p.flags, "outcome"),
    market: str(p.flags, "market"),
  });
  const depth = num(p.flags, "depth", 0);
  const book = await getBook(t.tokenId);
  // CLOB returns bids ascending (worst first) and asks descending (worst first);
  // sort both so index 0 is the top of book.
  const bids = [...book.bids].sort((a, b) => b.price - a.price);
  const asks = [...book.asks].sort((a, b) => a.price - b.price);
  const slice = (rows: typeof bids) => (depth > 0 ? rows.slice(0, depth) : rows);
  out(
    {
      question: t.market.question,
      slug: t.market.slug,
      outcome: t.outcome,
      tokenId: t.tokenId,
      conditionId: t.market.conditionId,
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks[0]?.price ?? null,
      spread: bids[0] && asks[0] ? Number((asks[0].price - bids[0].price).toFixed(6)) : null,
      bidDepth: bids.length,
      askDepth: asks.length,
      bids: slice(bids),
      asks: slice(asks),
    },
    p.flags,
  );
}

async function cmdHistory(p: Parsed): Promise<void> {
  const ref = firstRef(p, "polymarket history <id|slug|url> [--interval 1w]");
  const t = await resolveToken(ref, {
    outcome: str(p.flags, "outcome"),
    market: str(p.flags, "market"),
  });
  const interval = str(p.flags, "interval") ?? "1d";
  const bucket = str(p.flags, "bucket");
  const points = await getPriceHistory(t.tokenId, {
    interval,
    bucketSeconds: bucket ? Number(bucket) : undefined,
  });
  out(
    {
      question: t.market.question,
      slug: t.market.slug,
      outcome: t.outcome,
      tokenId: t.tokenId,
      interval,
      pointCount: points.length,
      first: points[0] ?? null,
      last: points[points.length - 1] ?? null,
      points,
    },
    p.flags,
  );
}

async function cmdTrades(p: Parsed): Promise<void> {
  const marketRef = str(p.flags, "market");
  let conditionId: string | undefined;
  if (marketRef) {
    const { market } = await resolveMarket(marketRef);
    conditionId = market.conditionId;
  }
  const trades = await getTrades({
    limit: num(p.flags, "limit", 20),
    market: conditionId,
    user: str(p.flags, "user"),
    side: str(p.flags, "side") as PriceSide | undefined,
    takerOnly: bool(p.flags, "taker-only"),
  });
  out({ count: trades.length, trades }, p.flags);
}

async function cmdHolders(p: Parsed): Promise<void> {
  const ref = firstRef(p, "polymarket holders <id|slug|url>");
  const { market } = await resolveMarket(ref, { market: str(p.flags, "market") });
  if (!market.conditionId) throw new Error(`market ${market.id} has no conditionId`);
  const groups = await getHolders({ market: market.conditionId, limit: num(p.flags, "limit", 20) });
  out({ question: market.question, slug: market.slug, conditionId: market.conditionId, groups }, p.flags);
}

async function cmdPositions(p: Parsed, closed = false): Promise<void> {
  const user = firstRef(p, `polymarket ${closed ? "closed-positions" : "positions"} <address>`);
  const limit = num(p.flags, "limit", 50);
  const rows = closed
    ? await getClosedPositions({ user, limit })
    : await getPositions({ user, limit, sortBy: str(p.flags, "sort") });
  out({ user, count: rows.length, positions: rows }, p.flags);
}

async function cmdActivity(p: Parsed): Promise<void> {
  const user = firstRef(p, "polymarket activity <address>");
  const rows = await getActivity({ user, limit: num(p.flags, "limit", 50), type: str(p.flags, "type") });
  out({ user, count: rows.length, activity: rows }, p.flags);
}

async function cmdLeaderboard(p: Parsed): Promise<void> {
  const rows = await getLeaderboard({
    period: (str(p.flags, "period") as "day" | "week" | "month" | "all" | undefined) ?? "all",
    limit: num(p.flags, "limit", 20),
    orderBy: (str(p.flags, "order") as "pnl" | "vol" | undefined) ?? "pnl",
    category: str(p.flags, "category"),
  });
  out({ count: rows.length, leaderboard: rows }, p.flags);
}

async function cmdTags(p: Parsed): Promise<void> {
  const related = str(p.flags, "related");
  if (related) {
    const tags = await getRelatedTags(related, num(p.flags, "limit", 20));
    out({ count: tags.length, tags }, p.flags);
    return;
  }
  const tags = await listTags({ limit: num(p.flags, "limit", 100), search: str(p.flags, "search") });
  out({ count: tags.length, tags }, p.flags);
}

async function cmdComments(p: Parsed): Promise<void> {
  const ref = firstRef(p, "polymarket comments <id|slug|url>");
  // Live API: parent_entity_type is Event-only (docs also list `market`, but it 422s).
  const event = await resolveEventWithFallback(ref);
  const res = await getComments({
    parentEntityType: "Event",
    parentEntityId: event.id,
    limit: num(p.flags, "limit", 20),
  });
  out({ eventId: event.id, eventTitle: event.title, comments: res }, p.flags);
}

async function cmdClock(p: Parsed): Promise<void> {
  const serverTime = await getServerTime();
  const skewMs = await clockSkewMs();
  out(
    {
      serverTimeUnix: serverTime,
      serverTimeIso: new Date(serverTime * 1000).toISOString(),
      localTimeIso: new Date().toISOString(),
      clockSkewMs: skewMs,
    },
    p.flags,
  );
}

async function cmdWatch(p: Parsed): Promise<void> {
  const refs = p.positional;
  if (refs.length === 0) throw new Error("usage: polymarket watch <id|slug|url>...");
  const tokens: string[] = [];
  for (const ref of refs) {
    const t = await resolveToken(ref, {
      outcome: str(p.flags, "outcome"),
      market: str(p.flags, "market"),
    });
    tokens.push(t.tokenId);
  }
  await watch({
    tokenIds: tokens,
    durationMs: num(p.flags, "duration", 30) * 1000,
    maxFrames: str(p.flags, "frames") ? Number(str(p.flags, "frames")) : undefined,
    events: str(p.flags, "events")?.split(",").map((s) => s.trim()).filter(Boolean),
    changesOnly: bool(p.flags, "changes-only"),
    pretty: bool(p.flags, "pretty"),
  });
}

async function cmdResolve(p: Parsed): Promise<void> {
  const ref = firstRef(p, "polymarket resolve <anything>");
  const c = classify(ref);
  const result: Record<string, unknown> = { input: ref, classified: c };
  try {
    const { market, event } = await resolveMarket(ref, { market: str(p.flags, "market") });
    result.market = {
      id: market.id,
      question: market.question,
      slug: market.slug,
      conditionId: market.conditionId,
      outcomeTokens: market.outcomeTokens,
      active: market.active,
      closed: market.closed,
      endDate: market.endDate,
    };
    result.event = event ? { id: event.id, title: event.title, slug: event.slug } : undefined;
    result.urls = {
      event: event?.slug ? `https://polymarket.com/event/${event.slug}` : undefined,
      market: market.slug ? `https://polymarket.com/market/${market.slug}` : undefined,
    };
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    if (e instanceof AmbiguousEventError) {
      result.event = { id: e.event.id, title: e.event.title, slug: e.event.slug };
      result.candidates = e.choices;
      result.hint = "re-run with --market <n|id|slug>, or fetch every market with `polymarket event <slug>`";
      delete result.error;
    }
  }
  // Addresses and tokens still get useful output.
  if (c.kind === "address") {
    result.profile = await getPublicProfile(c.address).catch(() => undefined);
  }
  out(result, p.flags);
}

/** Unused-but-cheap aliases kept for parity with the underlying APIs. */
const _extras = { getMarketById, getMarketBySlug, getEventBySlug, getPrice, getSpread, getTickSize, getLastTradePrice, getPriceHistoryV1 };
void _extras;

// ----------------------------------------------------------------------- main

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  const p = parseArgs(rest);
  switch (cmd) {
    case "search":
      return cmdSearch(p);
    case "events":
      return cmdEvents(p);
    case "event":
      return cmdEvent(p);
    case "markets":
      return cmdMarkets(p);
    case "market":
      return cmdMarket(p);
    case "price":
      return cmdPrice(p);
    case "book":
      return cmdBook(p);
    case "history":
      return cmdHistory(p);
    case "clock":
      return cmdClock(p);
    case "trades":
      return cmdTrades(p);
    case "holders":
      return cmdHolders(p);
    case "positions":
      return cmdPositions(p, false);
    case "closed-positions":
      return cmdPositions(p, true);
    case "activity":
      return cmdActivity(p);
    case "leaderboard":
      return cmdLeaderboard(p);
    case "tags":
      return cmdTags(p);
    case "comments":
      return cmdComments(p);
    case "watch":
      return cmdWatch(p);
    case "resolve":
      return cmdResolve(p);
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((e: unknown) => {
  if (e instanceof NotFoundError) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
  if (e instanceof ApiError) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
