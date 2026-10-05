# Symbols and resolution

Everything TradingView serves is addressed as `EXCHANGE:SYMBOL`
(`BINANCE:BTCUSDT`, `NASDAQ:AAPL`, `TVC:US10Y`, `CME:CNH1!`). This file explains
how the CLI turns bare names into that form, lists the built-in aliases, and
collects the unit / feed traps that produce wrong-looking numbers.

## How resolution works

`resolveSymbol(input)` in `src/symbols.ts` walks these steps in order:

1. **Explicit** — `input` contains `:` → used verbatim. Or `--exchange X` was
   passed with a bare name → `X:input`.
2. **Alias** — `input` (uppercased) is a key in the curated `ALIASES` table.
   Confidence `high`, no network call.
3. **Search** — `searchMarkets(input)` (optionally filtered by `--type`), then
   candidates are ranked. Confidence is `high` when a hit's `symbol` matches the
   input exactly, otherwise `medium`. Up to 4 runners-up are kept as
   `alternatives`.
4. **Unresolved** — `symbol: null`; the caller must `search` or pass an explicit
   symbol.

Ranking (`scoreHit`) prefers, in order: an exact `id` match, an exact `symbol`
match, a preferred exchange (`EXCHANGE_PRIORITY`), a preferred instrument type
(`TYPE_PRIORITY`), and penalises `OTC` pink-sheet equities (a common
autocomplete trap).

### Continuous futures (`ROOT<N>!`)

TradingView's autocomplete strips the `1!` suffix: searching `CNH1!` returns
`CME:CNH`. The resolver detects the `ROOT<N>!` shape, searches the root
(`CNH`), and reconstructs `${exchange}:${root}${N}!` for every root match.
`CNH1!` → `CME:CNH1!`, `ES1!` → `CME_MINI:ES1!`. Reconstructed symbols are
`confidence: medium` because they are not verified by the search response —
`resolve CNH1! --verify` sends a real quote request to each candidate.

### Fallback at fetch time

`quote` and `candles` try the resolved symbol first, then each `alternative`,
and report which one succeeded in `resolved_from` / `symbol`. This is why
`quote SOL` still returns data even when the top search hit is an index. Pass
`--strict` to disable fallback, or `--no-fallback` to also disable the search
step (alias + explicit only).

## Built-in aliases (`tradingview aliases`)

All targets below were verified against a live `getQuote` call on 2026-10-05.

### Crypto dominance & market cap — `CRYPTOCAP`

| Alias | Symbol | Notes |
| --- | --- | --- |
| `BTC.D` | `CRYPTOCAP:BTC.D` | BTC dominance, **percent** |
| `ETH.D` | `CRYPTOCAP:ETH.D` | ETH dominance, **percent** |
| `USDT.D` | `CRYPTOCAP:USDT.D` | USDT dominance, **percent** |
| `USDC.D` | `CRYPTOCAP:USDC.D` | USDC dominance, **percent** |
| `OTHERS.D` | `CRYPTOCAP:OTHERS.D` | ex-top-10 dominance, **percent** |
| `TOTAL` | `CRYPTOCAP:TOTAL` | total crypto market cap, **USD** |
| `TOTAL2` | `CRYPTOCAP:TOTAL2` | total ex-BTC, USD |
| `TOTAL3` | `CRYPTOCAP:TOTAL3` | total ex-BTC/ETH, USD |

These have `format: "percent"` or `"volume"` in the quote, **not** `"price"`.
`USDT.D = 6.39` means 6.39%, not $6.39.

### US treasuries — `TVC` (yields, percent)

| Alias | Symbol | Notes |
| --- | --- | --- |
| `US1Y` | `TVC:US01Y` | |
| `US2Y` | `TVC:US02Y` | |
| `US3Y` | `TVC:US03Y` | |
| `US5Y` | `TVC:US05Y` | |
| `US7Y` | `TVC:US07Y` | |
| `US10Y` | `TVC:US10Y` | |
| `US20Y` | `TVC:US20Y` | |
| `US30Y` | `TVC:US30Y` | |
| `US3M` | `TVC:US03MY` | **yield**; `TVC:US03M` is the ~99 discount price |
| `US6M` | `TVC:US06MY` | **yield** |

There is no `TVC:US2Y` — the zero-padded names (`US02Y`) are the real ones.
`volume` on these can be the sentinel `1e+100`; ignore it.

### Other macro benchmarks — `TVC` / `SP`

| Alias | Symbol |
| --- | --- |
| `DXY` | `TVC:DXY` |
| `VIX` | `TVC:VIX` |
| `GOLD` | `TVC:GOLD` |
| `XAUUSD` | `OANDA:XAUUSD` |
| `SILVER` | `TVC:SILVER` |
| `XAGUSD` | `OANDA:XAGUSD` |
| `WTI` / `USOIL` | `TVC:USOIL` |
| `BRENT` / `UKOIL` | `TVC:UKOIL` |
| `SPX` / `SP500` | `SP:SPX` |
| `NDX` / `NAS100` | `NASDAQ:NDX` |
| `NI225` | `TVC:NI225` |
| `JP10Y` / `CN10Y` / `CN2Y` | `TVC:JP10Y` / `TVC:CN10Y` / `TVC:CN02Y` |

### FX spot — `FX` / `FX_IDC`

