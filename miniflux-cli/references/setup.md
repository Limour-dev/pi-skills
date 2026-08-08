# Miniflux — prerequisites & one-time setup

## Prerequisites

- Node.js >= 22.6 (runs TypeScript directly — no build step, no npm install).
- Environment variables must be set:
  - `MINIFLUX_URL` (e.g. `https://rcdn.limour.top/`) — a trailing `/v1/` is tolerated and normalized away.
  - `MINIFLUX_API_KEY` (or `MINIFLUX_API_TOKEN`).

## One-time setup (PATH)

The skill installer copies the CLI to `~/.agents/skills/miniflux` (symlinked into
pi's `~/.pi/agent/skills/`) but does **not** put `miniflux` on PATH. The wrapper
auto-links itself on first run: invoke it once via full path, e.g.

```bash
~/.pi/agent/skills/miniflux/bin/miniflux healthcheck
```

and it symlinks into `~/.pi/agent/bin` (pi) or `~/.local/bin`, after which plain
`miniflux <command>` works. If auto-linking failed (or you prefer not to touch
the home dir), either fix it manually once:

```bash
ln -s ~/.pi/agent/skills/miniflux/bin/miniflux ~/.pi/agent/bin/miniflux
# or, for this session only:
export PATH="$SKILL_DIR/bin:$PATH"   # $SKILL_DIR = ~/.pi/agent/skills/miniflux
```

Verify with `command -v miniflux`. If none of that applies, the CLI also runs
directly: `node <skill-dir>/src/index.ts <command> [args]`.
