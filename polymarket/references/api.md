# Polymarket API reference

Everything this skill talks to, as verified against the live APIs. All endpoints
listed here are **public and unauthenticated**.

Base URLs:

| API | Base |
| --- | --- |
| Gamma (discovery, metadata, comments, profiles) | `https://gamma-api.polymarket.com` |
| CLOB (prices, order books, history) | `https://clob.polymarket.com` |
| Data (trades, positions, holders, leaderboards) | `https://data-api.polymarket.com` |
| Market WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` |

Official docs: <https://docs.polymarket.com>. An LLM-friendly index lives at
<https://docs.polymarket.com/llms.txt>, and any page is available as Markdown by
appending `.md` to its URL.

---

## Gamma API

### List events — `GET /events/keyset`

Cursor pagination; the preferred way to enumerate events.

| Param | Notes |
| --- | --- |
| `limit` | page size (≤ 100) |
| `closed` | `true` / `false` |
| `tag_id` | **numeric only** — a slug returns `invalid integer` |
| `order`, `ascending` | sort field and direction |
| `after_cursor` | from the previous response's `next_cursor` |

Response shape: `{ "$schema", "events": [...], "next_cursor" }`.

### List markets — `GET /markets/keyset`

Same contract as `/events/keyset`, with `"markets"` in place of `"events"`.

`GET /markets` is the legacy offset variant and additionally accepts `order` /
`ascending`, which is why the CLI routes `--order` there.

### Fetch one

```
GET /events/{id}
GET /events/slug/{slug}
GET /markets/{id}
GET /markets/slug/{slug}
```

### Look up by token or condition — `GET /markets`

```
GET /markets?clob_token_ids=<tokenId>
GET /markets?condition_ids=<conditionId>
```

Both return a bare JSON array of market objects (not wrapped).

### Search — `GET /public-search?q=<text>&limit_per_type=<n>`

Returns `{ events, tags, profiles }`.

### Tags

```
GET /tags?limit=<n>                              # caps at 100, no search param
GET /tags/slug/{slug}
GET /tags/slug/{slug}/related-tags               # {tagID, relatedTagID, rank}
GET /tags/slug/{slug}/related-tags/tags          # full tag objects + activeEventsCount
```

`/tags` silently ignores `limit` values above 100 and has no `search` query
parameter — filter client-side, then fall back to a slug lookup.

### Comments — `GET /comments`

| Param | Notes |
| --- | --- |
| `parent_entity_type` | **`Event`, `Series`, `PerpsAsset` only** |
| `parent_entity_id` | the Event id |
| `limit`, `order`, `ascending` | pagination / sort |

The published docs also list `market` as a valid `parent_entity_type`; the live
API rejects it with HTTP 422. Always resolve to the parent event.

### Profile — `GET /public-profile?address=<address>`

Note: this is on **Gamma**, not the Data API. Accepts a proxy wallet or user address.

### Other Gamma endpoints

```
GET /series?recurrence=weekly&closed=false&limit=20
GET /series/{id}
GET /sports
GET /sports/market-types
GET /teams?league=nba&limit=20
GET /comments?parent_entity_type=Event&parent_entity_id=<id>
```

---

## CLOB API

All read endpoints take `token_id` (the outcome's `clobTokenIds` entry).

| Endpoint | Returns | Batch variant |
| --- | --- | --- |
| `GET /book?token_id=` | `{market, asset_id, timestamp, hash, bids[], asks[]}` | `POST /books` |
| `GET /price?token_id=&side=BUY\|SELL` | `{price}` | `POST /prices` |
| `GET /midpoint?token_id=` | `{mid}` | `POST /midpoints` |
| `GET /spread?token_id=` | `{spread}` | `POST /spreads` |
| `GET /last-trade-price?token_id=` | `{price, side}` | `POST /last-trades-prices` |
| `GET /tick-size?token_id=` | `{minimum_tick_size}` | — |
| `GET /time` | unix seconds (bare number) | — |
| `GET /prices-history?market=&interval=&fidelity=` | `{history:[{t,p}]}` | — |

Batch variants take a JSON array body: `[{"token_id": "..."}, ...]`.

Important details:

- **Prices are strings** in every response. `"0.025"`, not `0.025`.
- Batch endpoints use **snake_case** keys (`token_id`), unlike most of the rest
  of the API surface.
- `bids` come back **ascending** (worst first) and `asks` **descending** (worst
  first). Sort before presenting a top of book.
- `/prices-history`'s parameter is named `market` but takes a **token id**. It is
  superseded by the Data API `v2/prices-history`; kept here only as a fallback.
- `side` is uppercase `BUY` (bid) or `SELL` (ask).
- `time` returns a bare number, not JSON — parse defensively.
- Other useful reads: `/sampling-markets`, `/simplified-markets`,
  `/markets-by-token/{token_id}`, `/ok`.

---

## Data API

| Endpoint | Key params | Returns |
| --- | --- | --- |
| `GET /trades` | `market` (conditionId), `user`, `limit`, `side`, `takerOnly` | trade array |
| `GET /positions` | `user`, `limit`, `market`, `sortBy`, `redeemable` | position array |
| `GET /closed-positions` | `user`, `limit` | realised-PnL array |
| `GET /holders` | `market` (**conditionId**), `limit` | `[{token, holders[]}]` |
| `GET /activity` | `user`, `limit`, `type` | activity array |
| `GET /v1/leaderboard` | `timePeriod` (`day`/`week`/`month`/`all`), `limit`, `orderBy` (`pnl`/`vol`), `category` | rank array |
| `GET /v2/prices-history` | `token_id`, `interval`, `bucket_seconds`, `start`, `end`, `as_of` | `{data:[{timestamp, price, resolution_seconds}]}` |

Notes:

- `user` is the **proxy wallet** address (the one on a Polymarket profile), not
  the EOA that signed the order.
- `/holders` takes a **conditionId**, not a token id — a common mistake.
- `/v2/prices-history` is the modern history endpoint: it states the bucket size
  per point in `resolution_seconds` instead of making you infer it from
  `fidelity`.
- Trader PnL fields: `cashPnl` / `percentPnl` (open, unrealised) on positions;
  `realizedPnl` on closed positions. Neither includes an authoritative
  lifetime total.

---

## Market WebSocket

```
wss://ws-subscriptions-clob.polymarket.com/ws/market
```

1. Connect.
2. Send a subscription frame:

```json
{ "assets_ids": ["<tokenId>", "..."], "type": "market" }
```

3. Send the **text frame** `PING` every 10 seconds. The server replies `PONG`.
   Without this heartbeat the connection is dropped.
4. Messages arrive as a JSON array of event objects (occasionally a bare object).

Event types:

| `event_type` | Meaning |
| --- | --- |
| `book` | full order-book snapshot (first frame per asset) |
| `price_change` | top-of-book delta, with `best_bid` / `best_ask` |
| `last_trade_price` | a trade printed |
| `tick_size_change` | the market's tick size changed |
| `market_resolved` | the market resolved, with `winning_outcome` |

Example `book` frame:

```json
{
  "event_type": "book",
  "market": "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
  "asset_id": "107505882767731489358349912513945399560393482969656700824895970500493757150417",
  "timestamp": "1782753357257",
  "hash": "0xabc123",
  "bids": [{ "price": "0.08", "size": "33343.4" }],
  "asks": [{ "price": "0.99", "size": "218442.27" }]
}
```

Other public channels (not used by this skill):

| Channel | URL | Contents |
| --- | --- | --- |
| CLOB user | `wss://ws-subscriptions-clob.polymarket.com/ws/user` | authenticated order/trade updates |
| Sports | `wss://sports-api.polymarket.com/ws` | live sports scores |
| RTDS | `wss://ws-live-v2.polymarket.com/ws` | Chainlink 60-second crypto TWAPs |

