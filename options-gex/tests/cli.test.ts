/** End-to-end CLI tests against the offline fixtures (no network). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "cli.ts");
const FIX = join(ROOT, "tests", "fixtures");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function json(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

test("gex returns projected JSON with dollar units", async () => {
  const result = await run([
    "gex",
    "SPY",
    "--from-file",
    join(FIX, "spy-2026-10-05-gamma.json"),
    "--top",
    "3",
    "--format",
    "compact",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const data = json(result.stdout);
  assert.equal(data.units, "usd_gex");
  const levels = data.levels as Record<string, unknown>;
  assert.equal(levels.net_gex_usd, "$544.93M");
  assert.equal(levels.spot_vs_flip, "above");
  assert.equal((data.gex_by_strike as unknown[]).length, 3);
  assert.equal(data.zero_gamma_estimate, 770.73);
  assert.deepEqual((data.provenance as Record<string, unknown>).warnings, []);
});

test("levels --format table renders a readable block", async () => {
  const result = await run([
    "levels",
    "SPY",
    "--from-file",
    join(FIX, "spy-2026-10-05-gamma.json"),
    "--format",
    "table",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^SPY {2}exp 2026-10-05 {2}source rest/m);
  assert.match(result.stdout, /"net_gex_usd":"\$544\.93M"/);
  assert.match(result.stdout, /\[GAMMA\] Positive Gamma Environment/);
});

test("strict-exp turns a silent fallback into exit 5", async () => {
  const args = [
    "levels",
    "SPY",
    "--exp",
    "2019-01-18",
    "--from-file",
    join(FIX, "rest-fallback.json"),
    "--strict-exp",
  ];
  const plain = await run(args);
  assert.equal(plain.code, 5);
  assert.match(plain.stderr, /silent expiry fallback/);
  assert.equal(plain.stdout, "");

  const structured = await run([...args, "--json-errors"]);
  assert.equal(structured.code, 5);
  const payload = json(structured.stdout);
  assert.equal(payload.ok, false);
  assert.equal((payload.error as Record<string, unknown>).code, "exp_fallback");
});

test("without --strict-exp the fallback is a warning and exit 0", async () => {
  const result = await run([
    "levels",
    "SPY",
    "--exp",
    "2019-01-18",
    "--from-file",
    join(FIX, "rest-fallback.json"),
    "--format",
    "compact",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const warnings = (json(result.stdout).provenance as Record<string, unknown>).warnings as string[];
  assert.ok(warnings.some((warning) => /requested exp 2019-01-18/.test(warning)));
});

test("the MCP fallback parses text fixtures into a snapshot", async () => {
  const result = await run([
    "gex",
    "SPY",
    "--source",
    "mcp",
    "--from-file",
    join(FIX, "mcp-spy-maxstrikes40.txt"),
    "--top",
    "2",
    "--format",
    "compact",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const data = json(result.stdout);
  const provenance = data.provenance as Record<string, unknown>;
  assert.equal(provenance.source, "mcp");
  assert.equal(data.units, "exposure_units");
  assert.equal((data.gex_by_strike as unknown[]).length, 2);
});

test("skew defaults to vanna + charm tables", async () => {
  const result = await run([
    "skew",
    "SPY",
    "--from-file",
    join(FIX, "spy-all-greeks.json"),
    "--top",
    "2",
    "--format",
    "compact",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const greeks = json(result.stdout).greeks as Record<string, unknown>;
  assert.deepEqual(Object.keys(greeks), ["vanna", "charm"]);
});

test("raw can add the OI dictionary on request", async () => {
  const result = await run([
    "raw",
    "SPY",
    "--from-file",
    join(FIX, "spy-all-greeks.json"),
    "--greeks",
    "all",
    "--top",
    "2",
    "--include",
    "oi",
    "--format",
    "compact",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const data = json(result.stdout);
  assert.deepEqual(Object.keys(data.greeks_exposure as Record<string, unknown>).sort(), [
    "charm",
    "delta",
    "gamma",
    "theta",
    "vanna",
    "vega",
  ]);
  assert.equal((data.open_interest_by_strike as unknown[]).length, 2);
});

test("expiries lists DTEs for the requested window", async () => {
  const result = await run([
    "expiries",
    "SPY",
    "--from-file",
    join(FIX, "spy-2026-10-05-gamma.json"),
    "--today",
    "2026-10-05",
    "--dte",
    "10",
    "--format",
    "compact",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const data = json(result.stdout);
  assert.equal(data.count, 9);
  assert.equal(data.total_available, 32);
  assert.deepEqual((data.expirations as Array<Record<string, unknown>>)[0], {
    exp: "2026-10-05",
    dte: 0,
    weekday: "Mon",
  });
});

test("flip reports the negative-gamma regime", async () => {
  const result = await run([
    "flip",
    "SPY",
    "--from-file",
    join(FIX, "spy-2026-10-16-gamma.json"),
    "--format",
    "compact",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const data = json(result.stdout);
  assert.equal(data.gamma_flip, 774.62);
  assert.equal(data.spot_vs_flip, "below");
  assert.match(String(data.regime), /negative net GEX/);
  assert.equal(data.zero_gamma_estimate, undefined);
});

test("usage errors exit 2 and mention the offending flag", async () => {
  const unknownFlag = await run(["gex", "SPY", "--nope", "1"]);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.stderr, /unknown flag --nope/);

  const unknownCommand = await run(["pivots", "SPY"]);
  assert.equal(unknownCommand.code, 2);
  assert.match(unknownCommand.stderr, /unknown command "pivots"/);

  const badExp = await run(["gex", "SPY", "--exp", "10/16/2026"]);
  assert.equal(badExp.code, 2);
  assert.match(badExp.stderr, /--exp must be YYYY-MM-DD/);

  const badGreek = await run(["gex", "SPY", "--greeks", "foo"]);
  assert.equal(badGreek.code, 2);
  assert.match(badGreek.stderr, /--greeks must be a comma list/);
});

test("--help and --version succeed without a ticker", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage: options-gex <command> <TICKER>/);

  const version = await run(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), "1.0.0");
});
