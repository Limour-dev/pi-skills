# Canonical output structure & templates

> Referenced by `SKILL.md`. Defines the exact tree, naming rules, and templates a
> subagent must produce for one paper directory.

## Target tree

```
NN/
├── INDEX.MD                    # Level 1 entry (uppercase, required)
├── full.md                     # KEEP original, untouched (archive)
├── _meta.md                    # machine-readable manifest (required)
├── images/                     # KEEP original images, untouched
├── front-matter/
│   ├── editorial.md            # open access, editors/reviewers, correspondence, dates, citation, copyright
│   ├── authors-affiliations.md
│   └── keywords.md
├── introduction/
│   └── introduction.md
├── methods/
│   ├── 0-<slug>.md             # e.g. formula/definition files, numbered by appearance
│   ├── 1-<slug>.md             # one file per methods subsection (2.1, 2.2, ...)
│   └── ...
├── results/                    # ★ one file per result
│   ├── 1-<slug>.md             # result subsection 3.1
│   ├── 2-<slug>.md             # result subsection 3.2
│   └── ...
├── tables/
│   ├── table-1-<slug>.md       # one file per table (HTML verbatim, or image + caption)
│   └── ...
├── figures/
│   ├── graphical-abstract.md   # if present (may embed several panel images)
│   ├── figure-1-<slug>.md      # one file per figure (image + caption)
│   └── ...
├── discussion/
│   ├── discussion.md
│   ├── limitations.md
│   └── conclusions.md
├── references/
│   └── references.md
└── back-matter/
    ├── data-availability.md
    ├── ethics.md
    ├── author-contributions.md
    ├── funding.md
    ├── conflict-of-interest.md
    ├── generative-ai-statement.md
    ├── publisher-note.md
    └── supplementary-material.md
```

Adaptation rules:
- Folder names are fixed; file slugs follow the paper's own headings (`<slug>` = short english kebab-case).
- Follow the paper's own section structure: some papers are animal/mechanistic studies
  (e.g. *Materials and methods* with *In vivo* / *In vitro* subsections) — split by their
  headings into `methods/` and `results/` the same way.
- Omit folders that have no content (e.g. no graphical abstract); create folders that do
  (e.g. a *Graphical abstract* or *Highlights* section).
- Back-matter: include only declarations actually present in the paper.

## Naming & linking rules

- File names: lowercase kebab-case; number prefixes (`1-`, `2-`, `table-1-`, `figure-2-`) preserve reading order.
- Images: never move them; from any subfolder reference as `../images/<filename>`.
- Every split file begins with a back-link header:
  `⬅️ 返回 [../INDEX.MD](../INDEX.MD) · 所属：第 N 节 …`
- Bidirectional cross-links: result files link their tables/figures; table/figure files link back to the citing result file.
- `INDEX.MD` must link to **every** split file (grouped by folder with short descriptions).

## PDF two-column cleanup (safe edits only)

Source `full.md` comes from PDF extraction; typical artifacts:
- Discussion/body paragraphs interleaved with table blocks → reassemble paragraphs in reading order (tables go to `tables/`).
- A reference (or abstract) split mid-sentence across a column/page break → rejoin.
- OCR word-breaks with stray spaces or swapped letters (`F u n d i n g`, `mvocardial`, `m ocardium`, `an ioplast`) → fix the word.
- **Never** change numbers, confidence intervals, p-values, author names, or meaning. When unsure, keep verbatim.

## INDEX.MD template (Level 1)

```markdown
# <Paper title>

> **论文 NN · 入口索引（渐进式披露 Level 1）**
> 本文件是该论文的第一披露层：标题、摘要、核心结论与全库导航。
> 全文已按章节拆分为各子文件夹中的独立 MD 文件；原始完整全文归档于 [`full.md`](full.md)。

## 速览（At a Glance）
| 项目 | 内容 |
|---|---|
| 研究类型 | … |
| 研究人群/模型 | … |
| 暴露/干预 | … |
| 主要终点 | … |
| 核心发现 | …（含关键数值） |
| 期刊 / DOI | … |

## 摘要（Abstract）
**Introduction/Background:** …
**Methods:** …
**Results:** …（保留关键数值）
**Discussion/Conclusions:** …

## 核心结论（Key Findings）
- …
- …

## 关键词（Keywords）
… → 详见 [front-matter/keywords.md](front-matter/keywords.md)

## 目录导航（Level 2 → Level 3）
### 📄 前置信息（front-matter/）
- [editorial.md](front-matter/editorial.md) — …
…（每个文件夹一组，链接全部文件）

---
⬆️ **上一级索引**：[../INDEX.MD](../INDEX.MD)
```

For Chinese papers: keep the same skeleton; section labels may be Chinese, body stays in the paper's language.

## _meta.md template (manifest)

The coordinator's `build_parent_index.py` parses the ` ```meta ` fence and the first
`## Abstract`/`## 摘要` section. Keep that structure exactly.

```markdown
# _meta — machine-readable manifest (structure parsed by build_parent_index.py)

```meta
paper_id: NN
status: done
title: <full paper title, one line>
lang: en
journal: <journal short name>
year: <YYYY>
doi: <doi without https>
authors_short: <FirstAuthor et al., or 中文作者等>
keywords: kw1; kw2; kw3
```

## Abstract

**Introduction:** … (concise, ≤ ~300 words total; keep key numbers)
**Methods:** …
**Results:** …
**Discussion:** …
```

Notes:
- `title` must be a single line (no line breaks) — it is embedded in a markdown table.
- For non-English papers, `lang` = e.g. `zh`; the Abstract section may be written in the paper's language.
- If the paper has no DOI (e.g. some Chinese journals), leave `doi:` empty.