---

## Rate limits (Cloudflare, IP-based)

Exceeding a limit **throttles/delays** rather than erroring. Sliding windows.

| API | Endpoint | Limit |
| --- | --- | --- |
| General | all | 15,000 req / 10 s |
| Gamma | general | 4,000 req / 10 s |
| Gamma | `/events` | 500 req / 10 s |
| Gamma | `/markets` | 300 req / 10 s |
| Gamma | `/markets` + `/events` listing | 900 req / 10 s |
| Gamma | `/comments` | 200 req / 10 s |
| Gamma | `/tags` | 200 req / 10 s |
| Gamma | `/public-search` | 350 req / 10 s |
| Data v1 | general | 1,000 req / 10 s |
| Data v1 | `/trades` | 200 req / 10 s |
| Data v1 | `/positions` | 150 req / 10 s |
| Data v1 | `/closed-positions` | 150 req / 10 s |

---

## Market object fields worth knowing

From Gamma `markets`:

| Field | Notes |
| --- | --- |
| `id` | Gamma market id (small integer, string) |
| `conditionId` | `0x…` — used by `/holders` and `/trades` |
| `slug` | URL slug |
| `question` | the human-readable question |
| `outcomes` | JSON-encoded string: `"[\"Yes\",\"No\"]"` |
| `outcomePrices` | JSON-encoded string: `"[\"0.0255\",\"0.9745\"]"` |
| `clobTokenIds` | JSON-encoded string of the two token ids |
| `volumeNum` / `liquidityNum` | numbers (`volume` / `liquidity` are strings) |
| `volume24hr`, `volume1wk`, `volume1mo`, `volume1yr` | numbers |
| `bestBid`, `bestAsk`, `spread`, `lastTradePrice` | convenience snapshot |
| `negRisk` | true for negative-risk multi-outcome events |
| `active`, `closed`, `archived`, `acceptingOrders` | lifecycle flags |
| `endDate` / `endDateIso` | ISO timestamp / date |
| `orderPriceMinTickSize`, `orderMinSize` | trading constraints |
| `events` | trimmed parent-event array (source of the parent event id) |
