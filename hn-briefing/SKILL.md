---
name: hn-briefing
description: >
  Fetch the current Hacker News front page and produce a daily HN briefing in a
  fixed Chinese three-part format (整体趋势 / 最值得点开的一条 / 头条详情). Fetches top
  stories via the HN Firebase API, extracts readable article text for any story,
  clusters high-scoring posts into 2-3 thematic threads, and writes the briefing.
  Use whenever the user asks to "summarize Hacker News", "HN 前100条简报", "今日 HN
  趋势", or similar.
---

# Hacker News Briefing

## What it does

Pulls the current Hacker News front page (default top 100 stories) and turns it
into a concise Chinese briefing with a fixed three-part structure. The CLI
fetches story metadata (title / points / comments / url) and can extract readable
article text for any story so the headline of the day can be summarized with
substance instead of just restating its title.

## Invocation

唯一入口：`<skill-dir>/bin/hn-briefing`（bash wrapper，直接运行 `node cli.ts`，
可在任何目录直接调用，无需构建）。

```bash
hn-briefing top 100                 # 前 100 条主打首页帖（HN 自身排序）
hn-briefing top --by-score 100      # 同样 100 条，但按 points 降序
hn-briefing item <id>               # 按 id 取单条帖子
hn-briefing content <url>           # 抓取 URL 并提取可读正文（供摘要）
```

所有命令都向 stdout 打印 JSON。

## 工作流（生成简报）

1. **取数据**：
   ```bash
   hn-briefing top 100
   ```
   拿到结构数组，每条含 `rank / title / score / descendants / url / by / time`。
   若想按热度排序再加 `--by-score`。

2. **挑头条**：默认取 `rank == 1`（HN 排名第一）作为"今日最值得点开的一条"。
   也可以结合阅读口碑（`descendants` 评论数）判断。

3. **抓头条正文**：取头条的 `url`，抓正文以便写出有实质内容的摘要：
   ```bash
   hn-briefing content "<top_story_url>"
   ```
   返回 `{ url, title, text, truncated }`。`text` 是清洗后的纯文本（已去掉
   script/style/标签、解码实体、压缩空白），用于理解文章主旨。

4. **聚类主线**：通读前 100 条的标题，把高分帖归纳成 **2-3 条当天主线**（例如
   "AI 军备竞赛与权力洗牌"、"职业倦怠与编程意义自省"、"硬件/内存被 AI 数据中心
   吸走的资源焦虑"）。主线要能概括多数高分帖的共同主题，不是硬凑。

5. **写简报**：严格按下面的三段式输出（中文），保持示例的语气——克制、有判断、
   把表层问题连到更深的结构性问题上。

## 简报模板

```
今日整体趋势：今天HN有三条主线——<主线一>；<主线二>；<主线三>。

今日最值得点开的一条：<头条标题>——它把"<表层问题>"，连到了"<更深的问题>"。

<头条标题> — <points> points / <comments> comments

<对头条的实质摘要：两三句讲清文章核心论点、作者的关键论证、以及它为什么值得读。
不要复述标题，要概括正文内容。>
```

可选（保持简报简洁则删掉）：在末尾附上其他高分帖的 1-2 行列表。

## 注意事项

- **用实时数据，不套用旧模板**：头条每天都会变。先 `hn-briefing top 100` 拿当前
  数据，再写摘要，不要照抄上一次的 headline。
- **正文抓取可能失败**：付费墙、JS 渲染、反爬的站点（如 Bloomberg、Twitter、
  The Guardian 等）正文可能抓不到或为空。此时退回用标题 + 常识 + 评论数来写，
  不要编造内容；并可在简报里注明"正文未能抓取"。
- **点数/评论数**：只在简报中标注 `points` 和 `descendants`（comments），不要
  编造其他数字。
- **CLI 输出是 JSON**：用 `node -e` 或 python 解析即可，脚本本身不依赖任何
  npm 包（`fetch` 为 Node ≥ 22 内置）。

## 参考

- 工作流细节见 [references/agent-guide.md](references/agent-guide.md)。
- 使用示例见 [references/examples.md](references/examples.md)。