# Miniflux — workflow tips & guardrails

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

For a large triage (e.g. mark a whole feed read), use bulk mark:

```bash
miniflux mark --all --from unread --status read --feed-id <id>   # mark a feed's unread entries read
miniflux mark --all --from unread --status read --dry-run         # preview count first
miniflux mark --all --from unread --status read --yes             # confirm a large batch
```

Always `--dry-run` first on large batches, then pass `--yes` to apply. This
replaces the old awkward "paginate + collect IDs + long argv" workflow.

Search old articles with `miniflux search <keyword>` (e.g. `miniflux search "SpaceX 月球"`),
and narrow with the same filters (`--status`, `--before`/`--after`).
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
- For big listings, use `--fields`/`--compact`/`--plain-text` to cut token usage,
  or `--all` to page through everything in one pass.
- On 401/403 errors, tell the user to check their API key.
- On connection errors, tell the user to verify `MINIFLUX_URL`.
- Confirm with the user before marking large batches as read; use bulk mark's
  `--dry-run` to preview the count and `--yes` to apply a large batch.
- When a listing returns empty results, suggest checking filters or confirming
  the instance has data.
- `export-opml` / `import-opml` may return 404 on some instances (features
  disabled by the server); that is a server-side limitation, not an error in
  the CLI.
