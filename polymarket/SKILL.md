---
name: polymarket
description: >
  Query Polymarket prediction markets with the read-only `polymarket` CLI —
  prices, order books, price history, live WebSocket trades, holders, trader
  positions/PnL, and leaderboards. Resolves any Gamma id, slug, condition id,
  outcome token id, or pasted polymarket.com URL automatically, with no API key
  or SDK. Use for questions like "What are the odds of X on Polymarket?",
  "Polymarket 上 X 的概率是多少", "show me the order book for this market",
  "watch this market's price", "what is this trader's PnL", "what are the top
  traders betting on", "search Polymarket for a market about X", or any task
  that needs prediction-market odds, volume, liquidity, or trader flow.
---

# Polymarket (read-only)

## What it does

A zero-dependency, pure-TypeScript CLI over Polymarket's three public REST APIs
plus the public WebSocket feed. Coverage:

| Surface | API | Commands |
| --- | --- | --- |
| Discovery & metadata | Gamma (`gamma-api.polymarket.com`) | `search`, `events`, `event`, `markets`, `market`, `tags`, `comments` |
| Live pricing & order book | CLOB (`clob.polymarket.com`) | `price`, `book`, `history`, `clock` |
| Activity, positions, analytics | Data (`data-api.polymarket.com`) | `trades`, `holders`, `positions`, `closed-positions`, `activity`, `leaderboard` |
| Real time | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | `watch` |

**No authentication, no API key, no npm install.** All read endpoints are public.
The CLI does not and cannot place orders — it is read-only by design.

Every command that takes an identifier accepts **any** of these, and resolves
them for you:

```
https://polymarket.com/event/<slug>     pasted event URL
https://polymarket.com/market/<slug>    pasted market URL
xi-jinping-out-before-2027              slug (market first, then event)
559651                                  Gamma market id
30828                                   Gamma event id
3233822019007135143577280179...         outcome token id (clobTokenIds entry)
0xa467b14d51f01b957109d9cbb...          condition id
0x56687bf447db6ffa42ffe2204a0...        wallet address (for positions/activity)
```

## Invocation

Single entry point: `<skill-dir>/bin/polymarket` (a bash wrapper around
`node cli.ts`, runnable from any directory, no build step).

```bash
polymarket <command> [args] [flags]
```

If `polymarket` is not on `PATH`, use the absolute path, or fall back to
`node <skill-dir>/cli.ts <command> [args]`.

All commands print JSON to stdout. Errors go to stderr with a non-zero exit code.

## Data model (read this before reasoning about output)

```
Event          one question set, e.g. "Who wins the 2028 nomination?"
 └─ Market     one tradable binary question, e.g. "...will Newsom win?"
     ├─ outcome "Yes"  → clobTokenId (huge 256-bit integer, as a string)
     └─ outcome "No"   → clobTokenId
```

- **Prices/order book/history are per outcome token**, not per market.
  `price`, `book`, and `history` take a market reference and default to the
  **Yes** outcome — pass `--outcome No` (or `--outcome 2`) for the other side.
- **Holders and trades are per market**, keyed by `conditionId`.
- A Polymarket price is a **probability in 0–1** (0.0255 = ~2.6%). Say
  "2.6% implied probability", not "0.0255%".
- Yes and No prices sum to roughly 1; the gap is the spread.

## Common commands

```bash
polymarket search "fed rate cut" --limit 5     # find markets by text
polymarket events --limit 20 --open            # active events (default: all states)
polymarket events --tag politics --limit 20    # filter by tag id or slug
polymarket event <ref>                         # one event + all its markets
polymarket markets --limit 20 --open --order volume24hr   # busiest markets
polymarket market <ref>                        # full market metadata

polymarket price <ref> [--outcome No]          # bid/ask/mid/spread/last/tick
polymarket book <ref> [--depth 10]             # sorted order book, top of book first
polymarket history <ref> --interval 1w [--bucket 3600]
polymarket clock                               # server time + local clock skew

polymarket trades [--market <ref>] [--user <addr>] [--limit 50] [--side BUY]
polymarket holders <ref> [--limit 20]          # largest position holders
polymarket positions <address> [--limit 50]    # open positions + unrealised PnL
polymarket closed-positions <address>          # realised PnL
polymarket activity <address> [--type TRADE]   # trade/redeem/merge history
polymarket leaderboard [--period month] [--order pnl|vol] [--limit 20]

polymarket tags [--search politics] [--related politics]
polymarket comments <ref> [--limit 20]
polymarket resolve <anything>                  # inspect ids without fetching data

polymarket watch <ref>... [--duration 30] [--frames 100]
                          [--events book,price_change] [--changes-only] [--pretty]
```

