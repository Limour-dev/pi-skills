---
name: optioncharts
description: >-
  Weekly and multi-expiry US options data from optioncharts.io (free tier, no API
  key) via a zero-dependency pure-TypeScript CLI: per-expiry chain statistics
  (volume, put/call ratios, open interest, IV, expected move, max pain, DTE),
  gamma & delta exposure by strike (GEX/DEX), call & put walls, open interest /
  volume / IV skew per strike, greeks, the expected-move cone and real-time spot.
  `scan` returns one compact row per expiry per ticker for TLT / SPY / QQQ and
  ~2300 other symbols. Use for 周度期权数据、期权链、到期日筛选、open interest、
  成交量 / PCR、GEX / DEX、call wall / put wall、max pain、expected move、IV skew、
  greeks, or questions like "这周期权怎么布局" / "哪个到期日" / "钱都在哪个行权价".
---

# optioncharts (read-only)

唯一入口：`<skill-dir>/bin/optioncharts`（bash wrapper，任何目录可直接调用）。
零依赖、无需 API key、无需浏览器。**只读**：不涉及下单。

```bash
optioncharts <command> <TICKER> [TICKER...] [flags]
```

stdout 输出 JSON（默认 pretty；`--compact` 单行；`--format csv` 表格）。
退出码：`0` 成功 · `1` 运行错误 · `2` 用法错误 · `3` 无该标的/无数据 ·
`4` 限流(429) · `5` **服务端静默换了到期日**（默认即报错）。

## 命令

| 命令 | 返回 |
| --- | --- |
| `spot TICKER` | 实时现价、涨跌幅、`As of` 时间、市场状态、期权延迟说明 |
| `info TICKER` | 股息率、均量、今日高低/开盘、成交量、52 周高低 |
| `expiries TICKER` | 全部到期日：`2026-10-09:w` / `:m`、星期、DTE、label |
| `scan TICKER...` | **周度扫描**：每个到期日一行（量/PCR/OI/PCR/IV/预期波动/max pain/DTE），`--gex` 再加墙位与敞口 |
| `stats TICKER...` | 全部到期日的链统计表（一次请求拿全） |
| `gex TICKER` / `dex TICKER` | 逐行权价 gamma/delta 敞口 + `call_wall` / `put_wall` + 净敞口 |
| `oi` / `volume` / `skew TICKER` | 逐行权价 open interest / 成交量 / 隐含波动率 |
| `greeks TICKER` | 逐行权价 delta/gamma/theta/vega/rho + IV（`--greek` 过滤） |
| `max-pain TICKER` | 一次请求返回**所有**到期日的 max pain |
| `em TICKER` | expected-move 锥形（近端 N 个点，`--limit`） |
| `chain TICKER` | 期权链表格（call/put，bid/ask/volume/OI/IV/delta） |
| `probe` | 各片段可达性与延迟（排查网络/改版） |
| `raw TICKER --endpoint NAME` | 打印片段内联 JSON（`--html` 打印原始片段） |

## 最常用三条

```bash
# 1) 周度仪表盘：TLT/SPY/QQQ 这周每个到期日一行（3 次请求）
optioncharts scan TLT SPY QQQ --dte 7 --weekly-only --format csv

# 2) 加上墙位/敞口（每个到期日 +1 次请求）
optioncharts scan SPY --dte 14 --gex --format csv

# 3) 单到期日的逐行权价结构
optioncharts gex TLT --exp 2026-10-09:w --top 20 --format csv
optioncharts oi  TLT --exp 2026-10-09:w --format csv
```

## 到期日（`--exp`）必须带 `:w` / `:m`

这是本数据源最坑的地方：`expiration_dates=2026-10-09`（不带后缀）**不报错**，
而是静默返回另一个到期日的数据。

- 写完整后缀最省请求：`--exp 2026-10-09:w`（不发解析请求），可重复也可逗号分隔
  （`--exp 2026-10-09:w,2026-10-16:m`）。
- 只写日期（`--exp 2026-10-09`）时 CLI 会去到期日列表解析后缀，并在
  `provenance.warnings` 记录 `suffix added`；列表里没有的日期按「第三个周五 = `:m`，
  其余 `:w`」推断。
