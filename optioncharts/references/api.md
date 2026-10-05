# Endpoints, parameters and quirks

optioncharts.io has **no JSON API**. It is a Rails + Hotwire/htmx app: every chart page is a
shell that pulls an HTML fragment with `hx-get`, and the chart data is inlined in that
fragment as `var <name> = {...};`. Fetching data therefore means:

1. `GET /async/<controller>/<action>?<params>` with the right query parameters;
2. extract the inline JSON with a string-aware brace matcher (a regex truncates on nested
   objects, and the same variable name can appear twice with different types).

A `.json` suffix does not exist (`/async/options_charts/open_interest.json` → HTTP 500).
No cookie, CSRF token or `HX-Request` header is required.

```text
GET /async/options_charts/<chart>?ticker=TLT&expiration_dates=2026-10-09:w&option_type=all&strike_range=all
```

## Chart endpoints — `/async/options_charts/*`

| Endpoint | Extra params | Inline variable | Shape |
| --- | --- | --- | --- |
| `open_interest` | | `chart_data` (a **list**, then a **dict**) | `{"2026-10-09:w:calls":[{strike,open_interest,option_type,contract_symbol,...}]}` |
| `volume` | | `chart_data` (list + dict) | same, `volume` |
| `volatility_skew` | | `chart_data` (dict) | same, `implied_volatility` |
| `gamma_exposure` | `gamma_exposure_type=open_interest\|volume` | `chart_exposure_data` | see below |
| `delta_exposure` | `delta_exposure_type=open_interest\|volume` | `chart_exposure_data` | same shape |
| `greeks` | | `all_chart_data` | `{delta:{...},gamma:{...},theta:{...},vega:{...}}`, rows carry `implied_volatility`/`rho`/`vanna`/`charm`/`vomma` |
| `max_pain` | (ignores expiries) | `chart_data` (**list**) | **all** expiries: `{expiration_date_id,max_pain_display,max_pain_to_price_diff,max_pain_to_price_display,...}` |
| `expected_move` | (ignores expiries) | `expectedMoveConeData` | ~838 daily points `{t,em_amt,em_pct,low,high,avg_iv}` |
| `probability_distribution` | | `chart_data` (dict) | keys `exp:lognormal`, rows `{underlying_price,probability_at,probability_above}` |

Common parameters:

| Parameter | Values | Notes |
| --- | --- | --- |
| `ticker` | `TLT`, `SPY`, `QQQ`, … | required; the site lists ~2338 symbols |
| `expiration_dates` | `2026-10-09:w` or comma-separated | **the `:w`/`:m` suffix is mandatory**, see Pitfalls |
| `option_type` | `all` / `call` / `put` | `all` returns calls and puts |
| `strike_range` | `all` or `min,max` | `all` = every strike that has contracts (TLT 36–47 rows, SPY 171) |
| `chart_type` | `column` / `scatter` / `line` | rendering only, data unchanged |

`chart_exposure_data` (GEX/DEX), verbatim shape:

```json
{
  "ticker": "TLT",
  "exposure_by_strike_series": [
    { "strike": 78.0, "call_exposure": 16797845.74, "put_exposure": -6677974.78, "net_exposure": 10119870.95 }
  ],
  "call_exposure": 80819612.23,
  "put_exposure": -55834471.87,
  "net_exposure": 24985140.36,
  "call_wall": 78.0,
  "put_wall": 78.0,
  "exposure_by_expiration_series": [
    { "expiration_index": 0, "expiration_date_id": "2026-10-09:w", "expiration_date_display": "Oct 09, 2026",
      "expiration_int": 1791576000, "net_exposure": 24985140.36, "call_exposure": 80819612.23,
      "put_exposure": -55834471.87, "call_wall": 78.0, "put_wall": 78.0, "gamma_zero_level": null }
  ]
}
```

Unit: **dollars per 1% underlying move** (`$/1%`), not notional. `gamma_exposure_type=volume`
weights by same-day volume ("flow GEX") and differs a lot from the OI version
(TLT 10-09: OI `+24.98M` vs volume `+107.69M`).

## Table endpoints

| Endpoint | Params | Returns |
| --- | --- | --- |
| `/async/option_chain` | `view=list\|straddle`, `columns=bid,ask,volume,oi,iv,delta`, `option_type`, `expiration_dates`, `strike_range` | HTML `<table>` per side (`option_chain_table_id-call` / `-put`), ~48 rows per TLT expiry |
| `/async/option_chain_statistics` | `expiration_dates=all`, `columns=expiration,volume_total,volume_pcr,oi_total,oi_pcr,iv,expected_move,max_pain,volume_calls,volume_puts,oi_calls,oi_puts,dte,contracts_total` | HTML `<table>`, **one row per expiry** (plus a trailing `Totals` row that is not an expiry) |
| `/async/options_ticker_info` | `ticker` | dividend yield / average volume / day range / 52-week range (label + value `<div>` pairs) |
| `/async/stock_price_widget` | `ticker` | real-time spot with change, `As of` stamp, market status and the option-delay banner |

`option_chain_statistics` is the best value endpoint: **one request for every expiry's**
volume, PCR, OI, PCR, IV, expected move, max pain, call/put split, DTE and contract count.

Table parsing notes:

- The expiry id is only in the cell's `<a href="…?expiration_dates=2026-10-09:w">`; the
  visible text (`Oct 05, 2026 (0 days) (w)`) is a fallback.
