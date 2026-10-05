# Worked examples

Output below is real, captured from the CLI. The `TEST` runs use the bundled
mock API (`tests/mock-server.ts`, fixture `tests/fixtures/snapshot-test.json`)
so the figures are reproducible; the `SPY` runs are live against
`https://api.massive.com`.

## 1. Gamma exposure for the ~1-week horizon (offline fixture)

```bash
node tests/mock-server.ts                    # prints e.g. http://127.0.0.1:40209
massive-options gex TEST --dte 7 --as-of 2026-10-02 \
  --base-url http://127.0.0.1:40209 --api-key demo --format table
```

```
spot 100.00 · 6 contracts · GEX in USD per 1% move · sign mode dealer
expiry      dte  contracts  net GEX  call GEX   put GEX  P/C OI  call wall    put wall     zero gamma
----------  ---  ---------  -------  --------  --------  ------  -----------  -----------  ----------
2026-10-09    7          6   14.00K   145.00K  -131.00K    1.63  100 (+0.0%)  100 (+0.0%)       97.50
ALL           7          6   14.00K   145.00K  -131.00K    1.63  100 (+0.0%)  100 (+0.0%)       97.50

largest strikes by |net GEX|
strike  net GEX  call GEX   put GEX  call OI  put OI  distance
------  -------  --------  --------  -------  ------  --------
100.00   20.00K   120.00K  -100.00K      200     250    +0.00%
95.00   -10.00K    20.00K   -30.00K      100     300    -5.00%
105.00    4.00K     5.00K    -1.00K       50      20    +5.00%
```

How to read it: net GEX is *positive* (`+14K` per 1% move) so hedging dampens
moves; the gamma flip sits at `97.5` (below spot, i.e. the chain is long gamma);
both walls coincide at the `100` strike, which is the pin candidate.

The same run as JSON (`--format json`) exposes the per-strike curve:

```jsonc
{
  "total": {
    "expiry": "ALL", "dte": 7, "gex": 14000, "callGex": 145000, "putGex": -131000,
    "putCallOiRatio": 1.6285714285714286, "zeroGamma": 97.5, "zeroGammaStrike": 100,
    "callWall": { "strike": 100, "exposure": 120000, "netGex": 20000, "distancePct": 0 },
    "putWall":  { "strike": 100, "exposure": 100000, "netGex": 20000, "distancePct": 0 },
    "strikes": [
      { "strike": 95,  "gex": -10000, "cumulativeGex": -10000 },
      { "strike": 100, "gex":  20000, "cumulativeGex":  10000 },
      { "strike": 105, "gex":   4000, "cumulativeGex":  14000 }
    ]
  }
}
```

Sanity check of the arithmetic by hand: the `100` call has `gamma 0.06`,
`OI 200`, multiplier `100`, `spot 100` →
`0.06 × 200 × 100 × 100² × 0.01 = 120,000`.

## 2. Max pain, per expiry and aggregated

```bash
massive-options max-pain TEST --dte 60 --as-of 2026-10-02 \
  --base-url http://127.0.0.1:40209 --api-key demo --format table
```

```
spot 100.00 · max pain = strike with the smallest total ITM payout · 9 contracts with OI
expiry      dte  contracts  max pain  payout there  vs spot  call OI  put OI
----------  ---  ---------  --------  ------------  -------  -------  ------
2026-10-09    7          6    100.00        60.00K   +0.00%      350     570
2026-11-20   49          3    100.00             0   +0.00%       15      50
ALL           7          9    100.00        60.00K   +0.00%      365     620

cheapest settlements
expiry      strike   payout  call ITM pts  put ITM pts
----------  ------  -------  ------------  -----------
2026-10-09  100.00   60.00K        500.00       100.00
2026-10-09   95.00  145.00K             0        1.45K
2026-10-09  105.00  200.00K         2.00K            0
2026-11-20  100.00        0             0            0
2026-11-20  110.00   10.00K        100.00            0
```

`100` is the cheapest settlement: if the underlying expires there, option
holders collect the least (60K of notional payout on the October expiry).

## 3. Chain inspection

```bash
massive-options chain TEST --dte 7 --as-of 2026-10-02 --limit 4 \
  --base-url http://127.0.0.1:40209 --api-key demo --format table
```

