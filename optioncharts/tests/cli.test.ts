/**
 * End-to-end CLI tests. Every data command is exercised against the trimmed
 * fragments with `--from-file`, so the whole suite runs offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

function run(args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    try {
      // errors are printed on stderr unless --json-errors is set
      json = JSON.parse(result.stderr.split("\n")[0]) as Record<string, unknown>;
    } catch {
      /* csv / usage output */
    }
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, json };
}

function firstTicker(runResult: Run): Record<string, unknown> {
  const tickers = runResult.json.tickers as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(tickers), `expected a tickers array, got: ${runResult.stdout.slice(0, 300)}`);
  return tickers[0];
}

test("stats reads the per-expiry table", () => {
  const result = run(["stats", "TLT", "--from-file", fixture("tlt-stats.html")]);
  assert.equal(result.status, 0);
  const ticker = firstTicker(result);
  assert.equal(ticker.count, 3);
  assert.equal(ticker.total_expiries, 3);
  assert.deepEqual(ticker.locked_columns, []);
  const rows = ticker.rows as Array<Record<string, unknown>>;
  assert.equal(rows[0].expiration, "2026-10-05:w");
  assert.equal(rows[0].oi_total, 84930);
  assert.equal(rows[0].expected_move_pct, 0.71);
});

test("stats skips expired rows with --dte and can filter weekly/monthly", () => {
  const dte = run(["stats", "TLT", "--dte", "3", "--from-file", fixture("tlt-stats.html")]);
  assert.equal(firstTicker(dte).count, 2);
  const monthly = run([
    "stats",
    "TLT",
    "--monthly-only",
    "--from-file",
    fixture("tlt-stats.html"),
  ]);
  assert.equal(firstTicker(monthly).count, 0);
});

test("stats reports locked paywalled columns as null", () => {
  const result = run([
    "stats",
    "TLT",
    "--columns",
    "expiration,oi_total,iv,dte,gex,dex",
    "--from-file",
    fixture("tlt-stats-locked.html"),
  ]);
  assert.equal(result.status, 0);
  const ticker = firstTicker(result);
  assert.deepEqual(ticker.locked_columns, ["gex", "dex"]);
  const rows = ticker.rows as Array<Record<string, unknown>>;
  assert.equal(rows[0].gex, null);
  const provenance = ticker.provenance as { warnings: string[] };
  assert.ok(provenance.warnings.some((warning) => /locked/.test(warning)));
});

test("--format csv emits a header plus one row per expiry (Totals dropped)", () => {
  const result = run(["stats", "TLT", "--format", "csv", "--from-file", fixture("tlt-stats.html")]);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith("ticker,expiration,volume_total,"));
  assert.ok(lines[1].startsWith("TLT,2026-10-05:w,"));
});

test("oi flattens strikes and keeps the per-expiry summary", () => {
  const result = run([
    "oi",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--from-file",
    fixture("tlt-open-interest.html"),
  ]);
  const ticker = firstTicker(result);
  const rows = ticker.rows as Array<Record<string, unknown>>;
  assert.equal(rows.length, 6);
  assert.equal(rows[0].open_interest, 0);
  assert.equal(rows[0].contract_symbol, "TLT261009C00065000");
  assert.ok(Array.isArray(ticker.summary));
  assert.equal((ticker.summary as Array<Record<string, unknown>>)[0].open_interest_total, 224932);
});

test("--top keeps the largest absolute rows", () => {
  const result = run([
    "oi",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--top",
    "2",
    "--from-file",
    fixture("tlt-open-interest.html"),
  ]);
  const rows = firstTicker(result).rows as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(Number(rows[0].open_interest)) >= Math.abs(Number(rows[1].open_interest)));
});

test("gex exposes walls, exposure and the free-tier caveats", () => {
  const result = run([
    "gex",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--top",
    "3",
    "--from-file",
    fixture("tlt-gamma-exposure.html"),
  ]);
  assert.equal(result.status, 0);
  const ticker = firstTicker(result);
  assert.equal(ticker.exposure, "GEX");
  assert.equal(ticker.unit, "usd_per_1pct_move");
  assert.equal(ticker.net_exposure, 24985140.36);
  assert.equal(ticker.call_wall, 78);
  assert.equal(ticker.put_wall, 78);
  assert.equal(ticker.gamma_zero_level, null);
  assert.deepEqual(ticker.returned_expiries, ["2026-10-09:w"]);
  assert.equal((ticker.gex_by_strike as unknown[]).length, 3);
});

test("dex shares the exposure shape", () => {
  const result = run([
    "dex",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--from-file",
    fixture("tlt-gamma-exposure.html"),
  ]);
  assert.equal(firstTicker(result).exposure, "DEX");
});

