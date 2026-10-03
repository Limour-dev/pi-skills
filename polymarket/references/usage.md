# polymarket CLI — usage reference

Full command and flag reference. For endpoint-level detail see
[`api.md`](./api.md); for worked output see [`examples.md`](./examples.md).

## Invocation

Single entry point: `<skill-dir>/bin/polymarket` (a bash wrapper around
`node cli.ts`, runnable from any directory, no build step).

```bash
polymarket <command> [args] [flags]
```

If `polymarket` is not on `PATH`, use the absolute path, or fall back to
`node <skill-dir>/cli.ts <command> [args]`.

All commands print JSON to stdout. Errors go to stderr with a non-zero exit
code. `--raw` prints compact JSON; `--pretty` is accepted for symmetry.

## Global flags

| Flag | Effect |
| --- | --- |
| `--market <n\|id\|slug>` | Disambiguate a multi-market event. `<n>` is 1-based. |
| `--fields a,b,c` | Keep only these **top-level** fields on each output object. For list envelopes (`{count, events:[…]}`) each item is projected and `count` is kept. |
| `--brief` | Preset small field set: `id,title,question,slug,volume24hr,liquidity,bestBid,bestAsk,outcomeTokens,closed,endDate`. |
| `--raw` | Compact JSON (no pretty-print). Does not trim fields — use `--fields`/`--brief`. |
| `--pretty` | Accepted; output is pretty by default. |

## Identifier resolution

Every command that takes an identifier accepts **any** of:

```
https://polymarket.com/event/<slug>     pasted event URL
https://polymarket.com/market/<slug>    pasted market URL
xi-jinping-out-before-2027              slug (market first, then event)
559651                                  Gamma market id
30828                                   Gamma event id
3233822019007135143577280179...         outcome token id (clobTokenIds entry)
0xa467b14d51f01b957109d9cbb...          condition id
0x56687bf447db6ffa42ffe2204a0...        wallet address (positions/activity)
```

Numeric refs are ambiguous by design: `event <n>` prefers the event namespace,
`market <n>` forces the market reading. A bare slug is tried as a market first,
then as an event.

## Output conventions

```
Event          one question set, e.g. "Who wins the 2028 nomination?"
 └─ Market     one tradable binary question
     ├─ outcome "Yes" → clobTokenId (256-bit int, string)
     └─ outcome "No"  → clobTokenId
```

- **Prices/order book/history are per outcome token.** `price`, `book`, and
  `history` default to the **Yes** outcome; pass `--outcome No` (or an index / an
  exact label) for the other side.
- **`outcomeTokens[]` is the normalized field**: `{outcome, tokenId, price}`.
  It appears on `market`, on `event.markets[]`, and in list output. The raw
  fields `outcomes`, `outcomePrices`, and `clobTokenIds` are JSON-encoded strings
  and should be ignored.
- **Holders and trades are per market**, keyed by `conditionId`.
- Prices are **probabilities in 0–1** (`0.0255` ≈ 2.6%). Yes and No sum to
  roughly 1; the gap is the spread.

## Discovery (Gamma API)

```bash
polymarket search <query> [--limit N]        # events / tags / profiles
polymarket events [flags]                    # listing (default: open)
polymarket event <ref>                       # one event + all its markets
polymarket markets [flags]                   # listing (default: open)
polymarket market <ref>                      # full market metadata
polymarket tags [--search <text>] [--related <slug>] [--limit N]
polymarket comments <ref> [--limit N]
```

Listing flags (`events`, `markets`):

| Flag | Effect |
| --- | --- |
| `--limit N` | Max rows (default 20). |
| `--open` / `--closed` | Only open / only closed. |
| `--all` | All states **and** page past the first page to reach `--limit`. Without it, `events`/`markets` default to **open** and only one page is fetched. |
| `--tag <id\|slug>` | Include only this tag (slug is resolved to a numeric id). |
| `--exclude-tag <slug>` | Drop rows carrying this tag (comma-separate several). Applied locally while paginating, so `--limit` still counts matches. Most reliable on `events` (market rows may not carry tags). Useful to drop `sports`. |
| `--min-liquidity N` | Drop rows with `liquidity < N` (local, paginating). |
| `--order <field>` | Sort field — validated locally against a whitelist; an unknown field errors before any request. |
| `--asc` | Ascending instead of descending. |

Allowed `--order` fields for **events**:

