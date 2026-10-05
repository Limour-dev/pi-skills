# Worked examples

Every example below is reproducible offline from the committed fixtures; the live ones only
depend on `sellthenews.org` / `mcp.sellthenews.org`.

## 1. Key levels, smallest output

```bash
$ options-gex levels SPY --from-file tests/fixtures/spy-2026-10-05-gamma.json
```

```json
{
  "provenance": {
    "source": "rest",
    "ticker": "SPY",
    "selected_exp": "2026-10-05",
    "updated_at": "2026-10-05T12:49:14.150Z",
    "market_session": "pre",
    "oi_source": "oi",
    "warnings": []
  },
  "levels": {
    "spot": 769.65,
    "net_gex": 544926340.3235289,
    "net_gex_usd": "$544.93M",
    "gamma_flip": 765.79,
    "spot_vs_flip": "above",
    "call_wall": 770, "call_wall_oi": 3563,
    "put_wall": 765, "put_wall_oi": 2714,
    "max_pain": 763,
    "min_iv_strike": 773,
    "bullish_score": 75,
    "implied_move_abs": 4.03, "implied_move_pct": 0.52,
    "stm_iv": 12.5,
    "pc_oi_ratio": 1.06
  },
  "insights": [
    { "type": "GAMMA", "title": "Positive Gamma Environment", "text": "Dealers are long gamma — they buy dips and sell rips, dampening moves. …" }
  ]
}
```

`--format table` prints the same numbers as aligned text:

```
SPY  exp 2026-10-05  source rest  updated 2026-10-05T12:49:14.150Z  session pre
levels: {"spot":769.65,"net_gex":544926340.3235289,"net_gex_usd":"$544.93M","gamma_flip":765.79,…}
[GAMMA] Positive Gamma Environment: Dealers are long gamma — they buy dips and sell rips, …
[KEY LEVELS] Support $765.0 / Resistance $770.0: Put Wall at $765.0 acts as support. …
```

## 2. Per-strike GEX around a magnet level

```bash
$ options-gex gex SPY --from-file tests/fixtures/spy-2026-10-05-gamma.json --top 3 --format compact
```

```json
{
  "units": "usd_gex",
  "selection": { "mode": "top_abs", "requested": 3, "returned": 3, "available": 151, "note": "largest |exposure|" },
  "gex_by_strike": [
    { "strike": 770, "value": 96358554.4915, "value_pretty": "$96.36M" },
    { "strike": 771, "value": 65758067.4448, "value_pretty": "$65.76M" },
    { "strike": 775, "value": 83013606.1794, "value_pretty": "$83.01M" }
  ],
  "zero_gamma_estimate": 770.73,
  "zero_gamma_estimate_delta": 4.94
}
```

The largest positive dollar gamma sits exactly on the `call_wall` (770). The cumulative curves cross
zero at ~770.7, which is *not* the reported `gamma_flip` (765.79) — expected, see
`zero_gamma_estimate_delta`.

## 3. Walls and max pain

```bash
$ options-gex walls SPY --from-file tests/fixtures/spy-2026-10-05-gamma.json --format compact
{"spot":769.65,"call_wall":770,"call_wall_oi":3563,
 "call_wall_distance":{"spot_side":"below","abs":0.35,"pct":-0.05},
 "put_wall":765,"put_wall_oi":2714,
 "put_wall_distance":{"spot_side":"above","abs":4.65,"pct":0.61},
 "net_gex":544926340.3235289}

$ options-gex max-pain SPY --from-file tests/fixtures/spy-2026-10-05-gamma.json --format compact
{"spot":769.65,"max_pain":763,"max_pain_distance":{"spot_side":"above","abs":6.65,"pct":0.87},
 "net_gex":544926340.3235289,"pc_oi_ratio":1.06}
```

Spot is pinned between the put wall (support, 765) and the call wall (resistance, 770), 0.87 % above
max pain.

## 4. Gamma flip — positive vs negative regime

```bash
$ options-gex flip SPY --from-file tests/fixtures/spy-2026-10-05-gamma.json --format compact
{"spot":769.65,"gamma_flip":765.79,"spot_vs_flip":"above","distance_abs":3.86,"distance_pct":0.5,
 "net_gex":544926340.32,"regime":"positive net GEX — dealers long gamma (mean-reverting, vol-suppressing)"}

$ options-gex flip SPY --from-file tests/fixtures/spy-2026-10-16-gamma.json --format compact
{"spot":769.65,"gamma_flip":774.62,"spot_vs_flip":"below","distance_abs":4.97,"distance_pct":-0.64,
 "net_gex":-1544151621.48,"regime":"negative net GEX — dealers short gamma (trend-amplifying, vol-expanding)",
 "net_gex":-1544151621.48,"regime":"negative net GEX — dealers short gamma (trend-amplifying, vol-expanding)"}
```

The 10-16 expiry is short-gamma: spot below the flip means dealer hedging amplifies moves.

## 5. Vanna / charm structure

