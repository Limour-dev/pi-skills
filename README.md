# pi-skills

A collection of [Agent Skills](https://agentskills.io/) for [pi](https://github.com/badlogic/pi),
Claude Code, Codex, Cursor, and any other agent that follows the Agent Skills standard.

## Skills

| Skill | Description |
| ----- | ----------- |
| [pdf](pdf/) | Read, create, and review PDF files where layout matters. Generates with `reportlab`, extracts with `pdfplumber`/`pypdf`, and verifies by rendering pages to PNG. |
| [progressive-paper-split](progressive-paper-split/) | Restructure paper directories (`full.md` + `images/`) into progressive-disclosure trees — an `INDEX.MD` entry, one MD per result/table/figure, per-paper `_meta.md` manifests — with a link checker, a collection-index generator, and a parallel headless-subagent batch runner. |
| [deep-literature-review](deep-literature-review/) | Deep-read, cross-compare, and gap-analyze a progressive-disclosure paper corpus. Enforces multi-layer reading (methods → results tables → discussion cross-references) beyond top-level indexes, then produces structured comparisons (definitions, effect sizes, study design, inter-paper citations) and evidence-based recommendations for missing literature. |

## Install

Install the whole collection:

```bash
npx skills add Limour-dev/pi-skills
```

Or a single skill explicitly:

```bash
npx skills add Limour-dev/pi-skills --skill pdf
```

## License

[Apache-2.0](LICENSE)
