---
name: pubmed-search
description: >-
  Search PubMed via the NCBI E-utilities API with a zero-dependency, pure-TypeScript
  client (pubmed-search/src/pubmed.ts): keyword/Boolean/MeSH search returning unified
  article records (title, authors, year, PMID, DOI, journal, abstract), fetch a single
  article by PMID, and look up MeSH descriptors by term. Use for 查文献、查论文、PubMed检索、
  文献检索、查找某篇文章、MeSH检索词、文献著录信息获取 — whenever a user needs PubMed
  literature, article metadata by PMID, or MeSH search terms, without requiring a
  Python MCP server.
---

# PubMed Search (pure TypeScript)

A dependency-free TypeScript client for NCBI E-utilities, ported 1:1 from
[`nature-skills/skills/nature-academic-search/mcp-server/sources/pubmed.py`](https://github.com/Yuan1z0825/nature-skills/blob/main/skills/nature-academic-search/mcp-server/sources/pubmed.py)
(Apache-2.0). It runs wherever Node can execute TypeScript directly (Node ≥ 23.6
natively, ≥ 22.6 with `--experimental-strip-types`, or any Node via `npx tsx`) —
**no Python, no npm runtime dependencies, no MCP server required**.

## Files

| File | Purpose |
|---|---|
| `src/pubmed.ts` | The client: `PubMedSource` class with `search()`, `getByPmid()`, `lookupMesh()`; types; `DataSourceError`. |
| `src/xml.ts` | Minimal ElementTree-compatible XML parser (Node has no built-in XML parser). Handles attributes, CDATA, DOCTYPE, entities. |
| `scripts/demo.ts` | Runnable smoke test / example (search → by PMID → MeSH → error handling). |
| `references/pubmed-query-syntax.md` | PubMed query-syntax cheat sheet (Boolean ops, field tags, MeSH, filters). |

## Quick start

```bash
cd pubmed-search

# Node >= 23.6 runs TS directly; otherwise use tsx
node scripts/demo.ts          # or: npx tsx scripts/demo.ts

# Provide your identity for NCBI (optional but recommended):
PUBMED_EMAIL=you@example.com NCBI_API_KEY=abc123 node scripts/demo.ts
```

Embedding in your own code:

```ts
import { PubMedSource } from "./src/pubmed.ts";

const pubmed = new PubMedSource({
  email: "you@example.com",        // or env PUBMED_EMAIL
  apiKey: "abc123",                // or env NCBI_API_KEY (10 req/s instead of 3)
  // requireEmail: false,          // unset to skip the email check
});

const { total, results } = await pubmed.search("(glioblastoma[Title]) AND MRI[Title]", 5, "relevance");
for (const r of results) {
  console.log(r.pmid, r.year, r.title, r.authors.join("; "), r.doi, r.journal, r.abstract);
}

const paper = await pubmed.getByPmid("28344011");
const mesh  = await pubmed.lookupMesh("Alzheimer Disease");
```

## API

### `search(query, rows = 5, sort = "relevance") → SearchResponse`

- `query`: full PubMed query syntax — Boolean (`AND`/`OR`/`NOT`), field tags
  (`[Title]`, `[Author]`, `[Journal]`, `[MeSH Terms]`, …), phrases in quotes,
  MeSH terms. See `references/pubmed-query-syntax.md`.
- `rows`: number of results (capped at `maxRows`, default 50).
- `sort`: `"relevance"` (Best Match) or `"date"` (Most Recent).
- Returns `{ total, query, results: UnifiedResult[] }`. `total` is the full
  match count, `results` only the fetched page.
- Internally: `esearch` (WebEnv/QueryKey, history) → `efetch` (abstracts).

### `getByPmid(pmid) → UnifiedResult`

Fetch one article by numeric PMID. Throws `DataSourceError` for non-numeric
input or a PMID that does not exist.

### `lookupMesh(term) → { term, results: { name, mesh_id, ui }[] }`

MeSH descriptor lookup. `esearch` on the `mesh` database, then `esummary` for
descriptor names. Returns up to 10 descriptors (`name`, `mesh_id`/`ui`).

### `UnifiedResult`

```ts
{
  title: string; authors: string[]; year: number | null;
  pmid: string; doi: string; journal: string;
  abstract: string; source: "pubmed";
}
```

### Errors

All failures throw `DataSourceError` (`name`, `source = "pubmed"`,
`originalError?`): empty/invalid input, missing config, HTTP errors,
timeouts, NCBI `<Error>` responses (e.g. rate limit), missing PMID, and
unparseable articles (skipped with a JSON warning on stderr, like the
Python original).

## Configuration

Resolution order: **constructor options → env vars → JSON config file**.

| Option | Env var | Config file key | Default |
|---|---|---|---|
| `email` | `PUBMED_EMAIL` | `pubmed.email` | `""` |
| `apiKey` | `NCBI_API_KEY` | `pubmed.api_key` | `""` |
| `maxRows` | `PUBMED_MAX_ROWS` | `pubmed.max_rows` | `50` |
| `configPath` | `PUBMED_CONFIG` | — | `config.json` in cwd (if present) |
| `timeoutMs` | — | — | `30000` |
| `requireEmail` | — | — | `true` |

The JSON config file is shaped like `{ "pubmed": { "email": "...", "api_key": "...", "max_rows": 50 } }`
(mirrors the Python `config.toml`). NCBI asks every tool to send an email
address; keep `requireEmail: true` unless you are scripting.

## Behavior notes (differences from the Python original)

1. **Zero dependencies** — the original used `requests` + `xml.etree.ElementTree`;
   this port uses built-in `fetch` + a bundled minimal XML parser. XML paths
   (`MedlineCitation`, `AuthorList/Author`, `AbstractText`, `ELocationID`, …)
   and the unified result dict are unchanged.
2. **`lookupMesh` uses `esummary` instead of `efetch`** — the MeSH database has
   no XML `efetch` (it returns plain text), so the original Python code would
   crash against today's live API. `esummary` returns the same descriptor
   records; the first `DS_MeshTerms` entry is used as the descriptor name.
3. **`raiseEutilsError`** — additionally surfaces NCBI `<Error>` payloads
   (e.g. API-key rate-limit messages) as `DataSourceError` instead of silently
   returning empty results.
4. **Titles/abstracts use `textContent`** (itertext semantics) so inline
   markup (e.g. `<i>`) inside `ArticleTitle`/`AbstractText` is preserved
   rather than truncated.

## MCP integration (optional)

If you want to expose this as an MCP server (like the original), wrap the
three methods in tools using `@modelcontextprotocol/sdk`:

| Tool | Backed by |
|---|---|
| `pubmed_search(query, rows, sort)` | `PubMedSource.search` |
| `pubmed_get_by_pmid(pmid)` | `PubMedSource.getByPmid` |
| `pubmed_mesh_lookup(term)` | `PubMedSource.lookupMesh` |

## Rate limits & etiquette

- 3 requests/second without an API key; 10 req/s with one. The client
  throttles automatically (`performance.now()`-based, mirroring the Python
  `_throttle`).
- Send a real email address (NCBI blocks tool users who do not).
- `search()` makes two requests (esearch + efetch); batch IDs via
  `getByPmid` where possible instead of looping single fetches.

## Verification

After any change, run `node scripts/demo.ts` — it exercises search, by-PMID
fetch, MeSH lookup, and both error paths against the live API. Type-check
with `npx tsc --noEmit` (devDependency `typescript`).
