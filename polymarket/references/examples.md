# Worked examples

Real output from the live APIs. Run everything from the skill directory or with
`polymarket` on `PATH`.

---

## 1. "What are the odds that Xi Jinping is out before 2027?"

```bash
polymarket search "xi jinping" --limit 1
```

Then price the market it returns:

```bash
polymarket price xi-jinping-out-before-2027
```

```json
{
  "question": "Xi Jinping out before 2027?",
  "slug": "xi-jinping-out-before-2027",
  "marketId": "559651",
  "conditionId": "0xa467b14d51f01b957109d9cbb1d6c124fab2a089d52ed8f471d23c2812e743b7",
  "outcome": "Yes",
  "tokenId": "32338220190071351435772801779725302244575775216413325951443816017994629993401",
  "bestBid": 0.025,
  "bestAsk": 0.026,
  "midpoint": 0.0255,
  "spread": 0.001,
  "lastTradePrice": 0.025,
  "lastTradeSide": "SELL",
  "tickSize": 0.001
}
```

**Report it as:** ~2.6% implied probability (midpoint 0.0255), with a bid/ask of
2.5¢ / 2.6¢. Quote the bid/ask, not just the midpoint — a 0.001 spread on a
2.6% market is ~4% of the price.

Do **not** write "0.0255%" — Polymarket prices are already probabilities in 0–1.

---

## 2. An event URL with several markets

Pasting an event URL is common, and most events split into one market per
deadline or candidate. The CLI refuses to guess:

```bash
polymarket resolve "https://polymarket.com/event/will-the-us-confirm-that-aliens-exist-before-2027"
```

```json
{
  "input": "https://polymarket.com/event/will-the-us-confirm-that-aliens-exist-before-2027",
  "classified": { "kind": "event-slug", "slug": "will-the-us-confirm-that-aliens-exist-before-2027" },
  "event": { "id": "90177", "title": "Will the US confirm that aliens exist by...?" },
  "candidates": [
    { "index": 1, "id": "2009849", "question": "Will the US confirm that aliens exist by April 30?", "slug": "will-the-us-confirm-that-aliens-exist-by-april-30" },
    { "index": 2, "id": "2034723", "question": "Will the US confirm that aliens exist by June 30?", "slug": "will-the-us-confirm-that-aliens-exist-by-june-30-333" }
  ],
  "hint": "re-run with --market <n|id|slug> to pick one"
}
```

Pick one, or better, chart the whole term structure:

```bash
for i in 1 2 3 4 5 6 7; do
  polymarket price will-the-us-confirm-that-aliens-exist-before-2027 --market $i \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['question'], d['midpoint'])"
done
```

The shape across deadlines is usually the actual insight — a single market's
odds hides that the market expects an announcement in a specific window.

---

## 3. Order book

```bash
polymarket book xi-jinping-out-before-2027 --depth 3
```

```json
{
  "bestBid": 0.025,
  "bestAsk": 0.026,
  "spread": 0.001,
  "bidDepth": 24,
  "askDepth": 130,
  "bids": [
    { "price": 0.025, "size": 13105.9 },
    { "price": 0.024, "size": 8828 },
    { "price": 0.023, "size": 14538.73 }
  ],
  "asks": [
    { "price": 0.026, "size": 9778.06 },
    { "price": 0.027, "size": 4078.24 },
    { "price": 0.028, "size": 15223.57 }
  ]
}
```

`bids` and `asks` are sorted best-first by the CLI (the raw CLOB API returns
both worst-first). `bidDepth` / `askDepth` are the count of price levels, which
is a quick liquidity proxy: 24 bid levels vs 130 ask levels means the ask side is
far better supplied, i.e. selling pressure.

---

## 4. Price history

```bash
polymarket history xi-jinping-out-before-2027 --interval 1w --bucket 21600
```

```json
{
  "interval": "1w",
  "pointCount": 28,
  "first": { "timestamp": 1790445600, "price": 0.0375, "resolutionSeconds": 21600 },
  "last":  { "timestamp": 1791048435, "price": 0.0255, "resolutionSeconds": 0 },
  "points": [ "... 28 buckets ..." ]
}
```

`resolutionSeconds: 0` on the final bucket means it is a partial (in-progress)
bucket — do not treat it as a full interval when annualising or computing
volatility. Formatted: 3.75% a week ago → 2.55% now.

---

## 5. Who is on the other side

```bash
polymarket holders xi-jinping-out-before-2027 --limit 1
```

