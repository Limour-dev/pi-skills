# options-gex — Skill 预备说明（sellthenews 期权 GEX）

本文档汇总把 `sellthenews` 的期权 GEX 能力封装成独立 skill 所需的**全部必要信息**：
数据源契约、字段语义、解析语法、边界坑、CLI 设计与测试夹具。

调研基准时间：`2026-10-05 12:4x UTC`（美东 08:4x，盘前 `market_session: "pre"`）。
下文每条结论都标注了验证状态：**已验证** = 有实测输出；**推断** = 由输出反推，未直接证实。

---

## 0. 结论先行

1. **MCP `get_options_data` 只是底层 REST JSON 的文本渲染器**，不是独立数据源。
   逐字段比对一致：`net_gex 544926340.32` ↔ `$544.93M`、`call_wall 770 / OI 3563`、
   `put_wall 765 / OI 2714`、`max_pain 763`、`gamma_flip 765.79`、`min_iv_strike 773`、
  `bullish_score 75`、`stm_iv 12.5`、`implied_move 4.03 / 0.52%`、`pc_oi_ratio 1.06`、
  总 OI/Vol 全部一致。（**已验证**）

2. **因此 skill 应直连 REST `GET /api/options/chain`，而不是走 MCP。**
   理由：原生 JSON（无需正则解析文本）、无 JSON-RPC/SSE 握手、字段更全
   （`cum_call_gex_by_strike`、`cum_put_gex_by_strike`、`greeks_exposure.{positive,negative,net}`、
   `option_mid_by_strike`、`expiration_dates`、`insights[]`），且 MCP 的 `maxStrikes` 参数
   在数据层是**被忽略**的（REST 始终返回完整 151 行权价）。

3. **本机 `MASSIVE_API_KEY` 是 Basic 档，拿不到 `/v3/snapshot/options/{ticker}`（HTTP 403），
   所以本地 `massive-options` skill 目前算不出 GEX。**（**已验证**，`massive-options probe`）
   → 这个新 skill 是当前**唯一可用的 GEX 来源**，与 `massive-options` 是互补而非重复关系。

4. MCP 仍值得实现为**降级通道**：REST 被 Cloudflare 挡/限流时可用，且 MCP 自带
   `maxStrikes` 文本裁剪，适合小上下文模型。

---

## 1. 数据源对比

| 维度 | MCP | REST |
| --- | --- | --- |
| 端点 | `POST https://mcp.sellthenews.org/mcp` | `GET https://sellthenews.org/api/options/chain` |
| 协议 | JSON-RPC 2.0 over Streamable HTTP（SSE 响应） | 纯 HTTP + JSON |
| 握手 | 无状态，可跳过 `initialize` 直接 `tools/call`（**已验证**） | 无 |
| 认证 | 无 | 无 |
| 参数 | `ticker`, `expiration`, `greeks`, `maxStrikes` | `ticker`, `exp`, `greeks` |
| 输出 | 纯文本（`content[0].text`），无 `structuredContent` | 结构化 JSON |
| 速率 | `x-ratelimit-limit: 120`（每 IP 短窗口，reset 走 unix 秒） | `ratelimit-limit: 30`，另有 `cache-control: public, max-age=60` + CF `cf-cache-status: HIT` |
| 单次延迟 | ~0.6–1.0 s（**已验证**，3 次采样） | 缓存命中时很快（`age: 33`） |
| 载荷 | ~1.9 KB（`maxStrikes=40`，gamma）/ ~3.1 KB（maxStrikes=200） | 34.9 KB（gamma）/ 80.3 KB（`greeks=all`） |
| 建议角色 | 降级 / 低 token 场景 | **主通道** |

> Pi 对超过 20 KB 的工具结果会截断中间，所以 REST 直连时必须由 CLI 先做**投影裁剪**，
> 不能把 80 KB 原样吐给模型。

---