test("greeks lists the available greeks and their rows", () => {
  const result = run([
    "greeks",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--top",
    "4",
    "--from-file",
    fixture("tlt-greeks.html"),
  ]);
  const ticker = firstTicker(result);
  assert.deepEqual(ticker.available_greeks, ["delta", "gamma", "theta", "vega"]);
  assert.equal((ticker.rows as unknown[]).length, 4);
});

test("skew and volume read their chart payloads", () => {
  const skew = run([
    "skew",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--from-file",
    fixture("tlt-skew.html"),
  ]);
  const skewRow = (firstTicker(skew).rows as Array<Record<string, unknown>>)[0];
  assert.equal(skewRow.iv_pct, 73.6705);
  const volume = run([
    "volume",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--from-file",
    fixture("tlt-volume.html"),
  ]);
  assert.equal(firstTicker(volume).metric, "volume");
});

test("max-pain, em and chain projections", () => {
  const maxPain = run(["max-pain", "TLT", "--from-file", fixture("tlt-max-pain.html")]);
  const painRows = firstTicker(maxPain).rows as Array<Record<string, unknown>>;
  assert.equal(painRows.length, 2);
  assert.equal(painRows[0].max_pain, 77.5);
  assert.equal(painRows[0].max_pain_diff, 0.4);

  const em = run([
    "em",
    "TLT",
    "--limit",
    "2",
    "--from-file",
    fixture("tlt-expected-move.html"),
  ]);
  const emTicker = firstTicker(em);
  assert.equal(emTicker.point_count, 4);
  assert.equal(emTicker.points_returned, 2);

  const chain = run([
    "chain",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--from-file",
    fixture("tlt-chain.html"),
  ]);
  const chainTicker = firstTicker(chain);
  assert.equal(chainTicker.row_count, 4);
  const chainRow = (chainTicker.rows as Array<Record<string, unknown>>)[0];
  assert.equal(chainRow.option_type, "CALL");
  assert.equal(chainRow.strike, 65);
});
test("em exposes the ET session date and CSV leads with it", () => {
  const result = run(["em", "TLT", "--limit", "2", "--from-file", fixture("tlt-expected-move.html")]);
  const points = firstTicker(result).points as Array<Record<string, unknown>>;
  assert.equal(points[0].et_date, "2026-10-05");
  assert.equal(points[0].et_time, "23:59:59");
  assert.equal(points[0].em_amt, 0.55);

  const csv = run([
    "em",
    "TLT",
    "--limit",
    "1",
    "--format",
    "csv",
    "--from-file",
    fixture("tlt-expected-move.html"),
  ]);
  const lines = csv.stdout.trim().split("\n");
  assert.ok(lines[0].startsWith("ticker,et_date,et_time,t,iso,"));
  assert.ok(lines[1].startsWith("TLT,2026-10-05,23:59:59,"));
});

test("gex adds cross-ticker normalisation fields and --units labels the CSV", () => {
  const normalized = run([
    "gex",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--top",
    "2",
    "--normalize",
    "pct",
    "--from-file",
    fixture("tlt-gamma-exposure.html"),
  ]);
  const ticker = firstTicker(normalized);
  assert.equal(ticker.normalize, "pct");
  assert.equal(typeof ticker.exposure_as_of, "string");
  const rows = ticker.gex_by_strike as Array<Record<string, unknown>>;
  assert.equal(typeof rows[0].share_of_abs_total_pct, "number");
  assert.equal(rows[0].sigma_pos, null);

  const csv = run([
    "gex",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--top",
    "1",
    "--format",
    "csv",
    "--units",
    "--from-file",
    fixture("tlt-gamma-exposure.html"),
  ]);
  const header = csv.stdout.split("\n")[0].split(",");
  // OC-05: --units must not rename columns; the original names stay addressable.
  for (const column of [
    "ticker",
    "expiry",
    "strike",
    "call_exposure",
    "put_exposure",
    "net_exposure",
    "share_of_abs_total_pct",
    "sigma_pos",
  ]) {
    assert.ok(header.includes(column), `missing ${column} in ${header.join(",")}`);
  }
  assert.ok(header.includes("unit_net_exposure"));
  assert.ok(header.includes("unit_share_of_abs_total_pct"));
});

test("--normalize rejects an unknown mode", () => {
  const result = run([
    "gex",
    "TLT",
    "--normalize",
    "bogus",
    "--from-file",
    fixture("tlt-gamma-exposure.html"),
  ]);
  assert.equal(result.status, 2);
});


