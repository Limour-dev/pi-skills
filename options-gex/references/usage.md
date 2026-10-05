# CLI reference

`bin/options-gex` is a bash wrapper around `node cli.ts`; call it from any directory.

```
options-gex <command> <TICKER> [TICKER...] [flags]
```

JSON goes to stdout (`--format pretty` by default). Diagnostics and errors go to stderr
unless `--json-errors` is set. A successful run always exits `0` and prints exactly one JSON
document (or one table).

Every data command repeats the same top-level key levels (`spot`, `net_gex`, `net_gex_usd`,
`gamma_flip`, `spot_vs_flip`, `call_wall`, `put_wall`, `max_pain`); `levels.*` is the
backward-compatible alias.

## Commands

### `gex <TICKER>`

Key levels plus a per-strike GEX table.

```json
{
  "provenance": { "...": "..." },
  "spot": 769.65,
  "net_gex": 544926340.32,
  "net_gex_usd": "$544.93M",
  "gamma_flip": 765.79,
  "spot_vs_flip": "above",
  "call_wall": 770,
  "put_wall": 765,
  "max_pain": 763,
  "units": "usd_gex",
  "series_label": "net GEX by strike in USD; the sum over all strikes equals net_gex",
  "levels": { "spot": 769.65, "net_gex": 544926340.32, "net_gex_usd": "$544.93M", "...": "..." },
  "selection": { "mode": "top_abs", "requested": 40, "returned": 40, "available": 151, "note": "largest |exposure|" },
  "gex_by_strike": [{ "strike": 770, "value": 96358554.49, "value_pretty": "$96.36M", "unit": "usd" }],
  "zero_gamma_estimate": 770.73,
  "zero_gamma_estimate_delta": 4.94,
  "zero_gamma_delta_pct_of_spot": 0.64,
  "zero_gamma_reliability": "high",
  "zero_gamma_note": "the upstream gamma_flip uses a finer strike grid ... small delta is expected",
  "insights": [{ "type": "GAMMA", "title": "...", "text": "..." }]
}
```

- `units` is `usd_gex` on REST and `exposure_units` when the data came from MCP
  (`gex_by_strike` does not exist in the MCP text; the table is gamma net exposure there).
  Every row carries `unit`: `usd` (dollar GEX, `value_pretty` has a `$`) or `exposure`
  (upstream exposure units — **no** `$`).
- `zero_gamma_estimate` only appears on REST and only when the cumulative curves cross zero.
  `zero_gamma_reliability` is `low` when the cross-check drifts more than 1% of spot from
  `gamma_flip`; then `zero_gamma_note` says so instead of the usual "small delta" caveat.
### `levels <TICKER>`

`{ provenance, ...key levels, levels, insights }` — the smallest useful payload (~400 B;
add `--no-insights` for ~400 B without the English insights).

### `walls <TICKER>`

```json
{
  "provenance": { "...": "..." },
  "spot": 769.65,
  "call_wall": 770, "call_wall_oi": 3563,
  "call_wall_distance": { "spot_side": "below", "abs": 0.35, "pct": -0.05 },
  "put_wall": 765, "put_wall_oi": 2714,
  "put_wall_distance": { "spot_side": "above", "abs": 4.65, "pct": 0.61 },
  "net_gex": 544926340.32
}
```

`spot_side` is where **spot** sits relative to the level ("below the call wall" = the wall is above).

### `max-pain <TICKER>`

`{ provenance, spot, max_pain, max_pain_distance, net_gex, pc_oi_ratio }`.

### `flip <TICKER>`

```json
{
  "provenance": { "...": "..." },
  "spot": 769.65,
  "gamma_flip": 774.62,
  "spot_vs_flip": "below",
  "distance_abs": 4.97,
  "distance_pct": -0.64,
  "net_gex": -1544151621.48,
  "regime": "negative net GEX — dealers short gamma (trend-amplifying, vol-expanding)",
  "zero_gamma_estimate": 770.73,
  "zero_gamma_method": "first zero crossing of cum_call_gex_by_strike + cum_put_gex_by_strike, linearly interpolated",
  "zero_gamma_note": "the upstream gamma_flip uses a finer strike grid than the published strikes, so a small delta is expected"
}
```

