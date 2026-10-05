---
name: tradingview
description: >-
  Read-only TradingView K线/OHLCV plus the 大道至简 indicator set via
  `tradingview candles` / `tradingview indicators`, built on
  @mathieuc/tradingview v4 with a local SQLite cache. Bare names resolve
  automatically with unit/symbol_kind metadata — USDT.D, US10Y, CNH1!, BTCUSD,
  DXY, VIX, ES1!, AAPL, SOL. Only closed bars are returned; the in-progress bar
  is never fetched. Use for K线/candles/OHLCV/历史行情/指标. Read-only: it never
  places orders or changes account state.
---

# tradingview candles / indicators（只读）

唯一入口：`<skill-dir>/bin/tradingview`（bash wrapper，任何目录可直接调用）。
底层是 `@mathieuc/tradingview` v4，经 TradingView websocket 取数，本地 SQLite
缓存。**只读**：只查询，不下单、不改自选股、不改图表。

```bash
tradingview candles    <SYMBOL> [flags]   # 原始 OHLCV
tradingview indicators <SYMBOL> [flags]   # 大道至简指标（唯一允许的指标集）
tradingview version                       # 版本 + 缓存路径
tradingview help
```

stdout 输出 JSON（默认 pretty，`--format csv|table|md` 可切换）；stderr 输出
解析/警告/note 与错误 JSON。

## ⚠️ 指标白名单（唯一允许的指标集）

`indicators` 只计算下面这一组，且按 TradingView `ta.*` 语义与 Pine 脚本
**大道至简**（© l834159672）逐 bar 对齐：

| 输出字段 | Pine 公式 |
| --- | --- |
| `kc1_mid` / `kc1_upper` / `kc1_lower` | `ta.kc(close, 50, 2.75)` |
| `ema_high` / `ema_low` | `ta.ema(high, 50)` / `ta.ema(low, 50)` |
| `kc2_mid` / `kc2_upper` / `kc2_lower` | `ta.kc(close, 50, 3.75)` |
| `kc_low_mid` / `kc_low_upper` / `kc_low_lower` | `ta.kc(low, 50, 3.75)` |
| `median_200` | `ta.median(hlcc4, 200)`，`hlcc4 = (high+low+2*close)/4` |
| `macd` / `macd_signal` / `macd_hist` | MACD(12, 26, 9)，`hist = 2*(macd - signal)` |

**分析走势时只用这些指标。** 不要另外计算或使用 RSI、ATR、MA20/50/100/200、
布林带、KDJ、OBV 等其它指标；`candles` 只提供价格/成交量，不提供其它指标。
（历史会话记录里曾建议补充 RSI/ATR/MA，本 skill 明确不采用。）

实现位置 `src/indicators.ts`（纯 Node.js，无依赖，可离线单测）。`indicators`
默认多取 300 根 warmup（`--warmup N` 可调）再计算，所以窗口最左边的
`median_200` / EMA 也已是完整值。

## Step 1 · 环境检查

```bash
cd <skill-dir> && npm install      # 首次使用
tradingview version                # 版本 + 缓存路径
tradingview candles BTCUSD --tf 1D --count 5
```

- 提示 `dependencies missing`：先 `npm install`。
- 需要 Node ≥ 22.13（直接运行 TypeScript + 内置 `node:sqlite`）。
- 账号 cookie **可选**，只从环境变量读取（能解锁更长的分钟级历史，日线等不需要）：
  `export TV_SESSION="..."` 和 `export TV_SIGNATURE="..."`。

## Step 2 · 取数与算指标

```bash
tradingview candles BTCUSD --tf 1D --count 30 --format csv
tradingview candles USDT.D --tf 4h --from -30d
tradingview candles TVC:US10Y --tf W --count 52 --select time_iso,close
tradingview indicators BTCUSD --tf 1D --count 30 --select time_iso,macd,macd_hist
tradingview indicators BINANCE:SOLUSDT --tf 4h --from -30d
```