## 2. REST 契约（主通道）

### 2.1 请求

```
GET https://sellthenews.org/api/options/chain?ticker=<SYM>[&exp=YYYY-MM-DD][&greeks=<list|all>]
```

| 参数 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- |
| `ticker` | ✅ | 大写或小写股票代码，`BRK.B` 这类点号代码可用（**已验证**） | 缺失 → HTTP 400 `{"ok":false,"error":"ticker required"}` |
| `exp` | ❌ | 严格 `YYYY-MM-DD`（**必须是 `exp`，不是 `expiration`**） | 省略 → 最近可用到期日 |
| `greeks` | ❌ | `gamma`(默认) / `vanna` / `charm` / `delta` / `theta` / `vega` / `all`（逗号分隔） | 非法值静默回落 `gamma` |

**被忽略的参数**（**已验证**）：
- `expiration=YYYY-MM-DD` — 完全无效，等价于省略
- `maxStrikes=N` — 完全无效，载荷恒为全量行权价

**静默回落（最重要的坑，已验证）**：
- `exp=2019-01-18`（格式合法但过期/不可用）→ **不报错**，回落到 `2026-10-05`
- `exp=bad` → **不报错**，回落到最近到期日
- `greeks=foo` / `greeks=`（空）→ **不报错**，回落 `gamma`
- → CLI **必须**回显响应中的 `selected_exp`，并校验它是否等于请求的 `exp`，不等则 warn

### 2.2 响应

成功：`{"ok": true, "ticker": "...", "expiration_dates": [...], "selected_exp": "...", "expiration": {...}, "updated_at": "...", "score_history": true}`

失败：`{"ok": false, "error": "<msg>"}`（HTTP 400 或 200，两种都出现过）

顶层字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | bool | 必须显式检查；错误也返回 HTTP 200 以外的形式不一 |
| `ticker` | string | 已大写规范化（`spy` → `SPY`） |
| `expiration_dates` | string[] | 该标的全部可用到期日（SPY 有 32 个，从 `2026-10-05` 到 `2029-01-19`），升序 |
| `selected_exp` | string | **实际选中的到期日**，用于校验回落 |
| `updated_at` | string | ISO UTC，服务端快照计算时间（如 `2026-10-05T12:46:39.221Z`） |
| `score_history` | bool | 仅为一个开关标志（值为 `true`），不是数据 |
| `expiration` | object | 见下（**单到期日口径**） |

> `updated_at` 是**请求时的服务端计算时间**，不是行情时间戳。同一分钟内 SPY/AAPL 两个
> ticker 返回相同的 `updated_at`（**已验证**）→ 不可当作数据新鲜度来断言，只能当生成时间。

### 2.3 `expiration` 字段表

标量（**全部已验证与 MCP 文本一致**）：

| 字段 | 示例（SPY 2026-10-05） | 语义 |
| --- | --- | --- |
| `spot` | `769.65` | 现货价（盘前 ≈ 前收盘 769.64，**推断**） |
| `forward_price` | `769.67` | 远期价 |
| `implied_move_abs` | `4.03` | ATM straddle 隐含波动（绝对值，美元） |
| `implied_move_pct` | `0.52` | 同上，百分比 |
| `stm_iv` | `12.5` | 短期 IV（%） |
| `dns_sm` | `-2.88` | 仪表盘标签 `DNS SM`，中文 i18n 为「偏度」，即 skew 类指标（%） |
| `total_call_oi` | `95175` | |
| `total_put_oi` | `101192` | |
| `total_call_vol` | `584474` | |
| `total_put_vol` | `794443` | |
| `pc_oi_ratio` | `1.06` | Put/Call OI 比；O'Neil 风格 |
| `call_wall` | `770` | Call 墙（gamma 集中度最大的 call 行权价） |
| `call_wall_oi` | `3563` | |
| `put_wall` | `765` | Put 墙 |
| `put_wall_oi` | `2714` | |
| `max_pain` | `763` | 最大痛点行权价 |
| `gamma_flip` | `765.79` | 可 `null`（仪表盘对此有 `optGammaNoFlip` 文案，**已验证**代码分支） |
| `min_iv_strike` | `773` | 最低 IV 行权价 |
| `net_gex` | `544926340.3235289` | **原始美元**，非「百万」。符号：正 = dealer 多头 gamma |
| `bullish_score` | `75` | 0–100 看多评分 |
| `oi_source` | `"oi"` | OI 来源；**推断** 当 OI 缺失时可能回落为 `"vol"`，此时 OI 统计不可信 → 需 warn |
| `market_session` | `"pre"` | 交易时段（`pre` / 别的值未穷举） |

