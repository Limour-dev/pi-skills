# massive-options

A zero-dependency, pure-TypeScript CLI for **short-dated US option analytics**
on the [Massive](https://massive.com/docs/rest/quickstart) REST API (a
polygon.io-compatible API), plus a skill (`SKILL.md`) that teaches AI agents how
to use it.

Computes the analytics that matter for the 0–7 DTE horizon:

- **GEX** (gamma exposure) per strike and per expiry, in the industry-standard
  *USD of dealer delta to re-hedge per 1% move*
- **gamma flip / zero-gamma** level and **call wall / put wall** strikes
- **max pain** per expiry and across the selection, with the full pain curve
- raw **chains** with open interest, greeks, IV, quotes and per-contract GEX

No SDK, no `npm install`, no build step — just Node ≥ 22.18.

## Install & run

```bash
export MASSIVE_API_KEY=your_key_here
bin/massive-options gex SPY --dte 7 --format table
```

### PATH setup

The skill installer copies the CLI to `~/.agents/skills/massive-options` (pi
symlinks it into `~/.pi/agent/skills/`) but does not put it on PATH. Either use
the full path, or symlink it:

```bash
ln -s ~/.pi/agent/skills/massive-options/bin/massive-options ~/.local/bin/massive-options
export PATH="$HOME/.agents/skills/massive-options/bin:$PATH"   # session only
```

## Usage

```bash
massive-options gex      SPY --dte 7                      # ~1 week, JSON
massive-options gex      QQQ --dte 0 --format table       # 0DTE only
massive-options gex      SPY --dte 14 --sign-mode absolute
massive-options max-pain SPY --expiries 2026-10-09,2026-10-16
massive-options chain    TSLA --dte 2 --strike-range 0.1 --limit 30
massive-options expiries AAPL --dte 14
massive-options spot     SPY
massive-options contract O:SPY261009C00600000
massive-options probe                                     # key entitlements
```

Selection defaults to **`--dte 7`** (calendar days from today, US/Eastern),
which is the "one week out" window the user usually means. `--dte 0` is today's
expiry; `--expiry`/`--expiries` pin exact dates.

Run `massive-options --help` for every flag.

## Plan requirements (important)

| Feature | Endpoint | Plan |
| --- | --- | --- |
| GEX, max pain, chain | `GET /v3/snapshot/options/{underlying}` | **Options Starter** and up |
| `expiries`, `contract` | `GET /v3/reference/options/contracts` | entry-level options plans |
| `spot` | stock snapshot, falling back to `/v2/aggs/ticker/{t}/prev` | works on entry-level (delayed) |

Open interest — the input GEX and max pain need — only exists on the chain
snapshot endpoint, so **Options Basic cannot compute GEX**. `massive-options
probe` reports exactly which endpoints a key can reach, and a blocked request
exits `3` with the required plan instead of printing a number.

For keys without entitlement, `--from-file` analyses a saved
`/v3/snapshot/options/...` response offline (no key, no rate limit):

```bash
curl -s "https://api.massive.com/v3/snapshot/options/SPY?expiration_date.gte=2026-10-09&expiration_date.lte=2026-10-09&limit=250" \
  -H "Authorization: Bearer $MASSIVE_API_KEY" > spy.json
massive-options gex SPY --from-file spy.json --as-of 2026-10-09 --spot 769.64
```

## Project layout

```
cli.ts                          # commands, hand-rolled arg parsing, output
src/
  api.ts                        # fetch layer: auth, retries, pagination, typed errors
  chain.ts                      # spot resolution, expiry discovery, snapshot normalisation
  gex.ts                        # GEX, gamma flip, walls
  maxpain.ts                    # max-pain curve and strikes
  format.ts                     # JSON / compact / table rendering
  types.ts                      # Massive wire types
bin/massive-options             # bash wrapper around `node cli.ts`
references/
  usage.md                      # full CLI + output-shape reference
  api.md                        # endpoints, parameters, plan access, quirks
  examples.md                   # worked examples with real output
tests/
  math.test.ts                  # hand-computed GEX / max-pain / greeks assertions
  cli.test.ts                   # end-to-end CLI tests against the mock API
  mock-server.ts                # offline mock of the endpoints used
  fixtures/snapshot-test.json
scripts/smoke-test.sh
```

## Definitions

```
GEX_contract = gamma × open_interest × shares_per_contract × spot² × 0.01
pain(S)      = Σ_calls OI·max(0,S−K) + Σ_puts OI·max(0,K−S), × multiplier
```

Default sign convention: calls `+`, puts `−` (`--sign-mode dealer`), i.e. the
usual "dealers long call gamma, short put gamma" assumption. `absolute` and
`inverse` are available.

## Development

```bash
npm test                      # node --test (math + CLI/mock tests, 31 cases)
npm run typecheck             # tsc --noEmit
scripts/smoke-test.sh         # offline suite
scripts/smoke-test.sh --live  # also probes the real API with MASSIVE_API_KEY
```

The CLI is a few hundred lines of dependency-free TypeScript; `tests/mock-server.ts`
serves the fixture so pagination, error mapping and the analytics are verified
without touching the network.

## Caveats this CLI refuses to hide

- Open interest is the **end of the previous session**; GEX/max pain are not
  intraday positioning.
- GEX assumes every contract is dealer-intermediated and is a *model*, not a
  position report.
- Missing greeks are reconstructed from IV via Black-Scholes and flagged
  (`gammaSource: "black-scholes"`, `gammaFromBlackScholes`, a stderr warning);
  contracts with neither gamma nor IV are excluded and counted.
- A `previous-close` spot price means the reference price is stale — the output
  always carries `spot.source` and `spot.timeframe`.

## License

Code is [GPL-3.0](../LICENSE); text is [CC BY-NC-SA 4.0](../LICENSE-CC-BY-NC-SA).
