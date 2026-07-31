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

# PubMed Search CLI

唯一入口：`<skill-dir>/bin/pubmed-search`（bash wrapper，可在任何目录直接调用）。
身份环境变量（`PUBMED_EMAIL` / `NCBI_API_KEY`）本机已配置，**无需设置**。

stdout 只输出结果 JSON（`--compact` 输出单行）；stderr 输出日志/错误；退出码 `0` 成功 / `1` 运行时错误 / `2` 用法错误。

## 子命令

### `search "<query>" [--rows N] [--sort relevance|date]`
→ `{ total, query, results: [{title, authors[], year, pmid, doi, journal, abstract, source}] }`

- `total` 是全量命中数，总结时必须报告
- 默认返回 5 条（`--rows` 上限 50）
- 查询语法（Boolean、`[Title]`/`[Author]`/`[Journal]`/`[MeSH Terms]`/`[dp]` 字段标签、引号短语、`*` 截断）：见 `references/pubmed-query-syntax.md`

### `get-by-pmid <pmid>`
→ 单条文章记录（形状同 search 的 results 元素）。PMID 非数字或不存在 → exit 1。

### `mesh "<term>"`
→ `{ term, results: [{name, mesh_id, ui}] }`，最多 10 个描述符。用 UI 组合检索式：`("68000544"[Mesh]) OR ("D006333"[Mesh])`。

## 其他

- 完整选项（`--email`/`--api-key`/`--max-rows`/`--no-email-check` 等）：`--help`
- 限流、错误处理细节、批量检索策略、开发验证：按需读 `references/agent-guide.md`