### `skew <TICKER>`

Default greeks are `vanna,charm` (override with `--greeks`).

```json
{
  "provenance": { "...": "..." },
  "units": "exposure_units",
  "levels": { "spot": 769.65, "stm_iv": 12.5, "pc_oi_ratio": 1.06, "net_gex": 544926340.32 },
  "greeks": {
    "vanna": { "selection": { "...": "..." }, "rows": [{ "strike": 775, "value": 664619.8, "value_pretty": "$664.62K" }] },
    "charm": { "selection": { "...": "..." }, "rows": [{ "strike": 793, "value": -31096604.73, "value_pretty": "-$31.10M" }] }
  }
}
```

### `expiries <TICKER>`

```json
{
  "provenance": { "...": "..." },
  "spot": 769.65,
  "count": 9,
  "expirations": [{ "exp": "2026-10-05", "dte": 0, "weekday": "Mon" }],
  "total_available": 32,
  "truncated": false
}
```

`--dte N` keeps expirations with `0 <= dte <= N` (it also drives `scan`; every other command
prints a stderr note and ignores it). `--today YYYY-MM-DD` overrides the DTE base date.
On the MCP fallback the list is truncated to the first 8 expirations and `total_available` comes from
the `(+N more)` count, so `truncated` is `true`.

### `raw <TICKER>`

Projected full snapshot: levels, expiration dates, insights, the GEX series, cumulative GEX
(REST only), every requested greek table, and any dictionaries requested with `--include oi,vol,mid`.
All series respect `--top` / `--strike-range`.


### `scan <TICKER> [TICKER...]`

Term-structure / weekly scan. One compact row per expiry inside `--dte` (`7` by default) for one or
more tickers, fetched concurrently. It never returns `insights` or `gex_by_strike`.

```json
{
  "generated_at": "2026-10-05T13:22:45.542Z",
  "today": "2026-10-05",
  "dte_max": 7,
  "concurrency": 3,
  "tickers": [
    {
      "ticker": "SPY",
      "spot": 769.65,
      "source": "rest",
      "dte_max": 7,
      "expirations_scanned": 3,
      "sign_flips": [{ "from_exp": "2026-10-15", "to_exp": "2026-10-16", "from": 13389079.22, "to": -1544151621.48 }],
      "warnings": [],
      "errors": [],
      "payload_fetched_at": "2026-10-05T13:22:44.921Z",
      "updated_at": "2026-10-05T13:21:21.249Z",
      "scan": [
        {
          "exp": "2026-10-05", "dte": 0,
          "net_gex": 544926340.32, "net_gex_usd": "$544.93M",
          "gamma_flip": 765.79, "spot_vs_flip": "above",
          "call_wall": 770, "put_wall": 765, "max_pain": 763,
          "implied_move_pct": 0.52, "stm_iv": 12.5, "pc_oi_ratio": 1.06,
          "bullish_score": 75, "regime": "positive"
        }
      ]
    }
  ]
}
```

- `sign_flips` flags adjacent expiries whose `net_gex` changes sign — the structural
  turning point (positive gamma suppresses vol, negative gamma amplifies it).
- `--concurrency` (1..8, default 3) bounds in-flight requests; `--max-exp` (default 12)
  caps the expiries per ticker. A failed expiry lands in `errors[]`; a rate limit stops
  fetching the remaining expiries for that ticker.
- `--exp YYYY-MM-DD` pins the scan to one expiry; `--dte N` and `--today` select the window.
### `probe`

```json
{
  "ok": true,
  "checked_at": "2026-10-05T13:01:08.711Z",
  "rest": { "ok": true, "latency_ms": 1017, "http_status": 200, "selected_exp": "2026-10-05", "cf_cache": "MISS", "ratelimit": { "limit": 30, "remaining": 28, "reset": 1791205326 }, "expirations": 32 },
  "mcp": { "ok": true, "latency_ms": 1489, "http_status": 200, "text_bytes": 1453 },
  "note": "REST is reachable — use it as the primary channel",
  "exit_code": 0
}
```

