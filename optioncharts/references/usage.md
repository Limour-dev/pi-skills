# CLI reference

`bin/optioncharts` is a bash wrapper around `node cli.ts`; call it from any directory
(no install, no API key). Node ≥ 22.18 runs the TypeScript directly.

```bash
optioncharts <command> <TICKER> [TICKER...] [flags]
```

JSON goes to stdout (`--format pretty` by default, `--compact` for one line, `--format csv`
for tables). Errors go to stderr as `{"ok":false,"error":{code,message,details}}` unless
`--json-errors` moves them to stdout; the exit code is always non-zero on failure.

## Envelope

Every data command returns the same envelope:

```json
{
  "source": "optioncharts.io",
  "generated_at": "2026-10-05T13:59:28.371Z",
  "command": "scan",
  "tickers": [ { "ticker": "TLT", "...": "command specific", "provenance": { "...": "..." } } ],
  "failures": [ { "ticker": "ZZZZZZ", "code": "unavailable", "message": "..." } ]
}
```

- `tickers[]` holds one entry per successful ticker; `failures` only appears when some
  ticker failed. A partially failed run still prints the data it has, and exits with the
  worst failure code (`5 > 4 > 3 > 2 > 1`).
- Every entry carries `provenance`: `source`, `ticker`, `endpoint`, `url`, `status`,
  `fetched_at` (local fetch/cache time), `latency_ms`, `from_cache`,
  `requests_this_run` (upstream requests, cache hits excluded) and `warnings`.

## Commands

### `spot <TICKER>`

```json
{
  "ticker": "TLT",
  "price": 77.16, "change": -0.32, "change_pct": -0.41, "currency": "USD",
  "name": "iShares 20+ Year Treasury Bond ETF",
  "as_of": "Oct 05, 9:47 AM EDT",
  "market_status": "Market Open",
  "options_delay": "Options 15-min Delayed",
  "price_source": "Polygon.io (real-time, per the page tooltip)"
}
```

`price` is real-time (Polygon.io); everything option-related on the site is 15 minutes
delayed. Pre/post-market prices only appear in the widget while a session is active.

### `info <TICKER>`

`dividend_yield_pct`, `average_volume`, `high_today`, `low_today`, `open_price`, `volume`,
`week52_high`, `week52_low`. Upstream renders `47.85M`; the CLI expands it to `47850000`.
Fields the page hides (no data) come back as `null`.

### `expiries <TICKER>`

```json
{
  "ticker": "TLT", "count": 4, "total_available": 31,
  "expirations": [
    { "exp": "2026-10-09:w", "date": "2026-10-09", "weekday": "Fri",
      "kind": "weekly", "dte": 4, "display": "Oct 09, 2026 (4 days) (w)" }
  ]
}
```

`dte` is the day count the upstream label shows. `kind` is `weekly` (`:w`) or `monthly`
(`:m`, third Friday). Filters: `--dte`, `--weekly-only`, `--monthly-only`, `--max-exp`.

### `scan <TICKER...>` — the weekly dashboard

One row per expiry inside `--dte` (default **no filter**, so pass `--dte 7`; remember `--dte N` is a
**ceiling**), capped by `--max-exp` (default 8). `--exp 2026-10-09:w` pins a single expiry (that row
only, one request). One `option_chain_statistics` request per ticker; `--gex` adds one
`gamma_exposure` request **per selected expiry**.

Row fields: `expiration`, `kind`, `dte`, `volume_total`, `volume_pcr`, `oi_total`, `oi_pcr`,
`iv_pct`, `expected_move_abs`, `expected_move_pct`, `max_pain`, `max_pain_diff_pct`,
`volume_calls`, `volume_puts`, `oi_calls`, `oi_puts`, `contracts_total`, plus
`net_exposure` / `call_exposure` / `put_exposure` / `call_wall` / `put_wall` /
`gamma_zero_level` / `gex_expiry` / `gex_as_of` / `expiry_fallback` with `--gex`.
`gex_as_of` is that row's GEX snapshot time — a `scan --gex` and a `gex` call can differ unless they
hit the same 60 s cache, so compare the two `as_of` values before quoting both.

```bash
optioncharts scan TLT SPY QQQ --dte 7 --weekly-only --format csv
```

