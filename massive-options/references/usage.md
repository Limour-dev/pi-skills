# CLI reference

```bash
massive-options <command> [args] [flags]
```

stdout = result (JSON unless `--format table`), stderr = warnings/errors.
Exit codes: `0` ok · `1` runtime/data error · `2` usage error (includes the full
usage text) · `3` auth or entitlement · `4` rate limited.

## Commands

### `gex <UNDERLYING>`
Gamma exposure for the selected expirations, per strike and per expiry.

```jsonc
{
  "underlying": "SPY",
  "spot": { "price": 769.64, "source": "previous-close", "timeframe": "END-OF-DAY", "asOf": "2026-10-02" },
  "selection": { "dte": 7, "asOf": "2026-10-05", "expirations": ["2026-10-09"], "strikeRangePct": null, "minOpenInterest": null, "contracts": 812 },
  "formula": "gex = gamma * open_interest * shares_per_contract * spot^2 * 0.01",
  "unit": "USD per 1% move",
  "signMode": "dealer",
  "expirations": [ /* one GexGroup per expiry */ ],
  "total": { /* GexGroup with expiry:"ALL" */ },
  "contractsUsed": 800, "contractsSkipped": 12,
  "provenance": { "source": "/v3/snapshot/options/SPY", "dataTimeframe": "END-OF-DAY",
                  "openInterestNote": "open interest is the end of the previous trading session",
                  "formulaNote": "USD of dealer delta to re-hedge per 1% move" },
  "meta": { "generatedAt": "…", "baseUrl": "https://api.massive.com", "requests": 6, "pages": 4, "warnings": [] }
}
```

`GexGroup` fields: `expiry`, `dte`, `expirations[]`, `gex`, `callGex`, `putGex`,
`callOi`, `putOi`, `putCallOiRatio`, `contracts`, `zeroGamma` (interpolated),
`zeroGammaStrike`, `callWall` / `putWall` (`{strike, exposure, netGex, distancePct}`),
`topExposures[]` (10 largest `|gex|`), `strikes[]` where each strike carries
`gex`, `callGex`, `putGex`, `callExposure`, `putExposure`, `callOi`, `putOi`,
`netOi`, `contracts`, `cumulativeGex`.

### `max-pain <UNDERLYING>`
Smallest total ITM payout per expiry and across the selection.

```jsonc
{
  "spot": { … }, "selection": { … },
  "formula": "pain(S) = sum_calls OI*max(0,S-K) + sum_puts OI*max(0,K-S), x shares_per_contract",
  "unit": "USD notional payout",
  "expirations": [ { "expiry": "2026-10-09", "dte": 7, "maxPain": 770, "painAtMaxPain": 1.2e9,
                     "distancePct": -0.05, "callOi": …, "putOi": …, "contracts": …, "top": [ … ] } ],
  "total": { "expiry": "ALL", "maxPain": 770, "painAtMaxPain": …, "curve": [ { "strike": …, "pain": …, "callItm": …, "putItm": …, "callOi": …, "putOi": … } ] },
  "contractsUsed": …, "contractsSkipped": …, "provenance": { … }, "meta": { … }
}
```

`top[]` holds the five cheapest settlement strikes; `total.curve[]` is the whole
pain curve (per-expiry curves are omitted from the JSON to keep payloads small —
narrow to one `--expiry` to get it).

### `chain <UNDERLYING>`
Normalised per-contract rows, each with `gex` and `moneynessPct` added:

`ticker, underlying, expiry, dte, strike, type, oi, oiMissing, volume, gamma,
gammaSource, delta, theta, vega, iv, bid, ask, mid, lastPrice,
sharesPerContract, timeframe, breakEvenPrice, gex, moneynessPct`

`--limit` caps the rows printed (default 250); the chain is sorted by expiry then
strike.

### `expiries <UNDERLYING>`
Expiration discovery that works on entry-level plans.
`{ underlying, asOf, horizonDays, expirations: [{expiry, dte, weekday}] }`.

### `spot <UNDERLYING>`
`{ underlying, price, source, timeframe, asOf }` where `source` is one of
`stock-snapshot` (real-time), `previous-close`, `open-close`, `flag`, `file`.

### `contract <OPTIONS_TICKER>`
`{ ticker, reference, previousDay, previousDayError }` — reference row straight
from `/v3/reference/options/contracts/{ticker}` plus the previous-day bar.

