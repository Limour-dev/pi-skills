# pubmed-search

Zero-dependency, pure-TypeScript **command-line** client for searching PubMed
via the NCBI E-utilities API. Ported from
[`nature-skills/.../sources/pubmed.py`](https://github.com/Yuan1z0825/nature-skills/blob/main/skills/nature-academic-search/mcp-server/sources/pubmed.py)
(Apache-2.0, attribution retained in `src/pubmed.ts`). No Python, no MCP
server, no npm install — invoke it from bash.

Part of the [Limour-dev/pi-skills](https://github.com/Limour-dev/pi-skills) collection.

## Install

Install the whole collection:

```bash
npx skills add Limour-dev/pi-skills
```

Or just this skill:

```bash
npx skills add Limour-dev/pi-skills --skill pubmed-search
```

## Requirements

- Node ≥ 22.6. The `bin/pubmed-search` wrapper detects the version and adds
  `--experimental-strip-types` automatically on 22.6–23.5; Node ≥ 23.6 needs
  nothing. Older versions get an actionable error (or run via `npx tsx`).
- **No runtime npm dependencies.** Only `typescript` as a devDependency for
  `npm run typecheck`.

## Usage (bash)

```bash
# 本机已配置好身份环境变量（PUBMED_EMAIL / NCBI_API_KEY），agent 无需再 export
# export PUBMED_EMAIL=you@example.com          # NCBI etiquette (required by default)
# export NCBI_API_KEY=...                      # optional: 10 req/s instead of 3

./bin/pubmed-search search "glioblastoma[Title] AND MRI[Title]" --rows 5
./bin/pubmed-search search "heart failure" --count-only        # 1 request, total only
./bin/pubmed-search get-by-pmid 28344011
./bin/pubmed-search get-by-pmid 22828611,28344011 --format citation
./bin/pubmed-search mesh "Alzheimer Disease"
```

Result JSON goes to stdout; errors to stderr; exit codes 0 / 1 / 2 (ok /
runtime error / usage error). See `SKILL.md` for the full agent protocol,
options, and workflow examples.

## Notable behavior

- **0 hits is a success** (`exit 0`, `total: 0`, `results: []`) — never an
  E-utilities error. `warnings` / `query_translation` explain *why* a query
  matched nothing.
- **Cross-process rate limiting + retries**: a lock file in
  `~/.cache/pubmed-search/` (override with `PUBMED_CACHE_DIR`) keeps parallel
  CLI invocations under NCBI's limit, and 429/5xx/timeouts are retried with
  exponential backoff (honouring `Retry-After`).
- **Batch + cache**: `get-by-pmid 1,2,3` fetches in one request and caches
  each article for a week (`--no-cache` to bypass).
- **MeSH**: `mesh` returns the reconstructed `descriptor_ui` (e.g.
  `D009203`), but PubMed searches must use the descriptor **name**.
- **Reference-ready output**: `get-by-pmid <pmid> --format citation`.

## Layout

```
cli.ts                       # CLI entry point (the supported interface)
bin/pubmed-search            # bash wrapper — run from anywhere
src/pubmed.ts                # client library (port of pubmed.py)
src/xml.ts                   # minimal ElementTree-compatible XML parser
scripts/smoke-test.sh        # bash smoke test (live API)
references/pubmed-query-syntax.md
SKILL.md
```

## Development

```bash
npm run smoke                # live smoke test of all subcommands
npm run typecheck            # strict tsc --noEmit
```

## License

Code is [GPL-3.0](../LICENSE); text is [CC BY-NC-SA 4.0](../LICENSE-CC-BY-NC-SA).
The ported `pubmed.py` logic retains its original Apache-2.0 attribution in `src/pubmed.ts`.
