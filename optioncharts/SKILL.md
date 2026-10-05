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

stdout 输出 JSON（默认 pretty；`--compact` 是 `--format compact` 的别名、单行；`--format csv` 表格）。
`--provenance minimal` 只留 `fetched_at`/`status`/`warnings` 并丢掉长说明串，`--no-provenance` 整个删掉，`--format csv --units` 追加 `unit_<列>` 列而不改列名。
退出码：`0` 成功 · `1` 运行错误 · `2` 用法错误 · `3` 无该标的/无数据 ·
`4` 限流(429) · `5` **服务端静默换了到期日**（默认即报错）。

## 命令

| 命令 | 返回 |
| --- | --- |
| `spot TICKER` | 实时现价、涨跌幅、`As of` 时间（另给机器可读 `as_of_iso`）、市场状态、期权延迟说明；支持 `--format csv` |
| `info TICKER` | 股息率、均量、今日高低/开盘、成交量、52 周高低 |
| `expiries TICKER` | 全部到期日：`2026-10-09:w` / `:m`、星期、DTE、label |
| `scan TICKER...` | **周度扫描**：每个到期日一行（量/PCR/OI/PCR/IV/预期波动/max pain/DTE），`--gex` 再加墙位、敞口与 ±1EM 归一化字段（`sign_flips[]` 标出相邻到期日 gamma 变号） |
| `stats TICKER...` | 全部到期日的链统计表（一次请求拿全） |
| `gex TICKER` / `dex TICKER` | 逐行权价 gamma/delta 敞口 + `call_wall` / `put_wall` + 净敞口（`--normalize sigma` 时附 `sigma_pos` 与 ±1EM 份额） |
| `oi` / `volume` / `skew TICKER` | 逐行权价 open interest / 成交量 / 隐含波动率（每行带统一 `metric`+`value`） |
| `greeks TICKER` | 逐行权价 delta/gamma/theta/vega/rho + IV（`--greek` 过滤） |
| `max-pain TICKER` | 一次请求返回**所有**到期日的 max pain |
| `em TICKER` | expected-move 锥形（近端 N 个点，`--limit`）；每点带 `et_date`（美东交易日） |
| `chain TICKER` | 期权链表格（call/put，bid/ask/volume/OI/IV/delta；`--columns` 为本地投影，identity 列自动补） |
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
> `--dte N` 是「**≤ N 天**」的上限，不是「正好 N 天」（`--dte 4` 会拿到 0–4 DTE 的全部到期日）。
> 只想钉住某一个到期日：`scan SPY --exp 2026-10-09:w`——只返回 1 行、只花 1 次请求，比 `--dte` 再过滤更省也不会误读。
> `--top N` 按 `|net_exposure|` **降序**取前 N。GEX 分析的目的是找 best/worst gamma 节点，而「最大 |net|」≠「最有意义的墙」：
> 要看完整墙位 / 翻转点就别加 `--top`，先看 `exposure_by_strike_count` 判断是否被截断，再决定要不要截。

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

## 两套 expected move：别混用

同一个到期日会出现**两个不同的 EM**，数值可差 ~16%，全因口径不同：

| | 来源 | 含义 | 何时用 |
| --- | --- | --- | --- |
| **per-expiry EM** | `scan` / `stats` 的 `expected_move_abs` / `expected_move_pct` | 该到期日自己的 straddle 隐含波动 | 单到期日区间 / σ 归一化——**一律用这个** |
| **cone EM** | `em` 的 `em_amt` / `em_pct` | spot-anchored、按日 √t 递推的曲线 | 只看时间维度上的扩张，不要当某个到期日的 EM |

- **cone 的日期坑**：`em` 每个点的 `t` 是**美东收盘时刻**（约 23:59:59 ET），它的 UTC 日期必然比它代表的交易日**晚一天**：
  读 `2026-10-06T03:59:59Z` 那一行拿到的是 **10-05** 的锥体值。所以一律读新增的 `et_date` / `et_time`，
  **不要**按 `iso` 的日期读；CSV 也已把 `et_date` 放在 `iso` 前面。
