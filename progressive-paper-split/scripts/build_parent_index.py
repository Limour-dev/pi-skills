#!/usr/bin/env python3
"""build_parent_index.py — regenerate a collection INDEX.MD from per-paper manifests.

Usage:
  python3 build_parent_index.py PARENT_DIR [--title TITLE] [--intro FILE] [--out FILE] [--abstracts]

Conventions:
- Every subdirectory of PARENT_DIR that contains full.md is a paper (id = dir name).
- Papers with _meta.md  -> status done (✅), entry link NN/INDEX.MD, plus a one-line
  core conclusion (the `one_liner` fence field) shown in the paper-list table.
- Full per-paper abstracts are NOT embedded by default — Level 0 must stay lean,
  and the full abstract already lives in each NN/INDEX.MD. Pass --abstracts to
  re-enable the verbose per-paper abstract section.
- Papers without _meta -> status pending (⏳), entry link NN/full.md,
  title auto-extracted from full.md's first '# ' heading.
- If --intro FILE or PARENT_DIR/INTRO.md exists, its content is embedded as the
  collection topic description.
- Output: --out FILE or PARENT_DIR/INDEX.MD (overwritten).
"""
import argparse
import os
import re

META_FENCE_RE = re.compile(r'```meta\s*\n(.*?)```', re.S)
H2_RE = re.compile(r'^##\s+(.*)$')
ABSTRACT_H2_RE = re.compile(r'^##\s+.*(?:Abstract|摘要)', re.I)

STRUCTURE_BLOCK = """```
NN/
├── INDEX.MD          # Level 1: title + abstract + key findings + full navigation
├── full.md           # original full text (archive, untouched)
├── _meta.md          # machine-readable manifest (title/abstract/keywords)
├── images/           # original images
├── front-matter/     # editorial info, authors/affiliations, keywords
├── introduction/     # introduction
├── methods/          # methods (one file per subsection)
├── results/          # results (one file per result)
├── tables/           # tables (one file per table)
├── figures/          # figures + captions (one file per figure)
├── discussion/       # discussion, limitations, conclusions
├── references/       # references
└── back-matter/      # data/ethics/contributions/funding/COI/AI/publisher/supplementary
```"""


def parse_meta(path):
    with open(path, encoding='utf-8') as fh:
        text = fh.read()
    meta = {}
    fence = META_FENCE_RE.search(text)
    if fence:
        for line in fence.group(1).splitlines():
            if ':' in line:
                key, value = line.split(':', 1)
                key, value = key.strip(), value.strip()
                if key:
                    meta[key] = value
    # Abstract: content under the first H2 whose title contains Abstract/摘要,
    # up to the next H2 or EOF.
    lines = text.splitlines()
    capturing = False
    abstract_lines = []
    for line in lines:
        if H2_RE.match(line):
            if capturing:
                break
            if ABSTRACT_H2_RE.match(line):
                capturing = True
            continue
        if capturing:
            abstract_lines.append(line)
    meta['_abstract'] = '\n'.join(abstract_lines).strip()
    return meta


def h1_title(full_md):
    try:
        with open(full_md, encoding='utf-8') as fh:
            for line in fh:
                if line.startswith('# '):
                    return line[2:].strip()
    except OSError:
        pass
    return '(untitled)'


def _cell(text):
    """Make a string safe for one markdown table cell (no pipes or newlines)."""
    if not text:
        return ''
    return ' '.join(str(text).split()).replace('|', '&#124;')


def _one_liner(meta):
    """One-line core conclusion for the parent index table.

    Prefers an authored `one_liner` field from the _meta.md fence; falls back to a
    truncated Results sentence from the abstract so older corpora without the field
    still render something useful.
    """
    line = (meta.get('one_liner') or '').strip()
    if line:
        return line
    abstract = meta.get('_abstract') or ''
    candidate = ''
    first = ''
    for raw in abstract.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        if not first:
            first = stripped
        plain = stripped.replace('*', '').strip()
        if plain.lower().startswith('results') or plain.startswith('结果'):
            candidate = plain
            break
    text = candidate or first
    text = text.replace('*', '')
    for label in ('Results:', 'Results', '结果:', '结果'):
        if text.startswith(label):
            text = text[len(label):]
            break
    text = text.lstrip(':： ').strip()
    text = ' '.join(text.split())
    if len(text) > 110:
        text = text[:110].rsplit(' ', 1)[0].rstrip(',;:') + '…'
    return text


