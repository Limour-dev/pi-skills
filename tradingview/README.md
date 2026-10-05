# tradingview

Read-only **TradingView OHLCV candles** for agents and scripts, built on
[`@mathieuc/tradingview`](https://github.com/Mathieu2301/TradingView-API) v4 and
backed by a local **SQLite cache**.

```bash
tradingview candles BTCUSD --tf 1D --count 30 --format table
```

```
time_iso                  open      high      low       close     volume
────────────────────────  ────────  ────────  ────────  ────────  ───────────
2026-09-30T00:00:00.000Z  83636.77  85600     82922.8   83562.58  1819.358925
2026-10-01T00:00:00.000Z  83555.46  85232.94  83130.14  84852.65  1410.0593
2026-10-02T00:00:00.000Z  84851.22  87219.4   83841.27  84500.84  1966.83679
```

## What it does

| Need | Command |
| --- | --- |
| Candles / OHLCV | `candles <SYM> --tf 1D --count 30` |
| A historical window | `candles <SYM> --tf 4h --from -30d` |
| A closed-only range | `candles <SYM> --tf 1D --from 2026-01-01 --to 2026-02-01` |
| Bypass the cache | `candles <SYM> --no-cache` |

That is the whole surface: `candles` (plus `version` and `help`).

### Only closed bars

The bar that is still forming is never requested, returned or cached. A bar
counts as closed only once a full bar length has elapsed since its open time —
a conservative, timezone-independent rule that never leaks an in-progress bar.
The practical effect is that a daily bar appears at the start of the next day
rather than the moment its exchange closes.

### SQLite cache

Every request goes through the cache:

1. read the bars already stored for `(symbol, timeframe, options)`;
2. fetch only the missing slices — older history at the front, new bars at the back;
3. write the fetched closed bars back for next time.

The cache lives at `$TV_CACHE_DB`, or `$XDG_CACHE_HOME/tradingview/candles.sqlite`
(`~/.cache/tradingview/candles.sqlite`). Override per call with `--cache PATH`
and disable with `--no-cache`. It uses Node's built-in `node:sqlite`, so there
is no native module to compile.

## Symbols

TradingView addresses instruments as `EXCHANGE:SYMBOL`. Bare names resolve
through a curated alias table, then TradingView's autocomplete:

- Crypto dominance: `USDT.D`, `BTC.D`, `ETH.D`, `TOTAL`, `TOTAL2`, `TOTAL3`
- Rates & macro: `US10Y`, `US2Y`, `US30Y`, `DXY`, `VIX`, `GOLD`, `WTI`, `SPX`
- FX: `EURUSD`, `USDJPY`, `USDCNH`, `USDCNY`
- Crypto: `BTCUSD`, `ETHUSD`, `BTCUSDT`, `SOLUSDT`
- Continuous futures: `CNH1!`, `ES1!`, `NQ1!`, `CL1!`, `GC1!`, `ZN1!`, `6E1!`
- Anything else: write `EXCHANGE:SYMBOL` (e.g. `BINANCE:BTCUSDT`)

See [`references/symbols.md`](references/symbols.md) for the full table and the
unit/feed traps (percent vs price, sentinel volumes, substitute feeds).

## Install

```bash
cd <skill-dir>
npm install        # installs @mathieuc/tradingview (Node >= 22.13)
tradingview candles BTCUSD --tf 1D --count 5
```

The CLI runs TypeScript directly (no build step) and stores candles in SQLite
via `node:sqlite` (unflagged since Node 22.13).

## Layout

```
bin/tradingview        bash wrapper (checks deps, runs cli.ts)
cli.ts                 the `candles` command + cache-aware fetching
src/cache.ts           SQLite schema, read/write, cache location
src/symbols.ts         alias table + resolution/fallback
src/output.ts          formats, error payloads, exit codes
src/args.ts            flag parser
src/util.ts            timeframes, bar-close math, time parsing
references/            symbols.md, commands.md, api.md
scripts/smoke-test.sh  live smoke tests (npm run smoke)
```

## Development

```bash
npx tsc --noEmit     # type-check
npm run smoke        # live candle requests; needs network
```

## Notes

- **Read-only.** No orders, no watchlist edits, no chart changes.
- Anonymous access works; intraday history is shorter than with account cookies,
  and deep `--from` ranges may be truncated by the server.
- Not affiliated with or endorsed by TradingView. Respect your data provider's
  terms and market-data permissions.
- Code is GPL-3.0; documentation is CC BY-NC-SA 4.0 — same as the parent
  `pi-skills` repository.
