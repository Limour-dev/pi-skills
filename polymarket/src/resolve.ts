/**
 * Input resolution: turn "whatever the user pasted" into concrete Polymarket
 * identifiers.
 *
 * Accepted forms:
 *   https://polymarket.com/event/<slug>
 *   https://polymarket.com/market/<slug>
 *   559651                      → Gamma market id
 *   30828                       → Gamma event id (tried as a fallback)
 *   323382201900713514357728... → outcome token id (clobTokenIds entry)
 *   0xa467b1...743b7 (66 hex)   → condition id
 *   xi-jinping-out-before-2027  → slug (market first, then event)
 *   0x56687bf4...f55839 (40 hex)→ wallet address
 */
import { NotFoundError } from "./http.ts";
import {
  embeddedEvent,
  findMarkets,
  getEventById,
  getEventBySlug,
  getMarketById,
  getMarketBySlug,
  type Event,
  type Market,
} from "./gamma.ts";

export type Ref =
  | { kind: "event"; id: string }
  | { kind: "event-slug"; slug: string }
  | { kind: "market"; id: string }
  | { kind: "market-slug"; slug: string }
  | { kind: "token"; tokenId: string }
  | { kind: "condition"; conditionId: string }
  | { kind: "address"; address: string }
  | { kind: "slug"; slug: string };

export function classify(input: string): Ref {
  const s = input.trim();
  if (!s) throw new Error("empty identifier");

  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new Error(`not a valid URL: ${s}`);
    }
    // Segments after the first of event|market are the slug.
    const segs = url.pathname.split("/").filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] === "event" && segs[i + 1]) return { kind: "event-slug", slug: segs[i + 1] };
      if (segs[i] === "market" && segs[i + 1]) return { kind: "market-slug", slug: segs[i + 1] };
    }
    throw new Error(`no /event/ or /market/ segment in URL: ${s}`);
  }

  if (/^0x[0-9a-f]+$/i.test(s)) {
    if (s.length === 42) return { kind: "address", address: s };
    if (s.length === 66) return { kind: "condition", conditionId: s };
    throw new Error(`unrecognised hex identifier (length ${s.length}): ${s}`);
  }

  if (/^\d+$/.test(s)) {
    // Outcome token ids are 256-bit integers; Gamma ids are small.
    if (s.length >= 25) return { kind: "token", tokenId: s };
    return { kind: "market", id: s };
  }

  return { kind: "slug", slug: s };
}

export type ResolvedMarket = { market: Market; event?: Event };

/**
 * Resolve anything that identifies a single market.
 *
 * `--market` disambiguates multi-market events: it accepts an index, a market
 * slug/id, or an outcome token id.
 */
export async function resolveMarket(
  input: string,
  opts: { market?: string } = {},
): Promise<ResolvedMarket> {
  const ref = classify(input);
  switch (ref.kind) {
    case "market": {
      const market = await getMarketById(ref.id);
      return { market, event: embeddedEvent(market) };
    }
    case "market-slug": {
      const market = await getMarketBySlug(ref.slug);
      return { market, event: embeddedEvent(market) };
    }
    case "token": {
      const [market] = await findMarkets({ tokenIds: [ref.tokenId], limit: 1 });
      if (!market) throw new NotFoundError(`no market for token ${ref.tokenId}`);
      return { market, event: embeddedEvent(market) };
    }
    case "condition": {
      const [market] = await findMarkets({ conditionIds: [ref.conditionId], limit: 1 });
      if (!market) throw new NotFoundError(`no market for condition ${ref.conditionId}`);
      return { market, event: embeddedEvent(market) };
    }
    case "event":
      return pickFromEvent(await getEventById(ref.id), opts.market);
    case "event-slug":
      return pickFromEvent(await getEventBySlug(ref.slug), opts.market);
    case "slug":
      return resolveSlug(ref.slug, opts.market);
    case "address":
      throw new Error(`${input} is a wallet address, not a market. Use \`positions\` or \`activity\`.`);
  }
}

