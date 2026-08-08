---
name: miniflux
description: >
  Manage RSS feeds and entries on a Miniflux instance via the `miniflux` CLI.
  Handles requests like "show my unread articles", "list my feeds",
  "rename this category", "unsubscribe from this feed", "import my OPML",
  "mark these entries as read", or "bookmark this article".
---

# Miniflux

## What it does

TypeScript CLI for a Miniflux RSS reader instance (reads `MINIFLUX_URL` /
`MINIFLUX_API_KEY` from the environment — both are already set). Browse feeds,
search entries by status or date, read articles, manage categories and feeds,
import/export OPML, mark entries as read, and toggle bookmarks.

All commands print JSON to stdout (except `healthcheck`, `export-opml`,
`import-opml` and the write confirmation messages, which print text).

## Invocation

唯一入口：`<skill-dir>/bin/miniflux`（bash wrapper，直接运行 `node src/index.ts`，
可在任何目录直接调用，无需构建）。

```bash
miniflux <command> [args]
```

`miniflux` 若不在 PATH：先按 `references/setup.md` 做一次性链接；
临时会话可用 `export PATH="<skill-dir>/bin:$PATH"`；
兜底 `node <skill-dir>/src/index.ts <command> [args]`。

## Common commands

```bash
miniflux healthcheck                              # reachability check
miniflux me                                       # current authenticated user
miniflux feeds                                    # list all feeds
miniflux feed-entries --feed-id <id> --limit 20   # a feed's entries
miniflux entries --status unread --limit 20       # unread entries
miniflux search <keyword>                        # full-text search entries
miniflux entry <id>                              # read a specific article
miniflux categories                              # list categories
miniflux mark <entry-id...> --status read        # mark read/unread/removed
miniflux mark --all --status read                # bulk-mark all unread as read
miniflux bookmark <id>                           # toggle star
miniflux discover <url>                           # discover feeds at a URL
miniflux create-feed <feed-url> <category-id>     # subscribe to a feed
miniflux export-opml                              # all feeds as OPML XML
```

## Details (load on demand)

- `references/setup.md` — prerequisites (Node, env vars) and one-time PATH setup.
- `references/commands.md` — full command reference: every subcommand and the
  entry-listing filters (`--status`, `--limit`, `--before`/`--after`, …).
- `references/agent-guide.md` — workflow tips (browse/triage/add/manage) and
  guardrails (pagination, error handling, confirmation before bulk marks).
