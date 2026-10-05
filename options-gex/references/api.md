# Endpoints, parameters and quirks

Two channels serve the same snapshot:

| | REST (primary) | MCP (fallback) |
| --- | --- | --- |
| Endpoint | `GET https://sellthenews.org/api/options/chain` | `POST https://mcp.sellthenews.org/mcp` |
| Protocol | plain HTTP + JSON | JSON-RPC 2.0 over Streamable HTTP (SSE response) |
| Auth / handshake | none | none; `initialize` can be skipped |
| Parameters | `ticker`, `exp`, `greeks` | `ticker`, `expiration`, `greeks`, `maxStrikes` |
| Output | structured JSON | plain text (`result.content[0].text`) |
| Payload | ~35 KB (gamma) / ~80 KB (`greeks=all`) | ~2 KB (`maxStrikes=40`) |
| Rate limit | `ratelimit-limit: 30`, `ratelimit-reset` (unix seconds), plus `cache-control: public, max-age=60` and Cloudflare caching | `x-ratelimit-limit: 120`, `x-ratelimit-reset` |
| Rounding | exact | scaled/rounded text (`$544.93M`) |

## REST

```
GET https://sellthenews.org/api/options/chain?ticker=<SYM>[&exp=YYYY-MM-DD][&greeks=<list|all>]
```

| Parameter | Required | Notes |
| --- | --- | --- |
| `ticker` | yes | case-insensitive; dotted symbols (`BRK.B`) work. Missing → HTTP 400 `{"ok":false,"error":"ticker required"}` |
| `exp` | no | strict `YYYY-MM-DD`. Omitted → nearest expiry. **`expiration` is ignored.** |
| `greeks` | no | `gamma` (default) / `vanna` / `charm` / `delta` / `theta` / `vega` / `all`, comma-separated. Invalid values silently fall back to `gamma`. |

**`maxStrikes` is ignored by REST** — the payload always carries every strike (151 for SPY).

Response (success): `{ ok, ticker, expiration_dates[], selected_exp, expiration{}, updated_at, score_history }`.
Failure: `{ ok:false, error }`, sometimes with HTTP 400 and sometimes with HTTP 200.

Fields the CLI reads from `expiration`:

| Field | Notes |
| --- | --- |
| `spot`, `forward_price` | |
| `implied_move_abs`, `implied_move_pct` | ATM straddle-implied move |
| `stm_iv` | short-term IV (%) |
| `pc_oi_ratio` | put/call open-interest ratio |
| `total_call_oi`, `total_put_oi`, `total_call_vol`, `total_put_vol` | |
| `call_wall`, `call_wall_oi`, `put_wall`, `put_wall_oi` | gamma concentration strikes |
| `max_pain` | |
| `gamma_flip` | may be `null` |
| `min_iv_strike` | |
| `net_gex` | raw USD; sign: positive = dealers long gamma |
| `bullish_score` | 0–100. Composition is **upstream-defined and undocumented** — treat as a relative score only |
| `oi_source` | `"oi"`; anything else changes what OI means |
| `market_session` | e.g. `"pre"` |
| `insights[]` | `{ type, color, title, text }`, `type` ∈ `GAMMA` / `DEALER FLOW` / `KEY LEVELS` / `VOL STATUS`; `text` is **English** upstream copy — translate/rewrite before quoting |
| `strikes[]` | every strike, ascending |
| `gex_by_strike` | `{"770.0": 96358554.49}`; sums to `net_gex` |
| `cum_call_gex_by_strike`, `cum_put_gex_by_strike` | cumulative from the lowest strike |
| `greeks_exposure.<greek>.{positive,negative,net}` | strike-keyed; `net = positive + negative`; contains near-zero float noise the CLI zeroes |
| `call_oi_by_strike`, `put_oi_by_strike`, `call_vol_by_strike`, `put_vol_by_strike`, `option_mid_by_strike.{call,put}` | large dictionaries, only returned by `raw --include` |
| `option_pop_by_strike` | always empty upstream — the CLI ignores it |

`updated_at` is the **server's computation time**, not a market timestamp: two tickers fetched in the
same minute share it. Treat it as generation time, not freshness. The CLI adds
`provenance.payload_fetched_at` (when the body was obtained locally; the cache write time on a cache
hit) and `provenance.cf_cache` (Cloudflare `HIT`/`MISS`), so cache behaviour is auditable.

## MCP

```bash
curl -s https://mcp.sellthenews.org/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_options_data",
       "arguments":{"ticker":"SPY","greeks":"gamma","maxStrikes":40}}}'
```

