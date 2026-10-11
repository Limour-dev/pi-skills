---
name: pubmed-search
description: >-
  Search PubMed via the NCBI E-utilities API using a pure-TypeScript CLI,
  invoked through bash — no Python, no MCP server, no npm install. Three
  subcommands: `search "<query>"` (Boolean/MeSH/field-tagged PubMed search
  returning unified article records: title, authors, year, PMID, DOI, journal,
  volume/issue/pages, publication types, MeSH terms, abstract, plus total match
  count and query warnings), `get-by-pmid <pmid[,pmid...]>` (fetch one or many
  articles, with `--format citation`), and `mesh "<term>"` (MeSH descriptor
  lookup with reconstructed descriptor UI). Use for 查文献、查论文、PubMed检索、
  文献检索、查找某篇文章、MeSH检索词、文献著录信息获取 — whenever a user needs PubMed
  literature, article metadata by PMID, or MeSH search terms.
---

# PubMed Search CLI

唯一入口：`<skill-dir>/bin/pubmed-search`（bash wrapper，可在任何目录直接调用）。
身份环境变量（`PUBMED_EMAIL` / `NCBI_API_KEY`）本机已配置，**无需设置**。

stdout 只输出结果 JSON（`--compact` 输出单行）；stderr 输出日志/错误；退出码 `0` 成功 / `1` 运行时错误 / `2` 用法错误。
**不要丢弃 stderr**（`2>/dev/null` 会丢掉真正的失败原因，如 429/0 命中的警告）。管道里需要保留退出码时用 `PIPESTATUS`，别用裸 `cmd | head` 的退出码。

## 子命令

### `search "<query>" [--rows N] [--offset N] [--sort relevance|date]`
→ `{ total, query, query_translation, warnings[], results: [{title, authors[], year, pmid, doi, journal, journal_abbrev, volume, issue, pages, issn, pubtype[], language, mesh_terms[], abstract, source}] }`

- `total` 是全量命中数，总结时必须报告
- **0 命中是成功**：`exit 0`、`total: 0`、`results: []`。绝不反复重试；用 `warnings` / `query_translation` 判断是「检索式写错」还是「确实没有文献」
- `warnings` 会给出 `QuotedPhraseNotFound` / `PhraseIgnored` / `FieldNotFound` / `No items found.` 等可操作原因
- 默认返回 5 条；`--rows` 超过 `--max-rows`（默认 50）时会**在 stderr 警告**并截断，用 `--offset` 翻页
- 轻量模式（只发 1 次 esearch 请求，省配额、更快）：
  - `--ids-only`：只回 `total` + `pmids[]`
  - `--count-only`：只回 `total`（+ warnings）
  - `--explain`：只回 `query_translation` + `warnings`（诊断检索式）
- 查询语法（Boolean、`[Title]`/`[Author]`/`[Journal]`/`[MeSH Terms]`/`[dp]` 字段标签、引号短语、`*` 截断）：见 `references/pubmed-query-syntax.md`

### `get-by-pmid <pmid[,pmid...]> [--format json|citation] [--no-cache]`
→ 单条文章记录（形状同 search 的 results 元素）；多个 PMID 用逗号分隔时 → `{ results: [...], missing: [...] }`。
PMID 非数字或不存在 → exit 1。默认走本地缓存（`~/.cache/pubmed-search/pmid/`，TTL 一周；`--no-cache` 跳过）。

`--format citation` 直接输出可粘贴进参考文献表的文本（`Authors. Title. Journal. Year;Vol(Issue):Pages. doi:… PMID:…`）。

### `mesh "<term>" [--rows N]`
→ `{ term, results: [{name, mesh_uid, descriptor_ui, ui, tree_numbers[], scope_note}] }`（默认 10 条，精确匹配优先）。

**在 PubMed 里必须用描述符名称检索**，不要用 UI 或数字 id：
```bash
# 1) 查描述符（拿到 descriptor_ui，仅用于核对/走 db=mesh）
pubmed-search mesh "heart failure" --compact
# 2) 用「名称」检索 PubMed（[MeSH] 是 [MeSH Terms] 的别名，只认文本名称）
pubmed-search search '"Heart Failure"[MeSH Terms] AND 2020:2024[dp]' --rows 10
```
`mesh_uid` 是 MeSH 内部数字 UID；`descriptor_ui`（如 `D009203`）是按前缀规则还原的正式 UI，仅在 `db=mesh` 有效，**不能**拼进 `db=pubmed` 检索式。

## 限流 / 错误

- 客户端跨进程自动节流（文件锁 + 时间戳），并对 429/5xx/超时做指数退避重试（优先遵守 `Retry-After`），并行调用不会半批失败。
- `--json-errors`：失败时除 stderr 外，还在 stdout 打印 `{"error": {...}, "exit_code": 1}`，方便管道解析。

## 其他

- 完整选项（`--email`/`--api-key`/`--max-rows`/`--no-email-check`/`--json-errors` 等）：`--help`
- 限流、错误处理细节、批量检索策略、开发验证：按需读 `references/agent-guide.md`
