# Examples

Real output produced with this skill (from the day the CLI was built). Use as a
quality bar for tone and structure.

---

今日整体趋势：今天HN有三条主线——AI正在怎样改写资源与权力边界；官僚系统如何消耗人；以及老HN味道的技术自主权焦虑。

今日最值得点开的一条：Hold on to Your Hardware——它把"硬件会不会涨价"这个表层问题，连到了"个人是否还能掌控自己的计算环境"这个更深的问题。

Hold on to Your Hardware — 554 points / 453 comments

作者认为消费者硬件的"黄金时代"正在结束，不是周期性涨价，而是内存、SSD、GPU的产能正被AI数据中心永久性地重新分配。核心问题不是"硬件会不会贵"，而是算力和控制权正在一起向数据中心集中，个人掌控自己计算环境的能力也在同步流失。

---

## Walkthrough

To reproduce a briefing end-to-end:

```bash
# 1. Get the top 100
hn-briefing top 100

# 2. Find the headline (rank 1), grab its url
hn-briefing item <id>          # or read url from the top output

# 3. Extract its body
hn-briefing content "<url>"

# 4. Cluster threads, then write the briefing per SKILL.md template
```

## CLI output examples

```bash
$ hn-briefing top 3
[
  {
    "rank": 1,
    "id": 49228663,
    "title": "Microsoft Word for Windows 1.1a, Native X64 Port",
    "score": 271,
    "descendants": 55,
    "url": "https://github.com/jmarshall23/msword"
  },
  ...
]

$ hn-briefing content https://example.com
{ "url": "https://example.com", "title": "Example Domain", "text": "Example Domain ...", "truncated": false }
```