| flag | 默认 | 含义 |
| --- | --- | --- |
| `--tf`, `--timeframe` | `D` | `1 3 5 15 30 45 60 120 180 240`（分钟）、`D W M`；别名 `1m 3m 5m 15m 30m 45m 1h 2h 3h 4h 1d 1w 1mo` |
| `--count N` | 100 | 最近 N 根**已收盘** K 线；给了 `--from` 时忽略 |
| `--from T` / `--to T` | | ISO（`2026-01-31`）、Unix 秒、或 `-7d`/`-12h`/`-30m` |
| `--newest-first` | | 倒序输出 |
| `--warmup N` | 300 | 仅 `indicators`：窗口前多取的 warmup 根数 |
| `--chart-type` | | `HeikinAshi`、`Renko`、`LineBreak`、`Kagi`、`PointAndFigure`、`Range` |
| `--currency` / `--adjustment` | `splits` | 价格换算 / `splits`、`dividends`、`none` |
| `--no-cache` / `--cache PATH` | | 绕过缓存 / 指定缓存库 |
| `--format json\|csv\|table\|md`、`--compact`、`--select a,b,c` | | 输出整形 |
| `--exchange X`、`--type T`、`--strict` | | 标的解析控制（见 Step 5） |

`candles` 输出：`{input, symbol, resolved_from, symbol_kind, unit,
volume_reliable, timeframe, count, coverage, as_of, last_bar_age, stale, cache,
candles}`。`indicators` 输出同信封，再加 `indicator`、`params`、`warmup_bars`、
`series`。每根 K 线是 `{time, time_iso, open, high, low, close, volume}`，
`time` 为 bar 开盘时间 Unix 秒，`time_iso` 为 UTC。

`--select` 的契约：
- csv/table/md 的**表头只含所选字段**，不会出现空列；
- json 顶层**仍是对象**（`symbol`/`coverage`/`cache`/`warnings` 都在），只是
  `candles[]` / `series[]` 的元素收窄为所选字段；
- 未知字段名 → stderr 警告并忽略；全部未知或加了 `--strict` → exit 2。

## Step 3 · 只取已收盘的 K 线

正在生成的那根永远不请求、不返回、不缓存。判定规则与交易所时区无关：

```
一根 K 线已收盘  <=>  time + K线长度 <= now        （月线 = 下一个月初）
```

日线在交易所收盘后要等满 24 小时才出现（保守，宁可晚一点也不返回未走完的
K 线）。`as_of` 是本次生成的 UTC 时刻，`last_bar_age` 是最后一根 bar 距离
`as_of` 的秒数，`stale` 在超过 2 个 bar 长度时为 `true` —— 用它区分「保守」
与「缓存陈旧」。

## Step 4 · SQLite 缓存

每次请求都走缓存：

1. 从 SQLite 读出 `[from, to]` 已缓存的 K 线；
2. 算出缺的**前面**（比缓存起点更早的历史）和**后面**（比缓存终点更新的新 K 线），
   只联网补这些片段；
3. 把取到的已收盘 K 线写回（`INSERT … ON CONFLICT DO UPDATE`）。

冷启动一次取整段，之后只补新尾巴；请求更长历史时才补前段。增量刷新失败但缓存里
有可用数据时，仍返回缓存内容并在 `warnings` 里说明。

缓存位置：`$TV_CACHE_DB` → `$XDG_CACHE_HOME/tradingview/candles.sqlite`
→ `~/.cache/tradingview/candles.sqlite`；`--cache PATH` 单次覆盖，`--no-cache`
完全绕过。按 `(symbol, timeframe, 图表选项, session)` 分行存储，不同配置不会串。

## Step 5 · 标的解析

TradingView 的标的一定是 `EXCHANGE:SYMBOL`。裸名按顺序解析：显式（含 `:`）→
`--exchange`（在该交易所内搜索，命中就用；否则回退成 `X:SYMBOL`）→ 内置别名 →
TradingView 自动补全。输出里的 `resolved_from` 标明来源
（`explicit`/`alias`/`search`）。

`--exchange X` 是**候选过滤器**，不是硬拼 `X:SYMBOL`：`--exchange BINANCE SOL`
会解析成 `BINANCE:SOLUSDT`，而不是报 `invalid symbol`。`--strict` 关闭搜索兜底。

常用别名（完整表见 `references/symbols.md`）：

