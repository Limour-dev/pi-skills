# Miniflux — full command reference

Run `miniflux --help` for the full list.

## Read

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

## Entry listing (shared filters)

```bash
miniflux entries [filters]
miniflux feed-entries --feed-id <id> [filters]
miniflux search <keyword> [filters]   # full-text search over entries
```

Filters (all optional):

- `--status <s>` — `read`, `unread`, or `removed`; comma-separate to query
  several at once (e.g. `--status read,unread`). For entry listings the default
  is `unread` (Miniflux's implicit default).
- `--offset <n>` — pagination offset
- `--limit <n>` — result limit (recommend 20)
- `--order <o>` — `id`, `status`, `published_at`, `category_title`, `category_id`
- `--direction <d>` — `asc` or `desc`
- `--before <ts>` / `--after <ts>` — a Unix timestamp, an ISO-8601 date
  (`2026-08-01` or `2026-08-01T12:00:00Z`), `now`, or a relative duration like
  `7d`/`2h`/`30m`. Converts to Unix seconds automatically.
- `--before-entry-id <id>` / `--after-entry-id <id>`
- `--starred <bool>` — `true`/`false` for bookmarked entries only

Output shaping (entry listings / search):

- `--all` — auto-paginate through all results instead of one page
- `--fields <csv>` — keep only the given entry fields (e.g. `id,title,published_at`)
- `--compact` — short per-entry summary (id/title/feed/published_at/status)
- `--plain-text` — strip HTML tags from entry `content`

Any zero-value timestamps (`0001-01-01T00:00:00Z`) are emitted as `null`.

## Write

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
miniflux mark --all --status read           # bulk-mark all matching entries
miniflux bookmark <id>                       # toggle star
```

Bulk mark options:

- `mark --all --status <target> [--from <cur>]` — fetch every entry whose status
  is `<cur>` (default `unread`) and mark them all `<target>`; prints how many
  were affected.
  - `--feed-id <id>` / `--search <q>` restrict the selection.
  - `--dry-run` prints how many would be affected without applying.
  - Batches above 100 entries require an explicit `--yes` to confirm.

Unknown commands print a `did you mean…` suggestion for close typos.
