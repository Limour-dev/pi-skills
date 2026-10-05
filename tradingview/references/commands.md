# `candles` / `indicators` command reference

Single entry point: `<skill-dir>/bin/tradingview` (a bash wrapper around
`node cli.ts`, runnable from any directory, no build step).

```bash
tradingview candles    <SYMBOL> [flags]   # closed OHLCV bars
tradingview indicators <SYMBOL> [flags]   # the 大道至简 indicator set
tradingview version                       # versions + cache location
tradingview help
```

stdout is JSON unless `--format csv|table|md`; resolution lines, notes and
warnings go to stderr, and errors are `{"error":{"code","message","hint"?,"details"?}}`.
See `../SKILL.md` for exit codes.

## Flags

| Flag | Default | Effect |
| --- | --- | --- |
| `--tf`, `--timeframe TF` | `D` | `1 3 5 15 30 45 60 120 180 240` (minutes), `D W M`; aliases `1m 3m 5m 15m 30m 45m 1h 2h 3h 4h 1d 1w 1mo` |
| `--count N` | `100` | Most recent closed bars. Ignored when `--from` is given. |
| `--from T` | | Oldest bar. ISO (`2026-01-31`), Unix seconds, or relative (`-7d`, `-12h`, `-30m`). |
| `--to T` | newest closed bar | Newest bar; same formats as `--from`. |
| `--newest-first` | | Reverse the output order. |
| `--warmup N` | `300` | `indicators` only: extra bars fetched before the window so the indicators are fully warmed up there. |
| `--chart-type TYPE` | | `HeikinAshi`, `Renko`, `LineBreak`, `Kagi`, `PointAndFigure`, `Range`. |
| `--currency CUR` | | Convert prices, e.g. `--currency EUR`. |
| `--adjustment A` | `splits` | `splits` / `dividends` / `none`. |
| `--no-cache` | | Bypass the SQLite cache (always hit the network, no writes). |
| `--cache PATH` | `$TV_CACHE_DB` or the XDG cache dir | Cache database location. |
| `--format json\|csv\|table\|md` | `json` | Output format (`--csv`/`--table`/`--md` shorthands). |
| `--compact` | | One-line JSON. |
| `--select a,b,c` | | Keep only these fields. |
| `--exchange X` | | Search for a bare symbol **inside** exchange `X` (candidate filter); falls back to the literal `X:SYMBOL` only when nothing matches. |
| `--type T` | | Restrict symbol search (`stock`, `crypto`, `forex`, `futures`, `index`, `bond`, …). |
| `--session regular\|extended` | `regular` | Trading session. |
| `--timeout MS` | `15000` | Per-call timeout; candles use at least `20000`. Transient errors (including HTTP 429) are retried with jittered backoff. |
| `--strict` / `--no-fallback` | | No symbol search, and unknown flags / `--select` fields are hard errors (exit 2). |
| `--quiet` | | Suppress the stderr resolution/note/warning lines. |
| `--help`, `--version` | | Help / versions and cache location. |

The `--tf` list above is generated from `TIMEFRAMES` in `src/util.ts`; the same
constant feeds the help text and the parse error, so they cannot disagree.
`360` / `480` / `720` minutes and seconds (`1S`) are **not** accepted: an
anonymous session answers `SERIES_ERROR` for them (exit 4), and they may still
require a paid account.

Flag parsing: `--name value` or `--name=value`. Boolean flags never consume the
next token, so `candles --quiet BTCUSD` keeps `BTCUSD` positional. Unknown flags
warn on stderr and are ignored unless `--strict` is set, so `--cout 30` cannot
silently fall back to `--count 100`.

## Output

### `candles`

```json
{
  "input": "BTCUSD",
  "symbol": "BITSTAMP:BTCUSD",
  "resolved_from": "alias",
  "symbol_kind": "crypto_spot",
  "unit": "price",
  "volume_reliable": true,
  "timeframe": "D",
  "count": 2,
  "coverage": { "first": "2026-10-02T00:00:00.000Z", "last": "2026-10-04T00:00:00.000Z" },
  "as_of": "2026-10-05T18:17:00.000Z",
  "last_bar_age": 152100,
  "stale": false,
  "cache": { "enabled": true, "path": "~/.cache/tradingview/candles.sqlite", "reused": 15, "fetched": 2 },
  "candles": [
    { "time": 1790985600, "time_iso": "2026-10-03T00:00:00.000Z",
      "open": 84500.85, "high": 85008.25, "low": 84433.06, "close": 84746.87, "volume": 454.3093179 }
  ]
}
```

- `time` is the bar **open** time in Unix **seconds**; `time_iso` is UTC.
- `resolved_from` is `explicit` / `alias` / `search`.
- `symbol_kind` / `unit` describe what the numbers mean; see `symbols.md`.
- `volume_reliable: false` marks derived indices, and their `volume` is `null`.
- `coverage` is the first/last returned bar; `candles` is oldest-first unless
  `--newest-first`.
