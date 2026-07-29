---
name: progressive-paper-split
description: Restructure an academic paper directory (full.md + images/) into a progressive-disclosure folder tree with an INDEX.MD entry point and category folders (results/, methods/, tables/, figures/, discussion/, references/, front-matter/, back-matter/), one MD file per result/table/figure, plus per-paper _meta.md manifests and scripts to verify links, regenerate a collection-level parent INDEX.MD, and batch-process whole corpora with parallel headless subagents. Use when splitting or restructuring paper corpora for RAG, building layered INDEX.MD indexes, or batch-processing pi-rag paper directories.
---

# Progressive Paper Split

Convert one paper directory (`full.md` + `images/`) into a 3-level progressive-disclosure tree, and aggregate a collection-level parent `INDEX.MD` from per-paper manifests.

**Designed for parallel batch processing:** each subagent writes ONLY inside its own paper directory; the shared parent index is regenerated afterwards from manifests — no write conflicts. Field-tested on a 15-paper collection: 14 headless subagents at concurrency 3, all succeeded, 515 MD files produced, 0 broken links.

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
2. Launch one subagent per paper. The proven way is the bundled batch runner:
   ```bash
   PARENT=/abs/path/to/collection bash {baseDir}/scripts/run_batch.sh        # defaults: MAX=3
   MAX=5 PARENT=/abs/path bash {baseDir}/scripts/run_batch.sh                # higher concurrency
   PARENT=/abs/path bash {baseDir}/scripts/run_batch.sh 07 12                # only specific papers
   ```
   It is idempotent (papers with `_meta.md` are skipped), throttles concurrency, sanitizes ambient `PI_*` env for child sessions, and writes `_batch/runner.log` (timeline) + `_batch/logs/NN.log` (per paper). For manual/interactive orchestration use the prompt template in [references/prompts.md](references/prompts.md).
3. After all subagents finish, regenerate the parent index:
   ```bash
   python3 {baseDir}/scripts/build_parent_index.py <PARENT> --title "<collection title>"
   ```
   Papers with `_meta.md` appear as ✅ with abstracts; papers without appear as ⏳ pending (titles auto-extracted from `full.md` H1). An optional topic paragraph in `<PARENT>/INTRO.md` is embedded automatically.
4. Collection-wide check:
   ```bash
   python3 {baseDir}/scripts/verify_links.py <PARENT>
   ```

## Headless batch operations (field-tested)

Lessons from the production run (15 papers, 14 headless `pi -p` subagents, concurrency 3):

- **Per-paper logs stay empty until the agent finishes** — `pi -p` prints only the final report to stdout. Monitor live progress on the filesystem (files appearing in each paper dir), not log tails.
- **Completion signal** = exit code 0 **and** `_meta.md` present. The `BATCH_DONE` line inside the report is informational (it can be truncated at the end).
- **Runtime varies 6–35 min/paper.** Slow starters may write nothing for 10+ minutes — normal. An agent is stuck only if its process is dead or file counts stop growing for a long time; don't kill early.
- **Sanitize child env**: child pi sessions must not inherit `PI_SESSION_ID`/`PI_SESSION_FILE` etc. (the runner strips them) — otherwise they can collide with the ambient session. Pass `--provider`/`--model` explicitly when the ambient defaults are wrong. Proven flags: `--skill <dir> --no-session --approve --thinking low`.
- **Concurrency ≤3** was gentle on API capacity; raise `MAX` only if quota allows.
- **Retry = rerun the runner**: done papers are skipped automatically. To force a redo, delete a paper's generated tree (keep `full.md` + `images/`) including `_meta.md`, then rerun.
- Monitoring one-liners:
  ```bash
  cat $PARENT/_batch/runner.log                  # START/OK/FAIL timeline
  ls $PARENT/*/_meta.md | wc -l                  # done count
  for d in $PARENT/*/; do printf '%s %s md\n' "$d" "$(find "$d" -name '*.md' | wc -l)"; done
  ```

## Scripts

- `scripts/run_batch.sh` — parallel headless batch runner. Env knobs: `PARENT` (required), `MAX`, `PI_BIN`, `PROVIDER`, `MODEL`, `THINKING`, `SKILL_DIR`, `PROMPT_FILE` (custom prompt template with `{PAPER_DIR} {NN} {PARENT} {SKILL_DIR}` placeholders; the embedded default is the field-proven prompt).
- `scripts/verify_links.py PATH...` — recursively checks every internal MD link and image reference under PATH; prints unreferenced images; exits 1 on broken links.
- `scripts/build_parent_index.py PARENT [--title T] [--intro F] [--out F]` — regenerates `PARENT/INDEX.MD` from `NN/_meta.md` manifests.

## Reference

- [references/structure.md](references/structure.md) — canonical tree, file-name conventions, `INDEX.MD` and `_meta.md` templates, edge-case rules (image tables, non-English papers, animal/mechanistic studies).
- [references/prompts.md](references/prompts.md) — coordinator recipe, monitoring, operational lessons, and the manual subagent prompt template.
