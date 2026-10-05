# options-gex

Short-dated **US option positioning** from the [Sell The News](https://sellthenews.org) options
dashboard, as a zero-dependency, pure-TypeScript CLI. No API key, no MCP server, no `npm install` —
`bin/options-gex` runs `node cli.ts` (Node ≥ 22.18, which strips TypeScript natively).

```bash
options-gex levels SPY                       # spot / net GEX / flip / walls / max pain
options-gex gex SPY --exp 2026-10-16 --strike-range 2 --format table
options-gex flip SPY                         # regime + zero-gamma cross-check
options-gex skew SPY --top 20                # vanna / charm by strike
options-gex scan TLT SPY QQQ --dte 7         # one compact row per expiry this week
options-gex probe                            # is REST/MCP reachable, and how fast?
```

## What it reports

- **Net GEX** and per-strike **GEX** (`gex_by_strike`, sums to `net_gex`)
- **Gamma flip / zero-gamma**: the reported `gamma_flip` plus an independent
  `zero_gamma_estimate` from the cumulative GEX curves, graded `high`/`low`
  by how far it drifts from `gamma_flip`
- **Call wall / put wall** with open interest and distance from spot
- **Max pain** with distance from spot
- **Vanna / charm** (and any other greek) net exposure by strike
- **Expiry calendar** with day counts, P/C OI, implied move, short-term IV and the dashboard's
  bullish score and insights
- **Term structure** via `scan`: one compact row per expiry inside `--dte`, for one or more
  tickers, with cross-expiry net-GEX sign flips called out

Every response is one expiry (nearest by default) and carries a `provenance` block with the selected
expiry, source, `updated_at` (server computation time), `payload_fetched_at` (local fetch/cache time),
`cf_cache`, market session, `oi_source` and any warnings. `levels.*` is echoed at the top level of
every command so `d["spot"]` / `d["net_gex"]` always work.

## Channels

1. **REST** `GET https://sellthenews.org/api/options/chain?ticker=&exp=&greeks=` — native JSON, the
   full field set (~35 KB gamma / ~80 KB all greeks). The CLI projects it down before printing.
2. **MCP** `get_options_data` — a text rendering of the same data, used as a fallback when
   Cloudflare blocks or rate limits REST (`--source mcp`, or automatically with the default
   `--source auto`).

Both channels silently swap an unavailable expiry for the nearest one, so the CLI always echoes
`selected_exp` and records the fallback in `provenance.warnings`; `--strict-exp` turns it into
exit code 5.

## Commands

| Command | Purpose |
| --- | --- |
| `gex <T>` | key levels + per-strike GEX table |
| `levels <T>` | key levels only (smallest output) |
| `walls <T>` | call/put walls with OI and spot distance |
| `max-pain <T>` | max pain with spot distance |
| `flip <T>` | gamma flip, spot position, zero-gamma cross-check |
| `skew <T>` | vanna/charm net exposure by strike |
| `expiries <T>` | expirations with DTE |
| `raw <T>` | projected full snapshot |
| `scan <T> [T...]` | one compact row per expiry inside `--dte` (default 7), one or more tickers |
| `probe` | channel reachability, latency and rate-limit headers |

Exit codes: `0` ok · `1` runtime · `2` usage · `3` no data · `4` rate limited · `5` silent expiry
fallback (`--strict-exp`).

## Offline and testing

```bash
options-gex raw SPY --from-file tests/fixtures/spy-all-greeks.json --greeks all --top 20
npm test          # node --test against the committed fixtures
npm run typecheck # tsc --noEmit
npm run smoke     # live end-to-end run against both channels
```

`--from-file` accepts a saved REST JSON body, a saved MCP JSON-RPC envelope, or raw MCP text, so a
captured snapshot can be replayed without network access. `OPTIONS_GEX_API_BASE` /
`OPTIONS_GEX_MCP_URL` override the endpoints and `OPTIONS_GEX_OFFLINE=1` refuses all network calls.

## Docs

- [`SKILL.md`](SKILL.md) — agent-facing usage, definitions and guardrails
- [`references/usage.md`](references/usage.md) — full flag reference, output shapes, recipes
- [`references/api.md`](references/api.md) — REST/MCP contracts, quirks, rate limits
- [`references/examples.md`](references/examples.md) — worked examples with real output

Read-only: this CLI never places orders.