`sign_flips[]` calls out adjacent expiries whose `net_exposure` changes sign (positive
gamma pinning ↔ negative gamma acceleration) — only meaningful with `--gex`.

### `stats <TICKER...>`

The full per-expiry statistics table, one request per ticker. `columns` defaults to the
free-tier set:

`expiration, volume_total, volume_pcr, oi_total, oi_pcr, iv, expected_move, max_pain,
volume_calls, volume_puts, oi_calls, oi_puts, dte, contracts_total`

Rows are normalised to `expiration`, `kind`, `dte`, `volume_total`, `volume_pcr`,
`oi_total`, `oi_pcr`, `iv_pct`, `expected_move_abs`, `expected_move_pct`, `max_pain`,
`max_pain_diff_pct`, `volume_calls`, `volume_puts`, `oi_calls`, `oi_puts`,
`contracts_total`. The upstream **`Totals` row is dropped** (it is not an expiry).

```bash
optioncharts stats TLT --dte 7
optioncharts stats TLT SPY QQQ --format csv
optioncharts stats TLT --columns expiration,oi_total,iv,dte,gex,dex   # gex/dex come back locked → null
```

`--columns` accepts any upstream column key; `gex` and `dex` are paid, so their cells are
`null` and the column name lands in `locked_columns` (plus a warning).

### `gex` / `dex <TICKER>`

```json
{
  "ticker": "TLT", "exposure": "GEX", "type": "open_interest",
  "expiries": ["2026-10-09:w"], "returned_expiries": ["2026-10-09:w"],
  "unit": "usd_per_1pct_move",
  "net_exposure": 24985140.36, "call_exposure": 80819612.23, "put_exposure": -55834471.87,
  "call_wall": 78, "put_wall": 78,
  "gamma_zero_level": null,
  "exposure_by_expiration": [ { "expiration": "2026-10-09:w", "net_exposure": 24985140.36,
                                "call_wall": 78, "put_wall": 78, "gamma_zero_level": null } ],
  "gex_by_strike": [ { "strike": 78, "call_exposure": 16797845.74,
                       "put_exposure": -6677974.78, "net_exposure": 10119870.95 } ]
}
```

- `unit` is always `usd_per_1pct_move`: **dollars of dealer gamma/delta per 1% move**,
  not notional. Never render these with a `$` notional prefix.
- `--type volume` switches the weighting to same-day volume (`gamma_exposure_type=volume`),
  which is a very different number (TLT 10-09: OI +24.98M vs volume +107.69M).
- `call_wall` / `put_wall` come from the inline JSON and are real values, even though the
  site renders them locked. `gamma_zero_level` is `null` on the free tier.
- The free tier returns **one** entry in `exposure_by_expiration` no matter how many
  expiries you request, while `gex_by_strike` is the sum across the requested expiries
  (warning included). Request one expiry for a clean series.
- `--top N` keeps the N largest `|net_exposure|` strikes (ranking key is `|net_exposure|` — a key
  strike can be dropped by a mid-sized one; omit `--top` for walls/flip work). `exposure_by_strike_count`
  still tells you how many existed.
- **Cross-ticker scale**: every strike row always carries
  `share_of_abs_total_pct = net_exposure / Σ|net_exposure| × 100`, and the payload carries
  `cross_ticker_note` / `share_of_abs_total_pct_note`. `--normalize sigma` additionally adds
  `sigma_pos = (strike − spot) / expected_move_abs` plus `spot`, `spot_as_of`,
  `expected_move_abs`, `expected_move_expiry` (needs one spot + one statistics request; it degrades
  to a warning — with `sigma_pos: null` — when those cannot be fetched, e.g. under `--from-file`).
- `exposure_as_of` is the exposure snapshot's fetch time (the fragment carries no OPRA snapshot
  stamp): compare it before mixing a `scan --gex` headline with a `gex` per-strike table.

### `oi` / `volume` / `skew <TICKER>`

Per-strike rows keyed by `{expiry}:{calls|puts}`:

```json
{ "expiration": "2026-10-09:w", "option_type": "CALL", "strike": 75,
  "contract_symbol": "TLT261009C00075000", "open_interest": 3577 }
```

