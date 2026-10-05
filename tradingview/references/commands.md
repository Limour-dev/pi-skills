# Command reference

Single entry point: `<skill-dir>/bin/tradingview` (a bash wrapper around
`node cli.ts`, runnable from any directory, no build step).

```bash
tradingview <command> [args] [flags]
```

stdout is JSON unless `--format csv|table|md`. Errors go to stderr as
`{"error":{"code","message","hint"?,"details"?}}`. See `../SKILL.md` for exit
codes.

## Global flags

| Flag | Effect |
| --- | --- |
| `--format json\|csv\|table\|md` | Output format (default `json`; `--csv`/`--table`/`--md` shorthands) |
| `--compact` | Single-line JSON |
| `--select a,b,c` | Keep only these fields (flat rows) |
| `--exchange X` | Prefix bare symbols with `X:` |
| `--type stock\|crypto\|forex\|futures\|index\|bond\|…` | Restrict symbol search by type |
| `--session regular\|extended` | Trading session for quotes/candles |
| `--timeout MS` | Per-call timeout (default 15000; candles use ≥20000 internally). Transient errors, including TradingView's HTTP 429 rate limit, are retried with jittered backoff before this fails. |
| `--strict` | No search fallback; only the resolved symbol |
| `--no-fallback` | Alias/explicit only; never search |
| `--raw` | Raw upstream objects (quote, info) |
| `--quiet` | Suppress informational stderr notes (errors are still printed) |
| `--help`, `--version` | Help / versions |

Flag parsing: `--name value` or `--name=value`. Boolean flags never consume the
next token, so `quote --raw BTCUSD` keeps `BTCUSD` positional.

## quote

`quote <SYMBOL...>` — one row per input. Tries a single batched request, then
falls back to per-symbol requests with candidate fallback.

Row fields: `input`, `symbol`, `resolved_from`, `description`, `exchange`,
`type`, `currency`, `last`, `change`, `change_pct`, `bid`, `ask`, `open`,
`high`, `low`, `prev_close`, `volume`, `format`, `update_mode`, `time`,
`time_iso`. Failures instead produce `{input, error, symbol?}`.

```bash
tradingview quote USDT.D US10Y CNH1! BTCUSD --format table
tradingview quote AAPL MSFT NVDA --select input,last,change_pct
tradingview quote BINANCE:BTCUSDT --raw
```

If **every** input fails the command exits 3 with the rows in `error.details`;
partial failures stay exit 0 with per-row `error`.

## candles

`candles <SYMBOL>` — OHLCV bars.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--tf`, `--timeframe` | `D` | `1 5 15 60 240` (minutes), `D W M 1S`; aliases `1m 5m 15m 1h 4h 1d 1w 1mo` |
| `--count N` | 100 | Most recent bars (deep history auto-batched) |
| `--from T` | | Oldest bar time (ISO, Unix seconds, or `-7d`/`-12h`/`-30m`); `count` ignored |
| `--to T` | now | Newest bar time |
| `--chart-type` | | `HeikinAshi`, `Renko`, `LineBreak`, `Kagi`, `PointAndFigure`, `Range` |
| `--currency` | | Convert prices, e.g. `EUR` |
| `--adjustment` | `splits` | `splits` / `dividends` / `none` |
| `--newest-first` | | Reverse the output order |

JSON shape: `{input, symbol, timeframe, count, coverage:{first,last}, candles:[…]}`.
Each candle: `time` (Unix seconds, bar open), `time_iso`, `open`, `high`, `low`,
`close`, `volume`.

```bash
tradingview candles BTCUSD --tf 1D --count 30 --format csv
tradingview candles BINANCE:BTCUSDT --tf 4h --from -7d
tradingview candles TVC:US10Y --tf W --count 52 --select time_iso,close
```

## watch

`watch <SYMBOL...>` — NDJSON stream to stdout.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--kind quote\|candles` | `quote` | What to stream |
| `--duration SEC` | 0 (until SIGINT) | Stop after N seconds |
| `--max-events N` | 0 (unlimited) | Stop after N data frames |
| `--changes-only` | | Quote kind: emit only when `last/chp/bid/ask` change |
| `--tf`, `--count` | `1`, 50 | Candle kind only |

Frames: `{"event":"start",…}`, `{"event":"quote"|"candle", ts, symbol, input, …}`,
`{"event":"error",…}`, `{"event":"stop", events, stopped_at}`. A first quote
frame can arrive before `bid`/`ask` are populated; later frames fill them.

```bash
tradingview watch BTCUSD --duration 20 --changes-only
tradingview watch BINANCE:BTCUSDT --kind candles --tf 1 --duration 15
```

Always bound a watch with `--duration` or `--max-events` in automation, and
close with SIGINT to stop early.

## ta

`ta <SYMBOL>` — TradingView scanner technical ratings per period
(`1 5 15 60 240 1D 1W 1M`), each `{all, ma, other, label}`. Values are on the
`-2 … +2` scale (`all` is the summary). `label` maps to strong sell / sell /
neutral / buy / strong buy.

```bash
tradingview ta BTCUSD --format table
```

## indicator