`probe` exits `0` when at least one channel answers and `1` when both fail. It ignores `--source`.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--exp YYYY-MM-DD` | nearest | Target expiry. `--expiration` is accepted as an alias but the wire parameter is `exp`. |
| `--greeks LIST` | `gamma` (`vanna,charm` for `skew`) | `gamma,delta,theta,vega,vanna,charm` or `all`. Invalid values are a usage error (exit 2). |
| `--top N` | `40` | Rows per per-strike table. |
| `--top-by abs\|nearest` | `abs` | Rank `--top` by absolute exposure or by distance to spot. |
| `--strike-range PCT` | — | Return every strike within ±PCT% of spot; overrides `--top`. |
| `--dte N` | `7` for `scan` | `expiries`/`scan`: keep expirations within N days. Ignored elsewhere with a stderr note. |
| `--concurrency N` | `3` | `scan`: in-flight requests (1..8). |
| `--max-exp N` | `12` | `scan`: cap expirations per ticker. |
| `--tickers A,B,C` | — | `scan`: extra tickers (same as positional). |
| `--include LIST` | — | `raw`: add `oi`, `vol`, `mid` dictionaries (filtered to the selection). |
| `--source rest\|mcp\|auto` | `auto` | `auto` tries REST, then MCP on any failure. |
| `--max-strikes N` | `40` | MCP only: rows per table (1..200). Ignored by REST. |
| `--format pretty\|compact\|table` | `pretty` | Output shape. |
| `--from-file PATH` | — | Read a saved REST JSON body, MCP JSON-RPC envelope, or MCP text instead of the network. |
| `--timeout SEC` | `20` | Per-request timeout. |
| `--max-retries N` | `2` | Retries for network errors, 5xx and 429 (exponential backoff, `ratelimit-reset` aware). |
| `--no-cache` | off | Bypass the 60 s local cache and add a cache-buster so Cloudflare revalidates. |
| `--strict-exp` | off | Exit 5 when `selected_exp !== requested exp`. |
| `--json-errors` | off | Print `{ok:false,error:{code,message,details}}` to stdout instead of stderr. |
| `--no-insights` | off | Omit the upstream English `insights[]` from any command's output. |
| `--today YYYY-MM-DD` | UTC today | Base date for `expiries` DTE (testing aid). |
| `--verbose` | off | Log request URLs, latency and fallbacks to stderr. |
| `-h`, `--help`, `--version` | — | Usage / version. |

## Exit codes

| Code | `error.code` | Meaning |
| --- | --- | --- |
| 0 | — | Success |
| 1 | `runtime` | Network failure, non-JSON response, malformed payload |
| 2 | `usage` | Unknown command/flag, bad `--exp` format, bad `--greeks`, out-of-range numbers |
| 3 | `unavailable` | `ok:false` from REST, "No options data" from MCP, unknown ticker |
| 4 | `rate_limited` | HTTP 429 survived every retry |
| 5 | `exp_fallback` | `selected_exp !== requested exp` with `--strict-exp` |

## Recipes

```bash
# Nearest expiry, smallest context
options-gex levels NVDA

# A specific expiry, read as a table, ±2% around spot
options-gex gex TSLA --exp 2026-10-16 --strike-range 2 --format table

# Top 15 strikes by |GEX| with the cumulative columns
options-gex raw SPY --top 15

# Everything the endpoint returns for one expiry
options-gex raw SPY --greeks all --include oi,vol,mid --top 151

# Volatility structure
options-gex skew SPY --top 20 --format compact

# Weekly term structure for several tickers (3 calls instead of ~24)
options-gex scan TLT SPY QQQ --dte 7 --concurrency 3 --format table

# Same, but capped and pinned to one expiry
options-gex scan SPY --dte 14 --max-exp 6 --exp 2026-10-09 --format compact

# Numeric scan without the English insights
options-gex levels NVDA --no-insights
# Rate limited on REST? Use the MCP fallback explicitly
options-gex walls SPY --source mcp --max-strikes 12

# CI / offline regression from a saved snapshot
options-gex flip SPY --from-file tests/fixtures/spy-2026-10-16-gamma.json

# Fail loudly if the server silently changes the expiry
options-gex levels SPY --exp 2026-10-16 --strict-exp
```