`skew` rows carry `implied_volatility` (upstream decimal, `0.5125`) **and** `iv_pct`
(`51.25`). `oi` also returns `summary[]`: the per-expiry totals the fragment ships
(`open_interest_calls`, `open_interest_puts`, `open_interest_total`).
Multiple `--exp` values in one request are allowed and keep per-expiry rows
(the server returns a `{expiry}:{side}` key per expiry).

### `greeks <TICKER>`

```json
{ "available_greeks": ["delta", "gamma", "theta", "vega"],
  "null_greeks_on_free_tier": [],
  "rows": [ { "greek": "delta", "expiration": "2026-10-09:w", "option_type": "CALL",
              "strike": 65, "value": 0.9944, "iv_pct": 51.2541,
              "contract_symbol": "TLT261009C00065000" } ] }
```

`--greek delta,gamma` filters; default `--top` is **40** rows (the payload is 4 greeks ×
2 sides × every strike). `vanna` / `charm` / `vomma` are `null` on the free tier.

### `max-pain <TICKER>`

One request covers **every** listed expiry: rows are
`{ expiration_date_id, expiration_date_display, max_pain, max_pain_diff,
max_pain_diff_display, max_pain_diff_pct }` (`max_pain_diff_pct` is vs the current spot).
`--dte` / `--weekly-only` / `--monthly-only` / `--max-exp` filter the returned list.

### `em <TICKER>`

The expected-move cone: `point_count` (upstream ships ~838 daily points) and
`points[]` = `{ t, iso, et_date, et_time, em_amt, em_pct, low, high, avg_iv }`, **nearest first**.
`--limit N` (default 24) trims the near end; `--limit 0` returns all.

- **Read `et_date`, not `iso`.** Every point stamps a session **close** in `America/New_York`
  (23:59:59 ET), so its UTC `iso` date is one day later: the row `2026-10-06T03:59:59Z` is the
  **2026-10-05** session. `et_time` is `23:59:59`. The CSV leads with `et_date` for the same reason.
- The cone is **spot-anchored and recomputed on every request**; `as_of` is only the local fetch
  time (there is no upstream snapshot stamp), and the same point moves within minutes.
- Two expected moves exist and must not be mixed: the cone's `em_amt`/`em_pct` is the daily
  interpolated curve, while `scan`/`stats` `expected_move_abs` is that expiry's own straddle IV.
  They agree only on an expiry's own `et_date`. **Use `scan`/`stats` for per-expiry σ normalisation**;
  see `cone_vs_per_expiry_note` in the payload.

### `chain <TICKER>`

The call and put tables of `/async/option_chain`, merged into one row list:

```json
{ "view": "list", "expiries": ["2026-10-09:w"], "columns": ["strike","bid","ask","volume","oi","iv","delta"],
  "rows": [ { "option_type": "CALL", "strike": 65, "bid": 12.1, "ask": 12.35,
              "volume": 0, "oi": 0, "iv_pct": 84.67, "delta": 0.97 } ] }
```

`--columns` picks upstream columns (strike/bid/ask/volume/oi/iv/delta/last/...);
`iv` is stored as `iv_pct` (percent). `--view straddle` renders the straddle layout.
A TLT single expiry is ~48 rows/side. Note: the chain endpoint **ignores a missing
expiry** and uses its own default, so the CLI cross-checks the contract symbols in the
fragment against the requested expiry and fails (exit 5) on a mismatch.

### `probe`

```json
{ "ok": true, "checked_at": "...", "base_url": "https://optioncharts.io",
  "requests": 4,
  "endpoints": [ { "name": "open_interest", "ok": true, "status": 200,
                   "latency_ms": 2140, "bytes": 133154 } ] }
```

Use it first when a run looks broken — it separates "site/network changed" from
"my ticker/expiry argument is wrong".

### `raw <TICKER> --endpoint <NAME>`

Debug escape hatch. Dumps `inline_variables` (every `var x = {...}` in the fragment) and
the parsed `json` for those variables, or the whole fragment with `--html`.
`--var NAME` picks variables, `--param k=v` adds query parameters.

Endpoint names: `open_interest`, `volume`, `volatility_skew`, `greeks`, `max_pain`,
`expected_move`, `probability_distribution`, `gamma_exposure`, `delta_exposure`,
`option_chain`, `option_chain_statistics`, `ticker_info`, `stock_price_widget`.
A raw `/async/...` path is accepted too.