数组 / 字典：

| 字段 | 结构 | 说明 |
| --- | --- | --- |
| `strikes` | `number[]`，长度 151（SPY） | 全部行权价，升序（`550 … 950`） |
| `gex_by_strike` | `{ "770.0": 96358554.49, ... }` | 键是**字符串化的浮点行权价**（注意 `"620.0"` 形式） |
| `cum_call_gex_by_strike` | 同上，151 键 | 从最低行权价向上累计 call GEX → 用于精确定位 zero-gamma |
| `cum_put_gex_by_strike` | 同上 | 累计 put GEX |
| `greeks_exposure` | `{ gamma: { positive: {...}, negative: {...}, net: {...} } }` | 键集合由 `greeks` 参数决定；顺序 `gamma,delta,theta,vega,vanna,charm`（`greeks=all` 时） |
| `call_oi_by_strike` / `put_oi_by_strike` | 各 151 键 | |
| `call_vol_by_strike` / `put_vol_by_strike` | 各 151 键 | |
| `option_mid_by_strike` | `{ call: {...}, put: {...} }` | 各 151 键，期权中间价 |
| `option_pop_by_strike` | `{ call: {}, put: {} }` | **实测恒为空对象**，不要依赖 |
| `insights` | `[{ type, color, title, text }]`，5 条 | `type`: `GAMMA` / `DEALER FLOW` / `KEY LEVELS` / `VOL STATUS` |

`greeks_exposure.<greek>` 三键语义（**已验证**）：`positive` 只含正值、`negative` 只含负值、
`net = positive + negative`。仪表盘图表就是分别取 `positive`/`negative` 画双色柱。
⚠️ 实测 `negative` 里存在 `-1.33e-7`、`-4.05e-6` 这类近零浮点噪声 → 渲染/统计前需按阈值清除。

### 2.4 实测边界表（REST）

| 请求 | 结果 |
| --- | --- |
| `ticker=zzzzzz` | `ok=false`, `error='Ticker "ZZZZZZ" not found'` |
| `ticker=`（空） | HTTP 400, `ok=false`, `error="ticker required"` |
| `ticker=SPY&exp=2019-01-18` | 静默回落 `selected_exp=2026-10-05` |
| `ticker=SPY&exp=bad` | 静默回落 |
| `ticker=SPY&expiration=2026-10-16` | **参数被忽略**，回落最近 `2026-10-05` |
| `ticker=SPY&maxStrikes=5` | **参数被忽略**，仍返回 151 行权价 |
| `ticker=BRK.B` | 正常，`selected_exp=2026-10-09`（该标的无 10-05 到期） |
| `ticker=spy` | 正常，`ticker` 回显为 `SPY` |
| `greeks=all` | `greeks_exposure` 6 个键；载荷 80.3 KB |

### 2.5 另一个可用端点（可选）

```
GET https://sellthenews.org/api/options/score-history?ticker=SPY&exp=2026-10-16&range=1m
```
返回 `{ok, ticker, exp, range, bucket_sec:1800, partial:true, days[], sessions[], ...}`（3.5 KB）。
可用于「bullish_score 历史走势」类需求，**是否纳入 skill 待定**。

