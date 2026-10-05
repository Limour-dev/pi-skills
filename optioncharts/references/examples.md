# Real outputs

Representative CLI output (2026-10-05, market open, all times UTC);
long arrays and `provenance` blocks are trimmed where marked. `optioncharts` is short for
`bin/optioncharts`.

## Weekly scan — `scan TLT --dte 7 --gex --format csv`

One row per expiry inside the DTE window: volume, put/call ratios, open interest, IV,
expected move, max pain, plus GEX walls and exposure when `--gex` is passed. `--gex` also appends the ±1EM
normalisation columns (`net_exposure_within_1em*`, `strikes_within_1em`, `strikes_total`).

```csv
ticker,expiration,kind,dte,volume_total,volume_pcr,oi_total,oi_pcr,iv_pct,expected_move_abs,expected_move_pct,max_pain,max_pain_diff_pct,net_exposure,call_wall,put_wall,net_exposure_within_1em,net_exposure_within_1em_share_pct,abs_share_within_1em_pct,strikes_within_1em,strikes_total,gex_expiry,gex_as_of,expiry_fallback
TLT,2026-10-05:w,weekly,0,6531,1.1,109683,0.51,22.62,0.24,0.32,77.5,0.58,32480195.16,77.5,77,1526570,4.7,3.1,8,36,2026-10-05:w,2026-10-05T14:02:11.000Z,
TLT,2026-10-07:w,weekly,2,6390,0.52,80431,0.79,16.7,0.63,0.82,78,1.23,-3888627.18,78,76.5,-178877,4.6,2.4,7,34,2026-10-07:w,2026-10-05T14:02:13.000Z,
TLT,2026-10-09:w,weekly,4,8243,0.43,286990,0.33,16.64,0.91,1.18,78,1.23,48706514.02,78,78,2289206,4.7,3.9,9,38,2026-10-09:w,2026-10-05T14:02:15.000Z,
TLT,2026-10-12:w,weekly,7,14579,0.04,65735,0.36,14.35,1.05,1.36,77.5,0.58,2771694.13,77,77,130270,4.7,2.1,6,30,2026-10-12:w,2026-10-05T14:02:17.000Z,
```

Reading it: `iv_pct` rises into the 0-DTE expiry (22.6%), `expected_move_pct` grows with
DTE, `net_exposure` flips sign between 10-07 and 10-09 (negative gamma → positive gamma),
and max pain sits ~1.2% above spot for the two closest weeklies.
`expiry_fallback` is empty because every row's GEX really belongs to its own expiry.

Without `--gex` the same command costs one request per ticker; `--gex` adds one `gamma_exposure` request per
expiry plus one spot request for the ±1EM band. The CLI warns `pass --gex to add walls and exposure` when omitted.

## Per-strike gamma exposure — `gex TLT --exp 2026-10-09:w --top 3`

```json
{
  "ticker": "TLT",
  "exposure": "GEX",
  "type": "open_interest",
  "expiries": ["2026-10-09:w"],
  "requested_expiries": ["2026-10-09:w"],
  "unit": "usd_per_1pct_move",
  "unit_note": "GEX is dollar gamma/delta per 1% underlying move (the upstream \"exposure\" unit) — do NOT label it as notional or absolute dollars",
  "net_exposure": 48706514.02,
  "call_exposure": 129395370.13,
  "put_exposure": -80688856.11,
  "call_wall": 78,
  "put_wall": 78,
  "wall_note": "call_wall / put_wall come from the inline JSON and are real even though the site's UI shows them locked",
  "gamma_zero_level": null,
  "gamma_zero_level_note": "null on the free tier (the server never computes it anonymously); recompute a flip level locally from `greeks` × open interest if you need one",
  "exposure_by_expiration": [
    { "expiration": "2026-10-09:w", "net_exposure": 48706514.02, "call_exposure": 129395370.13,
      "put_exposure": -80688856.11, "call_wall": 78, "put_wall": 78, "gamma_zero_level": null }
  ],
  "gex_by_strike": [
    { "strike": 78,   "call_exposure": 46373121.53, "put_exposure": -21731802.67, "net_exposure": 24641318.86 },
    { "strike": 77.5, "call_exposure": 25670260.52, "put_exposure":  -5591360.85, "net_exposure": 20078899.67 },
    { "strike": 78.5, "call_exposure": 18176626.75, "put_exposure":  -4680123.78, "net_exposure": 13496502.97 }
  ],
  "exposure_by_strike_count": 47,
  "returned_expiries": ["2026-10-09:w"]
}
```