| Alias | Symbol |
| --- | --- |
| `EURUSD` | `FX:EURUSD` |
| `GBPUSD` | `FX:GBPUSD` |
| `USDJPY` | `FX:USDJPY` |
| `AUDUSD` | `FX:AUDUSD` |
| `USDCNH` | `FX:USDCNH` (offshore yuan **spot**) |
| `USDCNY` | `FX_IDC:USDCNY` (onshore; `FX:USDCNY` does **not** exist) |

### Crypto spot

| Alias | Symbol |
| --- | --- |
| `BTCUSD` | `BITSTAMP:BTCUSD` |
| `ETHUSD` | `BITSTAMP:ETHUSD` |
| `BTCUSDT` | `BINANCE:BTCUSDT` |
| `ETHUSDT` | `BINANCE:ETHUSDT` |
| `SOLUSDT` | `BINANCE:SOLUSDT` |
| `BTCUSDC` | `BINANCE:BTCUSDC` |

`BTCUSD` and `BTCUSDT` are different instruments on different venues; a small
difference is normal (Tether basis + venue spread). Say which one you used.

### Continuous futures front month

| Alias | Symbol | Contract |
| --- | --- | --- |
| `CNH1!` | `CME:CNH1!` | Offshore yuan |
| `ES1!` | `CME_MINI:ES1!` | E-mini S&P 500 |
| `NQ1!` | `CME_MINI:NQ1!` | E-mini Nasdaq-100 |
| `YM1!` | `CBOT:YM1!` | E-mini Dow |
| `CL1!` | `NYMEX:CL1!` | Crude oil |
| `NG1!` | `NYMEX:NG1!` | Natural gas |
| `GC1!` | `COMEX:GC1!` | Gold |
| `SI1!` | `COMEX:SI1!` | Silver |
| `ZN1!` | `CBOT:ZN1!` | 10-year T-note |
| `6E1!` | `CME:6E1!` | Euro FX |
| `6J1!` | `CME:6J1!` | Japanese yen |
| `BTC1!` | `CME:BTC1!` | Bitcoin futures |

`CME:CNH1` (no `!`) is **invalid** — the `!` is required for continuous
contracts. `CME:CNH2!` is next month.

## Common exchange prefixes

| Prefix | Covers |
| --- | --- |
| `CRYPTOCAP` | crypto market-cap / dominance indices (synthetic) |
| `TVC` | TradingView-computed macro: yields, DXY, VIX, gold, oil, indices |
| `SP`, `NASDAQ`, `NYSE`, `AMEX`, `ARCA`, `CBOE` | US equities / indices |
| `BINANCE`, `BITSTAMP`, `COINBASE`, `CRYPTO`, `INDEX` | crypto |
| `FX`, `FX_IDC`, `OANDA` | forex / CFDs / metals |
| `CME`, `CME_MINI`, `COMEX`, `NYMEX`, `CBOT` | CME-group futures |
| `TVC:UKOIL` etc. | CFDs on macro underlyings |

Use `--exchange PREFIX` to force a bare name onto an exchange, or
`EXCHANGE:SYMBOL` directly.

## Gotchas

- **`format` decides the unit.** Read `format` from `quote`/`info`:
  `percent` → the number is a percentage; `price` → a price; `volume` → a USD
  amount (crypto market cap). Do not assume every number is a price.
- **Delayed feeds.** Quote rows carry `update_mode`. `streaming` is live;
  `delayed_streaming_600` means roughly a 10-minute delay (common for
  anonymous futures access, e.g. `CME:CNH1!` in our tests). Always mention it.
- **Bond volume sentinel.** `TVC:USxxY` can report `volume: 1e+100`. Treat it as
  missing, never as real volume.
- **Substitute feeds.** Anonymous sessions may be served by another exchange
  (`NASDAQ:AAPL` quoted from `BATS:AAPL`) while `pro_name` keeps `NASDAQ:AAPL`.
  `info` shows `exchange` / `listed_exchange` / `full_name`.
- **`searchMarkets('CNH1!')` ≠ `CNH1!`.** Search drops the `!`; use the alias or
  `EXCHANGE:CNH1!`.
- **Some symbols look alike but differ.** `FX:USDCNH` (spot) vs `CME:CNH1!`
  (futures); `TVC:US03M` (discount price) vs `TVC:US03MY` (yield);
  `CRYPTOCAP:SOL` (index) vs `BINANCE:SOLUSDT` (tradeable pair).
- **Deep history is truncated anonymously.** `from` ranges and `to` values in
  the past load less than requested with no error; the library reports the
  server's `data_completed: "limit"` / `"end"` reason when it can.

## Discovery

```bash
tradingview search "offshore yuan" --type forex --limit 5
tradingview search "S&P 500" --type futures --limit 5
tradingview info BINANCE:BTCUSDT            # exchange, session, timezone, pricescale
tradingview aliases --format csv            # the whole built-in table
```

`searchMarkets` options exposed as flags: `--type stock|futures|forex|cfd|crypto|index|economic|bond|fund`,
`--exchange EXCHANGE`, `--country US`, `--limit N`, `--offset N`.

## Adding aliases

Edit `ALIASES` in `src/symbols.ts`. Keep keys uppercase and only add targets you
verified with a live call:

```bash
tradingview quote <EXCHANGE:SYMBOL> --strict
```

`--strict` skips the search fallback, so a success proves the exact symbol.
