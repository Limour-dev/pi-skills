# PubMed Query Syntax Reference

Cheat sheet for the `query` argument of `PubMedSource.search()`. Full official
documentation: <https://pubmed.ncbi.nlm.nih.gov/help/#searching>.

## Boolean operators

| Operator | Example | Meaning |
|---|---|---|
| `AND` (default) | `diabetes AND retinopathy` | both terms (AND is implicit: `diabetes retinopathy`) |
| `OR` | `(infant OR newborn)` | either term |
| `NOT` | `hypertension NOT pregnancy` | exclude |

- Operators must be **uppercase** (`AND`, `OR`, `NOT`).
- Use parentheses to group: `(lung cancer OR bronchial carcinoma) AND immunotherapy`.

## Field tags (append `[tag]` to a term)

| Tag | Example | Field |
|---|---|---|
| `[Title]` / `[ti]` | `glioblastoma[Title]` | title only |
| `[Title/Abstract]` / `[tiab]` | `ferroptosis[tiab]` | title or abstract |
| `[Author]` / `[au]` | `Smith J[au]` | author |
| `[Journal]` / `[ta]` | `Nature[ta]` | journal title/abbrev |
| `[MeSH Terms]` / `[mh]` / `[Mesh]` | `cardiac arrest[mh]` | MeSH heading (exploded); text names only — see §MeSH |
| `[MeSH Major Topic]` / `[majr]` | `cardiac arrest[majr]` | MeSH heading as major topic |
| `[Date - Publication]` / `[dp]` | `2020:2024[dp]` | publication date range |
| `[Date - Create]` / `[crdt]` | `20230101:20231231[crdt]` | date added to PubMed |
| `[PMID]` / `[pmid]` | `28344011[pmid]` | PMID |
| `[DOI]` | `10.1016/j.jacc.2020.04.002[DOI]` | DOI |
| `[Language]` / `[la]` | `chinese[la]` | language |
| `[Publication Type]` / `[pt]` | `meta-analysis[pt]`, `randomized controlled trial[pt]` | pub type |

## Phrases

- Quote multi-word phrases: `"cardiac arrest"` (quotes disable automatic
  term mapping and force exact phrase matching).
- Use `*` truncation: `therap*` matches therapy, therapies, therapeutic…

## MeSH

- MeSH terms are auto-exploded (include narrower terms) when typed as plain
  words: `heart failure` includes "Heart Failure, Diastolic" etc.
- `[Mesh]` is an alias of `[MeSH Terms]` / `[mh]`, and it only works with the
  **text name** of a descriptor — never with a UI or numeric id:
  ```text
  "Heart Failure"[MeSH Terms]   # ✓ works
  Heart Failure[mh]             # ✓ works (auto-explode)
  "D006333"[Mesh]               # ✗ 0 hits: db=pubmed does not know descriptor UIs
  D006333[mh]                   # ✗ 0 hits
  ```
- Build search strategies with the `mesh` subcommand first, then search by the
  returned **name** (use `descriptor_ui` only for `db=mesh` cross-checks):
  ```bash
  pubmed-search mesh "heart failure"
  # -> { "name": "Heart Failure", "descriptor_ui": "D057174", ... }
  pubmed-search search '"Heart Failure"[MeSH Terms] AND 2020:2024[dp]'   # ✓
  ```

## Filters / built-in queries

- `randomized controlled trial[pt]`, `meta-analysis[pt]`, `systematic review[pt]`
- `humans[mh]`, `english[la]`, `review[pt]`
- `hasabstract[text]`, `free full text[sb]`

## Example composite queries

```
(immunotherapy OR checkpoint inhibitor[Title/Abstract]) AND non-small cell lung cancer[Title/Abstract] AND 2019:2024[dp]

heart failure AND sacubitril AND randomized controlled trial[pt] AND english[la]
```

## Result shaping

- `rows` is capped by `maxRows` (default 50); exceeding it logs a truncation
  warning to stderr and the response carries `"truncated": true`.
- `offset` (CLI `--offset`) maps to NCBI `retstart` for paging.
- `sort="date"` maps to NCBI `pub_date` (Most Recent); `sort="relevance"`
  maps to Best Match.
- `total` in the response is the full match count; `results` holds only the
  requested page — report `total` when summarizing to the user.
- `query_translation` is what NCBI actually ran; `warnings` explains 0-hit /
  malformed queries (`QuotedPhraseNotFound`, `FieldNotFound`, …).
- Light modes issue only the esearch request: `--ids-only` (`pmids[]`),
  `--count-only` (`total`), `--explain` (`query_translation` + `warnings`).
