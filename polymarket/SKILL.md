---
name: polymarket
description: >
  Read-only Polymarket prediction-market data via the `polymarket` CLI: odds,
  order books, history, live trades, holders, trader positions/PnL, and
  leaderboards. Resolves any Gamma id, slug, condition id, token id, or
  polymarket.com URL automatically — no API key or install. Use for
  prediction-market odds, volume, liquidity, or trader flow ("odds of X on
  Polymarket", "Polymarket 上 X 的概率", "order book", "watch this market",
  "trader PnL", "what's hot").
---

# Polymarket (read-only)

Zero-dependency `polymarket` CLI over Polymarket's public Gamma, CLOB, and Data
APIs plus the market WebSocket. No auth, no SDK, no `npm install`. Read-only: it
cannot place orders.

```bash
polymarket <command> [ref] [flags]
```

If `polymarket` is not on `PATH`, use `<skill-dir>/bin/polymarket` or
`node <skill-dir>/cli.ts`. Every identifier resolves automatically: a Gamma id,
slug, condition id, outcome token id, or pasted polymarket.com URL.

## Data model

```
Event                          e.g. "Who wins the 2028 nomination?"
 └─ Market (one binary question)
     └─ outcome "Yes" → tokenId, "No" → tokenId
```

- Prices are probabilities in 0–1 (`0.0255` = 2.6%). Say "2.6% implied
  probability", never "0.0255%".
- `price`/`book`/`history` act on one outcome token; they default to **Yes** —
  pass `--outcome No` for the other side.
- Use `outcomeTokens[]` (`{outcome, tokenId, price}`). It is present on
  `market`, on `event.markets[]`, and in `markets`/`events` list output. The raw
  `outcomes` / `outcomePrices` / `clobTokenIds` fields are JSON-encoded strings;
  ignore them.
- `holders` and `trades` are per market and keyed by `conditionId`.

## Command map

| Need | Command |
| --- | --- |
| Find by text | `search "<topic>" --limit 5` |
| Hot events | `events --open --order volume24hr --limit 20` |
| Hot markets | `markets --open --order volume24hr --limit 20` |
| One event + its markets | `event <ref>` |
| Live odds | `price <ref> [--outcome No]` |
| Order book | `book <ref> [--depth 10]` |
| History | `history <ref> --interval 1w` |
| Trades / holders | `trades [--market <ref>]` · `holders <ref>` |
| Trader | `positions <addr>` · `closed-positions <addr>` · `activity <addr>` |
| Leaderboard | `leaderboard --period week --order pnl` |
| Topic tags | `tags --related <slug>` |
| Live stream | `watch <ref> --duration 30 --changes-only` |

Trim large payloads with `--fields id,title,volume24hr,liquidity` (or `--brief`).

## Workflows

**Odds of X** — `search "<topic>"`; if the top hit is a multi-market event,
`event <ref>` lists the real questions, then `price <ref>` each. Report
`midpoint` (or the bid/ask pair) as a percentage plus `volume24hr` / `liquidity`.
Show every candidate market rather than silently picking one.

**What's hot** — `events --open --order volume24hr --limit 20` is the only way to
see event-level volume. Exclude one-off games with `--exclude-tag sports` and thin
markets with `--min-liquidity <n>`. Browse a topic with
`events --tag politics --order volume24hr`. Then `event <slug>`, `holders <ref>`,
`trades --market <ref>`.

**Assess a trader** — `positions <addr>` (open, unrealised) +
`closed-positions <addr>` (realised) + `activity <addr>`. Never sum `cashPnl` and
call it lifetime PnL; it excludes realised results and fees.

**Watch** — `watch <ref> --duration 60 --changes-only`. Output is NDJSON; the
first frame is always the full book snapshot.

**Multi-market events** — `price <event>` refuses and lists candidates with
bid/ask. Pick one with `--market <n|id|slug>`, or fetch them all at once with
`event <slug>`. `event <n>` prefers the event id namespace; `market <n>` forces
the market reading.

## Guardrails

- **Read-only.** Never claim to place, cancel, or modify orders.
- **Never invent prices.** Every number comes from command output. A `null` means
  no resting orders or no data — say so, do not substitute 0.
- Check `closed` / `endDate` before reporting a market as live.
- Keep page sizes modest (20–50); rate limits are per IP.
- Answer in the user's language.

## Details (load on demand)

- `references/usage.md` — full command/flag reference, filters, output shapes,
  identifier resolution, and API quirks the CLI normalizes.
- `references/api.md` — endpoints, parameters, rate limits, WebSocket protocol.
- `references/examples.md` — worked examples with real output.
