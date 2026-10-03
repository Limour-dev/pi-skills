# pi-skills

A collection of [Agent Skills](https://agentskills.io/) for [pi](https://github.com/badlogic/pi),
Claude Code, Codex, Cursor, and any other agent that follows the Agent Skills standard.

## Skills

| Skill | Description |
| ----- | ----------- |
| [pdf](pdf/) | Read, create, and review PDF files where layout matters. Generates with `reportlab`, extracts with `pdfplumber`/`pypdf`, and verifies by rendering pages to PNG. |
| [progressive-paper-split](progressive-paper-split/) | Restructure paper directories (`full.md` + `images/`) into progressive-disclosure trees — an `INDEX.MD` entry, one MD per result/table/figure, per-paper `_meta.md` manifests — with a link checker, a collection-index generator, and a parallel headless-subagent batch runner. |
| [deep-literature-review](deep-literature-review/) | Deep-read, cross-compare, and gap-analyze a progressive-disclosure paper corpus. Enforces multi-layer reading (methods → results tables → discussion cross-references) beyond top-level indexes, then produces structured comparisons (definitions, effect sizes, study design, inter-paper citations) and evidence-based recommendations for missing literature. |
| [pubmed-search](pubmed-search/) | Search PubMed via NCBI E-utilities with a zero-dependency, pure-TypeScript CLI (`search` / `get-by-pmid` / `mesh` subcommands) invoked from bash. Ported from nature-skills' `pubmed.py`; runs on Node ≥ 23.6 — no Python, no MCP server, no npm install. |
| [miniflux-cli](miniflux-cli/) | Manage a [Miniflux](https://miniflux.app/) RSS reader via a pure-TypeScript CLI (`SKILL.md`). 24 subcommands covering reads (feeds, entries, categories, users, discovery, OPML export) and writes (mark read, bookmark, feed/category CRUD, refresh, OPML import); reads `MINIFLUX_URL` + `MINIFLUX_API_KEY` from the environment. |
| [hn-briefing](hn-briefing/) | Pull the current Hacker News front page (top 100) and produce a daily Chinese briefing in a fixed three-part format (整体趋势 / 最值得点开的一条 / 头条详情). Zero-dependency pure-TypeScript CLI (`top` / `item` / `content` subcommands) via the HN Firebase API; extracts readable article text for the headline of the day. |
| [polymarket](polymarket/) | Read-only Polymarket data via a zero-dependency pure-TypeScript CLI. Prices, order books, price history, holders, trader positions/PnL, leaderboards, and a live market WebSocket — across the Gamma / CLOB / Data APIs with no API key or SDK. Accepts any Gamma id, slug, condition id, outcome token id, or pasted polymarket.com URL, and never silently guesses which market of a multi-market event you meant. |
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

Dual-licensed:

- **Code** (TypeScript, shell scripts, etc.) is licensed under the
  [GNU GPL v3](LICENSE).
- **Text** (documentation, `SKILL.md`, READMEs, references) is licensed under
  [CC BY-NC-SA 4.0](LICENSE-CC-BY-NC-SA).