- `stats` / `chain` `--columns` is a **local projection**: the CLI always sends the identity column
  (`expiration` / `strike`) first and maps cells by header text, so a column subset cannot shift values
  (OC-02/OC-03). Unknown column keys are rejected with a usage error.
- Paid cells render `<i class="bi bi-lock">` instead of a value — the CLI maps them to
  `null` and reports `locked_columns` instead of guessing.
- The `Totals` row has no href and is dropped.
- The chain tables carry no expiry list, so the CLI derives the expiry from the OCC
  contract symbols (`TLT261009C00065000` → `2026-10-09:w`) to detect a fallback.

## Free / paid boundary (anonymous, measured)

| Data | Free | Notes |
| --- | --- | --- |
| Chart JSON incl. per-strike GEX/DEX, `call_wall`, `put_wall`, `net_exposure` | ✅ | walls are real even though the UI shows 🔒 |
| `option_chain`, `option_chain_statistics`, `options_ticker_info`, `stock_price_widget` | ✅ | |
| `option_chain_statistics` `gex` / `dex` columns | ❌ | lock icon cells (not an error) |
| GEX/DEX per-expiry breakdown (`exposure_by_expiration_series` > 1) | ❌ | free tier collapses to 1 row; the per-strike series is the **sum** over the requested expiries |
| `gamma_zero_level` (Gamma Flip) | ❌ | always `null`; recompute from `greeks` × OI if needed |
| `vanna` / `charm` / `vomma` | ❌ | always `null` |
| Historical series (`option_history_*`, "View all expiries") | ❌ | fragment is an upgrade notice |
| CSV downloads (`/async/*.csv`) | ❌ | HTTP 401 (the only `/async` path robots.txt disallows) |

## Request characteristics (measured 2026-10-05)

| Observation | Result |
| --- | --- |
| Auth | none; no cookies/CSRF/special UA; `HX-Request: true` optional |
| Rate limit | 30 sequential requests all `200`, no `429`, no rate-limit headers |
| Latency | TTFB steady 2.1–2.4 s (`x-runtime` only ~0.13 s) |
| Concurrency | 5 parallel requests finished in 3.1 s |
| Compression | `Accept-Encoding: gzip` takes a fragment from ~113 KB to ~15 KB |
| Caching | weak `ETag`, `If-None-Match` still returns `200` (no 304); no usable CDN cache |
| Freshness | options **15 minutes delayed** (OPRA); spot via Polygon.io is real-time |
| robots.txt | only `Disallow: /async/*.csv`; the HTML fragments are not disallowed |

## Pitfalls

1. **`expiration_dates` must carry `:w` / `:m`.** Without the suffix the server silently
   answers for a different expiry:

   ```text
   expiration_dates=2026-10-09     → returns 2026-10-05:w   net=21,718,560  ← wrong
   expiration_dates=2026-10-09:w   → returns 2026-10-09:w   net=24,985,140  ← right
   ```

   The CLI resolves bare dates against the checkbox list, marks the correction in
   `provenance.warnings`, re-reads the expiry from the payload, and **exits 5** if the
   server answered for something else (`--allow-exp-fallback` downgrades it to a warning).
2. `chart_data` appears **twice** in one fragment (a summary list and the by-strike dict).
   Distinguish by the opening bracket — and note a third occurrence exists in some
   fragments, so pick the first of the wanted type but keep the type check.
3. `gamma_exposure` without `expiration_dates` usually falls back to the nearest expiry, but
   has been observed to fail — always send it.
4. The expiry checkbox list is **truncated (~30 entries)**, while the statistics table
   carries more (e.g. `2026-10-19:w`). Expiries that exist only in the statistics table are
   exactly the ones the chart endpoints refuse — hence pitfall 1's strict check.
5. `strike_range=all` means "every strike with contracts", not "unbounded".
6. `option_type=` (empty) behaves differently from `option_type=all` on `option_chain`;
   always send `all`.
7. Inline variable names (`chart_data`, `all_chart_data`, `expectedMoveConeData`, …) are
   template implementation details and can change without notice. The CLI fails with a
   `parse_error` instead of returning empty data, and `raw --endpoint … --html` shows the
   current fragment.
8. `expected_move` cone points stamp a **session close in `America/New_York`**
   (`t` ≈ 23:59:59 ET), so their UTC date is one day *later*; the CLI derives `et_date` / `et_time`.
   The cone is spot-anchored and interpolated per day — it is **not** the per-expiry
   `option_chain_statistics` expected move, and only matches it on an expiry's own session date.
9. GEX/DEX are **snapshot quantities** with no server timestamp in the fragment; two requests
   minutes apart legitimately differ. The CLI exposes `exposure_as_of` / `gex_as_of` (local fetch
   time) so callers can tell whether two numbers came from the same sample.
10. `exposure_by_strike_series.net_exposure` (and therefore `net_exposure`) scales with each
    ticker's contract notional and is not comparable across symbols without normalisation — the
    CLI always emits `share_of_abs_total_pct` and can emit `sigma_pos` via `--normalize sigma`.

## Risks

- **Terms**: robots.txt does not forbid the fragments, but bulk scraping/redistribution
  still needs a ToS check. Reading `put_wall` from the inline JSON while the UI renders it
  locked is a grey area (the data is not gated server-side).
- **Stability**: `/async/<controller>/<action>` paths are stable; the inline variable names
  are not.
- **Freshness**: 15-minute-delayed options data is unsuitable for intraday execution
  signals.
- **Units**: `exposure_by_strike_series.net_exposure` is `$/1%`, so it must never be
  formatted as a dollar notional.
