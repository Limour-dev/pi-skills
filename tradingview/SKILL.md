---
name: tradingview
description: >-
  Read-only TradingView K 线/OHLCV via the `tradingview candles` CLI, built on
  @mathieuc/tradingview v4 with a local SQLite cache. Bare names resolve
  automatically — USDT.D, US10Y, CNH1!, BTCUSD, DXY, VIX, ES1!, AAPL. Only
  closed bars are returned; the in-progress bar is never fetched. Each request
  reads cached history, fetches only the missing older/newer slices, and writes
  new bars back for next time. Use for K线/candles/OHLCV/历史行情. Read-only:
  it never places orders or changes account state.
---

# tradingview candles（只读）

唯一入口：`<skill-dir>/bin/tradingview`（bash wrapper，任何目录可直接调用）。
**只有 K 线一个功能**：`candles`（另有 `version`、`help`）。底层是
`@mathieuc/tradingview` v4 的 `getCandles`，经 TradingView websocket 取数。
**只读**：只查询，不下单、不改自选股、不改图表。

```bash
tradingview candles <SYMBOL> [flags]
```

stdout 输出 JSON（默认 pretty，`--format csv|table|md` 可切换）；stderr 输出
解析/警告行和错误 JSON。

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

## Step 2 · 取 K 线

```bash
tradingview candles BTCUSD --tf 1D --count 30 --format csv
tradingview candles USDT.D --tf 4h --from -30d
tradingview candles TVC:US10Y --tf W --count 52 --select time_iso,close
tradingview candles BINANCE:BTCUSDT --tf 1h --count 24 --cache ~/tv.sqlite
```

| flag | 默认 | 含义 |
| --- | --- | --- |
| `--tf`, `--timeframe` | `D` | `1 5 15 60 240`（分钟）、`D W M`，别名 `1m 1h 4h 1d 1w 1mo` |
| `--count N` | 100 | 最近 N 根**已收盘** K 线；给了 `--from` 时忽略 |
| `--from T` / `--to T` | | ISO（`2026-01-31`）、Unix 秒、或 `-7d`/`-12h`/`-30m` |
| `--newest-first` | | 倒序输出 |
| `--chart-type` | | `HeikinAshi`、`Renko`、`LineBreak`、`Kagi`、`PointAndFigure`、`Range` |
| `--currency` / `--adjustment` | `splits` | 价格换算 / `splits`、`dividends`、`none` |
| `--no-cache` / `--cache PATH` | | 绕过缓存 / 指定缓存库 |
| `--format json\|csv\|table\|md`、`--compact`、`--select a,b,c` | | 输出整形 |
| `--exchange X`、`--type T`、`--strict` | | 标的解析控制（见 Step 4） |

输出结构：`{input, symbol, resolved_from, timeframe, count, coverage, cache, candles}`；
`cache` 给出 `reused`（缓存命中）与 `fetched`（本次联网取到）。每根 K 线是
`{time, time_iso, open, high, low, close, volume}`，`time` 为 bar 开盘时间的
Unix 秒、`time_iso` 为 UTC。

## Step 3 · 只取已收盘的 K 线

正在生成的那根永远不请求、不返回、不缓存。判定规则与交易所时区无关：

```
一根 K 线已收盘  <=>  time + K线长度 <= now        （月线 = 下一个月初）
```

因此日线在交易所收盘后要等满 24 小时才出现（保守，宁可晚一点也不返回未走完的
K 线）。日线只到昨天，小时线只到上一个整点。

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

TradingView 的标的一定是 `EXCHANGE:SYMBOL`。裸名按顺序解析：显式（含 `:` 或
`--exchange`）→ 内置别名 → TradingView 自动补全。输出里的 `resolved_from`
标明来源（`explicit`/`alias`/`search`）。

常用别名（完整表见 `references/symbols.md`）：

| 裸名 | 解析为 | 含义 |
| --- | --- | --- |
| `USDT.D` / `BTC.D` | `CRYPTOCAP:USDT.D` … | 市占率，**百分比** |
| `TOTAL` / `TOTAL2` | `CRYPTOCAP:TOTAL…` | 加密总市值（美元） |
| `US10Y` / `US2Y` | `TVC:US10Y` … | 美债收益率，**百分比** |
| `DXY` / `VIX` / `GOLD` / `WTI` | `TVC:…` | 美元指数 / 波动率 / 金 / 油 |
| `CNH1!` | `CME:CNH1!` | 离岸人民币期货（连续） |
| `BTCUSD` / `BTCUSDT` | `BITSTAMP:BTCUSD` / `BINANCE:BTCUSDT` | 比特币现货 |
| `ES1!` / `NQ1!` / `CL1!` / `GC1!` | `CME_MINI:…` 等 | 连续期货前月 |

拿不准就写显式 `EXCHANGE:SYMBOL`（例如 `BINANCE:SOLUSDT`）；`--strict` 关闭
搜索兜底。没有独立的搜索命令。

## Step 6 · 读数与讲解

1. **先看单位和类型**：`CRYPTOCAP:*.D` 是百分比，`TOTAL` 是美元，`TVC:USxxY`
   是收益率百分比。K 线不带 `format`，按上面的别名表判断。
2. **看解析来源**：`resolved_from` 为 `search` 且交易所不对时，改用显式
   `EXCHANGE:SYMBOL`。
3. **债券成交量哨兵**：`TVC:USxxY` 的 `volume` 可能是 `1e+100`，当作缺失。
4. **匿名限制**：分钟级历史较短，过去的 `--from` 可能被截断；如实说明，不要编数。

## 退出码

| code | 含义 | 典型 `code` |
| --- | --- | --- |
| 0 | 成功 | — |
| 1 | 其他运行错误 | `CRITICAL_ERROR` |
| 2 | 用法错误 | `USAGE` / `INVALID_ARGUMENT` |
| 3 | 标的找不到 / 该区间无已收盘 K 线 | `SYMBOL_ERROR` / `NO_DATA` |
| 5 | 超时 / 被取消 | `TIMEOUT` / `ABORTED` |
| 6 | 网络 / 协议 / 解析 | `HTTP_ERROR` / `DISCONNECTED` |
| 69 | 缺依赖 / Node 版本过低 | — |

## Guardrails

- **只读**。不要说能下单、改自选股、改图表。
- **绝不编造价格**。每个数字都来自命令输出；解析不到就如实说「未解析」。
- 表格只给关键几行，别把几百根 K 线倒出来。
- 报数字时带上 `time_iso` 与 `symbol`；用用户的语言回答。

## 细节（按需加载）

- `references/commands.md` — `candles` 全部 flag、输出字段、缓存行为与示例。
- `references/symbols.md` — 别名全表、交易所、连续期货、解析算法与坑。
- `references/api.md` — 到 `@mathieuc/tradingview` 的映射、缓存表结构、限制与升级。
