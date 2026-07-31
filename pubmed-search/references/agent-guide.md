# Agent guide（按需阅读）

非核心内容，仅在出错、限流、需要批量策略或开发时读取。

## 错误处理

- **Exit 0** → stdout 有结果 JSON，直接用。
- **Exit 1** → 运行时/数据错误在 stderr：缺配置、HTTP/超时、NCBI `<Error>` payload（如限流）、无效或不存在 PMID。将 stderr 消息原样呈现给用户。
- **Exit 2** → 用法错误（命令/flag 不对）；stderr 显示 usage。

## 限流与批量策略

- 无 API key 时 NCBI 约 3 req/s（有 key 时 10 req/s）；客户端自动节流。
- 长流程优先一次 `search` 用较大 `--rows`，少用多次小调用；`get-by-pmid` 只能逐条。
- 遇 NCBI 限流错误：等几秒重试。

## Workflow 示例

文献检索 + 精读：

```bash
CLI=<skill-dir>/bin/pubmed-search
$CLI search "cardiac arrest AND 2020:2024[dp]" --rows 10 --sort date
$CLI get-by-pmid 36257926
```

MeSH 策略构建：

```bash
$CLI mesh "heart failure"
$CLI search '"D057174"[Mesh] AND randomized controlled trial[pt]'
```

## 行为说明（与 Python 原版的差异）

1. **零依赖** — 用内置 `fetch` + 最小 XML 解析器（原版用 requests + xml.etree）。
2. **`lookupMesh` 用 `esummary` 而非 `efetch`** — MeSH 库无 XML efetch（返回纯文本），原版 Python 代码会对今天的线上 API 崩溃；取首个 `DS_MeshTerms` 作描述符名。
3. **`raiseEutilsError`** — 把 NCBI `<Error>` payload（如 API-key 限流消息）作为错误暴露，而非静默返回空结果。
4. **标题/摘要用 `textContent`** — 保留 `ArticleTitle`/`AbstractText` 内联标记（如 `<i>`），不截断。

## 开发验证

修改代码后运行：

```bash
bash <skill-dir>/scripts/smoke-test.sh   # 或 npm run smoke：三子命令 + 两个错误路径，连真实 API
npx tsc --noEmit                          # 严格类型检查
```
