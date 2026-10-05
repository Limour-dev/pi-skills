# Endpoints, parameters and quirks

Base URL: `https://api.massive.com` (a polygon.io-compatible API; `--base-url` /
`MASSIVE_BASE_URL` override it — the test suite points it at a local mock).

Auth: `Authorization: Bearer <MASSIVE_API_KEY>` (the CLI also accepts
`?apiKey=`; the key is never printed or logged, and `--from-file` needs no key).

## Endpoints used

| Endpoint | Used for | Plan access (per Massive docs) |
| --- | --- | --- |
| `GET /v3/snapshot/options/{underlyingAsset}` | **Open interest + greeks + quotes for the whole chain** — the source for GEX and max pain | Options Starter and up; **not** Options Basic |
| `GET /v3/snapshot/options/{underlyingAsset}/{optionContract}` | Single-contract snapshot (probe only) | Same as above |
| `GET /v3/reference/options/contracts` | Expiration discovery inside the DTE window | Entry-level options plans |
| `GET /v3/reference/options/contracts/{options_ticker}` | `contract` command reference data | Entry-level |
| `GET /v2/aggs/ticker/{stocksTicker}/prev` | Fallback underlying price (previous close) | Entry-level |
| `GET /v1/open-close/{ticker}/{date}` | Last-resort underlying price | Entry-level |
| `GET /v2/snapshot/locale/us/markets/stocks/tickers/{t}` | Real-time underlying price (often plan-gated) | Stocks plans |
| `GET /v1/marketstatus/now` | Market context in `probe` | Always |

## Option chain snapshot

```
GET /v3/snapshot/options/{underlyingAsset}
  ?expiration_date.gte=YYYY-MM-DD
  &expiration_date.lte=YYYY-MM-DD
  &limit=250            # default 10, max 250
  &sort=expiration_date
  &order=asc
```

Per result the CLI reads:

| Field | Meaning |
| --- | --- |
| `details.ticker` | `O:AAPL211022C000150000` (OCC-style) |
| `details.contract_type` | `call` \| `put` \| `other` |
| `details.expiration_date`, `details.strike_price` | contract identity |
| `details.shares_per_contract` | multiplier (100 for equities) |
| `open_interest` | contracts held at the end of the previous session |
| `greeks.gamma` | ∂delta/∂S — the GEX input |
| `greeks.delta/theta/vega` | passed through to `chain` |
| `implied_volatility` | decimal (see quirks) |
| `day.volume`, `day.close` | session activity |
| `last_quote.bid/ask/midpoint` | quoting (plan-dependent) |
| `last_trade.price` | last print (plan-dependent) |
| `underlying_asset.price/ticker/timeframe` | underlying price + recency |

Only `open_interest`, `greeks` and `details` are required for GEX/max pain; a
plan without quotes or trades still produces valid analytics, with `bid`/`ask`
and `lastPrice` set to `null`.

## Pagination

Responses carry `next_url` (with a `cursor`). The CLI follows it until the data
runs out or `--max-pages` (default 20) / `--max-items` (default 5000) is hit; a
cap trip adds a warning and sets `meta.pages`. `next_url` is always fetched with
the Authorization header, so the cursor never carries the key.

## Quirks handled by this CLI

- **403 vs 401.** A *valid* key on the wrong plan returns
  `403 {"status":"NOT_AUTHORIZED","message":"You are not entitled to this data…"}`.
  The CLI maps this to exit `3` with a plan hint; a missing/invalid key (401) is
  also exit `3` but with a key hint. Neither ever prints a partial report.
- **`implied_volatility` units.** Normally a decimal (`0.3049`), but values in
  percentage points have been observed (e.g. `5`). Anything `> 3` is treated as
  percent and divided by 100; results above 500% are discarded rather than fed
  into the gamma fallback (`normalizeIv`).
- **Missing greeks.** Deep-ITM rows can omit `greeks` entirely, and put/call
  parity is not usable for the whole chain. The CLI reconstructs gamma as
  `φ(d1)/(S·σ·√T)` from `implied_volatility` and the underlying price, marks the
  contract `gammaSource: "black-scholes"`, and emits a warning. Rows with neither
  gamma nor IV are excluded and counted.
- **Missing `open_interest`.** Treated as `0` exposure, counted in
  `missingOpenInterest`, never estimated.
- **Stock snapshot gating.** `/v2/snapshot/locale/us/markets/stocks/tickers/{t}`
  is often not included in an options plan. The CLI transparently falls back to
  `/v2/aggs/ticker/{t}/prev` and reports `source: "previous-close"`,
  `timeframe: "END-OF-DAY"`. Pass `--prefer-delayed` to skip the doomed request
  (saves one API call on tight rate limits).
- **Timestamps.** Quote timestamps are nanoseconds
  (`last_quote.last_updated`), aggregate bar timestamps are milliseconds (`t`).
- **Index underlyings.** `--spot` is required when the underlying is an index
  (e.g. `I:SPX`) and the options chain is traded on a different symbol.
- **Rate limits.** Entry plans allow roughly 5 requests/minute, answered with
  HTTP 429 (sometimes without `Retry-After`). The CLI retries 429/5xx/network
  errors with exponential backoff up to `--max-retries` (default 3) and
  `--max-wait` (default 60 s), printing retry notices on stderr; exceeding the
  cap exits `4`.
- **Offline mode.** `--from-file` reads a saved snapshot (either the raw
  `{"results":[…]}` response or a bare array). The file must contain
  `underlying_asset.price` or you must pass `--spot`.
