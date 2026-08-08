# miniflux-cli

A pure TypeScript CLI for the [Miniflux](https://miniflux.app/) RSS reader API,
plus a skill (`SKILL.md`) that teaches AI agents how to use it.

This is a TypeScript rewrite of the original Rust MCP server + OpenClaw skill
from [openclaw-skill-miniflux](https://github.com/sinhong2011/openclaw-skill-miniflux),
delivered as a lightweight CLI (no MCP server required).

## Features

- Reads credentials from the environment:
  - `MINIFLUX_URL` — e.g. `https://rcdn.limour.top/` (trailing `/v1/` is tolerated and normalized away)
  - `MINIFLUX_API_KEY` (also accepts `MINIFLUX_API_TOKEN`)
- 24 subcommands covering reads (feeds, entries, categories, users, discovery,
  OPML export) and writes (mark read, bookmark, feed/category CRUD, refresh,
  OPML import).
- Fully typed against the Miniflux v2 API (`src/api/types.ts`).
- JSON output, printer-friendly, scriptable; clean errors on stderr with exit
  code 1.

## Project layout

See [ARCHITECTURE.md](./ARCHITECTURE.md) for design decisions and how to add
endpoints/filters/tests. [SKILL.md](./SKILL.md) is the AI-agent contract.

```
src/
  index.ts          # bin entry point
  api/
    client.ts       # typed Miniflux v2 API client
    config.ts       # env loading + base URL normalization
    error.ts        # MinifluxError
    types.ts        # API response/filter types
  cli/
    program.ts      # commander command definitions
    parsers.ts      # argument/option validation
    output.ts       # JSON/text printers
test/
  config.test.ts    # env/URL normalization unit tests
  parsers.test.ts   # CLI parser unit tests
  client.test.ts    # client tests against an in-process mock HTTP server
  cli.test.ts       # end-to-end tests (spawns the CLI against the mock server)
  helpers/mock-server.ts
```

## Install & build

Requires Node.js >= 18.

```bash
cd miniflux-cli
npm install
npm run build
```

The built CLI is at `dist/index.js`. Optionally link it into your PATH:

```bash
npm link
# now `miniflux <command>` works anywhere
```

## Install the skill

Install the whole collection:

```bash
npx skills add Limour-dev/pi-skills
```

Or just this skill (note: the installable skill *name* is `miniflux`, taken from the
`name:` field in `SKILL.md`, not the repo directory name `miniflux-cli`):

```bash
npx skills add Limour-dev/pi-skills --skill miniflux
```


## Usage

```bash
node dist/index.js healthcheck
node dist/index.js feeds
node dist/index.js entries --status unread --limit 20
node dist/index.js entry <id>
node dist/index.js mark <id> --status read
node dist/index.js bookmark <id>
node dist/index.js discover https://example.com
node dist/index.js create-feed <feed-url> <category-id>
```

Run `node dist/index.js --help` for the full command list.

## Development

```bash
npm run dev        # run via tsx (no build step)
npm run build      # compile TypeScript to dist/
npm run typecheck  # typecheck src + tests
npm test           # unit + end-to-end tests (node:test via tsx, no live server needed)
```

## License

Code is [GPL-3.0](../LICENSE); text is [CC BY-NC-SA 4.0](../LICENSE-CC-BY-NC-SA).
