/**
 * Parser tests: JSON extraction from htmx fragments, table scraping, number
 * formats and the expiry-suffix rules. All fixtures are trimmed versions of
 * real optioncharts.io fragments (see references/api.md).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseDiffDisplay,
  parseLevelWithPct,
  parseNumber,
  parsePlusMinus,
  parseTables,
  extractJson,
  extractExpiryIds,
  parseExpiryLabel,
  stripTags,
  tryExtractJson,
} from "../src/html.ts";
import {
  checkExpiryFallback,
  expiriesFromFragment,
  filterExpiries,
  inferExpiryKind,
  payloadExpiries,
} from "../src/endpoints.ts";
import { statsRows } from "../src/normalize.ts";
import { STATS_COLUMNS } from "../src/endpoints.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("extractJson picks the list form of a duplicated variable", () => {
  const list = extractJson(fixture("tlt-open-interest.html"), "chart_data", { expect: "list" });
  assert.ok(Array.isArray(list));
  assert.equal((list as Array<{ expiration_date_id: string }>)[0].expiration_date_id, "2026-10-09:w");
});

test("extractJson picks the dict form and keeps nested braces balanced", () => {
  const dict = extractJson(fixture("tlt-open-interest.html"), "chart_data", { expect: "dict" }) as Record<
    string,
    Array<{ strike: number; open_interest: number; contract_symbol: string }>
  >;
  assert.deepEqual(Object.keys(dict), ["2026-10-09:w:calls", "2026-10-09:w:puts"]);
  assert.equal(dict["2026-10-09:w:calls"].length, 3);
  assert.equal(dict["2026-10-09:w:calls"][0].strike, 65);
  assert.equal(dict["2026-10-09:w:calls"][0].contract_symbol, "TLT261009C00065000");
});

test("extractJson throws a parse error for a missing variable", () => {
  assert.equal(tryExtractJson(fixture("tlt-open-interest.html"), "nope"), undefined);
  assert.throws(() => extractJson(fixture("tlt-open-interest.html"), "nope"));
});

test("extractJson reads the exposure payload", () => {
  const exposure = extractJson(fixture("tlt-gamma-exposure.html"), "chart_exposure_data") as {
    ticker: string;
    net_exposure: number;
    call_wall: number;
    put_wall: number;
    exposure_by_expiration_series: Array<{ expiration_date_id: string; gamma_zero_level: null }>;
  };
  assert.equal(exposure.ticker, "TLT");
  assert.equal(exposure.net_exposure, 24985140.36);
  assert.equal(exposure.call_wall, 78);
  assert.equal(exposure.exposure_by_expiration_series[0].expiration_date_id, "2026-10-09:w");
  assert.equal(exposure.exposure_by_expiration_series[0].gamma_zero_level, null);
});

test("table scraping keeps hrefs, collapses markup and skips the Totals row", () => {
  const { rows, locked } = statsRows(fixture("tlt-stats.html"), [...STATS_COLUMNS]);
  assert.equal(rows.length, 3);
  assert.equal(locked.length, 0);
  const first = rows[0];
  assert.equal(first.expiration, "2026-10-05:w");
  assert.equal(first.kind, "weekly");
  assert.equal(first.dte, 0);
  assert.equal(first.volume_total, 109835);
  assert.equal(first.volume_pcr, 0.51);
  assert.equal(first.oi_total, 84930);
  assert.equal(first.iv_pct, 10.82);
  assert.equal(first.expected_move_abs, 0.55);
  assert.equal(first.expected_move_pct, 0.71);
  assert.equal(first.max_pain, 77.5);
  assert.equal(first.max_pain_diff_pct, 0.52);
  assert.equal(first.contracts_total, 72);
});

test("a locked (paywalled) column becomes null plus a locked column name", () => {
  const columns = ["expiration", "oi_total", "iv", "dte", "gex", "dex"];
  const { rows, locked } = statsRows(fixture("tlt-stats-locked.html"), columns);
  assert.deepEqual(locked, ["gex", "dex"]);
  assert.equal(rows[0].gex, null);
  assert.equal(rows[0].dex, null);
  assert.equal(rows[0].oi_total, 109683);
});

test("parseTables finds the call and put chain tables", () => {
  const tables = parseTables(fixture("tlt-chain.html"));
  assert.deepEqual(
    tables.map((table) => table.id),
    ["option_chain_table_id-call", "option_chain_table_id-put"],
  );
  assert.equal(tables[0].rows[0][0].text, "65.00");
  assert.equal(tables[0].rows[0][0].href, "/option/contract/TLT261009C00065000");
});

test("expiry list comes from the checkbox markup with day counts", () => {
  const entries = expiriesFromFragment(fixture("tlt-open-interest.html"));
  assert.deepEqual(
    entries.map((entry) => entry.exp_id),
    ["2026-10-05:w", "2026-10-07:w", "2026-10-09:w", "2026-10-12:w", "2026-10-14:w", "2026-10-16:m"],
  );
  assert.equal(entries[0].dte, 0);
  assert.equal(entries[2].kind, "weekly");
  assert.equal(entries[5].kind, "monthly");
  assert.match(String(entries[5].display), /\(m\)$/);
});

test("filterExpiries applies dte, kind and cap", () => {
  const entries = expiriesFromFragment(fixture("tlt-open-interest.html"));
  assert.equal(filterExpiries(entries, { dte: 7 }).length, 4);
  assert.equal(filterExpiries(entries, { weeklyOnly: true }).length, 5);
  assert.equal(filterExpiries(entries, { monthlyOnly: true })[0].exp_id, "2026-10-16:m");
  assert.equal(filterExpiries(entries, { max: 2 }).length, 2);
});

test("expiry ids can be recovered from hrefs as well as checkbox values", () => {
  const ids = extractExpiryIds(fixture("tlt-stats-locked.html"));
  assert.ok(ids.includes("2026-10-05:w"));
});

test("the third Friday of a month is the :m expiry", () => {
  assert.equal(inferExpiryKind("2026-10-16"), "monthly"); // third Friday
  assert.equal(inferExpiryKind("2026-10-09"), "weekly"); // second Friday
  assert.equal(inferExpiryKind("2026-10-23"), "weekly"); // fourth Friday
  assert.equal(inferExpiryKind("2026-10-05"), "weekly"); // Monday
});

test("payloadExpiries reads the expiry keys and row ids", () => {
  const payload = extractJson(fixture("tlt-open-interest.html"), "chart_data", { expect: "dict" });
  assert.deepEqual(payloadExpiries(payload), ["2026-10-09:w"]);
});

test("a silent expiry fallback is reported (and can be fatal)", () => {
  const data = extractJson(fixture("tlt-gamma-exposure-fallback.html"), "chart_exposure_data");
  const warnings = checkExpiryFallback(data, ["2026-10-09:w"], false, "TLT");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /2026-10-05:w/);
  assert.match(warnings[1], /no rows for 2026-10-09:w/);
  assert.throws(() => checkExpiryFallback(data, ["2026-10-09:w"], true, "TLT"), /suffix/);
  assert.deepEqual(checkExpiryFallback(data, ["2026-10-05:w"], true, "TLT"), []);
});

test("a requested expiry with no rows is a warning, not a zero", () => {
  const data = extractJson(fixture("tlt-gamma-exposure-fallback.html"), "chart_exposure_data");
  const warnings = checkExpiryFallback(
    data,
    ["2026-10-05:w", "2026-10-09:w"],
    true,
    "TLT",
    { ignoreMissing: true },
  );
  // 10-09 never appears, but the per-expiry collapse is expected (paid feature).
  assert.deepEqual(warnings, []);
  const flagged = checkExpiryFallback(data, ["2026-10-05:w", "2026-10-09:w"], true, "TLT");
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /no rows for 2026-10-09:w/);
});

test("upstream number formats", () => {
  assert.equal(parseNumber("1,234"), 1234);
  assert.equal(parseNumber("10.82%"), 10.82);
  assert.equal(parseNumber("$77.10"), 77.1);
  assert.equal(parseNumber("-"), null);
  assert.deepEqual(parsePlusMinus("±0.55 (0.71%)"), { abs: 0.55, pct: 0.71 });
  assert.deepEqual(parseLevelWithPct("77.50 +0.52%"), { value: 77.5, pct: 0.52 });
  assert.deepEqual(parseDiffDisplay("0.40 (0.52%)"), { abs: 0.4, pct: 0.52 });
  assert.deepEqual(parseExpiryLabel("Oct 09, 2026 (4 days) (w)"), { dte: 4, kind: "weekly" });
});

test("stripTags decodes entities and drops scripts", () => {
  assert.equal(stripTags("<div>a&amp;b</div><script>var x = 1;</script>"), "a&b");
});
