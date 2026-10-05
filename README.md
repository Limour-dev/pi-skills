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
| [massive-options](massive-options/) | Short-dated (≤7 DTE, 0DTE included) US option analytics from the Massive REST API via a zero-dependency pure-TypeScript CLI: gamma exposure (GEX) by strike/expiry, gamma flip and call/put walls, max pain with the full pain curve, and raw chains with open interest, greeks, IV and quotes. `probe` reports what an API key is entitled to, `--from-file` analyses a saved snapshot offline, and a blocked request exits 3 instead of inventing a number. |
| [options-gex](options-gex/) | Short-dated US option positioning from the Sell The News options dashboard via a zero-dependency pure-TypeScript CLI: net GEX, gamma flip / zero-gamma, call & put walls, max pain, per-strike gamma and vanna/charm exposure, P/C OI, implied move and bullish score — one expiry per call (nearest by default). `gex` / `levels` / `walls` / `max-pain` / `flip` / `skew` / `expiries` / `raw` / `probe` read a REST JSON channel and fall back to the MCP text tool when Cloudflare blocks it; every response carries `provenance` with the selected expiry, warnings and source. |
| [optioncharts](optioncharts/) | Weekly and multi-expiry US options data scraped from the optioncharts.io free tier (no API key) via a zero-dependency pure-TypeScript CLI: per-expiry chain statistics (volume, P/C ratios, OI, IV, expected move, max pain, DTE), gamma & delta exposure by strike (GEX/DEX), call & put walls, open interest / volume / IV skew, greeks, the expected-move cone, option chains and real-time spot. `scan TLT SPY QQQ --dte 7` returns one row per expiry per ticker; an expiry that the server silently swaps is a hard error (exit 5) instead of a wrong number, and every response carries `provenance` with the resolved expiries, units and warnings. |
| [tradingview](tradingview/) | Read-only TradingView K线/OHLCV plus the **大道至简** indicator set via a `tradingview` CLI on top of the `@mathieuc/tradingview` v4 data API, with a local SQLite cache and closed-bars-only fetching. `candles` returns OHLCV; `indicators` computes the whitelisted 大道至简 set in pure Node.js — Keltner channels on close (50, 2.75 / 3.75), Keltner on low (50, 3.75), `EMA(high,50)` / `EMA(low,50)`, `median(hlcc4,200)` and MACD(12,26,9) — and no other indicator. Every response carries `symbol_kind` / `unit` / `volume_reliable` / `as_of`. Bare names resolve automatically — `USDT.D`, `US10Y`, `CNH1!`, `BTCUSD`, `SOL`, `DXY`, `VIX`, `ES1!`, `AAPL` — through a curated alias table plus autocomplete that never silently returns a `CRYPTOCAP:*` index. JSON/CSV/table/markdown output, single-sourced `--tf`, and graded exit codes. |
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