The body is SSE (`event: message` + `data: {json}`). `maxStrikes` (1..200, default 12) only trims the
rendered text; it never changes the data. `expiration` must be strict `YYYY-MM-DD`.

Text grammar (the CLI's parser is in `src/mcp.ts`):

```
=== Options Data: <TICKER> ===
Spot Price: $<float>
Selected Expiration: <YYYY-MM-DD>
Updated: <YYYY-MM-DD HH:MM> ET
Available Expirations: <8 dates> (+<N> more; pass expiration=YYYY-MM-DD)

--- Key Levels ---
  Gamma Flip: $<float>            # or "N/A"
  Call Wall: $<float> (OI <int>)
  Put Wall: $<float> (OI <int>)
  Max Pain: $<float>
  Min IV Strike: $<float>
  Net GEX: $<float><K|M|B>
  Bullish Score: <int>/100
  Implied Move: ±$<float> (<float>%)
  Short-Term IV: <float>%
  P/C OI Ratio: <float>
  Total OI: Call <int> / Put <int>
  Total Vol: Call <int> / Put <int>

--- Insights ---
  [<TYPE>] <title>: <text>       # text is truncated with "..." around 200 chars

--- <GREEK> Net Exposure by Strike (nearest <N> to spot) ---   # suffix absent when maxStrikes >= strikes
  $<strike>: <value><K|M|B>
```

- Multiple greeks appear in the fixed order `GAMMA, DELTA, THETA, VEGA, VANNA, CHARM`
  (different from the parameter enum order).
- The per-strike table is `greeks_exposure.<greek>.net`, i.e. exposure units — **not** the dollar
  `gex_by_strike` series. The CLI labels this `units: "exposure_units"`.
- `Available Expirations` lists at most 8 dates plus `(+N more)`.

### MCP error handling (`isError` is not enough)

| Case | `isError` | Text |
| --- | --- | --- |
| missing `ticker` | `true` | `MCP error -32602: Input validation error: … "path":["ticker"] … "Required"` |
| `maxStrikes=0` / `999` | `true` | `… "too_small" minimum 1 …` / `… "too_big" maximum 200 …` |
| `expiration="2026/10/16"` | undefined | `Invalid expiration date format. Use YYYY-MM-DD.` |
| unknown ticker | undefined | `No options data available for ZZZZZZ. …` |
| past expiry | undefined | normal text with a silently different `Selected Expiration` |

The CLI classifies on both `isError` and text patterns, and maps the result to exit 2 (usage),
exit 3 (unavailable) or exit 1 (unexpected).

## Silent fallbacks

Both channels silently replace an unusable expiry or greeks value:

| Request | Result |
| --- | --- |
| `exp=2019-01-18` | `selected_exp` becomes the nearest expiry, no error |
| `exp=bad` | same |
| `expiration=2026-10-16` | parameter ignored, nearest expiry returned |
| `greeks=foo` / `greeks=` | falls back to `gamma` |
| `maxStrikes=5` (REST) | ignored, all 151 strikes returned |

The CLI always echoes `selected_exp`, records a `provenance.warnings` entry when it differs from
`--exp`, and turns that into exit 5 with `--strict-exp`.

## Caching and rate limits

- REST is behind Cloudflare with `cache-control: public, max-age=60`. The CLI additionally keeps a
  60-second on-disk cache in `${XDG_CACHE_HOME:-~/.cache}/options-gex` (override with
  `OPTIONS_GEX_CACHE_DIR`). Hits report `provenance.from_cache: true`. `--no-cache` skips the local
  cache and adds a cache-buster so Cloudflare revalidates.
- REST allows 30 requests per IP; `429` is retried with backoff driven by `ratelimit-reset`, then
  fails with exit 4. MCP allows 120. In `auto` mode a REST 429 falls back to MCP.
- `scan` turns a multi-ticker × multi-expiry sweep into a small number of requests: one fetch per
  `(ticker, expiry)` inside `--dte`, at most `--concurrency` in flight, and it reuses the
  `expiration_dates` of its first fetch. A weekly 3-ticker scan (≈15 requests) already consumes
  half of the 30/IP budget, so keep `--max-exp` small and lean on the 60 s cache.
- `OPTIONS_GEX_API_BASE` / `OPTIONS_GEX_MCP_URL` override the endpoints; `OPTIONS_GEX_OFFLINE=1`
  refuses all network calls (useful with `--from-file`).