`gex_by_strike` is truncated to 3 rows by `--top 3`; 47 strikes existed.
Everything is `$/1%`, so the wall level matters, not the magnitude relative to a notional.

## Cross-ticker normalisation — `gex TLT --exp 2026-10-09:w --top 3 --normalize pct --units --format csv`

```csv
ticker,expiry,strike,call_exposure,put_exposure,net_exposure,share_of_abs_total_pct,sigma_pos,unit_call_exposure,unit_put_exposure,unit_net_exposure,unit_share_of_abs_total_pct,unit_sigma_pos
TLT,2026-10-09:w,79,14294865.99,-2672476.47,11622389.52,22.6196,,usd_per_1pct_move,usd_per_1pct_move,usd_per_1pct_move,pct,sigma
TLT,2026-10-09:w,80,7495463.15,-1631161.41,5864301.74,11.4132,,usd_per_1pct_move,usd_per_1pct_move,usd_per_1pct_move,pct,sigma
TLT,2026-10-09:w,75,286913.09,-5607120.38,-5320207.28,-10.3542,,usd_per_1pct_move,usd_per_1pct_move,usd_per_1pct_move,pct,sigma
```

`--units` appends a `unit_<column>` column for every unit-bearing column while keeping the original header names,
so the same reader works with or without it. `share_of_abs_total_pct` is always present (no extra request) and
re-weights the chain to 100%, so it can be compared across tickers.
`--normalize sigma` additionally fills `sigma_pos = (strike − spot) / expected_move_abs` (here null
because `--from-file` cannot issue the two extra spot/statistics requests).

## Per-expiry statistics — `stats TLT --dte 4 --format csv`

One request for the whole table (the CSV below is complete).

```csv
ticker,expiration,volume_total,volume_pcr,oi_total,oi_pcr,iv_pct,expected_move_abs,max_pain,volume_calls,volume_puts,oi_calls,oi_puts,dte,contracts_total
TLT,2026-10-05:w,6531,1.1,109683,0.51,22.62,0.24,77.5,3111,3420,72428,37255,0,72
TLT,2026-10-07:w,6390,0.52,80431,0.79,16.7,0.63,78,4209,2181,45016,35415,2,90
TLT,2026-10-09:w,8243,0.43,286990,0.33,16.64,0.91,78,5779,2464,215608,71382,4,94
```

JSON rows and CSV headers share canonical names: `iv_pct`, `expected_move_abs` / `expected_move_pct` (the
upstream request keys `iv` / `expected_move` are still accepted in `--columns`).

## Max pain term structure — `max-pain TLT --dte 20 --format csv`

```csv
ticker,expiration,max_pain,diff,diff_pct,diff_display
TLT,2026-10-05:w,77.5,0.45,0.58,0.45 (0.58%)
TLT,2026-10-07:w,78,0.95,1.23,0.95 (1.23%)
TLT,2026-10-09:w,78,0.95,1.23,0.95 (1.23%)
TLT,2026-10-12:w,77.5,0.45,0.58,0.45 (0.58%)
TLT,2026-10-14:w,78.5,1.45,1.88,1.45 (1.88%)
```

`diff_pct` is versus the current spot (the spot moved between commands, so absolute
diffs shift; percentages are the stable read).

## Option chain — `chain TLT --exp 2026-10-09:w --format csv`

```csv
ticker,expiration,option_type,strike,bid,ask,volume,oi,iv_pct,delta
TLT,2026-10-09:w,CALL,65,12.05,12.25,0,0,67.51,0.99
TLT,2026-10-09:w,CALL,70,7.1,7.25,2,0,46.83,0.97
...
TLT,2026-10-09:w,PUT,77,0.39,0.41,359,3969,17.22,-0.3
```

`--top` does not apply here (strikes are the natural order) and the CLI says so on stderr.
The `iv` column is a percent; in JSON the same value is `iv_pct`.

## Real-time spot — `spot TLT`

```json
{
  "ticker": "TLT",
  "price": 77.07,
  "change": -0.41,
  "change_pct": -0.53,
  "name": "iShares 20+ Year Treasury Bond ETF",
  "currency": "USD",
  "as_of": "Oct 05, 10:01 AM EDT",
  "market_status": "Market Open",
  "options_delay": "Options 15-min Delayed",
  "price_source": "Polygon.io (real-time, per the page tooltip)",
  "note": "extended-hours (pre/post) prices are only present in the widget when a session is active"
}
```

