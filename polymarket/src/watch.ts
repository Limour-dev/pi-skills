/**
 * Real-time streaming over the public CLOB market WebSocket.
 *
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market
 *
 * Protocol notes:
 *   - Subscribe with `{"assets_ids": ["<tokenId>"], "type": "market"}`.
 *   - The first frame per asset is a full `book` snapshot; subsequent frames are
 *     `price_change` / `last_trade_price` / `tick_size_change` deltas, plus
 *     `market_resolved` for lifecycle events.
 *   - This channel uses an application-level heartbeat: send the text frame
 *     `PING` every 10s or the server drops the connection. The server replies
 *     with `PONG`.
 *
 * Emits one JSON object per line (NDJSON) so it pipes cleanly into `jq` or a
 * line-oriented reader.
 */
import { CLOB } from "./http.ts";
import { getServerTime } from "./clob.ts";

const MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const HEARTBEAT_MS = 10_000;
const DEFAULT_MS = 30_000;

export type WatchOptions = {
  tokenIds: string[];
  /** Stop after this many milliseconds (default 30s). 0 means run until Ctrl-C. */
  durationMs?: number;
  /** Stop after this many frames. */
  maxFrames?: number;
  /** Emit only these event types, e.g. ["price_change", "last_trade_price"]. */
  events?: string[];
  /** Emit only frames whose best bid/ask actually moved. */
  changesOnly?: boolean;
  pretty?: boolean;
};

export async function watch(opts: WatchOptions): Promise<number> {
  if (opts.tokenIds.length === 0) throw new Error("watch needs at least one token id");
  const durationMs = opts.durationMs ?? DEFAULT_MS;
  const pretty = opts.pretty ?? false;

  const ws = new WebSocket(MARKET_WS);
  let frames = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  // Track last best bid/ask per asset so --changes-only can suppress noise.
  const lastQuote = new Map<string, string>();
  // The server also expects a socket-level ping to keep intermediaries happy.
  let shelfPing: ReturnType<typeof setInterval> | undefined;

  const emit = (payload: unknown) => {
    process.stdout.write(JSON.stringify(payload, null, pretty ? 2 : 0) + "\n");
    frames += 1;
  };

  const shutdown = (code = 0) => {
    if (heartbeat) clearInterval(heartbeat);
    if (shelfPing) clearInterval(shelfPing);
    if (deadline) clearTimeout(deadline);
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    process.exit(code);
  };

  return await new Promise<number>((resolve, reject) => {
    ws.addEventListener("open", () => {
      emit({ type: "connected", url: MARKET_WS, assets: opts.tokenIds });
      ws.send(JSON.stringify({ assets_ids: opts.tokenIds, type: "market" }));

      heartbeat = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send("PING");
      }, HEARTBEAT_MS);
      shelfPing = setInterval(() => {
        // Node's WebSocket exposes ping(); the DOM types do not.
        const pinger = ws as unknown as { ping?: () => void };
        if (ws.readyState === ws.OPEN) pinger.ping?.();
      }, HEARTBEAT_MS);

      if (durationMs > 0) {
        deadline = setTimeout(() => {
          emit({ type: "timeout", frames, durationMs });
          shutdown(0);
        }, durationMs);
      }
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      const text = typeof ev.data === "string" ? ev.data : String(ev.data);
      if (text === "PONG" || text === "PING") return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        emit({ type: "raw", data: text });
        return;
      }

      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const obj = item as Record<string, unknown>;
        const evType = String(obj.event_type ?? obj.type ?? "");

        if (opts.events && opts.events.length > 0 && !opts.events.includes(evType)) continue;

        if (opts.changesOnly) {
          const asset = String(obj.asset_id ?? obj.market ?? "");
          const quote = JSON.stringify([obj.best_bid ?? obj.bids ?? null, obj.best_ask ?? obj.asks ?? null]);
          if (lastQuote.get(asset) === quote) continue;
          lastQuote.set(asset, quote);
        }

        emit(item);
        if (opts.maxFrames && frames >= opts.maxFrames) {
          shutdown(0);
          return;
        }
      }
    });

    ws.addEventListener("error", (ev: Event) => {
      const msg = (ev as unknown as { message?: string }).message ?? "websocket error";
      reject(new Error(msg));
    });

    ws.addEventListener("close", (ev: CloseEvent) => {
      emit({ type: "closed", code: ev.code, reason: ev.reason, frames });
      if (heartbeat) clearInterval(heartbeat);
      if (shelfPing) clearInterval(shelfPing);
      if (deadline) clearTimeout(deadline);
      resolve(0);
    });
  });
}

/** Latency probe against the public CLOB clock — handy when debugging staleness. */
export async function clockSkewMs(): Promise<number> {
  const before = Date.now();
  const server = await getServerTime();
  const after = Date.now();
  const serverMs = server * 1000;
  return Math.round(serverMs - (before + after) / 2);
}

export { CLOB };
