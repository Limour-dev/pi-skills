/**
 * End-to-end CLI tests against the offline mock API: argument handling,
 * pagination, output shapes, exit codes and credential hygiene.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { startMockServer, type MockServer } from "./mock-server.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "cli.ts");
const API_KEY = "mock-secret-key-do-not-leak";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { cwd: ROOT, env: { ...process.env, MASSIVE_API_KEY: "" } }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

let server: MockServer;
const base = (): string[] => ["--base-url", server.url, "--api-key", API_KEY];

before(async () => {
  server = await startMockServer({ pageSize: 4 });
});
after(async () => {
  await server.close();
});

test("gex: paginates the chain snapshot and computes the 1-week report", async () => {
  const r = await run([...base(), "gex", "TEST", "--dte", "7", "--as-of", "2026-10-02"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as any;

  assert.equal(out.underlying, "TEST");
  assert.equal(out.spot.price, 100);
  assert.equal(out.spot.source, "previous-close", "the stock snapshot is plan-gated; fall back to the delayed bar");
  assert.equal(out.signMode, "dealer");
  assert.equal(out.unit, "USD per 1% move");
  assert.match(out.formula, /spot\^2/);
  assert.deepEqual(out.selection.expirations, ["2026-10-09"]);
  assert.equal(out.total.gex, 14_000);
  assert.equal(out.total.zeroGamma, 97.5);
  assert.equal(out.total.callWall.strike, 100);
  assert.equal(out.total.putWall.strike, 100);
  assert.equal(out.meta.pages, 2, "9 fixture rows over 4-row pages needs 2 pages inside the window");
  assert.ok(out.meta.requests >= 3, "spot + expiry discovery + snapshot pages");
  assert.match(r.stderr, /warning: .*Black-Scholes|^$/);
});

test("gex: --format table renders without a JSON payload", async () => {
  const r = await run([...base(), "gex", "TEST", "--dte", "7", "--as-of", "2026-10-02", "--format", "table"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /net GEX/);
  assert.match(r.stdout, /zero gamma/);
  assert.throws(() => JSON.parse(r.stdout));
});

test("gex: --sign-mode absolute doubles the magnitude", async () => {
  const r = await run([...base(), "gex", "TEST", "--dte", "7", "--as-of", "2026-10-02", "--sign-mode", "absolute"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((JSON.parse(r.stdout) as any).total.gex, 276_000);
});

test("gex: an invalid --sign-mode is a usage error (exit 2)", async () => {
  const r = await run([...base(), "gex", "TEST", "--sign-mode", "nonsense"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--sign-mode must be one of/);
});

test("max-pain: reports the cheapest settlement strike", async () => {
  const r = await run([...base(), "max-pain", "TEST", "--dte", "60", "--as-of", "2026-10-02", "--format", "compact"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as any;
  assert.equal(out.total.maxPain, 100);
  assert.equal(out.total.painAtMaxPain, 60_000);
  assert.equal(out.expirations.length, 2);
  assert.equal(out.total.top[0].strike, 100);
});

test("chain: exposes per-contract open interest, greeks and gex", async () => {
  const r = await run([...base(), "chain", "TEST", "--dte", "7", "--as-of", "2026-10-02"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as any;
  assert.equal(out.contracts.length, 6);
  const c = out.contracts.find((x: any) => x.ticker === "O:TEST261009C00100000");
  assert.equal(c.oi, 200);
  assert.equal(c.gamma, 0.06);
  assert.equal(c.gex, 120_000);
  assert.equal(c.moneynessPct, 0);
});

test("expiries: discovers the horizon from the contract reference index", async () => {
  const r = await run([...base(), "expiries", "TEST", "--dte", "60", "--as-of", "2026-10-02"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as any;
  assert.deepEqual(
    out.expirations.map((e: any) => [e.expiry, e.dte]),
    [
      ["2026-10-09", 7],
      ["2026-11-20", 49],
    ],
  );
});

test("spot: falls back to the delayed bar and says so", async () => {
  const r = await run([...base(), "spot", "TEST"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as any;
  assert.equal(out.price, 100);
  assert.equal(out.source, "previous-close");
  assert.equal(out.timeframe, "END-OF-DAY");
});

test("contract: reference plus previous-day bar", async () => {
  const r = await run([...base(), "contract", "O:TEST261009C00100000", "--as-of", "2026-10-02"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as any;
  assert.equal(out.reference.ticker, "O:TEST261009C00100000");
  assert.equal(out.reference.strike_price, 100);
  assert.equal(out.previousDay.results[0].c, 100);
});

test("entitlement failures exit 3 with plan guidance and no stdout", async () => {
  const r = await run([...base(), "gex", "NOPE", "--dte", "7", "--as-of", "2026-10-02"]);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /not entitled|plan/i);
  assert.match(r.stderr, /massive\.com\/pricing/);
});

test("--from-file analyses a saved snapshot without any API access", async () => {
  const r = await run(["gex", "TEST", "--from-file", "tests/fixtures/snapshot-test.json", "--dte", "7", "--as-of", "2026-10-02"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as any;
  assert.equal(out.total.gex, 14_000);
  assert.equal(out.spot.source, "file");
  assert.equal(out.provenance.source, "file");
  assert.equal(out.meta.requests, 0);
});

test("probe: reports which endpoints the key can reach", async () => {
  const r = await run([...base(), "probe"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as any;
  assert.equal(out.gexAvailable, false);
  const chain = out.endpoints.find((e: any) => e.name === "options-chain-snapshot");
  assert.equal(chain.status, "not-entitled");
  assert.match(out.verdict, /cannot read the option chain snapshot/);
  assert.ok(out.workarounds.length > 0);
});

test("the API key never appears in output or errors", async () => {
  const ok = await run([...base(), "gex", "TEST", "--dte", "7", "--as-of", "2026-10-02"]);
  const bad = await run([...base(), "gex", "NOPE"]);
  for (const r of [ok, bad]) {
    assert.ok(!r.stdout.includes(API_KEY));
    assert.ok(!r.stderr.includes(API_KEY));
  }
});

test("missing credentials exit 3 with a signup hint", async () => {
  const r = await run(["spot", "TEST"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /No Massive API key/);
  assert.equal(r.stdout, "");
});

test("unknown commands exit 2 with usage", async () => {
  const r = await run(["nope"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command/);
  assert.match(r.stderr, /Usage:/);
});
