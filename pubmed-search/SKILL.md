---
name: pubmed-search
description: >-
  Search PubMed via the NCBI E-utilities API using a pure-TypeScript CLI,
  invoked through bash — no Python, no MCP server, no npm install. Three
  subcommands: `search "<query>"` (Boolean/MeSH/field-tagged PubMed search
  returning unified article records: title, authors, year, PMID, DOI, journal,
  abstract, plus total match count), `get-by-pmid <pmid>` (fetch one article),
  and `mesh "<term>"` (MeSH descriptor lookup). Use for 查文献、查论文、PubMed检索、
  文献检索、查找某篇文章、MeSH检索词、文献著录信息获取 — whenever a user needs PubMed
  literature, article metadata by PMID, or MeSH search terms.
---

# PubMed Search (pure TypeScript CLI)

A dependency-free TypeScript client for NCBI E-utilities, ported 1:1 from
[`nature-skills/skills/nature-academic-search/mcp-server/sources/pubmed.py`](https://github.com/Yuan1z0825/nature-skills/blob/main/skills/nature-academic-search/mcp-server/sources/pubmed.py)
(Apache-2.0), exposed as a **command-line tool**. Agents use it **only via
bash** — never import the module or wire up an MCP server. It runs wherever
Node can execute TypeScript directly (Node ≥ 23.6 natively, ≥ 22.6 with
`--experimental-strip-types`, or any Node via `npx tsx`).

## Files

| File | Purpose |
|---|---|
| `cli.ts` | The CLI entry point (the only interface agents should use). |
| `bin/pubmed-search` | Bash wrapper so the CLI runs from any directory. |
| `src/pubmed.ts` | The client library behind the CLI (`PubMedSource`, types, `DataSourceError`). |
| `src/xml.ts` | Minimal ElementTree-compatible XML parser (Node has no built-in XML parser). |
| `scripts/smoke-test.sh` | Bash smoke test for all subcommands (run after any change). |
| `references/pubmed-query-syntax.md` | PubMed query-syntax cheat sheet (Boolean ops, field tags, MeSH, filters). |

## Agent usage protocol (via bash)

1. **Resolve the CLI path.** This SKILL.md lives in the skill's own directory;
   the CLI is a sibling: `<skill-dir>/bin/pubmed-search` (a bash wrapper around
   `node <skill-dir>/cli.ts`). Use the absolute path in every invocation —
   do not `cd` into the skill directory as a side effect of searching.

2. **Set identity once per shell session** (NCBI etiquette; also raises the
   rate limit to 10 req/s when an API key is present):

   ```bash
   export PUBMED_EMAIL=you@example.com
   export NCBI_API_KEY=your_key_here        # optional, but recommended
   ```

3. **Run a subcommand** and read the JSON from stdout:

   ```bash
   /path/to/pubmed-search/bin/pubmed-search search "deep learning MRI Alzheimer's disease" --rows 5
   /path/to/pubmed-search/bin/pubmed-search get-by-pmid 28344011
   /path/to/pubmed-search/bin/pubmed-search mesh "Alzheimer Disease"
   ```

   stdout carries only the result JSON (pretty-printed; `--compact` for one
   line); stderr carries logs and errors; exit codes are 0 ok / 1 runtime
   error / 2 usage error.

## Subcommands

### `search "<query>" [--rows N] [--sort relevance|date]`

Returns `{ total, query, results[] }`:

```json
{
  "total": 1218,
  "query": "deep learning MRI Alzheimer's disease",
  "results": [
    {
      "title": "…",
      "authors": ["Warren Samuel L", "Moustafa Ahmed A"],
      "year": 2023,
      "pmid": "36257926",
      "doi": "10.1111/jon.13063",
      "journal": "Journal of neuroimaging : …",
      "abstract": "…",
      "source": "pubmed"
    }
  ]
}
```

- `total` is the full match count — always report it when summarizing.
- `results` holds only the requested page (`--rows`, default 5, capped at 50).
- Query syntax: Boolean (`AND`/`OR`/`NOT`), field tags (`[Title]`, `[Author]`,
  `[Journal]`, `[MeSH Terms]`, `[dp]` date ranges…), quoted phrases, `*`
  truncation. Full cheat sheet: `references/pubmed-query-syntax.md`.

### `get-by-pmid <pmid>`

Fetch one article by numeric PMID → a single `UnifiedResult` object (same
shape as one search result). Throws (exit 1) for non-numeric input or a PMID
that does not exist — e.g. `PMID 9999999999 not found`.

### `mesh "<term>"`

MeSH descriptor lookup → `{ term, results: [{ name, mesh_id, ui }] }`, up to
10 descriptors. Use it to build MeSH search strategies, then combine UI IDs in
queries: `("D057174"[Mesh]) OR ("D006333"[Mesh])`.

## Options

| Flag | Meaning |
|---|---|
| `--rows N` | Number of results (default 5, capped at `--max-rows`) |
| `--sort MODE` | `"relevance"` (Best Match, default) or `"date"` (Most Recent) |
| `--max-rows N` | Override the results cap (default 50) |
| `--email E` | NCBI email (overrides `PUBMED_EMAIL`) |
| `--api-key K` | NCBI API key (overrides `NCBI_API_KEY`) |
| `--no-email-check` | Skip the email guard (scripting only) |
| `--compact` | Single-line JSON on stdout |
| `-h/--help`, `-v/--version` | Help / version |

## Error handling for agents

- **Exit 0** → stdout has the JSON result; use it directly.
- **Exit 1** → runtime/data error on stderr: missing config, HTTP/timeout,
  NCBI `<Error>` payload (e.g. rate limit), invalid or missing PMID. Surface
  the stderr message to the user verbatim.
- **Exit 2** → usage error (bad command/flags); stderr shows the usage text.
- **Rate limiting:** without an API key NCBI allows ~3 req/s; the client
  throttles automatically, but long workflows should prefer one `search`
  with a larger `--rows` over many small calls, and batch lookups via
  `get-by-pmid` one at a time. If NCBI replies with a rate-limit error, wait
  a few seconds (or set `NCBI_API_KEY`) and retry.

## Workflow examples

Literature search + reading:

```bash
CLI=/path/to/pubmed-search/bin/pubmed-search
$CLI search "cardiac arrest AND 2020:2024[dp]" --rows 10 --sort date
$CLI get-by-pmid 36257926          # pull the full record of a hit
```

MeSH strategy building:

```bash
$CLI mesh "heart failure"
# then: $CLI search '"D057174"[Mesh] AND randomized controlled trial[pt]'
```

## Behavior notes (differences from the Python original)

1. **Zero dependencies** — the original used `requests` + `xml.etree.ElementTree`;
   this port uses built-in `fetch` + a bundled minimal XML parser. XML paths
   and the unified result dict are unchanged.
2. **`lookupMesh` uses `esummary` instead of `efetch`** — the MeSH database has
   no XML `efetch` (it returns plain text), so the original Python code would
   crash against today's live API. `esummary` returns the same descriptor
   records; the first `DS_MeshTerms` entry is used as the descriptor name.
3. **`raiseEutilsError`** — additionally surfaces NCBI `<Error>` payloads
   (e.g. API-key rate-limit messages) as errors instead of silently returning
   empty results.
4. **Titles/abstracts use `textContent`** (itertext semantics) so inline
   markup (e.g. `<i>`) inside `ArticleTitle`/`AbstractText` is preserved
   rather than truncated.

## Verification

After any change, run the smoke test from bash (it exercises all three
subcommands and both error paths against the live API):

```bash
bash /path/to/pubmed-search/scripts/smoke-test.sh   # or: npm run smoke
npx tsc --noEmit                                    # strict type check
```
