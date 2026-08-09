# Agent Guide — building an HN briefing

This is the detailed workflow the agent follows when generating a briefing.
Load it (or follow SKILL.md) whenever the user asks for an HN summary.

## 1. Fetch the data

```bash
hn-briefing top 100          # HN's own front-page order, rank 1 = top
hn-briefing top --by-score 100   # sorted by points descending
```

Each entry looks like:

```json
{
  "rank": 1,
  "id": 49228663,
  "title": "…",
  "score": 271,
  "descendants": 55,
  "url": "https://…",
  "by": "…",
  "time": 1754500000,
  "type": "story"
}
```

- `rank` — position on the HN front page (1 = top).
- `score` — upvotes/points.
- `descendants` — number of comments.

## 2. Pick the headline of the day

Default: `rank === 1`. Cross-check with `descendants` (a lively comment section
often means a more thought-provoking piece than raw points alone).

## 3. Extract the article body

```bash
hn-briefing content "<url>"
```

Returns `{ url, title, text, truncated }` where `text` is cleaned plain text
(scripts/styles/tags stripped, entities decoded, whitespace collapsed, capped at
20k chars). Read it to write a substantive summary.

**When extraction fails** (paywall, JS-rendered, bot-blocked sites like
Bloomberg / Twitter / The Guardian / arstechnica): fall back to the title plus
general knowledge and the comment count. Never fabricate article content. Optionally
note "正文未能抓取" in the briefing.

## 4. Cluster into 2–3 threads

Skim all 100 titles. Group high-scoring stories by shared theme. Examples from a
real day:
- AI 军备竞赛与权力洗牌 (DeepSeek V4, AMD 收购, OpenAI 攻防, Oracle 禁 AI 代码)
- 职业倦怠与"编程意义"自省 ("Why is everyone in tech so sad", "Code was never the hard part")
- 硬件/内存被 AI 数据中心吸走的资源焦虑 (2027 memory sold out, 数据中心污染)

The threads should genuinely cover most top posts, not be forced.

## 5. Write the briefing

Follow SKILL.md's fixed three-part template, in Chinese, in the sample's tone —
restrained, judgmental, connecting surface questions to deeper structural ones.