- `as_of` is when the response was generated; `last_bar_age` is seconds since the
  last bar opened, `stale` is `true` past two bar lengths (2 × 31 days for `M`).
- `cache.reused` counts bars served from SQLite, `cache.fetched` counts bars
  fetched on this call.
- `warnings` is present only when an incremental refresh failed while cached
  history was still usable.
- `notes` is present when the resolver has something to say (e.g. `--exchange`).

For `csv`/`table`/`md` the columns are
`time_iso, open, high, low, close, volume`.

### `indicators`

Same envelope, plus:

```json
{
  "indicator": "dadao_zhijian",
  "indicator_title": "大道至简",
  "params": { "kc_length": 50, "kc_mult_inner": 2.75, "kc_mult_outer": 3.75,
              "median_length": 200, "macd_fast": 12, "macd_slow": 26, "macd_signal": 9 },
  "warmup_bars": 300,
  "series": [
    { "time": 1790985600, "time_iso": "2026-10-03T00:00:00.000Z",
      "kc1_mid": 0, "kc1_upper": 0, "kc1_lower": 0,
      "ema_high": 0, "ema_low": 0,
      "kc2_mid": 0, "kc2_upper": 0, "kc2_lower": 0,
      "kc_low_mid": 0, "kc_low_upper": 0, "kc_low_lower": 0,
      "median_200": 0, "macd": 0, "macd_signal": 0, "macd_hist": 0 }
  ]
}
```

For `csv`/`table`/`md` the columns are
`time_iso, kc1_mid, kc1_upper, kc1_lower, ema_high, ema_low, kc2_mid,
kc2_upper, kc2_lower, kc_low_mid, kc_low_upper, kc_low_lower, median_200,
macd, macd_signal, macd_hist`.

This is the **only** indicator set the skill computes; see `../SKILL.md` for the
Pine formulas. Values before an indicator's warmup window are `null`; the
default `--warmup 300` makes the returned window fully warmed up.

### `--select`

`--select` trims the row array only:

- `csv`/`table`/`md`: the header is exactly the selected fields — no empty columns;
- `json`: the top level stays an object (`symbol`, `coverage`, `cache`, `warnings`
  keep their place), and only the elements of `candles[]` / `series[]` are narrowed;
- an unknown field warns on stderr and is dropped; if nothing matches, or
  `--strict` is set, the command exits 2.

```console
$ tradingview candles BTCUSD --tf 1D --count 2 --select time_iso,close --format csv
time_iso,close
2026-10-03T00:00:00.000Z,84746.87
2026-10-04T00:00:00.000Z,86510.16
```

## Closed bars only

Only bars that have finished are requested, returned and stored. A bar is
considered closed once a full bar length has passed since its open time
(`time + timeframe <= now`; months close at the next month boundary). This is
timezone-independent and never leaks the in-progress bar. Because it is
conservative, a daily bar from an exchange that closes before its full 24 h are
up appears at the next day boundary, not at the closing bell.

## Cache behaviour

For every `(symbol, timeframe, chart options, session)` the CLI:

1. reads the cached bars in `[from, to]`;
2. computes the missing **head** (older than the cached start) and **tail**
   (newer than the cached end) and fetches only those;
3. writes the fetched closed bars back (`INSERT … ON CONFLICT DO UPDATE`).

A cold cache fetches the whole window once; later calls only top up the tail (and
the head when you ask for more history). If the network fails for an incremental
slice, the command still returns the cached bars and reports a `warning`.

The store is keyed by symbol + timeframe + a variant string covering
`chart-type`, `currency`, `adjustment` and `session`, so differently configured
requests never share rows.

## Examples

```bash
tradingview candles BTCUSD --tf 1D --count 30 --format csv
tradingview candles USDT.D --tf 4h --from -30d
tradingview candles TVC:US10Y --tf W --count 52 --select time_iso,close
tradingview candles BINANCE:BTCUSDT --tf 1h --count 24 --cache ~/tv.sqlite
tradingview candles CRYPTOCAP:USDT.D --tf 240 --count 50 --no-cache
tradingview candles SOL --exchange BINANCE --tf 1D --count 30
tradingview indicators BTCUSD --tf 1D --count 30 --select time_iso,macd,macd_hist
tradingview indicators BINANCE:SOLUSDT --tf 4h --from -30d --format table
```

## Environment

| Variable | Meaning |
| --- | --- |
| `TV_CACHE_DB` | Cache database path (overridden by `--cache`) |
| `XDG_CACHE_HOME` | Base for the default cache path |
| `TV_SESSION`, `TV_SIGNATURE` | Optional TradingView account cookies |
