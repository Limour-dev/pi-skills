# `candles` command reference

Single entry point: `<skill-dir>/bin/tradingview` (a bash wrapper around
`node cli.ts`, runnable from any directory, no build step).

```bash
tradingview candles <SYMBOL> [flags]
```

stdout is JSON unless `--format csv|table|md`. Errors go to stderr as
`{"error":{"code","message","hint"?,"details"?}}`. See `../SKILL.md` for exit
codes. The only other commands are `version` and `help`.

## Flags

| Flag | Default | Effect |
| --- | --- | --- |
| `--tf`, `--timeframe TF` | `D` | `1 3 5 15 30 45 60 120 180 240 360 480 720` (minutes), `D W M`, `1S`; aliases `1m 5m 15m 1h 4h 1d 1w 1mo` |
| `--count N` | `100` | Most recent closed bars. Ignored when `--from` is given. |
| `--from T` | | Oldest bar. ISO (`2026-01-31`), Unix seconds, or relative (`-7d`, `-12h`, `-30m`). |
| `--to T` | newest closed bar | Newest bar; same formats as `--from`. |
| `--newest-first` | | Reverse the output order. |
| `--chart-type TYPE` | | `HeikinAshi`, `Renko`, `LineBreak`, `Kagi`, `PointAndFigure`, `Range`. |
| `--currency CUR` | | Convert prices, e.g. `--currency EUR`. |
| `--adjustment A` | `splits` | `splits` / `dividends` / `none`. |
| `--no-cache` | | Bypass the SQLite cache (always hit the network, no writes). |
| `--cache PATH` | `$TV_CACHE_DB` or the XDG cache dir | Cache database location. |
| `--format json\|csv\|table\|md` | `json` | Output format (`--csv`/`--table`/`--md` shorthands). |
| `--compact` | | One-line JSON. |
| `--select a,b,c` | | Keep only these fields (flat rows). |
| `--exchange X` | | Force an exchange for a bare symbol (`X:SYMBOL`). |
| `--type T` | | Restrict symbol search (`stock`, `crypto`, `forex`, `futures`, `index`, `bond`, …). |
| `--session regular\|extended` | `regular` | Trading session. |
| `--timeout MS` | `15000` | Per-call timeout; candles use at least `20000`. Transient errors (including HTTP 429) are retried with jittered backoff. |
| `--strict` / `--no-fallback` | | Do not fall back to symbol search; release/explicit names only. |
| `--quiet` | | Suppress the stderr resolution/warning notes. |
| `--help`, `--version` | | Help / versions and cache location. |

Flag parsing: `--name value` or `--name=value`. Boolean flags never consume the
next token, so `candles --quiet BTCUSD` keeps `BTCUSD` positional.

## Output

```json
{
  "input": "BTCUSD",
  "symbol": "BITSTAMP:BTCUSD",
  "resolved_from": "alias",
  "timeframe": "D",
  "count": 2,
  "coverage": { "first": "2026-10-02T00:00:00.000Z", "last": "2026-10-04T00:00:00.000Z" },
  "cache": { "enabled": true, "path": "~/.cache/tradingview/candles.sqlite", "reused": 15, "fetched": 2 },
  "candles": [
    { "time": 1790985600, "time_iso": "2026-10-03T00:00:00.000Z",
      "open": 84500.85, "high": 85008.25, "low": 84433.06, "close": 84746.87, "volume": 454.3093179 }
  ]
}
```

- `time` is the bar **open** time in Unix **seconds**; `time_iso` is UTC.
- `resolved_from` is `explicit` / `alias` / `search`.
- `coverage` is the first/last returned bar; `candles` is oldest-first unless
  `--newest-first`.
- `cache.reused` counts bars served from SQLite in the requested window,
  `cache.fetched` counts bars returned by the network on this call.
- `warnings` is present only when an incremental refresh failed while cached
  history was still usable.

For `csv`/`table`/`md` the columns are
`time_iso, open, high, low, close, volume`.

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
```

## Environment

| Variable | Meaning |
| --- | --- |
| `TV_CACHE_DB` | Cache database path (overridden by `--cache`) |
| `XDG_CACHE_HOME` | Base for the default cache path |
