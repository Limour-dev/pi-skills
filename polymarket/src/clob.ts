/**
 * CLOB API — live prices and order books.
 *
 * https://clob.polymarket.com
 *
 * All read endpoints are public. Prices are returned as *strings*; they are
 * converted to numbers here so downstream code does not have to care.
 */
import { CLOB, getJson, postJson, qs } from "./http.ts";

export type Level = { price: number; size: number };
export type OrderBook = {
  market: string;
  asset_id: string;
  timestamp: number | null;
  bids: Level[];
  asks: Level[];
};

function levels(rows: unknown): Level[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return { price: Number(o.price), size: Number(o.size) };
  });
}

export async function getBook(tokenId: string): Promise<OrderBook> {
  const raw = await getJson<Record<string, unknown>>(`${CLOB}/book` + qs({ token_id: tokenId }));
  return {
    market: String(raw.market ?? ""),
    asset_id: String(raw.asset_id ?? ""),
    timestamp: raw.timestamp != null ? Number(raw.timestamp) : null,
    bids: levels(raw.bids),
    asks: levels(raw.asks),
  };
}

export async function getBooks(tokenIds: string[]): Promise<OrderBook[]> {
  const raw = await postJson<Record<string, unknown>[]>(`${CLOB}/books`, tokenIds.map((token_id) => ({ token_id })));
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    market: String(r.market ?? ""),
    asset_id: String(r.asset_id ?? ""),
    timestamp: r.timestamp != null ? Number(r.timestamp) : null,
    bids: levels(r.bids),
    asks: levels(r.asks),
  }));
}

export type PriceSide = "BUY" | "SELL";

/** Best bid (BUY) or best ask (SELL) for one token. */
export async function getPrice(tokenId: string, side: PriceSide): Promise<number | null> {
  const raw = await getJson<Record<string, unknown>>(`${CLOB}/price` + qs({ token_id: tokenId, side }));
  return raw.price != null ? Number(raw.price) : null;
}

export async function getPrices(
  entries: { tokenId: string; side: PriceSide }[],
): Promise<{ token_id: string; side: PriceSide; price: number | null }[]> {
  if (entries.length === 0) return [];
  const raw = await postJson<Record<string, unknown>[]>(
    `${CLOB}/prices`,
    entries.map((e) => ({ token_id: e.tokenId, side: e.side })),
  );
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    token_id: String(r.token_id ?? ""),
    side: String(r.side ?? "") as PriceSide,
    price: r.price != null ? Number(r.price) : null,
  }));
}

export async function getMidpoint(tokenId: string): Promise<number | null> {
  const raw = await getJson<Record<string, unknown>>(`${CLOB}/midpoint` + qs({ token_id: tokenId }));
  return raw.mid != null ? Number(raw.mid) : null;
}

export async function getMidpoints(
  tokenIds: string[],
): Promise<{ token_id: string; mid: number | null }[]> {
  if (tokenIds.length === 0) return [];
  const raw = await postJson<Record<string, unknown>[]>(`${CLOB}/midpoints`, tokenIds.map((token_id) => ({ token_id })));
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    token_id: String(r.token_id ?? ""),
    mid: r.mid != null ? Number(r.mid) : null,
  }));
}

export async function getSpread(tokenId: string): Promise<number | null> {
  const raw = await getJson<Record<string, unknown>>(`${CLOB}/spread` + qs({ token_id: tokenId }));
  return raw.spread != null ? Number(raw.spread) : null;
}

export async function getSpreads(
  tokenIds: string[],
): Promise<{ token_id: string; spread: number | null }[]> {
  if (tokenIds.length === 0) return [];
  const raw = await postJson<Record<string, unknown>[]>(`${CLOB}/spreads`, tokenIds.map((token_id) => ({ token_id })));
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    token_id: String(r.token_id ?? ""),
    spread: r.spread != null ? Number(r.spread) : null,
  }));
}

export async function getLastTradePrice(
  tokenId: string,
): Promise<{ price: number | null; side: PriceSide | null }> {
  const raw = await getJson<Record<string, unknown>>(`${CLOB}/last-trade-price` + qs({ token_id: tokenId }));
  return {
    price: raw.price != null ? Number(raw.price) : null,
    side: raw.side != null ? (String(raw.side) as PriceSide) : null,
  };
}

export async function getTickSize(tokenId: string): Promise<{ minimum_tick_size: number | null }> {
  const raw = await getJson<Record<string, unknown>>(`${CLOB}/tick-size` + qs({ token_id: tokenId }));
  return { minimum_tick_size: raw.minimum_tick_size != null ? Number(raw.minimum_tick_size) : null };
}

export async function getServerTime(): Promise<number> {
  const raw = await getJson<number | string>(`${CLOB}/time`);
  return Number(raw);
}

/** Everything a trader needs about one token, in one round trip. */
export async function getPriceSummary(tokenId: string): Promise<{
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  lastTradePrice: number | null;
  lastTradeSide: PriceSide | null;
  tickSize: number | null;
}> {
  const [bid, ask, mid, spread, last, tick] = await Promise.all([
    getPrice(tokenId, "BUY").catch(() => null),
    getPrice(tokenId, "SELL").catch(() => null),
    getMidpoint(tokenId).catch(() => null),
    getSpread(tokenId).catch(() => null),
    getLastTradePrice(tokenId).catch(() => ({ price: null, side: null })),
    getTickSize(tokenId).catch(() => ({ minimum_tick_size: null })),
  ]);
  return {
    tokenId,
    bestBid: bid,
    bestAsk: ask,
    midpoint: mid,
    spread,
    lastTradePrice: last.price,
    lastTradeSide: last.side,
    tickSize: tick.minimum_tick_size,
  };
}

/**
 * Historical price series.
 *
 * v1 (`/prices-history`) is kept as a fallback; v2 on the Data API
 * (`/v2/prices-history`) returns explicit bucket sizes and is preferred.
 * Note: the v1 endpoint's parameter is named `market` but takes a *token id*.
 */
export async function getPriceHistoryV1(
  tokenId: string,
  opts: { interval?: string; fidelity?: number; startTs?: number; endTs?: number } = {},
): Promise<{ t: number; p: number }[]> {
  const raw = await getJson<Record<string, unknown>>(
    `${CLOB}/prices-history` +
      qs({
        market: tokenId,
        interval: opts.interval,
        fidelity: opts.fidelity,
        startTs: opts.startTs,
        endTs: opts.endTs,
      }),
  );
  const history = Array.isArray(raw.history) ? (raw.history as Record<string, unknown>[]) : [];
  return history.map((h) => ({ t: Number(h.t), p: Number(h.p) }));
}