`indicator <SYMBOL>` — run an indicator/strategy once.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--indicator ID` | required | `STD;RSI`, `PUB;xxxx`, `USER;xxxx`, or built-in `Volume@tv-basicstudies-241` |
| `--tf`, `--timeframe` | `60` | |
| `--inputs JSON` | | Pine inputs / built-in options, e.g. `{"Length":21}` |
| `--last N` | 5 | Number of value rows |
| `--all` | | Every value row |

JSON: `{input, symbol, indicator, timeframe, candles, bars, plots:[…],
strategy_report, values:[{time, time_iso, …plots}]}`.

- **Built-in studies work anonymously** (`Volume@tv-basicstudies-241`).
- **Pine studies need account cookies** — without them you get `STUDY_ERROR`
  ("maximum number of studies…", exit 4). Export `TV_SESSION` + `TV_SIGNATURE`.
- `plot_N` keys are unnamed/duplicate plots; named plots keep their names.

```bash
tradingview indicator BTCUSD --indicator Volume@tv-basicstudies-241 --tf 1D --last 3
TV_SESSION=… TV_SIGNATURE=… tradingview indicator BTCUSD --indicator 'STD;RSI' --inputs '{"Length":21}'
```

## search

`search <text>` — `searchMarkets` wrapper. Flags: `--type`, `--exchange`,
`--country`, `--limit` (default 15), `--offset`. JSON:
`{query, total, returned, results:[{id, symbol, exchange, description, type, currency, country}]}`.

```bash
tradingview search "offshore yuan" --type forex --limit 5
tradingview search AAPL --exchange NASDAQ --format csv
```

## info

`info <SYMBOL>` — symbol metadata: `name`, `description`, `exchange`,
`listed_exchange`, `type`, `currency`, `timezone`, `session`, `pricescale`,
`format`, `is_tradable`, `has_intraday`, `typespecs`. `--raw` for the full
upstream object.

```bash
tradingview info CNH1!
tradingview info BINANCE:BTCUSDT --select symbol,exchange,timezone,session
```

Anonymous sessions can be served by a substitute exchange — compare
`full_name` (`CME_DL:CNH1!`) with the requested symbol (`CME:CNH1!`).

## screener

`screener` — one scanner page (not a live subscription).

| Flag | Default | Meaning |
| --- | --- | --- |
| `--market` | `america` | `america`, `crypto`, `forex`, `global`, … |
| `--columns a,b,c` | required | Exact scanner field names; include every field used in filter/sort |
| `--filter JSON` | | `[{"left","operation","right"}]` |
| `--sort field:asc\|desc` | | |
| `--range A:B` or `--limit N` | `[0,50]` | Zero-based, end-exclusive |
| `--symbols A,B` | | Restrict to explicit symbols |

JSON: `{totalCount, columns, returned, rows:[{symbol, …values}]}`.
An invalid filter operation is `HTTP_ERROR` (exit 6). An unknown **column**
comes back as `null` and an unknown sort field is ignored, so verify field
names instead of trusting silence.

```bash
tradingview screener --market america \
  --columns 'name,close,change,volume,RSI|60' \
  --filter '[{"left":"RSI|60","operation":"less","right":30}]' \
  --sort volume:desc --limit 20 --format table

tradingview screener --market crypto \
  --columns 'name,close,change,volume,market_cap_calc' \
  --sort market_cap_calc:desc --limit 10
```

## hotlist

`hotlist --kind gainers|losers|mostActive|volumeGainers` — scanner-ranked list.
Flags: `--market` (default `america`), `--limit`/`--range`, `--columns`.
Default columns: name, close, change, volume, relative_volume_10d_calc. For a
non-`america` market the default stock filter is cleared automatically.

```bash
tradingview hotlist --kind gainers --limit 10 --format table
tradingview hotlist --kind volumeGainers --market crypto --limit 10
```

The top `gainers` are often OTC microcaps with huge percentage moves, and
crypto `volumeGainers` surfaces near-zero-liquidity pairs with absurd relative
volume. Filter by market cap / volume with `screener` when that matters.

## watchlists

`watchlists` — read-only account watchlists. Requires `TV_SESSION` +
`TV_SIGNATURE`; without them it exits 4. `--brief` omits the symbol arrays.

JSON rows: `{id, name, symbol_count, symbols?}`. Treat names/symbols as private.

## resolve

`resolve <SYMBOL...>` — show how each input resolves without fetching data.

| Flag | Meaning |
| --- | --- |
| `--verify` | Send a real quote request to the primary symbol and each alternative; report `verified:[{symbol, ok, last?/error?}]` and pick the first that works |
| `--candidates` | Include the raw search candidates |
| `--exchange`, `--type` | Same as global |

Rows: `{input, symbol, source, confidence, alternatives, notes, candidates?, verified?}`.
A one-line summary is also written to stderr unless `--quiet`.

## aliases

`aliases` — the built-in alias table as `{alias, symbol}` rows.

## probe

`probe` — runs a real `getQuote` and a real `searchMarkets`, returning
`{ok, cli, library, node, credentials, checks:{quote:{ok,latency_ms,value},search:{…}}}`.
Use it first when a command fails: it separates "network/blocked" from
"that symbol is wrong".

## version

`version` — `{cli, library, node, credentials}`.

## Environment

| Variable | Meaning |
| --- | --- |
| `TV_SESSION` (or `TV_SESSIONID`) | `sessionid` cookie |
| `TV_SIGNATURE` (or `TV_SESSIONID_SIGN`) | `sessionid_sign` cookie |

Credentials are read from the environment only; the CLI never echoes them.