Global flags: `--market <n|id|slug>` (disambiguate a multi-market event),
`--raw` (compact JSON), `--pretty`.

## Workflows

### Answer "what are the odds of X?"

1. Find the market: `polymarket search "<topic>" --limit 5`
2. If the top hit is an event with several markets, list them:
   `polymarket event <slug>` — the `markets[].question` values are the real questions.
3. Get the live price: `polymarket price <slug>`
4. Report `midpoint` (or the bid/ask pair) as a percentage, plus `volume24hr` /
   `liquidity` when the user is asking whether the odds are meaningful.
5. If several candidate markets exist, show the odds **for each** rather than
   picking one — the spread across strikes/dates is usually the real answer.

### Watch a market move

```bash
polymarket watch <ref> --duration 60 --changes-only
```

`--changes-only` suppresses repeat frames with an unchanged top of book, which
is essential on liquid markets. The first frame is always the full book
snapshot. Output is NDJSON, one JSON object per line.

### Assess a trader

1. `polymarket positions <address>` — open exposure and unrealised PnL
2. `polymarket closed-positions <address>` — realised PnL (`realizedPnl`)
3. `polymarket activity <address> --limit 100` — the actual trade ledger
4. `polymarket resolve <address>` — display name / pseudonym

Do **not** sum `cashPnl` across positions and present it as total PnL without
saying it excludes realised results and fees.

### Find what is hot / crowded

```bash
polymarket markets --open --order volume24hr --limit 20
polymarket leaderboard --period week --order pnl --limit 20
polymarket holders <ref> --limit 20
```

### Explore a topic area

```bash
polymarket tags --related politics --limit 20   # subtopics, each with activeEventsCount
polymarket events --tag <subtopic-slug> --limit 20
```

## API quirks this CLI already handles

Useful to know when interpreting output, and essential if you ever call the
APIs directly instead of through the CLI:

- **Gamma returns `outcomes`, `outcomePrices`, and `clobTokenIds` as
  JSON-encoded *strings***, not arrays. They need a second parse. `market`
  output exposes a clean `outcomeTokens[]` for this reason.
- **CLOB returns prices as strings** (`"0.025"`). The CLI converts them to numbers.
- **`/holders` takes a `conditionId`**, not a token id.
- The v1 `clob/prices-history` parameter is named `market` but requires a
  **token id**. The CLI uses the Data API `v2/prices-history` instead, which
  reports an explicit `resolutionSeconds` bucket size.
- **`comments` is Event-scoped only.** The docs list a `market` value for
  `parent_entity_type`, but the live API rejects it (422, accepts only
  `Event`/`Series`/`PerpsAsset`). The CLI always resolves to the parent event.
- **`/tags` caps at 100 results and has no search parameter.** The CLI filters
  locally and falls back to an exact `/tags/slug/<slug>` lookup.
- **Listing endpoints require a numeric `tag_id`** — a slug 400s. The CLI
  resolves slugs first.
- **Event ids and market ids are separate namespaces that both look like small
  integers**, and the same number can exist in both. `event <n>` prefers the
  event namespace; use `market <n>` to force the market reading.
- **Multi-market events never silently pick a market.** Commands error out and
  list the candidates; re-run with `--market <n>`.
- `public-profile` lives on **Gamma**, not the Data API.
- The market WebSocket needs an application-level **text frame `PING` every
  10 s** or the server closes the connection.

## Guardrails

- **Read-only.** Never claim to place, cancel, or modify orders. There is no
  trading support in this skill.
- **Never invent prices.** Every number in a report must come from a command's
  output. If a field is `null` (illiquid market, empty order book), say so
  instead of substituting 0.
- **Respect `null` liquidity.** A midpoint of `null` usually means no resting
  orders. Check `book` before quoting an odds figure.
- **Page sizes stay modest by default** (20–50). Use `--limit` and
  `--all`/`--raw` deliberately; `/markets` is limited to 300 req/10 s and
  Data API `/trades` to 200 req/10 s by Cloudflare.
- **Answer in the user's language.** These docs are Chinese/English mixed.
- When a market has a `closed: true` or `endDate` in the past, check
  `polymarket market <ref>` for resolution state before reporting it as live.

## Details (load on demand)

- `references/api.md` — full endpoint reference: URLs, parameters, response
  shapes, rate limits, and the WebSocket protocol.
- `references/examples.md` — worked examples with real output.