```
spot 100.00 · 6 contracts (showing 4)
expiry      dte  strike  type   OI  volume   mid     IV    gamma      GEX   dist  ticker
----------  ---  ------  ----  ---  ------  ----  -----  -------  -------  -----  ---------------------
2026-10-09    7   95.00  call  100     120  6.40  28.0%  0.02000   20.00K  -5.0%  O:TEST261009C00095000
2026-10-09    7  100.00  call  200     480  3.90  30.0%  0.06000  120.00K  +0.0%  O:TEST261009C00100000
2026-10-09    7  105.00  call   50      60  1.80  31.0%  0.01000    5.00K  +5.0%  O:TEST261009C00105000
2026-10-09    7   95.00  put   300     200  0.90  33.0%  0.01000   30.00K  -5.0%  O:TEST261009P00095000
```

## 4. Live: expirations and spot (works on an entry-level plan)

```bash
MASSIVE_API_KEY=… massive-options expiries SPY --dte 7 --format table
```

```
SPY · as of 2026-10-05 · 7-day horizon · 6 expiration(s)
expiry      dte  weekday
----------  ---  -------
2026-10-05    0  Mon
2026-10-06    1  Tue
2026-10-07    2  Wed
2026-10-08    3  Thu
2026-10-09    4  Fri
2026-10-12    7  Mon
```

Six expirations inside one week — dailies plus next Monday. `--dte 0` selects
just `2026-10-05`.

```bash
MASSIVE_API_KEY=… massive-options spot SPY --format compact
```

```json
{"underlying":"SPY","price":769.64,"source":"previous-close","timeframe":"END-OF-DAY","asOf":"2026-10-02","provenance":{"note":"delayed previous-day close from /v2/aggs/ticker/SPY/prev"},"meta":{"requests":2}}
```

`source: previous-close` + `timeframe: END-OF-DAY` is the honest signal: the
stock snapshot endpoint is not in this plan (that is the 2nd request), so the
reference price is Friday's close, not a live quote.

## 5. Live: entitlement check before promising GEX

```bash
MASSIVE_API_KEY=… massive-options probe --format table
```

```
endpoint                     path                                               state         needed for
---------------------------  -------------------------------------------------  ------------  -----------------------------------------
options-chain-snapshot       /v3/snapshot/options/SPY                           not-entitled  GEX and max pain (open interest + greeks)
option-contract-snapshot     /v3/snapshot/options/SPY/O:SPY261009C00600000      not-entitled  single-contract OI + greeks
options-contracts-reference  /v3/reference/options/contracts                    ok            expiration discovery
stock-snapshot               /v2/snapshot/locale/us/markets/stocks/tickers/SPY  not-entitled  real-time underlying price
stock-previous-bar           /v2/aggs/ticker/SPY/prev                           ok            delayed underlying price
market-status                /v1/marketstatus/now                               ok            market hours context

The key cannot read the option chain snapshot, so gex/max-pain cannot be computed from live data. …
```

## 6. Live: what a blocked request looks like

```bash
MASSIVE_API_KEY=… massive-options gex SPY --dte 7
# exit code 3, nothing on stdout
```

```
error: Not entitled to the SPY option chain snapshot (HTTP 403).
  endpoint: https://api.massive.com/v3/snapshot/options/SPY?expiration_date.gte=2026-10-05&expiration_date.lte=2026-10-12&limit=250&sort=expiration_date&order=asc&apiKey=***
  hint: The option chain snapshot is included from the "Options Starter" plan up (Options Basic does not include it) — see https://massive.com/pricing. GEX and max pain need per-contract open interest + gamma, which only this endpoint provides.
```

The right response is to report the plan limitation (or offer `--from-file`),
never to invent a GEX number.

## 7. Offline analysis of a saved snapshot

```bash
curl -s "https://api.massive.com/v3/snapshot/options/SPY?expiration_date.gte=2026-10-09&expiration_date.lte=2026-10-09&limit=250" \
  -H "Authorization: Bearer $MASSIVE_API_KEY" > spy-2026-10-09.json

massive-options gex SPY --from-file spy-2026-10-09.json --as-of 2026-10-09 --top 5
massive-options max-pain SPY --from-file spy-2026-10-09.json --as-of 2026-10-09
```

No API key required, no rate limit, and the `as-of` date makes the DTE and the
Black-Scholes fallback reproducible.

## 8. Narrowing a request for a tight rate limit

```bash
# entry plan: ~5 requests/minute
massive-options gex SPY --dte 7 --max-expiries 1 --strike-range 0.05 --prefer-delayed
```

One contract-reference request, one price request, and one or two snapshot
pages — enough for a single expiry around the money. Warnings tell you when a
cap actually bit (`contracts truncated to …`, `pagination was capped …`).