`price` is real-time while every option number on the site is 15 minutes delayed — do not
mix the two into one "as of" claim.

## Expected-move cone — `em TLT --limit 3 --format csv`

```csv
ticker,et_date,et_time,t,iso,em_amt,em_pct,low,high,avg_iv
TLT,2026-10-05,23:59:59,1791259199000,2026-10-06T03:59:59.000Z,0.25,0.32,76.88,77.38,21.71
TLT,2026-10-06,23:59:59,1791345599000,2026-10-07T03:59:59.000Z,0.45,0.58,76.68,77.58,19.43
TLT,2026-10-07,23:59:59,1791431999000,2026-10-08T03:59:59.000Z,0.65,0.84,76.48,77.78,17.15
```

Nearest-first: the cone opens as time to expiry grows. `et_date` is the America/New_York session
the point stamps — the UTC `iso` date is one day later, so **read `et_date`, not `iso`**. A cone row
whose `et_date` equals an expiry should match that expiry's `scan`/`stats` `expected_move_abs`
(they agree only on the expiry's own date); for per-expiry numbers use `stats`.

## Expiry list with the required suffix — `expiries TLT --dte 7`

```json
{
  "ticker": "TLT",
  "count": 4,
  "total_available": 31,
  "expirations": [
    { "exp": "2026-10-05:w", "date": "2026-10-05", "weekday": "Mon", "kind": "weekly", "dte": 0, "display": "Oct 05, 2026 (0 days) (w)" },
    { "exp": "2026-10-07:w", "date": "2026-10-07", "weekday": "Wed", "kind": "weekly", "dte": 2, "display": "Oct 07, 2026 (2 days) (w)" },
    { "exp": "2026-10-09:w", "date": "2026-10-09", "weekday": "Fri", "kind": "weekly", "dte": 4, "display": "Oct 09, 2026 (4 days) (w)" },
    { "exp": "2026-10-12:w", "date": "2026-10-12", "weekday": "Mon", "kind": "weekly", "dte": 7, "display": "Oct 12, 2026 (7 days) (w)" }
  ]
}
```

`2026-10-16:m` (the third Friday) is just outside the window here. Copying the `exp` value
straight into `--exp` is the cheapest, safest way to ask for one expiry.

## Failure modes

```console
$ optioncharts stats ZZZZZZ
{"ok":false,"error":{"code":"unavailable","message":"optioncharts.io has no options data for ticker ZZZZZZ (invalid ticker)"}}   # exit 3

$ optioncharts gex TLT --exp 2026-10-19:w
{"ok":false,"error":{"code":"exp_fallback","message":"TLT: requested 2026-10-19:w but the server returned 2026-10-05:w — expiration_dates must carry the :w / :m suffix"}}   # exit 5

$ optioncharts gex TLT --exp 2026-10-19:w --allow-exp-fallback --format csv
ticker,expiry,strike,call_exposure,put_exposure,net_exposure
...   # the data is for 2026-10-05:w, and the warning in provenance.warnings says so

$ optioncharts gex TLT --exp not-a-date
{"ok":false,"error":{"code":"usage","message":"invalid --exp not-a-date: expected YYYY-MM-DD or YYYY-MM-DD:w|m"}}   # exit 2
```

`2026-10-19:w` is a good illustration of the trap: the expiry shows up in the statistics
table but the chart endpoints silently substitute the nearest expiry for it.

## Warnings you will actually see

```json
"warnings": [
  "2026-10-09 → 2026-10-09:w (suffix added)",
  "optioncharts.io serves options data 15 minutes delayed (OPRA); spot prices are real-time (Polygon.io)",
  "the expiry checkbox list looks capped at 30 entries: `stats` reads the full per-expiry table, and a date past the list gets its :w/:m suffix inferred from the third-Friday rule",
  "2 expiries requested: the per-strike series is summed across them (the per-expiry breakdown is a paid feature on optioncharts.io) — request one expiry at a time for a clean series",
  "gex, dex are locked on the free tier (cells render a lock icon → null)"
]
```

Report them; they are the difference between "the wall is at 78" and "the wall I think I
fetched".
