/** MCP text grammar, error three-state handling and the fallback snapshot. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyMcpText, parseOptionsText } from "../src/mcp.ts";
import { fromMcp } from "../src/normalize.ts";
import { DataUnavailableError, UsageError } from "../src/errors.ts";
import { GREEK_ORDER, type HttpMeta } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const META: HttpMeta = { status: 200, latency_ms: 600, from_cache: false };
const URL = "https://mcp.sellthenews.org/mcp";

function read(name: string): string {
  return readFileSync(join(FIX, name), "utf8");
}

function parse(name: string) {
  return parseOptionsText(read(name));
}

test("maxStrikes=40 text parses to the same key levels as REST", () => {
  const parsed = parse("mcp-spy-maxstrikes40.txt");
  assert.equal(parsed.ticker, "SPY");
  assert.equal(parsed.spot, 769.65);
  assert.equal(parsed.selected_exp, "2026-10-05");
  assert.equal(parsed.updated_local, "2026-10-05 08:45 ET");
  assert.equal(parsed.levels.gamma_flip, 765.79);
  assert.equal(parsed.levels.call_wall, 770);
  assert.equal(parsed.levels.call_wall_oi, 3563);
  assert.equal(parsed.levels.put_wall, 765);
  assert.equal(parsed.levels.put_wall_oi, 2714);
  assert.equal(parsed.levels.max_pain, 763);
  assert.equal(parsed.levels.min_iv_strike, 773);
  assert.equal(parsed.levels.net_gex, 544_930_000);
  assert.equal(parsed.levels.bullish_score, 75);
  assert.equal(parsed.levels.implied_move_abs, 4.03);
  assert.equal(parsed.levels.implied_move_pct, 0.52);
  assert.equal(parsed.levels.stm_iv, 12.5);
  assert.equal(parsed.levels.pc_oi_ratio, 1.06);
  assert.equal(parsed.levels.total_call_oi, 95175);
  assert.equal(parsed.levels.total_put_oi, 101192);
  assert.equal(parsed.levels.total_call_vol, 584474);
  assert.equal(parsed.levels.total_put_vol, 794443);

  assert.equal(parsed.expiration_dates.length, 8);
  assert.equal(parsed.expiration_count, 32);
  assert.equal(parsed.insights.length, 5);
  assert.deepEqual(
    parsed.insights.map((insight) => insight.type),
    ["GAMMA", "DEALER FLOW", "KEY LEVELS", "KEY LEVELS", "VOL STATUS"],
  );

  assert.equal(parsed.greeks.length, 1);
  assert.equal(parsed.greeks[0].greek, "gamma");
  assert.equal(parsed.greeks[0].nearest, 40);
  assert.equal(Object.keys(parsed.greeks[0].values).length, 40);
  assert.equal(parsed.greeks[0].values["770"], 16300);
  assert.equal(parsed.greeks[0].values["750"], -2300);
  assert.equal(parsed.greeks[0].values["782"], 538);
});

test("maxStrikes=200 has no `(nearest N)` suffix and still parses", () => {
  const parsed = parse("mcp-spy-maxstrikes200.txt");
  assert.equal(parsed.greeks.length, 1);
  assert.equal(parsed.greeks[0].greek, "gamma");
  assert.equal(parsed.greeks[0].nearest, undefined);
  assert.ok(Object.keys(parsed.greeks[0].values).length > 100);
});

test("greeks=all emits the fixed GAMMA, DELTA, THETA, VEGA, VANNA, CHARM order", () => {
  const parsed = parse("mcp-spy-greeks-all-maxstrikes1.txt");
  assert.deepEqual(
    parsed.greeks.map((table) => table.greek),
    [...GREEK_ORDER],
  );
  for (const table of parsed.greeks) {
    assert.equal(table.nearest, 1);
    assert.equal(Object.keys(table.values).length, 1);
  }
  assert.equal(parsed.greeks.find((table) => table.greek === "delta")?.values["770"], 88_500);
  assert.equal(parsed.greeks.find((table) => table.greek === "theta")?.values["770"], -520_000);
  assert.equal(parsed.greeks.find((table) => table.greek === "charm")?.values["770"], -3_440_000);
});

test("MCP failures are classified even when isError is undefined", () => {
  const blocks = read("mcp-errors.txt")
    .split(/^### /m)
    .slice(1)
    .map((block) => {
      const newline = block.indexOf("\n");
      return {
        name: block.slice(0, newline).trim(),
        envelope: JSON.parse(block.slice(newline + 1).trim()) as {
          result?: { content?: Array<{ text?: string }>; isError?: boolean };
        },
      };
    });

  const byName = new Map(blocks.map((block) => [block.name, block]));
  assert.equal(blocks.length, 7);

  const textOf = (name: string) => {
    const block = byName.get(name);
    assert.ok(block, `missing fixture block ${name}`);
    return block.envelope.result?.content?.[0]?.text ?? "";
  };

  // isError:true — Zod validation.
  for (const name of ["missing ticker", "maxStrikes=0", "maxStrikes=999"]) {
    assert.equal(byName.get(name)?.envelope.result?.isError, true);
    assert.ok(classifyMcpText(textOf(name)) instanceof UsageError);
  }

  // isError undefined — the text itself must be classified.
  for (const name of ["bad exp format"]) {
    assert.equal(byName.get(name)?.envelope.result?.isError, undefined);
    assert.ok(classifyMcpText(textOf(name)) instanceof UsageError);
  }
  for (const name of ["unknown ticker"]) {
    assert.equal(byName.get(name)?.envelope.result?.isError, undefined);
    assert.ok(classifyMcpText(textOf(name)) instanceof DataUnavailableError);
  }

  // Silent fallback: valid text, different expiry than requested.
  const fallback = textOf("past exp silent fallback");
  assert.equal(classifyMcpText(fallback), null);
  const parsed = parseOptionsText(fallback);
  assert.equal(parsed.selected_exp, "2026-10-05");
  assert.equal(parsed.levels.gamma_flip, 765.79);
});

test("MCP snapshots carry a rounding warning and no pseudo-cumulative data", () => {
  const snapshot = fromMcp(parse("mcp-spy-maxstrikes40.txt"), {
    url: URL,
    meta: META,
    requestedExp: "2019-01-18",
  });
  assert.equal(snapshot.source, "mcp");
  assert.equal(snapshot.net_gex, 544_930_000);
  assert.equal(snapshot.gex_by_strike, undefined);
  assert.equal(snapshot.cum_call_gex_by_strike, undefined);
  assert.equal(snapshot.expiration_count, 32);
  assert.ok(snapshot.warnings.some((warning) => /rounded\/scaled/.test(warning)));
  assert.ok(snapshot.warnings.some((warning) => /requested exp 2019-01-18/.test(warning)));
  assert.ok(snapshot.warnings.some((warning) => /only 8 of 32 expirations/.test(warning)));
});