### `probe`
Checks eight endpoints with the configured key and reports
`{ baseUrl, endpoints: [{name, path, ok, status, error, needed_for}], gexAvailable, verdict, workarounds }`.
Use it before promising GEX numbers.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dte N` | `7` | Horizon in calendar days from the reference date (`0` = 0DTE only) |
| `--expiry D` | – | One expiry; repeatable and comma-separated |
| `--expiries A,B` | – | Several expiries at once |
| `--as-of D` | today (ET) | Reference date for DTE maths |
| `--strike-range PCT` | – | Keep strikes within ±PCT of spot (`0.2` = ±20%) |
| `--min-oi N` | – | Drop contracts with less open interest |
| `--max-contracts N` | – | Cap contracts kept (nearest expiry, biggest OI first) |
| `--max-expiries N` | – | Keep only the N nearest expirations |
| `--sign-mode MODE` | `dealer` | `dealer` (call +, put −) · `absolute` · `inverse` |
| `--multiplier N` | per contract | Override `shares_per_contract` |
| `--rate R` | `0.04` | Risk-free rate for the Black-Scholes gamma fallback |
| `--no-gamma-fallback` | off | Do not reconstruct missing gammas |
| `--spot PRICE` | – | Override the underlying price |
| `--top N` | `10` (`5`) | Rows in table sections |
| `--limit N` | `250` | Rows printed by `chain` |
| `--api-key K` | `$MASSIVE_API_KEY` | API key |
| `--base-url URL` | `$MASSIVE_BASE_URL` | API base |
| `--from-file PATH` | – | Analyse a saved chain snapshot offline |
| `--prefer-delayed` | off | Skip the plan-gated stock snapshot |
| `--max-pages N` | `20` | Pagination cap for the chain snapshot |
| `--max-retries N` | `3` | Retries for 429/5xx/network errors |
| `--max-wait MS` | `60000` | Cap on a single backoff wait |
| `--timeout MS` | `30000` | Per-request timeout |
| `--format MODE` | `json` | `json` · `compact` · `table` |
| `--compact` / `--table` | – | Shorthands for `--format` |
| `-h, --help` / `-v, --version` | – | Usage / version |

## Workflows

**"GEX for the week"** — `gex SPY --dte 7`. Report `total.gex` (and its sign),
`zeroGamma`, `callWall.strike`, `putWall.strike`, then the per-expiry split. Add
`--format table` when the user wants to read it directly.

**"0DTE / today's expiry"** — `gex SPY --dte 0`. If today has no listed expiry
the command exits `1` with a hint; widen with `--dte 1`.

**"Where does it pin Friday?"** — `max-pain SPY --expiry <friday>` for the
per-expiry strike, plus `gex` `callWall`/`putWall` for the neighbourhood. Quote
`painAtMaxPain` next to `distancePct` so the level's meaning is clear.

**"Full picture"** — `gex` and `max-pain` on the same selection, then `chain
--strike-range 0.05` to inspect the strikes that drive both.

**"Cheap exploration"** — `expiries AAPL --dte 14` (works without the chain
snapshot), pick a date, then `gex AAPL --expiry <date> --strike-range 0.15`.

**"No API entitlement"** — `probe`; if `gexAvailable` is false, say the plan is
missing the chain snapshot and offer `--from-file` with an exported snapshot.

**"Reproduce a past session"** — save the snapshot JSON, then
`gex SPY --from-file snap.json --as-of 2026-10-02 --spot 769.64`.

## Reading the numbers

- GEX is denominated in **USD per 1% move**. `+1.2B` means dealer hedging needs
  1.2B of delta rebalanced for each 1% move, damping volatility; a negative
  total means hedging amplifies moves.
- `zeroGamma` (gamma flip) is interpolated between the two strikes whose
  cumulative GEX changes sign; `zeroGammaStrike` is the listed strike above it.
  Above the flip, dealer gamma is usually long; below it, short.
- Walls are the largest single-strike call and put gamma concentrations — the
  usual magnets/pin candidates.
- `putCallOiRatio` > 1 means more put open interest than call open interest;
  it says nothing about direction by itself.
- Max pain is a payout-minimising strike, not a forecast. Combine it with OI
  freshness and volume before drawing conclusions.
