# CLI reference

`bin/options-gex` is a bash wrapper around `node cli.ts`; call it from any directory.

```
options-gex <command> <TICKER> [flags]
```

JSON goes to stdout (`--format pretty` by default). Diagnostics and errors go to stderr
unless `--json-errors` is set. A successful run always exits `0` and prints exactly one JSON
document (or one table).

## Commands

### `gex <TICKER>`

Key levels plus a per-strike GEX table.

```json
{
  "provenance": { "...": "..." },
  "units": "usd_gex",
  "series_label": "net GEX by strike in USD; the sum over all strikes equals net_gex",
  "levels": { "spot": 769.65, "net_gex": 544926340.32, "net_gex_usd": "$544.93M", "...": "..." },
  "selection": { "mode": "top_abs", "requested": 40, "returned": 40, "available": 151, "note": "largest |exposure|" },
  "gex_by_strike": [{ "strike": 770, "value": 96358554.49, "value_pretty": "$96.36M" }],
  "zero_gamma_estimate": 770.73,
  "zero_gamma_estimate_delta": 4.94,
  "insights": [{ "type": "GAMMA", "title": "...", "text": "..." }]
}
```

- `units` is `usd_gex` on REST and `exposure_units` when the data came from MCP
  (`gex_by_strike` does not exist in the MCP text; the table is gamma net exposure there).
- `zero_gamma_estimate` only appears on REST and only when the cumulative curves cross zero.

### `levels <TICKER>`

`{ provenance, levels, insights }` — the smallest useful payload (~400 B).

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

`--dte N` keeps expirations with `0 <= dte <= N`. `--today YYYY-MM-DD` overrides the DTE base date.
On the MCP fallback the list is truncated to the first 8 expirations and `total_available` comes from
the `(+N more)` count, so `truncated` is `true`.

### `raw <TICKER>`

Projected full snapshot: levels, expiration dates, insights, the GEX series, cumulative GEX
(REST only), every requested greek table, and any dictionaries requested with `--include oi,vol,mid`.
All series respect `--top` / `--strike-range`.

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
| `--dte N` | — | `expiries`: keep expirations no further than N days out. |
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

# Rate limited on REST? Use the MCP fallback explicitly
options-gex walls SPY --source mcp --max-strikes 12

# CI / offline regression from a saved snapshot
options-gex flip SPY --from-file tests/fixtures/spy-2026-10-16-gamma.json

# Fail loudly if the server silently changes the expiry
options-gex levels SPY --exp 2026-10-16 --strict-exp
```
