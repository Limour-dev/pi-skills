---
name: massive-options
description: >
  Short-dated US option analytics from the Massive (polygon.io-compatible) REST
  API via the zero-dependency `massive-options` CLI: gamma exposure (GEX) by
  expiry and strike, gamma-flip / zero-gamma levels, call and put walls,
  max-pain strikes, and raw chains with open interest, greeks, IV and quotes.
  Defaults to the ~1-week (≤7 DTE) horizon, including 0DTE; supports explicit
  expirations, strike windows and offline snapshot files. Use for 期权 GEX、
  gamma 敞口、最大痛点/max pain、末日期权/0DTE、一周到期短期期权、call wall /
  put wall、gamma flip、期权链 open interest, or any "where are dealers long
  gamma / where does this pin" question — and to check which Massive endpoints
  an API key can reach (`probe`).
---

# Massive options (GEX / max pain)

Zero-dependency, pure-TypeScript CLI over the Massive REST API. No SDK, no
`npm install`, no build step — just Node ≥ 22.18.

```bash
massive-options <command> [args] [flags]
```

If `massive-options` is not on `PATH`, use `<skill-dir>/bin/massive-options` or
`node <skill-dir>/cli.ts`. Requires `MASSIVE_API_KEY` (or `POLY_API_KEY` /
`--api-key`).

**Plan requirement.** GEX and max pain are computed from the option chain
snapshot (`GET /v3/snapshot/options/{underlying}`), which carries **open
interest + greeks**. That endpoint is included from **Options Starter** upward;
Options Basic does not include it. `expiries`, `spot` and `contract` work on the
entry-level plan. Run `massive-options probe` to see exactly what a key can
reach before promising numbers.

## Commands

| Need | Command |
| --- | --- |
| Gamma exposure, walls, gamma flip | `gex SPY --dte 7` |
| Max-pain strike | `max-pain SPY --dte 7` |
| Raw chain (OI, greeks, IV, quotes) | `chain SPY --dte 2 --strike-range 0.1` |
| Which expirations exist in the horizon | `expiries SPY --dte 7` |
| Underlying price + its source | `spot SPY` |
| One contract's reference + previous bar | `contract O:SPY261009C00600000` |
| What the API key is entitled to | `probe` |

Every command prints JSON on stdout (pretty by default; `--format compact` for
one line, `--format table` for a human table). Errors and warnings go to stderr.
Exit codes: `0` ok · `1` runtime error · `2` usage error · `3` auth/entitlement ·
`4` rate limited.

## Selection flags (the "one week" default)

- `--dte N` — horizon in **calendar days from today, US/Eastern** (default `7`,
  i.e. ~1 week; `0` = today's 0DTE expiry only, `14`/`30` for wider windows).
- `--expiry YYYY-MM-DD` / `--expiries A,B` — pin exact expirations instead.
- `--as-of YYYY-MM-DD` — reference date for DTE maths (essential for offline runs).
- `--strike-range PCT` — keep strikes within ±PCT of spot (`0.1` = ±10%).
- `--min-oi N`, `--max-contracts N`, `--max-expiries N` — size the payload down.

Analytics: `--sign-mode dealer|absolute|inverse` (default `dealer`), `--multiplier N`,
`--rate R` (Black-Scholes fallback), `--no-gamma-fallback`, `--spot PRICE`, `--top N`.

Data access: `--api-key`, `--base-url`, `--from-file PATH` (offline),
`--prefer-delayed`, `--max-pages`, `--max-retries`, `--max-wait`, `--timeout`.

## Definitions (state these when reporting)

```
GEX_contract = gamma × open_interest × shares_per_contract × spot² × 0.01
             → USD of dealer delta to re-hedge per 1% move
call +, put − (dealer mode): positive GEX = hedging dampens moves
pain(S)      = Σ_calls OI·max(0,S−K) + Σ_puts OI·max(0,K−S), × multiplier
max pain     = the strike minimising pain(S)
zero gamma   = strike where cumulative GEX (lowest strike upward) crosses 0
call/put wall = strike with the largest call / put gamma concentration
```

Output fields: `expirations[]` per expiry plus `total` (`ALL`), each with `gex`,
`callGex`, `putGex`, `callOi`, `putOi`, `putCallOiRatio`, `zeroGamma`,
`zeroGammaStrike`, `callWall`, `putWall`, `topExposures`, `strikes`. `max-pain`
returns `maxPain`, `painAtMaxPain`, `distancePct`, `top[]` and the full `curve[]`.

## Guardrails

- **Never invent numbers.** Every value comes from command output. If the chain
  snapshot is not entitled you get exit `3` and *no* stdout — say the plan is
  missing, not that GEX is zero.
- **Open interest is the previous session's close**, not intraday positioning;
  GEX/max pain also assume every contract is dealer-intermediated. Repeat this
  caveat whenever you report a level.
- **Always report the spot price and its `source`/`timeframe`.** `previous-close`
  + `END-OF-DAY` means the reference price is stale; `REAL-TIME` means the plan
  includes snapshots.
- Missing gammas are reconstructed from IV with Black-Scholes and flagged
  (`gammaFromBlackScholes`, a `warning`, `gammaSource: "black-scholes"`);
  contracts with neither gamma nor IV are *excluded* and counted in
  `missingGreeks` / `contractsSkipped`.
- Wide horizons multiply API calls; on tight plans use `--dte 7 --max-expiries 2`
  or `--expiry`. A 429 is retried with backoff unless it exceeds `--max-wait`.
- Read-only: this skill cannot place, modify or cancel orders.
- Answer in the user's language.

## Details (load on demand)

- `references/usage.md` — every flag, output shape, exit code and workflow recipe.
- `references/api.md` — endpoints, parameters, plan access, pagination, quirks.
- `references/examples.md` — worked examples with real command output.