---

## 3. MCP 契约（降级通道）

### 3.1 调用

```bash
curl -s https://mcp.sellthenews.org/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_options_data",
       "arguments":{"ticker":"SPY","greeks":"gamma","maxStrikes":40}}}'
```

- 响应体是 SSE：`event: message\n` + `data: {json}\n`
- **无需** `initialize`、无需 `Mcp-Session-Id`；`id` 可为字符串或数字（**已验证**）
- 服务器：`sellthenews v1.0.0`，协议 `2025-06-18`，capabilities 只有 `tools`
- 14 个工具中只有 `get_options_data` 与期权/GEX 相关（其余是新闻 / WSB / Truth Social / recap）

### 3.2 参数

| 参数 | 必填 | 约束 |
| --- | --- | --- |
| `ticker` | ✅ | 字符串，大小写不敏感 |
| `expiration` | ❌ | **严格** `YYYY-MM-DD`（`20261016`、`2026-1-5`、`2026/10/16` 都报错，**已验证**） |
| `greeks` | ❌ | `gamma`(默认) / `vanna` / `charm` / `delta` / `theta` / `vega` / `all` |
| `maxStrikes` | ❌ | 整数 `1..200`，默认 12；仅裁剪渲染文本，不改数据 |

Zod 校验失败会返回 JSON-RPC `-32602` 风格文本且 `isError: true`（**已验证**，见 3.4）。

### 3.3 错误分类（关键：两类都不是走 JSON-RPC error 字段）

MCP 把错误都塞进 `result.content[0].text`，`isError` 只在**参数校验失败**时才为 `true`：

| 场景 | `isError` | 文本 |
| --- | --- | --- |
| 缺少 `ticker` | `true` | `MCP error -32602: Input validation error: ... "path":["ticker"] ... "Required"` |
| `maxStrikes=0` / `999` | `true` | `... "too_small" minimum 1 ...` / `... "too_big" maximum 200 ...` |
| `expiration="2026/10/16"` | **undefined** | `Invalid expiration date format. Use YYYY-MM-DD.` |
| `ticker="ZZZZZZ"` | **undefined** | `No options data available for ZZZZZZ. It may not have listed options, or isn't a US-listed symbol we cover.` |
| `expiration="2019-01-18"` | **undefined** | **正常输出**，`Selected Expiration: 2026-10-05`（静默回落） |

→ 解析器**不能只看 `isError`**，必须同时做文本特征匹配。这本身也是「优先用 REST」的理由。

### 3.4 文本语法（正则解析表）

行分隔符 `\n`，节分隔符 `---`，字段分隔符 `: `。

```
=== Options Data: <TICKER> ===
Spot Price: $<float>
Selected Expiration: <YYYY-MM-DD>
Updated: <YYYY-MM-DD HH:MM> ET
Available Expirations: <D1>, <D2>, ... <D8> (+<N> more; pass expiration=YYYY-MM-DD)
<blank>
--- Key Levels ---
  Gamma Flip: $<float>                     # 也可能缺失/为 "N/A"（推断，需实测确认）
  Call Wall: $<float> (OI <int>)
  Put Wall: $<float> (OI <int>)
  Max Pain: $<float>                       # 注意：这里是无小数点的 763，Rest 为 763
  Min IV Strike: $<float>
  Net GEX: $<float><K|M|B>                 # 已做 1e3/1e6/1e9 缩放，带正负号
  Bullish Score: <int>/100
  Implied Move: ±$<float> (<float>%)
  Short-Term IV: <float>%
  P/C OI Ratio: <float>
  Total OI: Call <int> / Put <int>
  Total Vol: Call <int> / Put <int>
<blank>
--- Insights ---
  [<TYPE>] <title>: <text>                 # text 超 ~200 字符被截断并以 "..." 结尾（已验证）
<blank>
--- <GREEK> Net Exposure by Strike (nearest <N> to spot) ---
  $<strike>: <value><K|M|B>
  ...
```

