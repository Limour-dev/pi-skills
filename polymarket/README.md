# polymarket

A zero-dependency, pure-TypeScript **read-only** CLI for
[Polymarket](https://polymarket.com), plus a skill (`SKILL.md`) that teaches AI
agents how to use it.

Wraps Polymarket's three public REST APIs and the public market WebSocket. No API
key, no wallet, no SDK, no `npm install`, no build step — just Node.

## Features

- **One entry point for three APIs**: Gamma (discovery/metadata), CLOB (prices
  and order books), Data (trades, positions, holders, leaderboards).
- **Universal identifier resolution.** Every command accepts a Gamma id, a slug,
  a `conditionId`, an outcome token id, or a pasted `polymarket.com` URL and
  figures out the rest.
- **Refuses to guess.** A multi-market event URL errors with the candidate list
  (including live bid/ask) instead of silently pricing the wrong strike.
- **Live streaming** over `wss://ws-subscriptions-clob.polymarket.com/ws/market`
  with an application-level heartbeat, NDJSON output, and a `--changes-only`
  filter that makes liquid markets watchable.
- **Normalized output**: the JSON-encoded-string quirks (`outcomes`,
  `outcomePrices`, `clobTokenIds`) are parsed into a consistent
  `outcomeTokens[]` (`{outcome, tokenId, price}`) on markets and listings,
  string prices become numbers, and order books are sorted best-first.
- **Small payloads on demand**: `--fields id,title,volume24hr` projects output
  (or `--brief`), so scanning many events stays cheap.
- **JSON on stdout, errors on stderr**, non-zero exit codes — scriptable.
- Read-only by construction: there is no order-placement code path at all.

## Project layout

```
cli.ts               # command definitions + hand-rolled arg parsing
src/
  http.ts            # shared fetch layer, timeouts, ApiError/NotFoundError
  gamma.ts           # Gamma API client + market/event normalization
  clob.ts            # CLOB API client (prices, books, history)
  data.ts            # Data API client (trades, positions, holders, leaderboard)
  resolve.ts         # id/slug/URL classification and resolution
  watch.ts           # public market WebSocket stream
bin/polymarket       # bash wrapper around `node cli.ts`
references/
  usage.md           # full CLI command/flag reference
  api.md             # endpoint reference, rate limits, WebSocket protocol
  examples.md        # worked examples with real output
scripts/smoke-test.sh
```

## Install & run

Requires Node.js >= 22.18 (runs TypeScript directly via type stripping). No build
step and no `npm install` needed at runtime.

```bash
bin/polymarket search "fed rate cut" --limit 5
bin/polymarket price xi-jinping-out-before-2027
node cli.ts events --limit 5
```

### PATH setup

The skill installer copies the CLI to `~/.agents/skills/polymarket` (pi symlinks
it into `~/.pi/agent/skills/`) but does not put `polymarket` on PATH. Either use
the full path, or symlink it:

```bash
ln -s ~/.pi/agent/skills/polymarket/bin/polymarket ~/.local/bin/polymarket
# or for this session only:
export PATH="$HOME/.agents/skills/polymarket/bin:$PATH"
```

Verify with `command -v polymarket`.

## Install the skill

```bash
npx skills add Limour-dev/pi-skills                     # whole collection
npx skills add Limour-dev/pi-skills --skill polymarket  # just this one
```

## Usage

```bash
polymarket search "fed rate cut" --limit 5
polymarket events --open --order volume24hr --limit 20
polymarket events --tag politics --order volume24hr \
  --exclude-tag sports --min-liquidity 100000 --fields id,title,volume24hr,liquidity
polymarket event <ref>
polymarket markets --limit 20 --open --order volume24hr
polymarket market <ref>

polymarket price <ref> [--outcome No]
polymarket book <ref> [--depth 10]
polymarket history <ref> --interval 1w [--bucket 3600]
polymarket clock

polymarket trades [--market <ref>] [--user <addr>] [--limit 50]
polymarket holders <ref> [--limit 20]
polymarket positions <address> [--limit 50]
polymarket closed-positions <address>
polymarket activity <address> [--type TRADE]
polymarket leaderboard [--period month] [--order pnl|vol]

polymarket tags [--search politics] [--related politics]
polymarket comments <ref> [--limit 20]
polymarket resolve <anything>

polymarket watch <ref>... [--duration 30] [--frames 100] [--changes-only] [--pretty]
```

Run `polymarket help` for the full list.

## Development

```bash
npm run typecheck   # tsc --noEmit (devDependency only; not needed at runtime)
npm run smoke       # hits the live public APIs, read-only
```

`scripts/smoke-test.sh` exercises every command against the real endpoints and
fails if any returns non-JSON or a non-zero exit code.

## API quirks handled here

See [references/usage.md](./references/usage.md) for the full CLI flag reference,
[references/api.md](./references/api.md) for the endpoint list, and [SKILL.md](./SKILL.md)
for the agent-facing summary. Highlights:

- Gamma returns `outcomes` / `outcomePrices` / `clobTokenIds` as
  **JSON-encoded strings**, not arrays. Use the normalized `outcomeTokens[]`,
  which has the same shape on `market`, `event.markets[]`, and listings.
- CLOB returns **prices as strings**.
- `/holders` wants a `conditionId`, not a token id.
- `comments` only accepts `parent_entity_type=Event` despite the docs listing
  `market`.
- `/tags` caps at 100 results and ignores `search`; listing endpoints require a
  numeric `tag_id`.
- Event ids and market ids are distinct namespaces that can collide numerically.
- `public-profile` is on Gamma, not the Data API.

## License

Code is [GPL-3.0](../LICENSE); text is [CC BY-NC-SA 4.0](../LICENSE-CC-BY-NC-SA).
