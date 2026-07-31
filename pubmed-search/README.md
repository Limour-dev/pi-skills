# pubmed-search

Zero-dependency, pure-TypeScript **command-line** client for searching PubMed
via the NCBI E-utilities API. Ported from
[`nature-skills/.../sources/pubmed.py`](https://github.com/Yuan1z0825/nature-skills/blob/main/skills/nature-academic-search/mcp-server/sources/pubmed.py)
(Apache-2.0, attribution retained in `src/pubmed.ts`). No Python, no MCP
server, no npm install — invoke it from bash.

## Requirements

- Node ≥ 23.6 (runs TypeScript natively), or ≥ 22.6 with
  `--experimental-strip-types`, or any Node via `npx tsx`.
- **No runtime npm dependencies.** Only `typescript` as a devDependency for
  `npm run typecheck`.

## Usage (bash)

```bash
# 本机已配置好身份环境变量（PUBMED_EMAIL / NCBI_API_KEY），agent 无需再 export
# export PUBMED_EMAIL=you@example.com          # NCBI etiquette (required by default)
# export NCBI_API_KEY=...                      # optional: 10 req/s instead of 3

./bin/pubmed-search search "glioblastoma[Title] AND MRI[Title]" --rows 5
./bin/pubmed-search get-by-pmid 28344011
./bin/pubmed-search mesh "Alzheimer Disease"
```

Result JSON goes to stdout; errors to stderr; exit codes 0 / 1 / 2 (ok /
runtime error / usage error). See `SKILL.md` for the full agent protocol,
options, and workflow examples.

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

Apache-2.0 (same as both the source repo and this pi-skills collection).
