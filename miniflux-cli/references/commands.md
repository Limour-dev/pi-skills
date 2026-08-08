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
miniflux bookmark <id>                       # toggle star
```
