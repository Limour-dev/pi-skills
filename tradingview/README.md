# tradingview

Read-only TradingView market data for agents and scripts, built on
[`@mathieuc/tradingview`](https://github.com/Mathieu2301/TradingView-API) v4.

A single CLI (`bin/tradingview`) wraps the library's data API and adds the one
thing that makes it usable in practice: **bare symbol names just work**.

```bash
tradingview quote USDT.D US10Y CNH1! BTCUSD --format table
```

```
input   symbol            description                                   last      change   change_pct  time_iso
──────  ────────────────  ────────────────────────────────────────────  ────────  ───────  ──────────  ────────────────────────
USDT.D  CRYPTOCAP:USDT.D  Market Cap USDT Dominance, %                  6.393     0.077    1.21        2026-10-05T15:55:00.000Z
US10Y   TVC:US10Y         United States 10 Year Government Bonds Yield  5.332     0.057    1.08        2026-10-05T15:54:41.000Z
CNH1!   CME:CNH1!         Offshore Chinese Renminbi (CNH) Futures       6.6715    -0.0015  -0.02       2026-10-05T15:30:00.000Z
BTCUSD  BITSTAMP:BTCUSD   Bitcoin / U.S. dollar                         85270.84  -1239    -1.43       2026-10-05T15:55:10.000Z
```

## What it does

| Need | Command |
| --- | --- |
| Quotes (batched) | `quote <SYM...>` |
| Candles / OHLCV | `candles <SYM> --tf 1D --count 30` |
| Live streaming | `watch <SYM...> --duration 30 --changes-only` |
| Technical ratings | `ta <SYM>` |
| Indicators / strategies | `indicator <SYM> --indicator 'STD;RSI'` |
| Symbol search | `search "offshore yuan"` |
| Symbol metadata | `info <SYM>` |
| Screener / hotlists | `screener --columns …`, `hotlist --kind gainers` |
| Account watchlists | `watchlists --brief` (needs cookies) |
| Resolve a bare name | `resolve <SYM> --verify` |
| Health check | `probe` |

Output is JSON by default; `--format csv|table|md`, `--select a,b,c` and
`--compact` shape it for people. Errors are JSON on stderr with distinct exit
codes (2 usage, 3 not found, 4 auth/study, 5 timeout, 6 network).

## Symbols

TradingView addresses instruments as `EXCHANGE:SYMBOL`. The CLI resolves bare
names through a curated alias table, then TradingView's autocomplete, then
per-request fallbacks:

- Crypto dominance: `USDT.D`, `BTC.D`, `ETH.D`, `TOTAL`, `TOTAL2`, `TOTAL3`
- Rates & macro: `US10Y`, `US2Y`, `US30Y`, `DXY`, `VIX`, `GOLD`, `WTI`, `SPX`
- FX: `EURUSD`, `USDJPY`, `USDCNH`, `USDCNY`
- Crypto: `BTCUSD`, `ETHUSD`, `BTCUSDT`, `SOLUSDT`
- Continuous futures: `CNH1!`, `ES1!`, `NQ1!`, `CL1!`, `GC1!`, `ZN1!`, `6E1!`
- Anything else: `tradingview search "<text>"`, or write `EXCHANGE:SYMBOL`

`resolve <SYM> --verify` shows exactly which candidate answers a real request.
See [`references/symbols.md`](references/symbols.md) for the full table and the
unit/feed traps (percent vs price, delayed futures, sentinel volumes,
substitute feeds).

## Install

```bash
cd <skill-dir>
npm install        # installs @mathieuc/tradingview (Node >= 22.18)
tradingview probe
```

The CLI runs TypeScript directly (no build step). Optional account cookies for
Pine studies and fuller history:

```bash
export TV_SESSION="..."    # sessionid cookie
export TV_SIGNATURE="..."  # sessionid_sign cookie
```

Without them: quotes, candles, built-in indicators, screener and `ta` work;
Pine studies return `STUDY_ERROR` and intraday history is shorter.

## Layout

```
bin/tradingview        bash wrapper (checks deps, runs cli.ts)
cli.ts                 command dispatch + output shaping
src/symbols.ts         alias table + resolution/fallback
src/output.ts          formats, error payloads, exit codes
src/args.ts            flag parser
src/util.ts            timeframes, time parsing, ratings
src/creds.ts           env-only credentials
references/            symbols.md, commands.md, api.md
scripts/smoke-test.sh  live smoke tests (npm run smoke)
```

## Development

```bash
npx tsc --noEmit     # type-check
npm run smoke        # live commands; needs network
```

## Notes

- **Read-only.** No orders, no watchlist edits, no chart changes.
- Not affiliated with or endorsed by TradingView. Respect your data provider's
  terms and market-data permissions.
- Code is GPL-3.0; documentation is CC BY-NC-SA 4.0 — same as the parent
  `pi-skills` repository.
