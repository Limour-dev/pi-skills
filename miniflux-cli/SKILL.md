---
name: miniflux
description: >
  Manage RSS feeds and entries on a Miniflux instance via the `miniflux` CLI.
  Handles requests like "show my unread articles", "list my feeds",
  "rename this category", "unsubscribe from this feed", "import my OPML",
  "mark these entries as read", "bookmark this article", or "summarize my
  unread feed into a theme-based briefing".
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

## Workflows

### Browsing feeds

1. `miniflux feeds` to list subscriptions
2. `miniflux feed-entries --feed-id <id> --limit 20` to see a feed's entries
3. `miniflux entry <id>` to read a specific article

### Triaging unread articles

1. `miniflux entries --status unread --limit 20`
2. Read the interesting ones with `miniflux entry <id>`
3. Mark reviewed ones read: `miniflux mark <id> --status read`
4. Bookmark important ones: `miniflux bookmark <id>`

For a large triage (e.g. mark a whole feed read), use bulk mark:

```bash
miniflux mark --all --from unread --status read --feed-id <id>   # a feed's unread entries
miniflux mark --all --from unread --status read --dry-run         # preview count first
miniflux mark --all --from unread --status read --yes             # confirm a large batch
```

Always `--dry-run` first on large batches, then `--yes`. Search old articles with
`miniflux search <keyword>`, narrowed by the same filters (`--status`, `--before`/`--after`).

### Producing briefings / summaries

When asked to "summarize"/"总结" the unread feed, do NOT dump a title list — that
is data movement, not a summary. Ask why the user can't just skim titles themselves;
the value is in reading the bodies and surfacing insights they'd miss from titles alone.

1. **Clarify the deliverable** — if ambiguous, ask: title list, per-article bullet
   summary, or theme-based briefing? Default to a **briefing**, not a list.
2. **Read bodies, not titles** — pull plain text with `--compact --plain-text` (keeps
   `id/title/feed/published_at` + stripped `content`):

   ```bash
   miniflux entries --status unread --limit 20 --compact --plain-text
   miniflux search <keyword> --compact --plain-text
   ```

   Note: `--plain-text` works only with `--compact`; plain `miniflux entry <id>` prints
   raw JSON with HTML.
3. **Extract 1–2 hard facts per entry** — concrete numbers, the actual announcement.
4. **Group by theme, not by feed** — common patterns/causes/contrasts (e.g. "AI talent
   reshuffle"); feed grouping is a database view, theme grouping is a reader view.
5. **Structure as a briefing** — themed sections with headings, a takeaway per section,
   and a one-sentence overall summary.
6. **Confirm delivery** — offer to export, expand a section, or mark the underlying
   entries read (prefer bulk `mark --all` over a long `mark <id...>` argv).

## Guardrails

- Default to small page sizes (`--limit 20`).
- For big listings use `--fields`/`--compact`/`--plain-text`, or `--all` to page through.
- On 401/403: tell the user to check their API key. On connection errors: verify `MINIFLUX_URL`.
- Confirm before bulk-marking large batches; use `--dry-run` to preview, `--yes` to apply.
- Empty results: suggest checking filters or confirming the instance has data.

## Details (load on demand)

- `references/setup.md` — prerequisites (Node, env vars) and one-time PATH setup.
- `references/commands.md` — full command reference: every subcommand and the
  entry-listing filters (`--status`, `--limit`, `--before`/`--after`, …).
- `references/agent-guide.md` — lower-frequency workflows (adding feeds, managing
  categories) not already covered above.