- **自检**：cone 中 `et_date` 等于某到期日的那一行，其 `em_amt`/`em_pct` 应与 `scan`/`stats` 同到期日的
  `expected_move_abs`/`expected_move_pct` 相等（这就是「两者在到期日当天相等」）。`em` 的 `cone_vs_per_expiry_note` 也写明了。
- `em` 是**实时重算**的 spot-anchored 量：`as_of` 只表示本地抓取时刻（服务端不给快照戳），同一行几分钟内会变；引用时带 `as_of`。

## 跨标的比较必须归一化

`net_exposure` / `call_exposure` / `put_exposure` 是**每 1% 标的变动的美元 gamma/delta**，量级随每个标的的合约名义额线性变化
（实测 TLT ≈ `$7.7k`/张，SPY/QQQ ≈ `$75k`/张）——**绝对数值跨标的比大小会系统性低估 TLT**。

- `gex` / `dex` 每行**总是**带 `share_of_abs_total_pct = net_exposure / Σ|net_exposure| × 100`（免费、无需额外请求）——用它在**桶内**定位墙位。
- `--normalize sigma` 再给出 `sigma_pos = (strike − spot) / expected_move_abs`（`spot` 取实时、`expected_move_abs` 取该到期日 per-expiry EM；
  额外 +2 次请求，取不到时降级为 warning、`sigma_pos` 为 `null`）。
- 组合多标的的正确做法：按 `sigma_pos` 对齐行权价，或比较「±1EM 内净 GEX 占全链比例」——`scan --gex` 每行已直接给出 `net_exposure_within_1em` / `net_exposure_within_1em_share_pct` / `abs_share_within_1em_pct` / `strikes_within_1em` / `strikes_total`（需 spot + per-expiry EM，故 `scan --gex` 会多取一次 spot）；`gex` 在 `--normalize sigma` 时同样给出。**不要**直接比较 `net_exposure` 数字。

## 多到期日 × 逐行权价

- `oi` / `volume` / `skew` **支持一次请求多个到期日**：`--exp 2026-10-09:w,2026-10-16:m`（每行带自己的 `expiration`）。要「每个行权价 × 每个到期日」的 OI / 成交量矩阵，这是首选。
- `gex` / `dex` 在免费层对多到期日会**塌缩**：`gex_by_strike` 是多个到期日的**求和**，`exposure_by_expiration` 只有 1 行。
  要逐到期日的 GEX，只能每个到期日各发一次请求（`for d in ...; do optioncharts gex TICKER --exp $d:w; done`），并比较各自的 `exposure_as_of`。
- 一次性 `ladder` / `matrix` 命令暂未提供，按上面的配方组合。

## 输出约定

- 每个数据命令统一信封：`{ source, generated_at, command, tickers: [ { ticker, ... , provenance } ] }`；
  多个标的时某个失败不会中断整轮，失败项进 `failures`，退出码取最严重的那个。
- `provenance` 里有 `endpoint` / `url` / `status` / `fetched_at` / `latency_ms` /
  `from_cache` / `requests_this_run` / `warnings` —— **报表时先看 warnings**。
- `--format csv` 会带 `ticker` 列，适合多标的横向比较；但 CSV 会丢掉 warnings。
  担心列名被误记（例如第 14 列 `net_exposure` 是 `usd_per_1pct_move` 而非美元名义额），加 `--units`
  让每个带单位的列尾随一个 `unit_<列名>` 列（如 `unit_net_exposure`）——原列名保持不变，同一 reader 可解析加不加 `--units` 的两种输出；需要严格口径时直接用 JSON（默认）。
  其它 CSV 陷阱：`em` 的日期列是 `et_date`（不是裸 `iso`）；每行的 GEX 快照时刻看 `gex_as_of` / `exposure_as_of`。
