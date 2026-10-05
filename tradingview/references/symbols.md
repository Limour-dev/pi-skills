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
4. **Unresolved** — `symbol: null`; pass an explicit `EXCHANGE:SYMBOL` instead.

Ranking (`scoreHit`) prefers, in order: an exact `id` match, an exact `symbol`
match, a preferred exchange (`EXCHANGE_PRIORITY`), a preferred instrument type
(`TYPE_PRIORITY`), and penalises `OTC` pink-sheet equities (a common
autocomplete trap).

### Continuous futures (`ROOT<N>!`)

TradingView's autocomplete strips the `1!` suffix: searching `CNH1!` returns
`CME:CNH`. The resolver detects the `ROOT<N>!` shape, searches the root
(`CNH`), and reconstructs `${exchange}:${root}${N}!` for every root match.
`CNH1!` → `CME:CNH1!`, `ES1!` → `CME_MINI:ES1!`. Reconstructed symbols are
`CNH1!` → `CME:CNH1!`, `ES1!` → `CME_MINI:ES1!`. Reconstructed symbols are
`confidence: medium` because they are not verified by the search response.

### Resolution and fetch

`candles` resolves one symbol and fetches it directly; the resolved name and how
it was found are reported in the output as `symbol` and `resolved_from`
(`explicit` / `alias` / `search`). Pass `--strict` to skip the search step
(alias + explicit only). A wrong top search hit is the usual cause of
odd-looking bars — pass `EXCHANGE:SYMBOL` explicitly when in doubt.

## Built-in aliases

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

- **Unit traps.** `CRYPTOCAP:*.D` values are **percent** and `TOTAL` is USD;
  `TVC:USxxY` values are **yield percent**. Candle prices are not unit-annotated,
  so read the alias table above before interpreting a number.
- **Delayed feeds.** Anonymous futures feeds can be delayed by roughly 10
  minutes (e.g. `CME:CNH1!` in our tests). Say so when reporting bars.
- **Bond volume sentinel.** `TVC:USxxY` can report `volume: 1e+100`. Treat it as
  missing, never as real volume.
- **Substitute feeds.** Anonymous sessions may be served by another exchange
  (`NASDAQ:AAPL` from `BATS:AAPL`) while `pro_name` keeps `NASDAQ:AAPL`.
- **`searchMarkets('CNH1!')` ≠ `CNH1!`.** Search drops the `!`; use the alias or
  `EXCHANGE:CNH1!`.
- **Some symbols look alike but differ.** `FX:USDCNH` (spot) vs `CME:CNH1!`
  (futures); `TVC:US03M` (discount price) vs `TVC:US03MY` (yield);
  `CRYPTOCAP:SOL` (index) vs `BINANCE:SOLUSDT` (tradeable pair).
- **Deep history is truncated anonymously.** `from` ranges and `to` values in
  the past load less than requested with no error; the library reports the
  server's `data_completed: "limit"` / `"end"` reason when it can.

## Discovery

There is no standalone search command — `candles` resolves a bare name through
`searchMarkets` internally and reports what it picked as `resolved_from` /
`symbol`. When in doubt, write `EXCHANGE:SYMBOL` yourself. `--type` still
filters the internal search (`stock`, `futures`, `forex`, `cfd`, `crypto`,
`index`, `economic`, `bond`, `fund`), and `--exchange` forces a prefix.

## Adding aliases

Edit `ALIASES` in `src/symbols.ts`. Keep keys uppercase and only add targets you
verified with a live candle request:

```bash
tradingview candles <EXCHANGE:SYMBOL> --tf 1D --count 1 --strict
```

`--strict` skips the search fallback, so a success proves the exact symbol.