test("spot and info scrape the server-rendered widgets", () => {
  const spot = run(["spot", "TLT", "--from-file", fixture("tlt-price.html")]);
  const spotTicker = firstTicker(spot);
  assert.equal(spotTicker.price, 77.1);
  assert.equal(spotTicker.change_pct, -0.49);
  assert.equal(spotTicker.market_status, "Market Open");

  const info = run(["info", "TLT", "--from-file", fixture("tlt-ticker-info.html")]);
  const infoTicker = firstTicker(info);
  assert.equal(infoTicker.dividend_yield_pct, 4.85);
  assert.equal(infoTicker.average_volume, 47850000);
});

test("expiries filters by kind and flags the 30-entry list cap rule", () => {
  const result = run([
    "expiries",
    "TLT",
    "--weekly-only",
    "--from-file",
    fixture("tlt-open-interest.html"),
  ]);
  const ticker = firstTicker(result);
  assert.equal(ticker.count, 5);
  assert.equal(ticker.total_available, 6);
  const expirations = ticker.expirations as Array<Record<string, unknown>>;
  assert.equal(expirations[0].exp, "2026-10-05:w");
  assert.equal(expirations[0].weekday, "Mon");
  assert.equal(expirations[0].dte, 0);
});

test("a silent expiry fallback exits 5 unless allowed", () => {
  const strict = run([
    "gex",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--from-file",
    fixture("tlt-gamma-exposure-fallback.html"),
  ]);
  assert.equal(strict.status, 5);
  assert.equal((strict.json.error as Record<string, unknown>).code, "exp_fallback");

  const lenient = run([
    "gex",
    "TLT",
    "--exp",
    "2026-10-09:w",
    "--allow-exp-fallback",
    "--from-file",
    fixture("tlt-gamma-exposure-fallback.html"),
  ]);
  assert.equal(lenient.status, 0);
  const ticker = firstTicker(lenient);
  assert.deepEqual(ticker.returned_expiries, ["2026-10-05:w"]);
  const warnings = (ticker.provenance as { warnings: string[] }).warnings;
  assert.ok(warnings.some((warning) => /server returned/.test(warning)));
});

test("an unknown ticker exits 3 with a JSON error", () => {
  const result = run(["stats", "ZZZZZZ", "--from-file", fixture("invalid-ticker.html")]);
  assert.equal(result.status, 3);
  assert.equal((result.json.error as Record<string, unknown>).code, "unavailable");
});

test("usage errors exit 2", () => {
  assert.equal(run(["stats"]).status, 2);
  assert.equal(run(["nope", "TLT"]).status, 2);
  assert.equal(run(["stats", "TLT", "--nope"]).status, 2);
  assert.equal(run(["gex", "TLT", "--exp", "not-a-date", "--from-file", fixture("tlt-gamma-exposure.html")]).status, 2);
});

test("--help and --version work without arguments", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /optioncharts/);
  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("--json-errors prints errors on stdout", () => {
  const result = run([
    "stats",
    "ZZZZZZ",
    "--json-errors",
    "--from-file",
    fixture("invalid-ticker.html"),
  ]);
  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  assert.equal((result.json.error as Record<string, unknown>).code, "unavailable");
});

test("--compact aliases --format compact and conflicts are rejected (OC-01)", () => {
  const compact = run(["oi", "TLT", "--exp", "2026-10-09:w", "--compact", "--from-file", fixture("tlt-open-interest.html")]);
  assert.equal(compact.status, 0);
  assert.equal(compact.stdout.trim().split("\n").length, 1);
  assert.equal(compact.json.command, "oi");

  const conflict = run(["oi", "TLT", "--compact", "--format", "pretty", "--from-file", fixture("tlt-open-interest.html")]);
  assert.equal(conflict.status, 2);
});

test("chain --columns without strike keeps values aligned (OC-02)", () => {
  const control = run([
    "chain", "TLT", "--exp", "2026-10-09:w", "--columns", "strike,volume,oi",
    "--format", "csv", "--from-file", fixture("tlt-chain.html"),
  ]);
  const subset = run([
    "chain", "TLT", "--exp", "2026-10-09:w", "--columns", "volume,oi",
    "--format", "csv", "--from-file", fixture("tlt-chain.html"),
  ]);
  assert.equal(subset.status, 0);
  const controlRows = control.stdout.trim().split("\n").map((line) => line.split(","));
  const subsetRows = subset.stdout.trim().split("\n").map((line) => line.split(","));
  assert.deepEqual(subsetRows[0], ["ticker", "expiration", "option_type", "volume", "oi"]);
  assert.deepEqual(controlRows[0], ["ticker", "expiration", "option_type", "strike", "volume", "oi"]);
  assert.deepEqual(
    subsetRows.slice(1).map((row) => [row[3], row[4]]),
    controlRows.slice(1).map((row) => [row[4], row[5]]),
  );
  // The old positional bug read the strike (65.00) into `volume`.
  assert.notEqual(subsetRows[1][3], controlRows[1][3]);
  assert.equal(subsetRows[1][3], "0");

  const iv = run(["chain", "TLT", "--exp", "2026-10-09:w", "--columns", "iv", "--from-file", fixture("tlt-chain.html")]);
  const ivRows = firstTicker(iv).rows as Array<Record<string, unknown>>;
  assert.ok(Number(ivRows[0].iv_pct) < 200);
  assert.equal(run(["chain", "TLT", "--columns", "nope", "--from-file", fixture("tlt-chain.html")]).status, 2);
});

