---
name: progressive-paper-split
description: Restructure an academic paper directory (full.md + images/) into a progressive-disclosure folder tree with an INDEX.MD entry point and category folders (results/, methods/, tables/, figures/, discussion/, references/, front-matter/, back-matter/), one MD file per result/table/figure, plus per-paper _meta.md manifests and scripts to verify links and regenerate a collection-level parent INDEX.MD. Use when splitting or restructuring paper corpora for RAG, building layered INDEX.MD indexes, or batch-processing pi-rag paper directories with multiple parallel subagents.
---

# Progressive Paper Split

Convert one paper directory (`full.md` + `images/`) into a 3-level progressive-disclosure tree, and aggregate a collection-level parent `INDEX.MD` from per-paper manifests.

**Designed for parallel batch processing:** each subagent writes ONLY inside its own paper directory; the shared parent index is regenerated afterwards by the coordinator from manifests — no write conflicts.

## Roles

| Role | Scope | Writes |
|---|---|---|
| **Subagent** (one per paper) | `PARENT/NN/` | split tree + `INDEX.MD` + `_meta.md` inside `NN/` only |
| **Coordinator** (you) | `PARENT/` | launches subagents, then regenerates `PARENT/INDEX.MD` via script |

## Disclosure levels

- **Level 0** — `PARENT/INDEX.MD`: collection overview + per-paper abstracts + links to each `NN/INDEX.MD`.
- **Level 1** — `NN/INDEX.MD`: paper title, at-a-glance table, abstract, key findings, full navigation to every split file.
- **Level 2/3** — category folders: section files, one MD per result/table/figure, references, declarations.

## Subagent workflow (per paper)

Input: absolute path to a paper directory containing `full.md` and `images/`.

1. **Read** `full.md` completely (paginate if large).
2. **Map sections**: front matter (editors/citation/copyright), title, authors/affiliations, structured abstract, keywords, graphical abstract, introduction, methods subsections, results subsections, tables (HTML or images), figures + captions, discussion/limitations/conclusions, references, back-matter declarations.
3. **Write the canonical tree** — exact layout, naming, and file templates in [references/structure.md](references/structure.md). Hard rules:
   - Every results subsection → its own `results/N-slug.md`.
   - Every table → its own `tables/table-N-slug.md` (HTML verbatim; image tables embed the image + caption).
   - Every figure → its own `figures/figure-N-slug.md` (image + caption).
   - Images stay in `images/`; reference them as `../images/<file>` from subfolders.
   - Two-column PDF artifacts: rejoin split paragraphs, reassemble references split across columns/page breaks, fix obvious OCR word-breaks (e.g. `mvocardial` → `myocardial`). **Never alter numbers, statistics, or meaning.**
   - Every split file starts with a back-link header to its `INDEX.MD`; `INDEX.MD` links to every split file. Bidirectional cross-links between results ↔ tables ↔ figures.
   - Keep `full.md` as an untouched archive.
4. **Write `_meta.md`** (machine-readable manifest, template in [references/structure.md](references/structure.md)): title, status, journal/DOI, short authors, keywords, and a ~300-word structured abstract.
5. **Verify** (must exit 0):
   ```bash
   python3 {baseDir}/scripts/verify_links.py <PAPER_DIR>
   ```
6. **Report**: files created, verify output, unresolved issues (e.g. unreferenced images).

**Constraint:** write only inside the assigned paper directory. Never modify sibling paper directories or `PARENT/INDEX.MD` (the coordinator owns it).

## Coordinator workflow

1. List papers:
   ```bash
   find <PARENT> -maxdepth 2 -name full.md | sort
   ```
2. Launch one subagent per paper using the prompt template in [references/prompts.md](references/prompts.md) (recommended concurrency 3–5). Skip directories that already contain `_meta.md` (idempotent reruns).
3. After all subagents finish, regenerate the parent index:
   ```bash
   python3 {baseDir}/scripts/build_parent_index.py <PARENT> --title "<collection title>"
   ```
   Papers with `_meta.md` appear as ✅ with abstracts; papers without appear as ⏳ pending with titles auto-extracted from `full.md`'s H1. Optionally drop a topic paragraph in `<PARENT>/INTRO.md` — it is embedded automatically.
4. Collection-wide check:
   ```bash
   python3 {baseDir}/scripts/verify_links.py <PARENT>
   ```

## Scripts

- `scripts/verify_links.py PATH...` — recursively checks every internal MD link and image reference under PATH; prints unreferenced images; exits 1 on broken links.
- `scripts/build_parent_index.py PARENT [--title T] [--intro F] [--out F]` — regenerates `PARENT/INDEX.MD` from `NN/_meta.md` manifests.

## Reference

- [references/structure.md](references/structure.md) — canonical tree, file-name conventions, `INDEX.MD` and `_meta.md` templates, edge-case rules (image tables, non-English papers, animal/mechanistic studies).
- [references/prompts.md](references/prompts.md) — ready-to-paste subagent prompt template and coordinator launch recipe.
