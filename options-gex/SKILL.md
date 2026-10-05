---
name: options-gex
description: >-
  Short-dated US option positioning from the Sell The News options dashboard via
  a zero-dependency, pure-TypeScript CLI: net GEX, gamma flip / zero-gamma,
  call & put walls, max pain, per-strike gamma and vanna/charm exposure,
  P/C OI, implied move and bullish score. Every call is one expiry (nearest by
  default) — a REST JSON channel with an MCP text fallback. Use for 期权 GEX、
  gamma 敞口、gamma flip、call wall / put wall、最大痛点 max pain、dealer
  positioning / 做市商持仓、0DTE / 短期到期期权, or questions like "where do
  dealers hedge" / "where does price pin" / "spot 在 flip 上方还是下方".
---

# options-gex (read-only)

唯一入口：`<skill-dir>/bin/options-gex`（bash wrapper，任何目录可直接调用）。
零依赖、无需 API key、无需 MCP 握手。**只读**：不涉及下单。

```bash
options-gex <command> <TICKER> [flags]
```

stdout 输出 JSON（默认 pretty；`--compact` 单行；`--table` 人类可读）。
退出码：`0` 成功 · `1` 运行错误 · `2` 用法错误 · `3` 无该标的期权数据 · `4` 限流(429) · `5` 静默到期日回落（仅 `--strict-exp`）。

## 命令

| 命令 | 返回 |
| --- | --- |
| `gex <T>` | Key Levels + 按行权价 GEX（默认按 \|GEX\| 取前 40 档） |
| `levels <T>` | 仅 Key Levels + insights（token 最小） |
| `walls <T>` | call/put wall、各自 OI、现价距离 |
| `max-pain <T>` | max pain 行权价 + 现价距离 |
| `flip <T>` | gamma flip、现价相对位置、zero-gamma 交叉校验 |
| `skew <T>` | vanna + charm 按行权价净敞口（默认各 40 档） |
| `expiries <T>` | 全部到期日 + DTE（`--dte N` 过滤） |
| `raw <T>` | 投影后的完整快照（`--greeks all` + `--include oi,vol,mid`） |
| `probe` | 自检：REST / MCP 是否可达、延迟、限流头 |

常用 flag：`--exp YYYY-MM-DD`（REST 参数名是 `exp`）、`--top N`、`--top-by abs|nearest`、
`--strike-range PCT`（±% of spot，优先于 `--top`）、`--source rest|mcp|auto`、
`--from-file PATH`（离线夹具）、`--format pretty|compact|table`、
`--timeout SEC`、`--max-retries N`、`--no-cache`、`--strict-exp`、`--json-errors`。
完整清单见 `references/usage.md`。

## 口径（报告时必须带上）

- **单到期日**：`gamma_flip` / `max_pain` / walls / `net_gex` 全部只属于
  `provenance.selected_exp` 这一个到期日，不是多 DTE 汇总。**报告任何数字都要带 `selected_exp`。**
- **GEX 定义**（第三方口径，勿与自算混用）：
  `GEX_contract = gamma × OI × 100 × spot² × 0.01`，call 为正、put 为负。
  正 `net_gex` = dealer 多头 gamma（高抛低吸、压制波动）；负值反之。
  端点直接给 `net_gex`，**CLI 不自算、不重定义**；`gex_by_strike` 之和恒等于 `net_gex`。
- **`flip` 的 `zero_gamma_estimate`** 是用 `cum_call_gex_by_strike + cum_put_gex_by_strike`
  的零交叉点线性插值出来的**交叉校验**（REST 才有）。服务端 `gamma_flip` 用的是更细的行权价网格，
  两者相差几美元属正常，不要因此改写 `gamma_flip`。
- **OI 是上一交易日收盘值**，不代表盘中持仓变化；`net_gex` 假设全部合约由 dealer 中介。
- **`oi_source` 若不是 `"oi"`**，说明统计口径可能变成成交量，`provenance.warnings` 会告警，需在报告中说明。
- 数据源是第三方聚合（Sell The News），非交易所原始数据。报告时标注来源与 `updated_at`
  （它是服务端计算时刻，**不是行情时间戳**）。
- 用用户语言回答。

## 通道与坑（CLI 已处理，但报表时要留意 provenance）

- 主通道 REST `GET https://sellthenews.org/api/options/chain?ticker=&exp=&greeks=`；
  MCP `get_options_data` 是降级通道（`--source mcp` 或 REST 失败时 `auto` 自动切换）。
- **`exp` 是唯一有效的到期日参数**；`expiration`、`maxStrikes` 会被静默忽略。
  非法/过期 `exp`（如 `2019-01-18`）**不报错**，静默回落到最近到期日 →
  CLI 比对 `selected_exp` 并在 `provenance.warnings` 记录；`--strict-exp` 时以 exit 5 失败。
- REST 被 Cloudflare 挡住 → `--source mcp`（自带文本裁剪，更适合小上下文）。
- MCP 文本里的数值是**缩放/四舍五入**后的（如 `$544.93M`），只有 REST 才是精确值；
  MCP 也不返回 `gex_by_strike`，此时 `units` 是 `exposure_units`（上游敞口单位，不是美元 GEX）。
- REST 有 60 秒本地缓存（`--no-cache` 绕过）；限流 30 次/IP，MCP 120 次/IP。

## 工作流

```bash
# 1) 先看哪条通道活着（网络异常时）
options-gex probe

# 2) 最小上下文的三件套
options-gex levels SPY                 # spot / net_gex / flip / walls / max pain
options-gex flip SPY                   # 现价在 flip 哪一侧 + regime
options-gex walls SPY                  # 支撑阻力位与距离

# 3) 看某个到期日的 GEX 分布（默认最近到期日）
options-gex gex SPY --exp 2026-10-16 --strike-range 2 --format table

# 4) 波动结构：vanna / charm
options-gex skew SPY --top 20

# 5) 离线复现/回归
options-gex raw SPY --from-file tests/fixtures/spy-all-greeks.json --greeks all --top 20
```

## 细节（按需读）

- 全部 flag、输出形状、退出码、配方：`references/usage.md`
- REST / MCP 契约、静默回落表、限流与缓存：`references/api.md`
- 真实输出样例：`references/examples.md`

开发验证：`npm test`（离线夹具）、`npm run typecheck`、`npm run smoke`（联网）。