async function resolveSlug(slug: string, marketSelector?: string): Promise<ResolvedMarket> {
  try {
    const market = await getMarketBySlug(slug);
    return { market, event: embeddedEvent(market) };
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  try {
    return pickFromEvent(await getEventBySlug(slug), marketSelector);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  throw new NotFoundError(`no market or event with slug "${slug}"`);
}

/** Raised when an event URL/slug maps to more than one market and no selector was given. */
export class AmbiguousEventError extends Error {
  event: Event;
  choices: { index: number; id: string; question: string; slug: string | undefined }[];

  constructor(event: Event) {
    const markets = event.markets ?? [];
    const choices = markets.map((m, i) => ({
      index: i + 1,
      id: String(m.id),
      question: String(m.question ?? ""),
      slug: m.slug,
    }));
    const list = choices.map((c) => `  ${c.index}. ${c.question} (${c.slug ?? c.id})`).join("\n");
    super(
      `event "${event.slug ?? event.id}" has ${markets.length} markets — pick one with --market <n|id|slug>:\n${list}`
    );
    this.name = "AmbiguousEventError";
    this.event = event;
    this.choices = choices;
  }
}

function pickFromEvent(event: Event, selector?: string): ResolvedMarket {
  const markets = event.markets ?? [];
  if (markets.length === 0) throw new NotFoundError(`event ${event.slug ?? event.id} has no markets`);

  if (selector) {
    const byToken = markets.find((m) => m.outcomeTokens.some((t) => t.tokenId === selector));
    if (byToken) return { market: byToken, event };
    const byIdOrSlug = markets.find((m) => m.id === selector || m.slug === selector);
    if (byIdOrSlug) return { market: byIdOrSlug, event };
    const idx = Number(selector);
    if (Number.isInteger(idx)) {
      // 1-based for humans; also accept 0-based.
      const m = markets[idx - 1] ?? markets[idx];
      if (m) return { market: m, event };
    }
    throw new NotFoundError(
      `event ${event.slug ?? event.id} has no market matching "${selector}" (use --market 1..${markets.length})`
    );
  }

  if (markets.length === 1) return { market: markets[0], event };

  // Never silently guess: a wrong market is worse than an extra round trip.
  throw new AmbiguousEventError(event);
}

export async function resolveEvent(input: string): Promise<Event> {
  const ref = classify(input);
  switch (ref.kind) {
    case "event":
      return getEventById(ref.id);
    case "event-slug":
      return getEventBySlug(ref.slug);
    case "market":
    case "market-slug": {
      const { market, event } = await resolveMarket(input);
      // Fall back to a single-market event so callers always get an Event back.
      return event ?? syntheticEvent(market);
    }
    case "token":
    case "condition": {
      const { market, event } = await resolveMarket(input);
      return event ?? syntheticEvent(market);
    }
    case "slug": {
      try {
        return await getEventBySlug(ref.slug);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
        const { market, event } = await resolveMarket(ref.slug);
        return event ?? syntheticEvent(market);
      }
    }
    case "address":
      throw new Error(`${input} is a wallet address, not an event.`);
  }
}
/** Stand-in event for a market that has no parent event attached. */
function syntheticEvent(market: Market): Event {
  return { id: String(market.id), slug: market.slug, title: market.question, markets: [market] };
}
export type ResolvedToken = { tokenId: string; outcome: string; market: Market; event?: Event };

/**
 * Resolve anything into a specific outcome token id.
 * `--outcome` picks YES / NO / an index / an exact outcome label.
 */
export async function resolveToken(
  input: string,
  opts: { outcome?: string; market?: string } = {},
): Promise<ResolvedToken> {
  // A bare token id needs no market lookup.
  const ref = classify(input);
  if (ref.kind === "token") {
    const { market, event } = await resolveMarket(input);
    const match = market.outcomeTokens.find((t) => t.tokenId === ref.tokenId);
    return { tokenId: ref.tokenId, outcome: match?.outcome ?? "", market, event };
  }

  const { market, event } = await resolveMarket(input, { market: opts.market });
  const tokens = market.outcomeTokens.filter((t) => t.tokenId);
  if (tokens.length === 0) throw new NotFoundError(`market ${market.slug ?? market.id} has no outcome tokens`);

  const want = (opts.outcome ?? "Yes").trim();
  let chosen =
    tokens.find((t) => t.outcome.toLowerCase() === want.toLowerCase()) ??
    (() => {
      const idx = Number(want);
      if (Number.isInteger(idx)) return tokens[idx - 1] ?? tokens[idx];
      return undefined;
    })();

  if (!chosen) {
    const labels = tokens.map((t) => t.outcome).join(", ");
    throw new NotFoundError(`outcome "${want}" not in market ${market.slug ?? market.id} (available: ${labels})`);
  }

  return { tokenId: chosen.tokenId as string, outcome: chosen.outcome, market, event };
}

/** Compact one-line rendering used in CLI listings. */
export function marketLabel(m: Market): string {
  const q = m.question ?? m.slug ?? m.id;
  const tokens = (m.outcomeTokens ?? [])
    .map((t) => `${t.outcome}=${t.price ?? "?"}`)
    .join(" / ");
  return `${q}${tokens ? `  [${tokens}]` : ""}`;
}
