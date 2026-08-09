# Miniflux — lower-frequency workflows

The high-frequency workflows (browsing, triaging, briefing/summarizing) and the
guardrails now live in `SKILL.md`. This file covers the less-common operations.

## Adding feeds

1. `miniflux discover <url>` to find available feeds
2. If needed `miniflux create-category <title>`
3. `miniflux create-feed <feed-url> <category-id>` to subscribe

## Managing categories

- List: `miniflux categories`
- Create: `miniflux create-category <title>`
- Rename: `miniflux update-category <id> <title>`
- Delete: `miniflux delete-category <id>` (feeds move to default)

## Feed management

- `miniflux update-feed <id> [--title <t>] [--category-id <n>] [--feed-url <u>]`
- `miniflux delete-feed <id>`
- `miniflux refresh-feed <id>`