def load_intro(args, parent):
    if args.intro and os.path.isfile(args.intro):
        with open(args.intro, encoding='utf-8') as fh:
            return fh.read().strip()
    default_intro = os.path.join(parent, 'INTRO.md')
    if os.path.isfile(default_intro):
        with open(default_intro, encoding='utf-8') as fh:
            return fh.read().strip()
    return ''


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('parent', help='collection parent directory')
    ap.add_argument('--title', default=None,
                    help='collection title (default: "论文集总索引 (Collection Index)")')
    ap.add_argument('--intro', default=None,
                    help='path to intro markdown (default: PARENT/INTRO.md if present)')
    ap.add_argument('--out', default=None,
                    help='output file (default: PARENT/INDEX.MD)')
    ap.add_argument('--abstracts', action='store_true',
                    help='also embed full per-paper abstract sections (default: off; '
                         'full abstracts live in each NN/INDEX.MD, Level 0 stays lean)')
    args = ap.parse_args()

    parent = os.path.abspath(args.parent)
    if not os.path.isdir(parent):
        raise SystemExit(f'not a directory: {parent}')

    paper_ids = sorted(
        d for d in os.listdir(parent)
        if os.path.isfile(os.path.join(parent, d, 'full.md'))
    )
    if not paper_ids:
        raise SystemExit(f'no paper directories (with full.md) under {parent}')

    papers = []
    for pid in paper_ids:
        pdir = os.path.join(parent, pid)
        meta_path = os.path.join(pdir, '_meta.md')
        if os.path.isfile(meta_path):
            meta = parse_meta(meta_path)
            papers.append({
                'id': pid,
                'done': True,
                'title': meta.get('title') or h1_title(os.path.join(pdir, 'full.md')),
                'meta': meta,
            })
        else:
            papers.append({
                'id': pid,
                'done': False,
                'title': h1_title(os.path.join(pdir, 'full.md')),
                'meta': {},
            })

    title = args.title or '论文集总索引 (Collection Index)'
    intro = load_intro(args, parent)
    first, last = paper_ids[0], paper_ids[-1]
    done_count = sum(1 for p in papers if p['done'])

    out = []
    out.append(f'# {title}\n')
    out.append('> **渐进式披露 · Level 0（顶层入口）**')
    out.append('> 本文件是整个论文集的第一披露层：以**一句话核心结论**概览每篇论文，并链接到各论文的子索引（`NN/INDEX.MD`）获取完整摘要与细节。')
    out.append('> 阅读路径：本文件 → 论文 `INDEX.MD` → 章节文件（results / methods / tables …）→ 具体表格/图片/参考文献。\n')

    if intro:
        out.append(intro + '\n')

    out.append('## 状态图例（Legend）\n')
    out.append('- ✅ 已完成渐进式重构（含 `INDEX.MD` 与 `_meta.md`）')
    out.append('- ⏳ 待处理（仅有 `full.md` 原文）\n')

    out.append(f'## 论文清单（Papers {first}–{last}）\n')
    out.append('| # | 状态 | 标题 | 核心结论 | 入口 |')
    out.append('|---|---|---|---|---|')
    for p in papers:
        if p['done']:
            status = '✅ 已重构'
            entry = f"[{p['id']}/INDEX.MD]({p['id']}/INDEX.MD)"
            conclusion = _cell(_one_liner(p['meta'])) or '—'
        else:
            status = '⏳ 待处理'
            entry = f"[{p['id']}/full.md]({p['id']}/full.md)"
            conclusion = '—'
        out.append(f"| {p['id']} | {status} | {_cell(p['title'])} | {conclusion} | {entry} |")
    out.append('')
    out.append('---\n')

    done_papers = [p for p in papers if p['done']]
    if args.abstracts and done_papers:
        out.append('## 已完成论文摘要（Abstracts）\n')
        for p in done_papers:
            m = p['meta']
            out.append(f"### 论文 {p['id']} — ✅\n")
            out.append(f"**标题**：{p['title']}")
            journal = m.get('journal', '')
            doi = m.get('doi', '')
            cite = ' · '.join(x for x in [journal, f"doi: {doi}" if doi else ''] if x)
            if cite:
                out.append(f'**期刊/DOI**：{cite}')
            authors = m.get('authors_short', '')
            if authors:
                out.append(f'**作者**：{authors}')
            out.append(f"**入口**：[{p['id']}/INDEX.MD]({p['id']}/INDEX.MD) · 原始全文：[{p['id']}/full.md]({p['id']}/full.md)\n")
            out.append(m.get('_abstract', '') or '_（_meta.md 中未提供摘要）_')
            out.append('\n---\n')

    pending = [p for p in papers if not p['done']]
    if pending:
        out.append(f'## 待处理论文（{len(pending)} 篇）\n')
        out.append('> 各文仅有 `full.md` 原文，尚未生成 `INDEX.MD` / `_meta.md`。处理完成后重跑本脚本即可自动更新状态与摘要。\n')

    out.append('## 渐进式披露结构说明（Structure convention）\n')
    out.append('每篇论文（完成后）遵循统一结构：\n')
    out.append(STRUCTURE_BLOCK)
    out.append('')

    out_path = args.out or os.path.join(parent, 'INDEX.MD')
    with open(out_path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out).rstrip() + '\n')

    print(f'wrote {out_path}')
    print(f'papers: {len(papers)} total, {done_count} done, {len(pending)} pending')


if __name__ == '__main__':
    main()
