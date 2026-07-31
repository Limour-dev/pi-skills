# pubmed-search

Zero-dependency, pure-TypeScript client for searching PubMed via the NCBI
E-utilities API. Ported from
[`nature-skills/.../sources/pubmed.py`](https://github.com/Yuan1z0825/nature-skills/blob/main/skills/nature-academic-search/mcp-server/sources/pubmed.py)
(Apache-2.0, attribution retained in `src/pubmed.ts`).

## What it does

- `search(query, rows, sort)` — Boolean/MeSH/field-tagged PubMed search →
  unified article records (title, authors, year, PMID, DOI, journal, abstract) + total match count.
- `getByPmid(pmid)` — one article by PMID.
- `lookupMesh(term)` — MeSH descriptor lookup (name + UI).

## Requirements

- Node ≥ 23.6 (runs TypeScript natively), or ≥ 22.6 with
  `--experimental-strip-types`, or any Node via `npx tsx`.
- **No runtime npm dependencies.** Only `typescript` as a devDependency for
  `npm run typecheck`.

## Usage

```bash
npm run demo                 # live smoke test against NCBI
npm run typecheck            # strict tsc --noEmit
```

```ts
import { PubMedSource } from "./src/pubmed.ts";

const pubmed = new PubMedSource({ email: process.env.PUBMED_EMAIL, apiKey: process.env.NCBI_API_KEY });
const { total, results } = await pubmed.search("glioblastoma[Title] AND MRI[Title]", 5);
```

Config: constructor options → env (`PUBMED_EMAIL`, `NCBI_API_KEY`,
`PUBMED_MAX_ROWS`, `PUBMED_CONFIG`) → JSON config file
(`{ "pubmed": { "email", "api_key", "max_rows" } }`). See `SKILL.md`.

## Layout

```
src/pubmed.ts                  # the client (port of pubmed.py)
src/xml.ts                     # minimal ElementTree-compatible XML parser
scripts/demo.ts                # runnable example / smoke test
references/pubmed-query-syntax.md
SKILL.md                       # agent-facing usage instructions
```

## License

Apache-2.0 (same as both the source repo and this pi-skills collection).