| 裸名 | 解析为 | 含义 |
| --- | --- | --- |
| `USDT.D` / `BTC.D` | `CRYPTOCAP:USDT.D` … | 市占率，**百分比** |
| `TOTAL` / `TOTAL2` | `CRYPTOCAP:TOTAL…` | 加密总市值（美元） |
| `US10Y` / `US2Y` | `TVC:US10Y` … | 美债收益率，**百分比** |
| `DXY` / `VIX` / `GOLD` / `WTI` | `TVC:…` | 美元指数 / 波动率 / 金 / 油 |
| `CNH1!` | `CME:CNH1!` | 离岸人民币期货（连续） |
| `BTCUSD` / `BTCUSDT` | `BITSTAMP:BTCUSD` / `BINANCE:BTCUSDT` | 比特币现货 |
| `SOL` / `DOGE` / `LINK` … | `BINANCE:<TICKER>USDT` | 主流币现货（避免落到 `CRYPTOCAP:*` 或同名股票） |
| `ES1!` / `NQ1!` / `CL1!` / `GC1!` | `CME_MINI:…` 等 | 连续期货前月 |

拿不准就写显式 `EXCHANGE:SYMBOL`（例如 `BINANCE:SOLUSDT`）；没有独立的搜索命令。

## Step 6 · 读数与讲解

1. **先读 `unit`，不要猜**：
   - `percent` — `CRYPTOCAP:*D`（市占率）、`TVC:USxxY`（收益率）；
   - `usd` — `CRYPTOCAP:TOTAL*` 与 `CRYPTOCAP:<币种>`（**总市值美元**，量级可达
     10^10，不是币价）；
   - `price` — 其它交易所报价；只在同一 symbol 的历史内比较，别跨 symbol 比大小。
2. **看 `symbol_kind` 与 `resolved_from`**：`crypto_marketcap`、`index` /
   `resolved_from: search` 命中指数类时，stderr 会给出 `note:` 明确提示「这是市值
   指数不是价格序列」；要价格请写 `EXCHANGE:SYMBOL`。
3. **看 `volume_reliable`**：指数/合成序列为 `false`，此时 `volume` 一律为
   `null`——不要用指数序列的量能做推断。`TVC:USxxY` 的 `1e+100` 哨兵同样按缺失。
4. **看 `stale` / `warnings`**：`stale: true` 或存在 `warnings` 时如实说明数据
   新鲜度/降级。
5. **匿名限制**：分钟级历史较短，过去的 `--from` 可能被截断；如实说明，不要编数。

## 退出码

| code | 含义 | 典型 `code` |
| --- | --- | --- |
| 0 | 成功 | — |
| 1 | 其他运行错误 | `CRITICAL_ERROR` |
| 2 | 用法错误（含未知 flag / `--select` 字段、`--tf` 不支持） | `USAGE` / `INVALID_ARGUMENT` |
| 3 | 标的找不到 / 该区间无已收盘 K 线 | `SYMBOL_ERROR` / `NO_DATA` |
| 4 | 权限 / 分辨率不可用（如匿名下的秒级、360/480/720 分钟） | `SERIES_ERROR` |
| 5 | 超时 / 被取消 | `TIMEOUT` / `ABORTED` |
| 6 | 网络 / 协议 / 解析 | `HTTP_ERROR` / `DISCONNECTED` |
| 69 | 缺依赖 / Node 版本过低 | — |

## Guardrails

- **只读**。不要说能下单、改自选股、改图表。
- **只用白名单指标**（见上）。不要引入 RSI/ATR/MA/布林带/KDJ 等其它指标。
- **绝不编造价格**。每个数字都来自命令输出；解析不到就如实说「未解析」。
- 表格只给关键几行，别把几百根 K 线倒出来。
- 报数字时带上 `time_iso` 与 `symbol`，并说明 `unit`；用用户的语言回答。

## 细节（按需加载）

- `references/commands.md` — `candles` / `indicators` 全部 flag、输出字段、缓存行为与示例。
- `references/symbols.md` — 别名全表、交易所、连续期货、解析算法、`unit`/`kind` 与坑。
- `references/api.md` — 到 `@mathieuc/tradingview` 的映射、缓存表结构、指标公式与限制。