要点：
- 行权价表头：`maxStrikes < 可用行权价数` 时带 ` (nearest N to spot)` 后缀；
  否则**不带后缀**（纯 `--- GAMMA Net Exposure by Strike ---`，**已验证**，`maxStrikes=200` 时）。
  → 正则需把后缀设为可选。
- 多 greek 时按 `greeks=all` 的固定顺序追加多个表：
  `GAMMA, DELTA, THETA, VEGA, VANNA, CHARM`
  （注意顺序与参数枚举 `gamma,vanna,charm,delta,theta,vega` **不同**）
- `Available Expirations` 只列前 8 个 + `(+N more)`；SPY 为 `(+24 more)` = 共 32 个，与 REST
  `expiration_dates.length` 一致。
- 数值格式：`K`/`M`/`B` 后缀，存在 `-0`、`538` 这类无后缀原值，负数带 `-`。
- `Available Expirations` 是**节内单独一行**，是获取到期日列表的唯一 MCP 途径（且被截断）。

### 3.5 MCP 实测边界

| 请求 | 结果 |
| --- | --- |
| `ticker=ZZZZZZ` | 友好文本，非 error |
| `expiration=1999-01-01` | 静默回落最近到期日 |
| `expiration=2026-10-06` | 正确返回 `Selected Expiration: 2026-10-06` |
| `greeks=foo` / `greeks=""` | 静默回落 `gamma` |
| `maxStrikes=1` | 1 行/表，Key Levels 与 Insights 仍完整 |
| `maxStrikes=40` | 40 行/表，总 1969 B，69 行 |
| `maxStrikes=200` | 表头无 `(nearest …)` 后缀，SPY 139 行（受数据侧行权价数限制） |
| `SPX` / `VIX` / `QQQ` / `TSLA` / `IWM` / `BRK.B` | 均正常；`SPX` `maxStrikes=200` 时恰好 200 行（被截） |
| `GET /mcp` | 405（只接受 POST）；`OPTIONS` 返回 204 |

---

## 4. 必须写进 SKILL.md 的口径与免责

沿用 `massive-options` 的 guardrail 风格：

- **GEX 定义**（需明确说明这是第三方口径，不可与自算混用）：
  `GEX_contract = gamma × OI × 100 × spot² × 0.01`，
  call 为正、put 为负 → 正 `net_gex` = dealer 多头 gamma，做市商高抛低吸、压制波动。
  该端点直接给出 `net_gex`，**skill 不自算、不重定义**。
- **单到期日口径**：所有 Key Levels（`gamma_flip` / `max_pain` / walls / `net_gex`）都是
  `selected_exp` **这一个到期日**的值，不是多 DTE 汇总。报告时必须带 `selected_exp`。
- **OI 是上一交易日收盘值**，不代表盘中持仓变化；`net_gex` 假设全部合约由 dealer 中介。
- **`oi_source` 若非 `"oi"`（疑似 `"vol"`）则统计口径改变**，需告警。
- 数据源为第三方聚合（Sell The News），**非交易所原始数据**，需在报告中标注来源与 `updated_at`。
- 只读：不涉及下单。
- 用用户语言回答。

---

## 5. 建议的 Skill 设计与 CLI

### 5.1 目录（对齐 `massive-options` 约定）

```
.pi/skills/options-gex/
├── SKILL.md              # frontmatter: name/description（触发词含 GEX、gamma 敞口、max pain、
│                         #   call wall/put wall、gamma flip、0DTE、dealer positioning 等）
├── cli.ts                # 零依赖纯 TS 单文件 CLI（Node ≥ 22.18）
├── bin/options-gex       # bash wrapper: exec node "$DIR/cli.ts" "$@"
├── package.json          # type: module, bin, engines.node>=22.18, dependencies: {}
├── src/                  # 可选：client.ts / types.ts / reduce.ts / format.ts
├── references/
│   ├── usage.md          # 全部 flag / 输出形状 / 退出码 / 配方
│   ├── api.md            # REST + MCP 契约、静默回落表、限流
│   └── examples.md       # 真实输出样例
└── tests/
    ├── fixtures/         # chain-spy-2026-10-05.json 等
    └── *.test.ts
```