```
id, volume, volume24hr, volume1wk, volume1mo, volume1yr, liquidity,
openInterest, competitive, startDate, endDate, closedTime, createdAt, updatedAt
```

For **markets** (legacy `/markets` listing):

```
id, question, slug, volume, volumeNum, volume24hr, volume1wk, volume1mo,
volume1yr, liquidity, liquidityNum, openInterest, competitive,
oneHourPriceChange, oneDayPriceChange, oneWeekPriceChange, oneMonthPriceChange,
lastTradePrice, bestBid, bestAsk, spread, negRisk, active, closed,
startDate, endDate, closedTime, createdAt, updatedAt
```

`events --open --order volume24hr` is the only way to rank by **event-level**
24-hour volume. `--exclude-tag sports --min-liquidity 100000` removes one-off
games and thin books.

## Pricing (CLOB API)

```bash
polymarket price <ref> [--outcome Yes|No|N]
polymarket book <ref> [--depth N] [--outcome ...]
polymarket history <ref> [--interval 1d|1w|1m|max] [--bucket <seconds>] [--outcome ...]
polymarket clock                              # server time + local clock skew
```

- `price` returns bid/ask/midpoint/spread/last trade/tick size in one call.
- `book` sorts bids and asks best-first (the raw CLOB API returns both
  worst-first) and reports `bestBid`/`bestAsk`/`spread`/`bidDepth`/`askDepth`.
- `history` uses the Data API v2 endpoint; the final bucket may report
  `resolutionSeconds: 0`, meaning it is partial.

## Activity (Data API)

```bash
polymarket trades [--market <ref>] [--user <addr>] [--limit N] [--side BUY|SELL]
polymarket holders <ref> [--limit N]
polymarket positions <address> [--limit N] [--sort <field>]
polymarket closed-positions <address> [--limit N]
polymarket activity <address> [--limit N] [--type <type>]
polymarket leaderboard [--period day|week|month|all] [--limit N] [--order pnl|vol]
```

- `user` is the **proxy wallet** on a Polymarket profile, not the signing EOA.
- `holders` takes a market ref and converts it to a `conditionId`.
- Trader PnL: `cashPnl`/`percentPnl` on open positions is unrealised;
  `realizedPnl` on closed positions is locked in. Neither is a lifetime total and
  neither nets fees.

## Real time

```bash
polymarket watch <ref>... [--duration <seconds>] [--frames N]
                          [--events book,price_change] [--changes-only] [--pretty]
```

Output is NDJSON, one JSON object per line. `--changes-only` suppresses repeat
frames with an unchanged top of book (essential on liquid markets); the first
frame is always the full snapshot.

## Utilities

```bash
polymarket resolve <anything>     # classify + emit canonical ids without fetching data
polymarket help
```

`resolve` prints `classified`, `market`, `event`, and `urls`. For a multi-market
event it prints `candidates` (index, id, question, slug, `bestBid`, `bestAsk`,
`lastTradePrice`) and a hint, and sets `candidates`/`hint` instead of `error`.

## API quirks this CLI already handles

Useful when interpreting output, and essential if you ever call the APIs
directly instead of through the CLI:

- **Gamma returns `outcomes`, `outcomePrices`, and `clobTokenIds` as
  JSON-encoded strings**, not arrays. The CLI parses them into `outcomeTokens[]`.
- **CLOB returns prices as strings** (`"0.025"`). The CLI converts them to numbers.
- **`/holders` takes a `conditionId`**, not a token id.
- The v1 `clob/prices-history` parameter is named `market` but requires a
  **token id**. The CLI uses the Data API `v2/prices-history` instead.
- **`comments` is Event-scoped only.** The docs list a `market` value for
  `parent_entity_type`, but the live API rejects it (422). The CLI always
  resolves to the parent event.
- **`/tags` caps at 100 results and has no search parameter.** The CLI filters
  locally and falls back to an exact `/tags/slug/<slug>` lookup.
- **Listing endpoints require a numeric `tag_id`** — a slug 400s. The CLI
  resolves slugs first.
- **Event ids and market ids are separate namespaces that both look like small
  integers.** `event <n>` prefers the event namespace; use `market <n>` to force
  the market reading.
- **Multi-market events never silently pick a market.** `price`/`book`/`history`
  error out and list candidates with live bid/ask; use `--market <n>` or `event <slug>`.
- `public-profile` lives on **Gamma**, not the Data API.
- The market WebSocket needs an application-level **text frame `PING` every
  10 s** or the server closes the connection.