```json
{
  "question": "Xi Jinping out before 2027?",
  "conditionId": "0xa467b14d51f01b957109d9cbb1d6c124fab2a089d52ed8f471d23c2812e743b7",
  "groups": [
    {
      "token": "32338220190071351435772801779725302244575775216413325951443816017994629993401",
      "holders": [
        { "proxyWallet": "0x2c649b504168c5414277f23135fb9ce36df72099", "name": "rollsrolls", "pseudonym": "Common-Airbus", "amount": 685996.503776, "outcomeIndex": 0 }
      ]
    }
  ]
}
```

`outcomeIndex: 0` is Yes, `1` is No. A single holder with 686k shares against
20M shares of resting bids at 0.001 says the book, not the holders, is where the
liquidity is.

---

## 6. Assess a trader

```bash
polymarket resolve 0x2c649b504168c5414277f23135fb9ce36df72099
polymarket positions 0x2c649b504168c5414277f23135fb9ce36df72099 --limit 2
polymarket closed-positions 0x2c649b504168c5414277f23135fb9ce36df72099 --limit 2
```

```json
// positions (open, unrealised)
{ "title": "Xi Jinping out before 2027?", "outcome": "Yes", "size": 685996.5037,
  "avgPrice": 0.0795, "curPrice": 0.0255, "cashPnl": -37051.0678, "percentPnl": -67.9287 }

// closed-positions (realised)
{ "title": "Will Donald Trump win the popular vote...", "avgPrice": 0.3695, "realizedPnl": 8303171.2313 }
```

Report unrealised and realised **separately**. `cashPnl` on an open position is
mark-to-market and moves with the price; `realizedPnl` is locked in. Neither is a
lifetime PnL, and neither nets out fees.

---

## 7. What is the crowd trading right now

```bash
polymarket trades --limit 3
```

```json
[
  { "side": "SELL", "outcome": "Yes", "size": 117.83, "price": 0.330124756,
    "title": "Croatia vs. England: Both Teams to Score" },
  { "side": "SELL", "outcome": "No", "size": 22.84, "price": 0.7,
    "title": "Croatia vs. England: Both Teams to Score" }
]
```

Scope it to one market with `--market <ref>` (the CLI converts the reference
into the `conditionId` the endpoint needs).

---

## 8. Live price watch

```bash
polymarket watch xi-jinping-out-before-2027 --duration 30 --changes-only --events price_change,last_trade_price
```

```json
{"type":"connected","url":"wss://ws-subscriptions-clob.polymarket.com/ws/market","assets":["32338220190071351435772801779725302244575775216413325951443816017994629993401"]}
{"market":"0xa467b1...","asset_id":"323382...","timestamp":"1791048560534","hash":"91cd14b2...","bids":[...],"asks":[...]}
```

Notes drawn from real use:

- Without `--changes-only` a liquid market emits a frame per book update — often
  several per second. Always filter when watching for a minute or more.
- The first frame is always the full snapshot, even with `--changes-only`.
- `--events price_change` drops the snapshot entirely if you only care about
  deltas — but then you never learn the book, so keep `book` in the list unless
  you already have it.
- `watch` exits cleanly on `--duration`/`--frames`; use `timeout 30 polymarket watch …`
  if you would rather not wait out an empty market.

---

## 9. Discover a topic area

```bash
polymarket tags --related politics --limit 5
```

```json
[
  { "slug": "trump", "label": "Trump", "activeEventsCount": 330 },
  { "slug": "midterms", "label": "Midterms", "activeEventsCount": 1194 },
  { "slug": "senate-midterms", "activeEventsCount": 116 },
  { "slug": "house-elections", "activeEventsCount": 874 },
  { "slug": "governor-midterms", "activeEventsCount": 92 }
]
```

Then drill in — note that `--tag` accepts the slug even though the underlying
endpoint demands a numeric id:

```bash
polymarket events --tag midterms --limit 20
```

---

## 10. Resolve before you fetch

`resolve` makes one discovery call and prints the canonical identifiers, which is
the cheapest way to check you are pointed at the right market:

```bash
polymarket resolve 559651
```

```json
{
  "classified": { "kind": "market", "id": "559651" },
  "market": {
    "id": "559651",
    "question": "Xi Jinping out before 2027?",
    "conditionId": "0xa467b1...",
    "outcomes": [
      { "outcome": "Yes", "tokenId": "323382...", "price": 0.0255 },
      { "outcome": "No",  "tokenId": "256593...", "price": 0.9745 }
    ],
    "closed": false,
    "endDate": "2027-01-01T04:59:00Z"
  }
}
```

Use it whenever you need a `tokenId` (to hand to a raw CLOB call) or a
`conditionId` (for `/holders` and `/trades`).
