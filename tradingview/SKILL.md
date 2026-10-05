---
name: tradingview
description: >-
  Read-only TradingView market data via the `tradingview` CLI, built on the
  @mathieuc/tradingview v4 library: quotes, OHLCV candles, live quote/candle
  streams, multi-timeframe technical ratings, built-in indicators, screener and
  hotlist scans, and symbol lookup. Bare names resolve automatically — USDT.D,
  US10Y, CNH1!, BTCUSD, DXY, VIX, ES1!, AAPL. Use for 行情/报价/最新价, K线/
  candles, BTC dominance / USDT 占比 / 加密总市值, 美债收益率 (US10Y/US2Y),
  离岸人民币 CNH 期货, DXY/VIX/黄金/原油, 股指期货 ES/NQ, technical ratings
  (RSI/MACD 评分), screening / 选股, live watch / 实时盯盘. Read-only: it never
  places orders or changes account state.
---

# tradingview (read-only)

唯一入口：`<skill-dir>/bin/tradingview`（bash wrapper，任何目录可直接调用）。
底层是 `@mathieuc/tradingview` v4 的 data API，通过 TradingView 的 websocket /
scanner 取数。**只读**：只做查询，不下单、不改自选股、不改图表。

```bash
tradingview <command> [args] [flags]
```

stdout 输出 JSON（默认 pretty），stderr 输出错误 JSON，退出码见下。

## Step 1 · 环境检查

```bash
# 首次使用前安装一次（在 skill 目录里执行）：
cd <skill-dir> && npm install

# 之后自检：真实拉一次报价 + 一次搜索
<skill-dir>/bin/tradingview probe
```

- 若提示 `dependencies missing`：先执行 `cd <skill-dir> && npm install`。
- 若提示 Node 版本过低：需要 Node ≥ 22.18（本 CLI 直接运行 TypeScript）。
- `probe` 的 `ok: true` 表示网络/接口可用；`credentials: false` 表示没配账号 cookie（可选）。

账号 cookie 是**可选**的，通过环境变量提供，不要写进文件、issue 或 prompt：

```bash
export TV_SESSION="..."      # sessionid cookie
export TV_SIGNATURE="..."    # sessionid_sign cookie
```

## Step 2 · 先搞清楚标的（本 skill 的核心）

TradingView 的标的一定是 `EXCHANGE:SYMBOL`。本 CLI 会自动把裸名解析成候选：

1. **显式**：输入已含 `:`（`BINANCE:BTCUSDT`），或加了 `--exchange BINANCE`。
2. **别名**：内置高频宏观看板名（见下）。
3. **搜索**：调用 TradingView 自动补全，取最匹配的一条，其余作为 fallback。
4. 否则返回 `symbol: null`，必须改用 `search` 或显式 `EXCHANGE:SYMBOL`。

```bash
tradingview resolve USDT.D US10Y CNH1! BTCUSD   # 看解析结果（stderr 也会打印一行摘要）
tradingview resolve CNH1! --verify              # 逐个候选真发一次请求，确认哪个能取到
tradingview search "offshore yuan" --limit 5    # 解析不了时自己找
```

常用别名（完整表见 `references/symbols.md`，或 `tradingview aliases`）：

| 裸名 | 解析为 | 含义 / 单位 |
| --- | --- | --- |
| `USDT.D` | `CRYPTOCAP:USDT.D` | USDT 市占率，**百分比**（不是价格） |
| `BTC.D` / `ETH.D` | `CRYPTOCAP:BTC.D` … | 市占率，百分比 |
| `TOTAL` / `TOTAL2` / `TOTAL3` | `CRYPTOCAP:TOTAL…` | 加密总市值（美元） |
| `US10Y` / `US2Y` / `US30Y` | `TVC:US10Y` … | 美债收益率，百分比 |
| `DXY` / `VIX` | `TVC:DXY` / `TVC:VIX` | 美元指数 / 波动率 |
| `GOLD` / `WTI` | `TVC:GOLD` / `TVC:USOIL` | 现货金 / WTI |
| `CNH1!` | `CME:CNH1!` | 离岸人民币期货（连续，前月） |
| `USDCNH` | `FX:USDCNH` | 离岸人民币**现货** |
| `EURUSD` / `USDJPY` | `FX:EURUSD` … | 外汇现货 |
| `BTCUSD` | `BITSTAMP:BTCUSD` | 比特币现货（Bitstamp） |
| `BTCUSDT` | `BINANCE:BTCUSDT` | 比特币现货（Binance，USDT 计价） |
| `ES1!` / `NQ1!` / `CL1!` / `GC1!` | `CME_MINI:ES1!` … | 连续期货前月 |

**解析的坑**

- `!` 连续期货：TradingView 搜索会返回不带 `!` 的合约根（`CNH1!` → `CME:CNH`），
  解析器据根名重建 `CME:CNH1!`。`resolve CNH1! --verify` 可确认。
- 一个裸名可能命中多个交易所（`SOL` → `CRYPTOCAP:SOL`、`CME:SOL`…）。
  想要可交易的币种对，直接写 `BINANCE:SOLUSDT`。`--exchange` 只做前缀拼接，
  `--exchange BINANCE SOL` 会得到不存在的 `BINANCE:SOL`。
- 别猜交易所：拿不准就先 `search` 找到完整的 `EXCHANGE:SYMBOL`，后续命令直接用它。

## Step 3 · 取数

