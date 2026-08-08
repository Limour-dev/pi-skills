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

Provides access to a Miniflux RSS reader instance through a TypeScript CLI.
Reads `MINIFLUX_URL` and `MINIFLUX_API_KEY` from the environment (both are
already set). You can browse feeds, search entries by status or date, read
specific articles, check categories, and create/update/delete feeds and
categories, import/export OPML, mark entries as read, and toggle bookmarks.

All commands print JSON to stdout (except `healthcheck`, `export-opml`,
`import-opml` and the write confirmation messages, which print text).

## Prerequisites

- Node.js >= 18
- The CLI is built at `{baseDir}/dist/index.js`.
- Environment variables must be set:
  - `MINIFLUX_URL` (e.g. `https://rcdn.limour.top/`) — a trailing `/v1/` is tolerated and normalized away.
  - `MINIFLUX_API_KEY` (or `MINIFLUX_API_TOKEN`).

## Invocation

Use the built binary directly:

```bash
node {baseDir}/dist/index.js <command> [args]
```

Or, if linked into your PATH, just `miniflux <command> [args]`.

## Commands

### Read

```bash
miniflux healthcheck                          # reachability check
miniflux me                                   # current authenticated user
miniflux user-by-id <id>                      # user by numeric ID
miniflux user-by-name <username>              # user by username
miniflux feeds                                # list all feeds
miniflux feed <id>                            # single feed
miniflux feed-icon <id>                       # feed favicon
miniflux discover <url>                       # discover feeds at a URL
miniflux categories                           # list categories
miniflux entry <id>                           # single entry
miniflux export-opml                          # all feeds as OPML XML
```

### Entry listing (shared filters)

```bash
miniflux entries [filters]
miniflux feed-entries --feed-id <id> [filters]
```

Filters (all optional):

- `--status <s>` — `read`, `unread`, or `removed`
- `--offset <n>` — pagination offset
- `--limit <n>` — result limit (recommend 20)
- `--order <o>` — `id`, `status`, `published_at`, `category_title`, `category_id`
- `--direction <d>` — `asc` or `desc`
- `--before <ts>` / `--after <ts>` — Unix timestamps for date ranges
- `--before-entry-id <id>` / `--after-entry-id <id>`
- `--starred <bool>` — `true`/`false` for bookmarked entries only

### Write

```bash
miniflux import-opml <opml|@file|->          # OPML XML string, @/path/to/file, or '-' for stdin
miniflux create-category <title>
miniflux update-category <id> <title>
miniflux delete-category <id>
miniflux create-feed <feed-url> <category-id>
miniflux update-feed <id> [--title <t>] [--category-id <n>] [--feed-url <u>] [--site-url <u>] [--user-agent <ua>]
miniflux delete-feed <id>
miniflux refresh-feed <id>
miniflux mark <entry-id...> --status <s>     # read/unread/removed
miniflux bookmark <id>                       # toggle star
```

## Workflow tips

### Browsing feeds
1. `miniflux feeds` to see subscriptions
2. `miniflux feed-entries --feed-id <id> --limit 20` to see a feed's entries
3. `miniflux entry <id>` to read a specific article

### Triaging unread articles
1. `miniflux entries --status unread --limit 20`
2. Read interesting ones with `miniflux entry <id>`
3. Mark reviewed ones as read: `miniflux mark <id> --status read`
4. Bookmark important ones: `miniflux bookmark <id>`

### Adding feeds
1. `miniflux discover <url>` to find available feeds
2. If needed `miniflux create-category <title>`
3. `miniflux create-feed <feed-url> <category-id>` to subscribe

### Managing categories
- List: `miniflux categories`
- Create: `miniflux create-category <title>`
- Rename: `miniflux update-category <id> <title>`
- Delete: `miniflux delete-category <id>` (feeds move to default)

## Guardrails

- Default to small page sizes (`--limit 20`) to avoid overwhelming responses.
- On 401/403 errors, tell the user to check their API key.
- On connection errors, tell the user to verify `MINIFLUX_URL`.
- Confirm with the user before marking large batches of entries as read.
- When a listing returns empty results, suggest checking filters or confirming
  the instance has data.
- `export-opml` / `import-opml` may return 404 on some instances (features
  disabled by the server); that is a server-side limitation, not an error in
  the CLI.