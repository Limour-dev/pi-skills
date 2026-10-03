/**
 * Data API — trades, positions, holders, leaderboards, price history.
 *
 * https://data-api.polymarket.com
 *
 * Every endpoint here is public and read-only. `user` parameters take a proxy
 * wallet address (the address shown on a Polymarket profile), not the EOA that
 * signed the order.
 */
import { DATA, getJson, qs } from "./http.ts";

export type PricePoint = { timestamp: number; price: number; resolutionSeconds: number | null };

/** v2 price history — preferred over the CLOB v1 endpoint. */
export async function getPriceHistory(
  tokenId: string,
  opts: { interval?: string; bucketSeconds?: number; startTs?: number; endTs?: number; asOf?: number } = {},
): Promise<PricePoint[]> {
  const raw = await getJson<{ data?: Record<string, unknown>[] }>(
    `${DATA}/v2/prices-history` +
      qs({
        token_id: tokenId,
        interval: opts.interval,
        bucket_seconds: opts.bucketSeconds,
        start: opts.startTs,
        end: opts.endTs,
        as_of: opts.asOf,
      }),
  );
  const rows = Array.isArray(raw.data) ? raw.data : [];
  return rows.map((r) => ({
    timestamp: Number(r.timestamp),
    price: Number(r.price),
    resolutionSeconds: r.resolution_seconds != null ? Number(r.resolution_seconds) : null,
  }));
}

export type Trade = {
  proxyWallet: string;
  side: string;
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  outcome: string;
  transactionHash: string;
};

export async function getTrades(opts: {
  limit?: number;
  market?: string;
  user?: string;
  takerOnly?: boolean;
  side?: "BUY" | "SELL";
} = {}): Promise<Trade[]> {
  const rows = await getJson<Record<string, unknown>[]>(
    `${DATA}/trades` +
      qs({
        limit: opts.limit ?? 20,
        market: opts.market,
        user: opts.user,
        takerOnly: opts.takerOnly,
        side: opts.side,
      }),
  );
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    proxyWallet: String(r.proxyWallet ?? ""),
    side: String(r.side ?? ""),
    asset: String(r.asset ?? ""),
    conditionId: String(r.conditionId ?? ""),
    size: Number(r.size),
    price: Number(r.price),
    timestamp: Number(r.timestamp),
    title: String(r.title ?? ""),
    slug: String(r.slug ?? ""),
    outcome: String(r.outcome ?? ""),
    transactionHash: String(r.transactionHash ?? ""),
  }));
}

export type Position = Record<string, unknown> & {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  title: string;
  outcome: string;
};

export async function getPositions(opts: {
  user: string;
  limit?: number;
  market?: string;
  sortBy?: string;
  redeemable?: boolean;
}): Promise<Position[]> {
  const rows = await getJson<Record<string, unknown>[]>(
    `${DATA}/positions` +
      qs({
        user: opts.user,
        limit: opts.limit ?? 50,
        market: opts.market,
        sortBy: opts.sortBy,
        redeemable: opts.redeemable,
      }),
  );
  return (Array.isArray(rows) ? rows : []) as Position[];
}

export async function getClosedPositions(opts: { user: string; limit?: number }): Promise<Record<string, unknown>[]> {
  const rows = await getJson<Record<string, unknown>[]>(
    `${DATA}/closed-positions` + qs({ user: opts.user, limit: opts.limit ?? 50 }),
  );
  return Array.isArray(rows) ? rows : [];
}

export type HolderGroup = {
  token: string;
  holders: {
    proxyWallet: string;
    name: string;
    pseudonym: string;
    amount: number;
    outcomeIndex: number;
  }[];
};

/** `market` here is a **conditionId**, not a token id. */
export async function getHolders(opts: { market: string; limit?: number }): Promise<HolderGroup[]> {
  const rows = await getJson<Record<string, unknown>[]>(
    `${DATA}/holders` + qs({ market: opts.market, limit: opts.limit ?? 20 }),
  );
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    token: String(r.token ?? ""),
    holders: (Array.isArray(r.holders) ? (r.holders as Record<string, unknown>[]) : []).map((h) => ({
      proxyWallet: String(h.proxyWallet ?? ""),
      name: String(h.name ?? ""),
      pseudonym: String(h.pseudonym ?? ""),
      amount: Number(h.amount),
      outcomeIndex: Number(h.outcomeIndex),
    })),
  }));
}

export async function getActivity(opts: { user: string; limit?: number; type?: string }): Promise<Record<string, unknown>[]> {
  const rows = await getJson<Record<string, unknown>[]>(
    `${DATA}/activity` + qs({ user: opts.user, limit: opts.limit ?? 50, type: opts.type }),
  );
  return Array.isArray(rows) ? rows : [];
}

export type LeaderboardRow = {
  rank: number;
  proxyWallet: string;
  userName: string;
  vol: number;
  pnl: number;
};

export async function getLeaderboard(opts: {
  period?: "day" | "week" | "month" | "all";
  limit?: number;
  orderBy?: "pnl" | "vol";
  category?: string;
} = {}): Promise<LeaderboardRow[]> {
  const rows = await getJson<Record<string, unknown>[]>(
    `${DATA}/v1/leaderboard` +
      qs({
        timePeriod: opts.period ?? "all",
        limit: opts.limit ?? 20,
        orderBy: opts.orderBy ?? "pnl",
        category: opts.category,
      }),
  );
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    rank: Number(r.rank),
    proxyWallet: String(r.proxyWallet ?? ""),
    userName: String(r.userName ?? ""),
    vol: Number(r.vol),
    pnl: Number(r.pnl),
  }));
}