### 5.2 建议命令面

| 命令 | 作用 | 关键 flag |
| --- | --- | --- |
| `gex <TICKER>` | Key Levels + 按行权价 GEX 表 | `--exp YYYY-MM-DD`, `--top N`, `--strike-range PCT` |
| `levels <TICKER>` | 只要 Key Levels（最小 token） | `--exp` |
| `walls <TICKER>` | call/put wall + OI | `--exp` |
| `max-pain <TICKER>` | `max_pain` + spot 距离 | `--exp` |
| `flip <TICKER>` | `gamma_flip` + 现价相对位置 + 用 `cum_*_gex_by_strike` 精算的 zero-gamma 校验 | `--exp` |
| `skew <TICKER>` | `greeks=vanna,charm` 的按行权价敞口 | `--exp`, `--top N` |
| `expiries <TICKER>` | 列出 `expiration_dates` + DTE | `--dte N` |
| `raw <TICKER>` | 透传裁剪后的 REST JSON | `--greeks`, `--top`, `--from-file` |
| `probe` | 自检：REST 是否可达、MCP 是否可达、各自延迟 | — |

通用 flag：
- `--source rest|mcp|auto`（默认 `auto`：先 REST，失败降级 MCP）
- `--format pretty|compact|table`（默认 pretty JSON，与 massive-options 一致）
- `--from-file PATH`（离线夹具，测试必需）
- `--timeout SEC`、`--max-retries N`、`--no-cache`
- `--json-errors`（结构化错误到 stdout）

退出码（沿用 massive-options 语义，便于模型统一处理）：
`0` ok · `1` 运行错误 · `2` 用法错误 · `3` 数据不可用/无该标的期权 · `4` 限流(429) · `5` 静默回落告警（可配 `--strict-exp` 升级为错误）

### 5.3 输出裁剪（必须）

REST 原载荷 35 KB / 80 KB，必须投影为：

- `levels`：只输出标量块（约 400 B）
- `gex`：标量块 + `--top N`（默认 40）按 |gex| 或按 `--strike-range` 筛选的行权价
- 默认**不返回** `call_oi_by_strike` / `put_oi_by_strike` / `option_mid_by_strike` 等大字典
- 永远附带 `provenance`：`{source, url, ticker, selected_exp, requested_exp, updated_at, market_session, oi_source, warnings[]}`
- 若 `selected_exp !== requested_exp` → 在 `warnings[]` 中显式记录

### 5.4 建议的 `SKILL.md` description（草稿）

> Short-dated US option positioning from the Sell The News options dashboard:
> net GEX, gamma flip / zero-gamma, call & put walls, max pain, per-strike gamma
> and vanna/charm exposure, P/C OI, implied move and bullish score — single-expiry
> snapshot with a REST JSON path and an MCP text fallback. Use for 期权 GEX、gamma
> 敞口、gamma flip、call wall / put wall、最大痛点 max pain、dealer positioning、
> 0DTE / 短期到期期权, or "where do dealers hedge / where does price pin".

⚠️ 需与 `massive-options` 的 description 做**触发词去重**，避免两个 skill 互相抢触发；
建议在两者 SKILL.md 中各加一行交叉引用（谁可用、谁不可用、何时用谁）。

---

## 6. 待确认 / 未验证项

