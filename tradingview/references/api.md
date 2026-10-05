# Library mapping, limits and maintenance

This skill is a thin CLI over
[`@mathieuc/tradingview`](https://github.com/Mathieu2301/TradingView-API) v4.
It does not re-implement any protocol; every command maps to one data-API
function. This file records what is used, the upstream limits, and how to keep
the skill working.

## Version

- Pinned dependency: `@mathieuc/tradingview@4.0.0-rc.0` (npm dist-tag `next`).
- `4.0.0-beta.5` is the `beta` dist-tag; `latest` is still the v3 line
  (`3.5.2`) with the old `Client` API and **no** `getCandles`/`getQuote` data
  API. Do not install `@mathieuc/tradingview` without the prerelease tag.
- Node ≥ 22.18 is required because the CLI runs TypeScript directly
  (type stripping). The library itself needs Node ≥ 20.
- ESM only, TypeScript declarations included.

Upgrade:

```bash
cd <skill-dir>
npm install @mathieuc/tradingview@next   # or a pinned 4.x version
npx tsc --noEmit                          # type-check the CLI against it
npm run smoke                             # live smoke tests
```

If upstream ships a breaking data-API change, the affected command usually
fails at type-check time; the mappers in `cli.ts` are the only place to update.

## Command → function

| Command | Data-API function |
| --- | --- |
| `quote` | `getQuotes({symbols})`, falling back to `getQuote({symbol})` per symbol |
| `candles` | `getCandles({symbol, timeframe, count?, from?, to?, chartType?, …})` |
| `watch --kind quote` | `watchQuotes({symbols}, {onData, onError})` |
| `watch --kind candles` | `watchCandles({symbol, timeframe, count}, {onData, onError})` |
| `ta` | `getTechnicalAnalysis(symbol)` |
| `indicator` | `getIndicatorData({symbol, timeframe, indicator, inputs?})` |
| `search` | `searchMarkets(text, {type?, exchange?, country?, offset?})` |
| `info` | `getSymbolInfo({symbol, session?})` |
| `screener` | `getScreener({market, columns, filter?, sort?, range?, symbols?})` |
| `hotlist` | `getHotlist({kind, market, columns?, filter?, range?})` |
| `watchlists` | `getWatchlists({credentials})` |
| `resolve` / fallback | `searchMarkets` + curated aliases (local) |
| `probe` | `getQuote` + `searchMarkets` |

`TradingViewError` is the only error type; the CLI maps `error.code` to an exit
code (see `src/output.ts`).

### Errors

| Code | Meaning | CLI exit |
| --- | --- | --- |
| `INVALID_ARGUMENT` | Bad query, checked before connecting | 2 |
| `SYMBOL_ERROR` / `QUOTE_ERROR` / `NO_DATA` / `NOT_FOUND` / `SERIES_ERROR` | Unknown symbol / empty range / refused bars | 3 |
| `STUDY_ERROR` / `AUTH_ERROR` | Pine studies need an account; cookies rejected | 4 |
| `TIMEOUT` / `ABORTED` | Didn't answer in time / cancelled | 5 |
| `DISCONNECTED` / `CONNECTION_ERROR` / `HTTP_ERROR` / `PROTOCOL_ERROR` / `PARSE_ERROR` | Transport / decoding | 6 |
| `CRITICAL_ERROR` / `CALLBACK_ERROR` | Command refused / watcher callback threw | 1 |

`error.details` keeps the raw server payload when present.

## Upstream limits (as of the 4.0.0-rc.0 docs and our tests)

- **Anonymous** access is limited: in upstream tests about 7 000 one-minute
  bars; reference times (`to`) in the past are capped. History stops early
  without error when the server has no more bars.
- **Pine studies require an account.** Without cookies every `STD;*` /
  `PUB;*` / `USER;*` study returns `STUDY_ERROR`
  ("maximum number of studies per chart"). Built-in studies
  (`Volume@tv-basicstudies-241`) work anonymously.
- **Substitute feeds.** Anonymous sessions may be served by another venue
  (`NASDAQ:AAPL` → `BATS:AAPL`) while `pro_name` keeps the requested symbol.
- **Delays.** Futures (and possibly other feeds) can be delayed for anonymous
  users; `update_mode: delayed_streaming_600` ≈ 10 minutes.
- **Screener** is one HTTP page, not a streaming scanner, and does not grant
paid entitlements. An invalid filter operation raises `HTTP_ERROR`; an unknown
column comes back as `null` and an unknown sort field is ignored, so verify
field names rather than trusting silence. `range` is zero-based, end-exclusive,
default `[0, 50]`.
- **Hotlist** is a scanner query, not an exact replica of the TradingView UI
  widget; the universe/session/liquidity filters may differ.
- **No auto-reconnect.** A watcher that hits a fatal error stops; `watch` prints
  `{"event":"error"}` and exits. Start a new watch if you need continuity.

## Candle options exposed by the library

`getCandles` query fields (all wired to CLI flags unless noted):

| Library option | CLI flag | Default |
| --- | --- | --- |
| `symbol` | positional | required |
| `timeframe` | `--tf` | `D` |
| `count` | `--count` | 100 |
| `from` / `to` | `--from` / `--to` | `count`-based / now |
| `maxCount` | — | 20 000 |
| `chartType` | `--chart-type` | line/regular |
| `chartInputs` | — | |
| `currency` | `--currency` | |
| `session` | `--session` | `regular` |
| `adjustment` | `--adjustment` | `splits` |
| `backAdjustment` | — | |
| `timezone` | — | |
| `credentials` | env only | none |
| `timeoutMs` | `--timeout` | 15 000 |

`chartType: "HeikinAshi" | "Renko" | "LineBreak" | "Kagi" | "PointAndFigure" | "Range"`.

## Timeframes

`1S` (seconds), `1 3 5 15 30 45 60 120 180 240 360 480 720` (minutes),
`D W M`, plus `3M 6M 12M`. The CLI also accepts `1m 5m 15m 1h 4h 1d 1w 1mo`
and validates before connecting.

## Time and units

- Candle `time` is the bar **open** time in Unix **seconds**.
- Quote `lp_time` is Unix seconds; the CLI adds `time_iso` (UTC) everywhere.
- `format` is the unit hint: `price`, `percent`, `volume`.
- `lp` = last price, `ch` = change, `chp` = change %, `rch`/`rchp` =
  pre/post-market change.

## Maintenance checklist

```bash
cd <skill-dir>
npm install          # after cloning
npx tsc --noEmit     # type-check
npm run smoke        # live commands; needs network
```

- Aliases live in `src/symbols.ts` (`ALIASES`, `EXCHANGE_PRIORITY`,
  `TYPE_PRIORITY`). Verify new entries with `quote <SYM> --strict`.
- Exit-code mapping lives in `src/output.ts` (`TV_ERROR_CODES`, `EXIT`).
- The remaining upstream-reality notes (delays, sentinel volumes, substitute
  feeds) are in `references/symbols.md`; re-verify them if TradingView changes
  feed policy.

## Attribution

TradingView is a trademark of its owner. This skill is an independent,
read-only client of a community library and is not affiliated with or endorsed
by TradingView. Respect your data provider's terms and market-data permissions.