- 发送后 CLI 会用 payload 里的到期日**反查**服务端到底回了哪个：
  不一致 → **默认 exit 5**（`--strict-exp` 是默认行为）；
  加 `--allow-exp-fallback` 降级为 warning 并继续输出数据。
  `payload.returned_expiries` / `scan` 行的 `gex_expiry` 告诉你真实到期日，
  该行同时标记 `expiry_fallback: true`（CSV 也有这一列）——**别把这些数字当请求到期日的数字用**。
- 免费层到期日复选框列表只有 ~30 条；`stats` 的表格更全（能看到 10-19 这类
  只有统计表才有的到期日）。这些「统计表有、图表端点没有」的到期日正是
  静默回落高发区，所以默认报错而不是静默给错数据。
- 请求了多个到期日、而 payload 里没有某个到期日时，会额外告警 `the payload has no rows for …`：
  把它当**缺失**，不要当 0。（GEX/DEX 的按到期日汇总在免费层必塌缩成 1 行，那种情况由
  多到期日告警单独说明，不会重复刷屏。）

## 输出约定

- 每个数据命令统一信封：`{ source, generated_at, command, tickers: [ { ticker, ... , provenance } ] }`；
  多个标的时某个失败不会中断整轮，失败项进 `failures`，退出码取最严重的那个。
- `provenance` 里有 `endpoint` / `url` / `status` / `fetched_at` / `latency_ms` /
  `from_cache` / `requests_this_run` / `warnings` —— **报表时先看 warnings**。
- `--format csv` 会带 `ticker` 列，适合多标的横向比较；但 CSV 丢掉了单位与 warnings，
  需要严格口径时用 JSON（默认）。
- 行权价相关的量纲：GEX/DEX 的 `net_exposure` / `call_exposure` 等是
  **每 1% 标的变动的美元 gamma/delta**（`unit: usd_per_1pct_move`），
  **不是**名义敞口、也不要加 `$` 前缀当美元. `stats` 的 `iv_pct` 是百分数，
  `skew` 同时给 `implied_volatility`（小数）与 `iv_pct`。
- `stats` 的每一行是一张表的位置映射：`expiration` 从 `<a href>` 里解析，
  付费列（`gex`/`dex`）在免费层是锁图标 → 值为 `null` 且列名进 `locked_columns`，
  绝不编造。
- `gamma_zero_level`（Gamma Flip）**免费层恒为 `null`**（服务端未计算）；
  `vanna`/`charm`/`vomma` 同理不可用。历史序列类端点付费（`/async/*.csv` 直接 401）。

## 结论口径

- 期权数据是 **15 分钟延迟**（OPRA）；`spot` 是实时（Polygon.io）。
  不适合做盘中执行级信号，适合盘后/次日布局分析。
- `call_wall` / `put_wall` 来自内联 JSON，是**真值**（站点 UI 上却显示 🔒）。
- max pain 的 `max_pain_diff_pct` 是相对**当前 spot** 的百分比。
- 上游是第三方聚合站，非交易所原始数据；条款（批量抓取/再分发）自行确认。

## 请求预算（TTFB ~2s，实测无限流）

| 场景 | 请求数 |
| --- | --- |
| `scan TICKER --dte 7 --weekly-only` | 1 / 标的 |
| `scan TICKER --dte 7 --gex` | 1 + 到期日数 |
| `stats TLT SPY QQQ` | 3 |
| `gex TICKER --exp DATE:w` | 1（带后缀） |
| `gex TICKER --exp DATE`（裸日期） | 2（多一次到期日解析） |

片段有 60 秒本地缓存（`~/.cache/optioncharts`，`--no-cache` 绕过），
同一分钟内的重复调用不计请求。

## 细节（按需读）

- 全部 flag、输出字段、退出码、配方：`references/usage.md`
- `/async/*` 端点契约、参数、免费/付费边界、反爬与踩坑：`references/api.md`
- 真实输出样例（JSON + CSV）：`references/examples.md`

开发验证：`npm test`（44 个离线夹具用例）、`npm run typecheck`、`npm run smoke`（联网，33 项）。