- 行权价相关的量纲：GEX/DEX 的 `net_exposure` / `call_exposure` 等是
  **每 1% 标的变动的美元 gamma/delta**（`unit: usd_per_1pct_move`），
  **不是**名义敞口、也不要加 `$` 前缀当美元. `stats` 的 `iv_pct` 是百分数，
  `skew` 同时给 `implied_volatility`（小数）与 `iv_pct`。
- `stats` / `chain` 的 `--columns` 是**本地投影**：CLI 一定把 identity 列（`stats` 的 `expiration`、`chain` 的 `strike`）放在请求首位并按表头文本回填，取列子集不会再整体错位/丢行（OC-02/03）；未知列名直接 exit 2。
- 列名只有一套：`--columns` 里 `iv`→`iv_pct`、`expected_move`→`expected_move_abs`/`expected_move_pct`，CSV 表头也用规范名（与 `stats.rows[].iv_pct` 一致）；`oi`/`volume`/`skew` 每行额外给 `metric`+`value`。
- `stats` 的每一行是一张表；付费列（`gex`/`dex`）在免费层是锁图标 → 值为 `null` 且列名进 `locked_columns`，绝不编造。列出的到期日若 `oi_total=0`，会告警 `expiry listed but no open interest yet`。
- `gamma_zero_level`（Gamma Flip）**免费层恒为 `null`**（服务端未计算）；
  `vanna`/`charm`/`vomma` 同理不可用。历史序列类端点付费（`/async/*.csv` 直接 401）。

## 结论口径

- 期权数据是 **15 分钟延迟**（OPRA）；`spot` 是实时（Polygon.io）。
  不适合做盘中执行级信号，适合盘后/次日布局分析。
- `call_wall` / `put_wall` 来自内联 JSON，是**真值**（站点 UI 上却显示 🔒）。
- **同一指标只取单一来源**：`scan --gex` 的头条 GEX 与 `gex` 的逐行表是两次独立采样
  （只有命中同一份 60s cache 时才一致）。跨命令混引前先比 `gex_as_of` / `exposure_as_of`，
  不一致就重取，**别把两个时刻的数字放进同一张表**。
- GEX/DEX 是 spot-anchored 的实时量，`exposure_as_of` 是唯一可比的快照时间；
  服务端不提供 OPRA 快照时间（只有抓取时间 `provenance.fetched_at`），期权链本身仍为 15 分钟延迟。
- 跨标的比净敞口前**必须**先归一化（见上文「跨标的比较必须归一化」），否则会系统性低估名义额小的标的。
- max pain 的 `max_pain_diff_pct` 是相对**当前 spot** 的百分比。
- 上游是第三方聚合站，非交易所原始数据；条款（批量抓取/再分发）自行确认。

## 请求预算（TTFB ~2s，实测无限流）

| 场景 | 请求数 |
| --- | --- |
| `scan TICKER --dte 7 --weekly-only` | 1 / 标的 |
| `scan TICKER --dte 7 --gex` | 2 + 到期日数（多 1 次 spot 取 ±1EM 基准） |
| `stats TLT SPY QQQ` | 3 |
| `gex TICKER --exp DATE:w` | 1（带后缀） |
| `gex TICKER --exp DATE`（裸日期） | 2（多一次到期日解析） |
| `gex TICKER --exp DATE:w --normalize sigma` | 3（gex + spot + stats 取 EM） |

片段有 60 秒本地缓存（`~/.cache/optioncharts`，`--no-cache` 绕过），
同一分钟内的重复调用不计请求。

## 细节（按需读）

- 全部 flag、输出字段、退出码、配方：`references/usage.md`
- `/async/*` 端点契约、参数、免费/付费边界、反爬与踩坑：`references/api.md`
- 真实输出样例（JSON + CSV）：`references/examples.md`

开发验证：`npm test`（48 个离线夹具用例）、`npm run typecheck`、`npm run smoke`（联网，38 项）。
