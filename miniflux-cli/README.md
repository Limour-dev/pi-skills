# miniflux-cli

A pure TypeScript CLI for the [Miniflux](https://miniflux.app/) RSS reader API,
plus a skill (`SKILL.md`) that teaches AI agents how to use it.

This is a TypeScript rewrite of the original Rust MCP server + OpenClaw skill
from [openclaw-skill-miniflux](https://github.com/sinhong2011/openclaw-skill-miniflux),
delivered as a lightweight, dependency-free CLI (no MCP server required).

## Features

- Reads credentials from the environment:
  - `MINIFLUX_URL` — e.g. `https://rcdn.limour.top/` (trailing `/v1/` is tolerated and normalized away)
  - `MINIFLUX_API_KEY` (also accepts `MINIFLUX_API_TOKEN`)
- 24 subcommands covering reads (feeds, entries, categories, users, discovery,
  OPML export) and writes (mark read, bookmark, feed/category CRUD, refresh,
  OPML import).
- JSON output, printer-friendly, scriptable.

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

## Set up the skill

Copy/symlink the skill into your agent's skills directory, e.g.:

```bash
ln -s "$(pwd)/skill" ~/.pi/agent/skills/miniflux
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
npm run dev      # run via tsx (no build step)
npm run build    # compile TypeScript to dist/
npm run typecheck
```

## License

MIT