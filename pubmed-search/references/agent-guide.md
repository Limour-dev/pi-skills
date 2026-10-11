# Agent guide（按需阅读）

非核心内容，仅在出错、限流、需要批量策略或开发时读取。

## 错误处理

- **Exit 0** → stdout 有结果 JSON，直接用。
  - `search` 的 **0 命中也是 exit 0**：`{"total": 0, "results": [], "warnings": [...], "query_translation": "..."}`。不要重试，也不要当成工具故障。
- **Exit 1** → 运行时/数据错误在 stderr：缺配置、HTTP/超时（重试耗尽后）、无效或不存在 PMID。将 stderr 消息原样呈现给用户。
- **Exit 2** → 用法错误（命令/flag 不对）；stderr（或 `--json-errors` 时的 stdout）显示原因。
- **不要丢弃 stderr**：`2>/dev/null` 会把真正的失败原因一起丢掉。管道里 `cmd | head` 的退出码是 `head` 的，需要判断成功与否时看 `PIPESTATUS[0]`，或改用 `--json-errors` 让 stdout 也带错误。
- `--json-errors`：任何失败都会在 stdout 输出 `{"error": {"source"?, "message"}, "exit_code": N}`。

## 限流与批量策略

- 无 API key 时 NCBI 约 3 req/s（有 key 时 10 req/s）；客户端**跨进程**自动节流（lock 文件 + 共享时间戳），并把 429 / 5xx / 超时做指数退避重试（0.5s→1s→2s，优先遵守 `Retry-After`）。看到 `level: "warning"` 的 retry 日志属正常，最终成功即 exit 0。
- 并行发多个 CLI 调用现在是安全的：节流对同一台机器的所有进程生效。
- 省请求的手段：
  - `search --ids-only`（只 esearch，1 次请求，回 `pmids[]`）
  - `search --count-only` / `--explain`（只 esearch，1 次请求）
  - `get-by-pmid 1,2,3,...`（一次 efetch 取多篇，带一周本地缓存）
  - 长流程优先一次 `search` 用较大 `--rows`（上限 `--max-rows`，默认 50），少用多次小调用
  - 需要翻页时用 `--offset`
- 若客户端重试后仍失败：把 stderr 的 HTTP 状态/消息呈现给用户，不要盲目重跑整批。

## Workflow 示例

文献检索 + 精读：

```bash
CLI=<skill-dir>/bin/pubmed-search
$CLI search "cardiac arrest AND 2020:2024[dp]" --rows 10 --sort date
$CLI get-by-pmid 36257926
```

先探命中规模，再决定是否拉详情：

```bash
$CLI search "red cell distribution width AND myocardial infarction" --count-only
$CLI search "red cell distribution width AND myocardial infarction" --ids-only --rows 50
```

批量补著录并生成参考文献：

```bash
$CLI get-by-pmid 22828611,25271081,28344011 --format citation
```

MeSH 策略构建（用**名称**，不是 UI）：

```bash
$CLI mesh "heart failure"
$CLI search '"Heart Failure"[MeSH Terms] AND randomized controlled trial[pt]' --rows 10
```

诊断一个 0 命中：

```bash
$CLI search '"some phrase"[Title]' --explain
# warnings: QuotedPhraseNotFound → 短语不存在；query_translation → NCBI 实际执行的检索式
```

## 行为说明（与 Python 原版的差异）

1. **零依赖** — 用内置 `fetch` + 最小 XML 解析器（原版用 requests + xml.etree）。
2. **`lookupMesh` 用 `esummary` 而非 `efetch`** — MeSH 库无 XML efetch（返回纯文本），原版 Python 代码会对今天的线上 API 崩溃；取首个 `DS_MeshTerms` 作描述符名，并还原 `descriptor_ui`。
3. **0 命中不再走 efetch** — 0 命中时 esearch 仍返回合法的 WebEnv/QueryKey，原版会继续 efetch 空历史集并抛出误导性的 `Empty result - nothing to do`；现在按 `Count`/`IdList` 提前返回成功结果。
4. **`raiseEutilsError`** — 把真正的 NCBI `<Error>` payload（如 API-key 限流消息）作为错误暴露，而非静默返回空结果。
5. **标题/摘要用 `textContent`** — 保留 `ArticleTitle`/`AbstractText` 内联标记（如 `<i>`），不截断。
6. **跨进程限流 + 重试** — 见上；节流锁和 PMID 缓存位于 `~/.cache/pubmed-search/`（可用 `PUBMED_CACHE_DIR` 覆盖）。

## 开发验证

修改代码后运行：

```bash
bash <skill-dir>/scripts/smoke-test.sh   # 或 npm run smoke：三子命令 + 0 命中 + 轻量模式 + 批量/引用格式 + 错误路径，连真实 API
npx tsc --noEmit                          # 严格类型检查
```
