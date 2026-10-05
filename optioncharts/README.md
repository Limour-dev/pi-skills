# optioncharts

Weekly **US options data** from [optioncharts.io](https://optioncharts.io) as a
zero-dependency, pure-TypeScript CLI. No API key, no SDK, no `npm install` —
`bin/optioncharts` runs `node cli.ts` (Node ≥ 22.18 strips TypeScript natively).

```bash
optioncharts scan TLT SPY QQQ --dte 7 --weekly-only --format csv   # weekly dashboard
optioncharts scan SPY --dte 14 --gex --format csv                  # + walls/exposure per expiry
optioncharts gex TLT --exp 2026-10-09:w --top 20 --format csv      # per-strike GEX
optioncharts stats TLT --dte 7                                     # per-expiry stats table
optioncharts chain SPY --exp 2026-10-09:w --format csv             # option chain
optioncharts max-pain TLT                                          # all expiries, one request
```

## What it reports

- **Weekly / per-expiry dashboard** (`scan`): volume, put/call ratios, open interest,
  IV, expected move, max pain, call/put OI split, DTE and contract count — one row per
  expiry, one request per ticker (plus one per expiry with `--gex`).
- **Gamma & delta exposure by strike** (`gex`, `dex`): net/call/put exposure in
  `$/1% move`, `call_wall` / `put_wall`, and the per-expiry breakdown the free tier exposes.
- **Open interest, volume and IV skew by strike** (`oi`, `volume`, `skew`), each with the
  contract symbol so rows can be joined to any other dataset.
- **Greeks** (`greeks`): delta, gamma, theta, vega, rho and IV per strike/side.
- **Max pain** (`max-pain`): every listed expiry in a single request, with the delta to spot.
- **Expected-move cone** (`em`, points carry `et_date` in America/New_York) and **option chain**
  (`chain`: bid/ask/volume/OI/IV/delta).
- **Real-time spot** (`spot`) and **key stats** (`info`: dividend yield, average volume,
  day/52-week range).

Everything is normalised into one envelope (`{ source, generated_at, command, tickers[] }`),
with a `provenance` block per ticker (`url`, `status`, `fetched_at`, `latency_ms`,
`from_cache`, `requests_this_run`, `warnings`) and `--format pretty|compact|csv`.

## Why a scraper

The site is Rails + htmx with **no JSON API**: each chart is an HTML fragment with the data
inlined as `var <name> = {...};`. This CLI issues the fragment requests, extracts the inline
JSON with a string-aware brace matcher, and parses the table endpoints into rows. Details,
including the free/paid boundary and every known trap, are in `references/api.md`.

The three traps worth knowing before you trust a number:

1. `expiration_dates` **must** carry the `:w` / `:m` suffix, otherwise the server silently
   answers for a different expiry. The CLI resolves bare dates, re-reads the expiry from the
   payload and **exits 5** on a mismatch (`--allow-exp-fallback` downgrades it to a warning).
2. GEX/DEX magnitudes are **dollars per 1% move**, not notional — `unit: usd_per_1pct_move` —
   and they scale with each ticker's contract size, so `gex`/`dex` always expose
   `share_of_abs_total_pct` (and `sigma_pos` under `--normalize sigma`) for cross-ticker work.
3. `em` cone points stamp a **session close in ET** (`et_date`), so their UTC `iso` date is one
   day later; and the cone's expected move is not the per-expiry `scan`/`stats` one.

## Install

```bash
npx skills add Limour-dev/pi-skills --skill optioncharts
```

Or use the wrapper directly from a checkout: `optioncharts/bin/optioncharts`.

## Documentation

- `SKILL.md` — agent-facing summary: commands, expiry rules, units, request budget.
- `references/usage.md` — every command, flag, output field and exit code.
- `references/api.md` — `/async/*` endpoints, parameters, free/paid boundary, pitfalls.
- `references/examples.md` — verbatim real outputs (JSON + CSV) and failure modes.

## Development

```bash
npm test          # 48 offline tests against trimmed live fixtures
npm run typecheck # tsc --noEmit
npm run smoke     # live run over TLT/SPY/QQQ incl. exit-code checks
```

License: code under GPL-3.0, text under CC BY-NC-SA 4.0 (see the repository root).