test("stats --columns without expiration still returns rows (OC-03)", () => {
  const result = run(["stats", "TLT", "--columns", "oi_total", "--format", "csv", "--from-file", fixture("tlt-stats.html")]);
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines[0], "ticker,oi_total");
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith("TLT,"));

  const canonical = run([
    "stats", "TLT", "--columns", "expiration,oi_total",
    "--format", "csv", "--from-file", fixture("tlt-stats.html"),
  ]);
  assert.equal(canonical.stdout.split("\n")[0], "ticker,expiration,oi_total");
  assert.equal(run(["stats", "TLT", "--columns", "nope", "--from-file", fixture("tlt-stats.html")]).status, 2);
});

test("spot and info answer --format csv (OC-04)", () => {
  const spot = run(["spot", "TLT", "--format", "csv", "--from-file", fixture("tlt-price.html")]);
  assert.equal(spot.status, 0);
  const spotLines = spot.stdout.trim().split("\n");
  assert.ok(spotLines[0].startsWith("ticker,price,change,change_pct"));
  assert.ok(spotLines[1].startsWith("TLT,77.1,"));

  const info = run(["info", "TLT", "--format", "csv", "--from-file", fixture("tlt-ticker-info.html")]);
  assert.equal(info.status, 0);
  assert.ok(info.stdout.split("\n")[0].startsWith("ticker,dividend_yield_pct"));
});

test("series rows carry a metric/value pair and stats names are canonical (OC-06)", () => {
  const oi = run(["oi", "TLT", "--exp", "2026-10-09:w", "--from-file", fixture("tlt-open-interest.html")]);
  const row = (firstTicker(oi).rows as Array<Record<string, unknown>>)[0];
  assert.equal(row.metric, "open_interest");
  assert.equal(row.value, row.open_interest);

  const stats = run(["stats", "TLT", "--format", "csv", "--from-file", fixture("tlt-stats.html")]);
  const header = stats.stdout.split("\n")[0].split(",");
  assert.ok(header.includes("iv_pct"));
  assert.ok(header.includes("expected_move_abs"));
  assert.ok(!header.includes("iv"));
  assert.ok(!header.includes("expected_move"));
});

test("gex exposes the ±1EM summary fields and a note without --normalize sigma (OC-07)", () => {
  const result = run(["gex", "TLT", "--exp", "2026-10-09:w", "--from-file", fixture("tlt-gamma-exposure.html")]);
  const ticker = firstTicker(result);
  assert.ok("net_exposure_within_1em" in ticker);
  assert.equal(ticker.net_exposure_within_1em, null);
  assert.equal(typeof ticker.within_em_note, "string");
});

test("--provenance=minimal trims long notes and --no-provenance drops it (OC-08)", () => {
  const full = run(["spot", "TLT", "--from-file", fixture("tlt-price.html")]);
  const minimal = run(["spot", "TLT", "--provenance", "minimal", "--from-file", fixture("tlt-price.html")]);
  assert.equal(minimal.status, 0);
  const provenance = firstTicker(minimal).provenance as Record<string, unknown>;
  assert.equal(typeof provenance.fetched_at, "string");
  assert.ok(Array.isArray(provenance.warnings));
  assert.ok(!("url" in provenance));
  assert.ok(!("note" in firstTicker(minimal)));
  assert.ok(minimal.stdout.length < full.stdout.length);

  const none = run(["spot", "TLT", "--no-provenance", "--from-file", fixture("tlt-price.html")]);
  assert.ok(!("provenance" in firstTicker(none)));
  assert.equal(run(["spot", "TLT", "--provenance", "bogus", "--from-file", fixture("tlt-price.html")]).status, 2);
});

test("spot carries as_of_iso and zero-OI expiries warn (OC-09)", () => {
  const spot = run(["spot", "TLT", "--from-file", fixture("tlt-price.html")]);
  const asOfIso = firstTicker(spot).as_of_iso;
  assert.match(String(asOfIso), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const zero = run([
    "stats", "TLT", "--columns", "expiration,oi_total",
    "--from-file", fixture("tlt-stats-zero-oi.html"),
  ]);
  assert.equal(zero.status, 0);
  const warnings = (firstTicker(zero).provenance as { warnings: string[] }).warnings;
  assert.ok(warnings.some((warning) => /no open interest yet/.test(warning)));
});