| # | 项 | 影响 | 建议验证方式 |
| --- | --- | --- | --- |
| 1 | `gamma_flip` 为 `null` 时 MCP 文本如何呈现 | MCP 解析器健壮性 | 找一个全正/全负 gamma 的标的（如深 ITM 小票）实测 |
| 2 | `oi_source` 出现非 `"oi"` 的条件与取值 | 是否要告警降级 | 盘前/新上市标的多次采样 |
| 3 | `market_session` 的完整枚举 | 是否要按 session 调整措辞 | 盘中/盘后各采一次 |
| 4 | `dns_sm` 精确定义 | 是否可对外引用 | 仅在 i18n 中见「偏度」；建议**不在 SKILL.md 露面**或标为未定义 |
| 5 | MCP 120 限流窗口长度 | 降级通道的重试策略 | 连续压测读 `x-ratelimit-reset`（unix 秒） |
| 6 | REST 限流窗口（`limit 30`）与 CF 缓存交互 | 是否需要本地缓存 | 压测 + 观察 `cf-cache-status` / `age` |
| 7 | `min_iv_strike` 语义（最低 IV 行权价） | 展示措辞 | 交叉验证 IV 曲线 |
| 8 | 是否纳入 `score-history` 端点 | 功能范围 | 产品决策 |
| 9 | 盘中数据是否实时（MCP `Updated` 是请求时刻而非行情时刻） | **免责措辞准确性** | 开盘后对比交易所报价 |

---

## 7. 可直接落地的测试夹具

已抓取并存于会话临时目录，正式开发时复制到 `tests/fixtures/`：

| 夹具 | 来源 | 用途 |
| --- | --- | --- |
| `spy-2026-10-05-gamma.json` | REST 34.9 KB | 主路径、投影裁剪、限流/错误分支 |
| `spy-2026-10-16-gamma.json` | REST，`net_gex` 为负（`-1544151621`）、`Gamma Flip 774.62`、负 gamma 环境 | 符号分支、负 gamma insight |
| `spy-all-greeks.json` | REST 80.3 KB，6 greeks | 裁剪上限、greek 顺序 |
| `mcp-spy-maxstrikes40.txt` | MCP 文本 | 正则解析器主用例（69 行 / 1969 B） |
| `mcp-spy-maxstrikes200.txt` | MCP 文本 | 表头**无** `(nearest N)` 后缀分支 |
| `mcp-spy-greeks-all-maxstrikes1.txt` | MCP 文本 | 6 段 greek 顺序校验 |
| `mcp-errors.txt` | MCP 文本 | `-32602` / `Invalid expiration` / `No options data` → `isError` 三态 |
| `rest-errors.json` | REST | `ticker required`(400) / `Ticker "X" not found` |
| `rest-fallback.json` | REST | `exp=2019-01-18` → `selected_exp=2026-10-05` 静默回落 |

回归断言要点：
1. `net_gex` 缩放：`544926340.32` → `$544.93M`（MCP 同值）
2. 静默回落必须产生 `warnings[]`，且 `selected_exp !== requested_exp`
3. `greeks=all` 的段顺序 = `GAMMA, DELTA, THETA, VEGA, VANNA, CHARM`
4. `maxStrikes=200` 表头无后缀也能解析
5. `isError` 为 undefined 的文本错误也能被识别为失败
6. 近零浮点噪声（`-1.33e-7`）在 `--strike-range` 过滤与展示中被清理

---

## 8. 一句话交接

> 主通道直连 `GET https://sellthenews.org/api/options/chain?ticker=&exp=&greeks=`（**注意是 `exp`**，
> 且 `maxStrikes`/`expiration` 会被静默忽略，非法 `exp`/`greeks` 会**静默回落**，必须校验 `selected_exp`）；
> 降级通道是 MCP `get_options_data`（文本，需正则 + `isError` 三态判断 + 静默回落同样存在）；
> 所有 Key Levels 均为**单到期日**口径，且本机 Massive key 无 chain snapshot 权限，故本 skill 是当前唯一 GEX 来源。