```bash
$ options-gex skew SPY --from-file tests/fixtures/spy-all-greeks.json --top 2 --format compact
{"units":"exposure_units",
 "levels":{"spot":769.65,"stm_iv":12.5,"pc_oi_ratio":1.06,"net_gex":544926340.32},
 "greeks":{
   "vanna":{"rows":[{"strike":775,"value":664619.8,"value_pretty":"$664.62K"},
                    {"strike":793,"value":479161.53,"value_pretty":"$479.16K"}]},
   "charm":{"rows":[{"strike":760,"value":21043426.8,"value_pretty":"$21.04M"},
                    {"strike":793,"value":-31096604.73,"value_pretty":"-$31.10M"}]}}}
```

## 6. Expiry calendar with day counts

```bash
$ options-gex expiries SPY --from-file tests/fixtures/spy-2026-10-05-gamma.json --today 2026-10-05 --dte 10 --format table
SPY  exp 2026-10-05  source rest  updated 2026-10-05T12:49:14.150Z  session pre
count: 9  total_available: 32
       exp  day  dte
2026-10-05  Mon    0
2026-10-06  Tue    1
2026-10-07  Wed    2
2026-10-08  Thu    3
2026-10-09  Fri    4
2026-10-12  Mon    7
2026-10-13  Tue    8
2026-10-14  Wed    9
2026-10-15  Thu   10
```

## 7. Channel health

```bash
$ options-gex probe --timeout 20 --no-cache
{
  "ok": true,
  "checked_at": "2026-10-05T13:01:08.711Z",
  "rest": { "ok": true, "latency_ms": 1017, "http_status": 200, "selected_exp": "2026-10-05",
            "cf_cache": "MISS", "ratelimit": { "limit": 30, "remaining": 28, "reset": 1791205326 },
            "expirations": 32 },
  "mcp": { "ok": true, "latency_ms": 1489, "http_status": 200, "text_bytes": 1453 },
  "note": "REST is reachable — use it as the primary channel",
  "exit_code": 0
}
```

## 8. MCP fallback

```bash
$ options-gex walls SPY --source mcp --max-strikes 5 --format compact
{"provenance":{"source":"mcp","url":"https://mcp.sellthenews.org/mcp","ticker":"SPY",
 "selected_exp":"2026-10-05","updated_local":"2026-10-05 09:00 ET",
 "warnings":["values come from the MCP text rendering and are rounded/scaled (e.g. net_gex); use --source rest for exact figures",
             "MCP lists only 8 of 32 expirations; use --source rest for the full calendar"]},
 "spot":769.65,"call_wall":770,"call_wall_oi":3563,
 "call_wall_distance":{"spot_side":"below","abs":0.35,"pct":-0.05},
 "put_wall":765,"put_wall_oi":2714,
 "put_wall_distance":{"spot_side":"above","abs":4.65,"pct":0.61},
 "net_gex":544930000}
```

When REST is unreachable, `--source auto` produces the same thing plus a warning naming the REST
failure. Point `OPTIONS_GEX_API_BASE` at a dead host to see it:

```bash
$ OPTIONS_GEX_API_BASE=http://127.0.0.1:9 options-gex flip SPY --max-retries 0 --timeout 5 --format compact
{"provenance":{"source":"mcp","warnings":["…","…",
  "REST channel unavailable (request to http://127.0.0.1:9/api/options/chain?ticker=SPY&greeks=gamma failed: fetch failed); this snapshot came from the MCP text fallback"], …}}
```

## 9. Silent fallback and exit codes

```bash
$ options-gex levels SPY --exp 2019-01-18 --from-file tests/fixtures/rest-fallback.json --format compact
# exit 0; provenance.selected_exp = "2026-10-05" and warnings has
# "requested exp 2019-01-18 is not available (or was ignored); the server returned 2026-10-05"

$ options-gex levels SPY --exp 2019-01-18 --from-file tests/fixtures/rest-fallback.json --strict-exp
options-gex: silent expiry fallback: requested 2019-01-18, server returned 2026-10-05
# exit 5

$ options-gex gex SPY --exp 10/16/2026 --json-errors
{
  "ok": false,
  "error": { "code": "usage", "message": "--exp must be YYYY-MM-DD (got \"10/16/2026\")" }
}
# exit 2
```

`ok:false` payloads (unknown ticker, missing ticker) exit 3, and an exhausted REST rate limit exits 4.

## 10. Offline regression

```bash
$ options-gex raw SPY --from-file tests/fixtures/spy-all-greeks.json --greeks all --top 2 --include oi --format compact
{"units":"usd_gex","greeks_available":["charm","delta","gamma","theta","vanna","vega"],
 "greeks_exposure":{"gamma":{"rows":[{"strike":770,"value":16266.86,"value_pretty":"$16.27K"},
                                      {"strike":775,"value":14014.02,"value_pretty":"$14.01K"}]},
                    "…":"…"},
 "open_interest_by_strike":[{"strike":770,"call":3563,"put":1578},
                            {"strike":775,"call":3588,"put":477}]}
```

`--from-file` accepts a saved REST JSON body, a saved MCP JSON-RPC envelope, or raw MCP text, so a
snapshot captured from any channel can be replayed without network access.