| 需求 | 命令 |
| --- | --- |
| 最新价 / 涨跌幅 / 买卖价 | `quote USDT.D US10Y CNH1! BTCUSD` |
| K 线 | `candles BTCUSD --tf 1D --count 30` |
| 实时盯盘 | `watch BTCUSD --duration 30 --changes-only` |
| 多周期技术评分 | `ta BTCUSD` |
| 指标 | `indicator BTCUSD --indicator 'Volume@tv-basicstudies-241'` |
| 找标的 | `search "nvidia"` |
| 标的元数据 | `info USDT.D` |
| 选股 / 扫描 | `screener --columns 'name,close,change,volume' --sort volume:desc` |
| 涨跌榜 | `hotlist --kind gainers` |
| 自选股（需 cookie） | `watchlists --brief` |
| 连通性自检 | `probe` |

最常用四条：

```bash
# 1) 四大宏观/加密标的一次拿全
tradingview quote USDT.D US10Y CNH1! BTCUSD --format table

# 2) 日线最近 30 根，CSV 直接进表格
tradingview candles BTCUSD --tf 1D --count 30 --format csv

# 3) 盯 20 秒报价，只在变化时输出（NDJSON）
tradingview watch BTCUSD BINANCE:ETHUSDT --duration 20 --changes-only

# 4) 多周期技术面
tradingview ta BTCUSD --format table
```

`--format json|csv|table|md` 切换输出；`--select a,b,c` 只保留字段；
`--compact` 单行 JSON；`--timeout MS` 放宽超时；`--strict` 关闭搜索兜底。

## Step 4 · 读数与讲解（最重要）

1. **先看单位和类型再报数**。`quote` 行里的 `format` 字段：`percent` 表示百分比，
   `price` 表示价格，空表示未声明。
   - `CRYPTOCAP:*` 的 `*.D` 是**百分比**；`TOTAL` 是美元。
   - `TVC:US10Y` 是**收益率百分比**（`5.33` = 5.33%）。
   - `TVC:US03M` 是贴现价（≈99），收益率是 `TVC:US03MY`；别名 `US3M` 已指向后者。
   - 债券类 `volume` 可能是哨兵值 `1e+100`，**不要当作成交量**。
   - `FX:USDCNH` 是现货，`CME:CNH1!` 是期货，两者有基差，别混着比。
2. **看延迟**。报价行带 `update_mode`：`streaming` 是实时；`delayed_streaming_600`
   等表示延迟（匿名访问下部分期货延迟约 10 分钟）。报数时说清「延迟/实时」。
3. **看解析来源**。报价行带 `resolved_from`（`alias` / `explicit` / `search`）；
   若是 `search` 且不是你要的那个交易所，换显式 `EXCHANGE:SYMBOL` 重取。
4. **K 线时间**是 bar 开盘时间的 Unix 秒，输出里已附 `time_iso`（UTC）。
5. **匿名访问有限制**（见 Step 5）；数字取不到就如实说，不要编。

## Step 5 · 匿名 vs 账号

默认匿名可用：报价、K 线、内置指标、screener、TA 评分。
匿名限制（有 cookie 会缓解）：

- 分钟级历史较短（我们的测试约为 ~7000 根 1 分钟），过去的 `to` 会被截断；
- **Pine 指标/策略需要账号**：`STD;RSI` 这类会返回 `STUDY_ERROR`
  （"maximum number of studies…"）。匿名只能用内置 study，例如
  `Volume@tv-basicstudies-241`；
- 可能被换成替代 feed（例如 `NASDAQ:AAPL` 由 `BATS:AAPL` 服务）；
- 部分期货 feed 延迟。

设置 `TV_SESSION` + `TV_SIGNATURE` 后，`indicator --indicator 'STD;RSI'` 与
更长历史即可用。凭证只从环境变量读取，`info`/`quote` 都不会回显 cookie。

## Step 6 · 诊断

```bash
tradingview probe                       # 一次真实 quote + 一次真实 search，含延迟
tradingview resolve <SYM> --verify      # 逐个候选实际请求，定位 no_such_symbol
tradingview info <SYM>                  # 交易所、session、时区、pricesscale
```

## 退出码

| code | 含义 | 典型错误 `code` |
| --- | --- | --- |
| 0 | 成功（含部分行为成功的批量查询） | — |
| 1 | 其他运行错误 | `CRITICAL_ERROR` |
| 2 | 用法错误 | `USAGE` / `INVALID_ARGUMENT` |
| 3 | 标的找不到 / 无数据 | `SYMBOL_ERROR` `QUOTE_ERROR` `NO_DATA` |
| 4 | 需要账号或凭证被拒 | `STUDY_ERROR` `AUTH_ERROR` |
| 5 | 超时 / 被取消 | `TIMEOUT` `ABORTED` |
| 6 | 网络 / 协议 / 解析 | `HTTP_ERROR` `DISCONNECTED` … |

批量 `quote` 里单个标的失败会在该行输出 `error` 字段且整体仍退出 0；
**全部**失败才退出 3。`watch` 的 NDJSON 里错误是 `{"event":"error",...}`。

## Guardrails

- **只读**。不要说能下单、改自选股、改图表。
- **绝不编造价格**。每个数字都来自命令输出；解析不到的标的如实说「未解析」。
- 表格只给关键几行/几只标的，别把几百行 screener 或完整期权链倒出来。
- 报数字时带上 `time_iso`、单位/`format`、`update_mode`（延迟与否）。
- 用用户的语言回答。

## 细节（按需加载）

- `references/symbols.md` — 别名全表、交易所、连续期货、解析算法与全部坑。
- `references/commands.md` — 每个命令的全部 flag、输出字段、示例。
- `references/api.md` — 到 `@mathieuc/tradingview` 各函数的映射、限制与升级方式。
