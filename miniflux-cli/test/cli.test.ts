/**
 * End-to-end tests: spawn the real CLI (via tsx) against a mock server.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { MockServer, startMockServer } from "./helpers/mock-server.js";

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const ENTRYPOINT = fileURLToPath(new URL("../src/index.ts", import.meta.url));

let server: MockServer;

before(async () => {
  server = await startMockServer([
    { method: "GET", path: "/v1/healthcheck", json: { message: "OK" } },
    { method: "GET", path: "/v1/me", json: { id: 1, username: "limour" } },
    { method: "GET", path: "/v1/entries", json: { total: 1, entries: [{ id: 5, title: "Hello" }] } },
    { method: "GET", path: "/v1/entries/5", json: { id: 5, title: "Hello" } },
    { method: "PUT", path: "/v1/entries", status: 204 },
    { method: "GET", path: "/v1/export/opml", text: "<opml>x</opml>" },
  ]);
});

after(async () => {
  await server.close();
});

function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [ENTRYPOINT, ...args], {
      env: {
        ...process.env,
        MINIFLUX_URL: server.url,
        MINIFLUX_API_KEY: "test-key",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("healthcheck prints a success message", async () => {
  const { code, stdout } = await runCli(["healthcheck"]);
  assert.equal(code, 0);
  assert.match(stdout, /Miniflux instance is healthy/);
});

test("entries prints JSON and forwards filters", async () => {
  const { code, stdout } = await runCli(["entries", "--status", "unread", "--limit", "20"]);
  assert.equal(code, 0);
  const data = JSON.parse(stdout) as { total: number };
  assert.equal(data.total, 1);
  const req = server.requests.at(-1)!;
  assert.match(req.url, /status=unread/);
  assert.match(req.url, /limit=20/);
});

test("mark requires --status and validates it", async () => {
  const missing = await runCli(["mark", "5"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /status/i);

  const invalid = await runCli(["mark", "5", "--status", "bogus"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /bogus|read.*unread.*removed/i);

  const ok = await runCli(["mark", "5", "--status", "read"]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /Entry status updated successfully/);
});

test("feed-entries requires --feed-id", async () => {
  const { code, stderr } = await runCli(["feed-entries"]);
  assert.equal(code, 1);
  assert.match(stderr, /feed-id/i);
});

test("invalid IDs fail with a clean error, not a stack trace", async () => {
  const { code, stdout, stderr } = await runCli(["entry", "abc"]);
  assert.equal(code, 1);
  assert.match(stderr, /positive integer/);
  assert.doesNotMatch(stderr, /at \S+:\d+:\d+/); // no stack trace
  assert.equal(stdout, "");
});

test("API errors exit 1 with a message on stderr", async () => {
  const { code, stderr } = await runCli(["entry", "999"]);
  assert.equal(code, 1);
  assert.match(stderr, /Miniflux API 404/);
});

test("missing MINIFLUX_URL exits 1 with guidance", async () => {
  const { code, stderr } = await runCli(["me"], { MINIFLUX_URL: "" });
  assert.equal(code, 1);
  assert.match(stderr, /MINIFLUX_URL environment variable is required/);
});

test("export-opml prints raw XML", async () => {
  const { code, stdout } = await runCli(["export-opml"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "<opml>x</opml>");
});