## Flags

| Flag | Meaning |
| --- | --- |
| `--exp YYYY-MM-DD[:w\|:m]` | repeatable **and** comma-separated (`--exp A:w,B:m`); always send the suffix (see api.md §Pitfalls) |
| `--dte N` | keep expiries **≤** N days out (a ceiling, not exactly N; `scan`/`stats`/`gex`/`expiries`) |
| `--weekly-only` / `--monthly-only` | keep `:w` / `:m` expiries |
| `--all-expiries` | chart commands: use every matching expiry instead of the nearest one |
| `--max-exp N` | cap expiries per ticker (`scan` default 8) |
| `--strict-exp` | default; exit 5 when the server answers for another expiry |
| `--allow-exp-fallback` | downgrade that to a warning and keep going |
| `--option-type all\|call\|put` | default `all` |
| `--strike-range all\|MIN,MAX` | upstream strike window (default `all`) |
| `--type open_interest\|volume` | `gex`/`dex` weighting (default `open_interest`) |
| `--normalize none\|pct\|sigma` | `gex`/`dex` cross-ticker scale: always adds `share_of_abs_total_pct`; `sigma` also adds `sigma_pos` (+2 requests) |
| `--view list\|straddle` | `chain` layout |
| `--top N` | keep the N largest **\|value\|** rows, ranked by `\|net_exposure\|` for `gex`/`dex`/`oi`/`volume`/`skew` and by `\|value\|` for `greeks` (default 40) |
| `--limit N` | `em` points to print (default 24, `0` = all) |
| `--columns a,b,c` | `stats` / `chain` columns |
| `--greek delta,gamma` | `greeks` filter |
| `--gex` | `scan`: add walls + exposure per expiry |
| `--spot` | `scan`: add a real-time spot per ticker |
| `--concurrency N` | `scan` fan-out (default 2) |
| `--format pretty\|compact\|csv` | default `pretty` |
| `--units` | `--format csv` only: annotate headers with units, e.g. `net_exposure[usd_per_1pct_move]` |
| `--from-file PATH` | parse a saved fragment offline (single request only) |
| `--no-cache` | bypass the 60 s local fragment cache |
| `--timeout MS` | per-request timeout (default 30000) |
| `--endpoint NAME`, `--var NAME`, `--param k=v`, `--html` | `raw` |
| `--json-errors` | errors to stdout (exit code unchanged) |
| `-h, --help`, `--version` | |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | ok (partial per-ticker failures may still print a non-zero code) |
| `1` | runtime error (network, parse, unexpected shape) |
| `2` | usage error (unknown flag/command, bad `--exp`, missing ticker) |
| `3` | data unavailable (invalid ticker, past expiry, no listed expiry) |
| `4` | rate limited (HTTP 429 after retries) |
| `5` | the server silently answered for a different expiry |

## Caching, timeouts and retries

- 60-second on-disk cache in `$OPTIONCHARTS_CACHE_DIR` or `~/.cache/optioncharts`, keyed by
  the full URL. `--no-cache` bypasses it. Upstream sends a weak ETag but never 304s, so the
  cache is the only way to keep repeated scans cheap.
- 30 s timeout, 2 retries with backoff on network errors, 5xx and 429.
- `--from-file` serves exactly one request from a saved fragment and then errors: use it
  for offline reproduction of a single-request command
  (`optioncharts gex TLT --exp 2026-10-09:w --from-file fragment.html`).

## Recipes

```bash
# Weekly dashboard for a basket, then a deeper look at one expiry
optioncharts scan TLT SPY QQQ --dte 7 --weekly-only --format csv
optioncharts gex QQQ --exp 2026-10-09:w --top 15 --format csv

# Term structure of max pain (all expiries, one request)
optioncharts max-pain SPY --dte 60 --format csv

# Where is the open interest concentrated?
optioncharts oi SPY --exp 2026-10-09:w --option-type call --top 10 --format csv

# IV skew across the near-term expiries (one request, per-expiry rows)
optioncharts skew SPY --exp 2026-10-09:w --exp 2026-10-16:m --top 6 --format csv

# Offline reproduction of a saved fragment
optioncharts stats TLT --from-file tests/fixtures/tlt-stats.html
```
