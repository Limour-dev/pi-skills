# Library mapping, cache internals, limits and maintenance

This skill is a thin CLI over
[`@mathieuc/tradingview`](https://github.com/Mathieu2301/TradingView-API) v4.
It does not re-implement any protocol: `candles` maps to one data-API function,
and every bar it sees is persisted in SQLite. This file records what is used,
the upstream limits, and how to keep the skill working.

## Version

- Pinned dependency: `@mathieuc/tradingview@4.0.0-rc.0` (npm dist-tag `next`).
- `4.0.0-beta.5` is the `beta` dist-tag; `latest` is still the v3 line
  (`3.5.2`) with the old `Client` API and **no** `getCandles` data API. Do not
  install `@mathieuc/tradingview` without the prerelease tag.
- Node ≥ 22.13 is required: the CLI runs TypeScript directly (type stripping)
  and uses the built-in `node:sqlite` module (unflagged since 22.13).
- ESM only, TypeScript declarations included.

Upgrade:

```bash
cd <skill-dir>
npm install @mathieuc/tradingview@next   # or a pinned 4.x version
npx tsc --noEmit                          # type-check the CLI against it
npm run smoke                             # live smoke tests
```

## Command → function

| Command | Data-API function |
| --- | --- |
| `candles` | `getCandles({symbol, timeframe, from, to, chartType?, currency?, adjustment?, session?})` |
| `indicators` | `getCandles(...)` (same loader) + local math in `src/indicators.ts` |
| resolution | `searchMarkets` + curated aliases (local, `src/symbols.ts`) |

`TradingViewError` is the only error type; the CLI maps `error.code` to an exit
code (see `src/output.ts`).

### Errors

| Code | Meaning | CLI exit |
| --- | --- | --- |
| `INVALID_ARGUMENT` | Bad query, checked before connecting | 2 |
| `SYMBOL_ERROR` / `NO_DATA` / `NOT_FOUND` | Unknown symbol / empty range | 3 |
| `SERIES_ERROR` | Server-side resolution/permission refusal (e.g. a paid-only resolution) | 4 |
| `TIMEOUT` / `ABORTED` | Didn't answer in time / cancelled | 5 |
| `DISCONNECTED` / `CONNECTION_ERROR` / `HTTP_ERROR` / `PROTOCOL_ERROR` / `PARSE_ERROR` | Transport / decoding | 6 |
| `CRITICAL_ERROR` / `CALLBACK_ERROR` | Command refused | 1 |

`error.details` keeps the raw server payload when present.

## The cache

`src/cache.ts` opens `node:sqlite`'s `DatabaseSync` and keeps one table:

```sql
CREATE TABLE candles (
  symbol TEXT, timeframe TEXT, variant TEXT, time INTEGER,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (symbol, timeframe, variant, time)
) WITHOUT ROWID;
```

- `variant` = `chart-type|currency|adjustment|session`; it keeps differently
  configured series apart.
- Writes are one transaction of `INSERT … ON CONFLICT(symbol,timeframe,variant,time)
  DO UPDATE`, so overlapping head/tail fetches never duplicate rows.
- `PRAGMA journal_mode = WAL` + `busy_timeout = 5000` let several CLI processes
  read and write at once.
- Default path: `$TV_CACHE_DB`, else `$XDG_CACHE_HOME/tradingview/candles.sqlite`,
  else `~/.cache/tradingview/candles.sqlite`.

`cli.ts` (`loadCandles`) reads the requested window, then fetches only the
missing head/tail slices. A slice whose `to` exactly matches a bar open time is
requested as `to + 1` because upstream treats `to` as exclusive. Fetched bars
are filtered with `isBarFinished` (`src/util.ts`) before being written.

## Upstream limits (as of the 4.0.0-rc.0 docs and our tests)

- **Anonymous** access is limited: in upstream tests about 7 000 one-minute
  bars; reference times (`to`) in the past are capped. History stops early
  without error when the server has no more bars.
- **Substitute feeds.** Anonymous sessions may be served by another venue
  (`NASDAQ:AAPL` → `BATS:AAPL`) while `pro_name` keeps the requested symbol.
- **Delays.** Futures (and possibly other feeds) can be delayed for anonymous
  users by roughly 10 minutes.
- **Candle `to` is exclusive.** A range `[from, to]` returns bars with
  `from <= time < to`; request `to + 1` to include a bar sitting on the edge.
- **No auto-reconnect.** Each call opens and closes its own websocket.
- **Rate limiting (HTTP 429).** A burst of concurrent commands makes
  TradingView answer excess handshakes with `429`. The CLI retries transient
  transport errors (including 429) with an exponential, jittered backoff and
  reports them as `NETWORK_ERROR`/`TIMEOUT` (exit 6/5), not `NOT_FOUND`.

## Candle options exposed by the library

| Library option | CLI flag | Default |
| --- | --- | --- |
| `symbol` | positional | required |
| `timeframe` | `--tf` | `D` |
| `count` | `--count` | 100 (only when `--from` is absent) |
| `from` / `to` | `--from` / `--to` | window start / newest closed bar |
| `maxCount` | — | 20 000 |
| `chartType` | `--chart-type` | regular |
| `chartInputs` | — | |
| `currency` | `--currency` | |
| `session` | `--session` | `regular` |
| `adjustment` | `--adjustment` | `splits` |
| `backAdjustment`, `timezone` | — | |
| `timeoutMs` | `--timeout` | 15 000 (candles use ≥ 20 000) |

`chartType: "HeikinAshi" | "Renko" | "LineBreak" | "Kagi" | "PointAndFigure" | "Range"`.

## Timeframes and time

`1 3 5 15 30 45 60 120 180 240` (minutes), `D W M`, plus `1m 3m 5m 15m 30m 45m
1h 2h 3h 4h 1d 1w 1mo` aliases. The list lives in one place — `TIMEFRAMES` /
`TIMEFRAME_HELP` in `src/util.ts` — and feeds the help text, the parse error and
`references/commands.md`. `360` / `480` / `720` minutes and seconds (`1S`) are
**not** accepted: the CLI rejects them locally as a `USAGE` error (exit 2),
before any network call. `SERIES_ERROR` (exit 4) is only for a resolution the
*server* refuses (e.g. one that needs a paid account). Upstream also knows
`3M 6M 12M`, which the CLI does not expose.

Candle `time` is the bar **open** time in Unix **seconds**; the CLI adds
`time_iso` (UTC). A bar is closed when `time + length <= now` (months close at
the next month boundary).

## Indicators (`src/indicators.ts`)

`indicators` is pure Node.js math over the candles the loader already returned —
no extra TradingView call and no account. It implements exactly the 大道至简 set
(and nothing else) with TradingView `ta.*` semantics:

| Function | Semantics |
| --- | --- |
| `sma(v, n)` | mean of the last `n`; `na` until `n` values exist |
| `ema(v, n)` | `alpha = 2/(n+1)`, seeded with `sma(v, n)`, then recursive |
| `rollingMedian(v, n)` | statistical median; an even `n` averages the two middle values |
| `trueRange(h, l, c)` | `max(h-l, |h-c[-1]|, |l-c[-1]|)`; first bar falls back to `h-l` |
| `keltnerChannels(...)` | basis `ema(src, n)`, span `ema(ta.tr, n)`, bands `basis ± span*mult` |
| `macd(c, 12, 26, 9)` | `macd = ema12 - ema26`, `signal = sma(macd, 9)`, `hist = 2*(macd - signal)` |
| `hlcc4(h, l, c)` | `(h + l + 2c) / 4` |

`computeDadaoZhiJian` composes them into the plot set;
`warmupBars()` returns 300 (the default `--warmup`). The command fetches
`count + warmup` bars, computes over all of them and returns only the requested
window, so `median_200` / the EMAs at the left edge are already warmed up. The
pure functions are covered offline by `tests/indicators.test.ts`.

## Maintenance checklist

```bash
cd <skill-dir>
npm install          # after cloning
npx tsc --noEmit     # type-check
npm test             # offline unit tests (indicators + CLI contracts)
npm run smoke        # live candle requests; needs network
```

- Aliases live in `src/symbols.ts` (`ALIASES`, `EXCHANGE_PRIORITY`,
  `TYPE_PRIORITY`). Verify new entries with a live candle request.
- Timeframes are single-sourced in `TIMEFRAMES` (`src/util.ts`); help, errors and
  `references/commands.md` must follow it.
- Indicator math and its offline tests live in `src/indicators.ts` and
  `tests/indicators.test.ts`; `--select`/flag/unit contracts are in
  `tests/cli-lib.test.ts`.
- Exit-code mapping lives in `src/output.ts` (`TV_ERROR_CODES`, `EXIT`).
- Bar-close math and cache location live in `src/util.ts` and `src/cache.ts`.
- The remaining upstream-reality notes (delays, sentinel volumes, substitute
  feeds) are in `references/symbols.md`.

## Attribution

TradingView is a trademark of its owner. This skill is an independent,
read-only client of a community library and is not affiliated with or endorsed
by TradingView. Respect your data provider's terms and market-data permissions.
