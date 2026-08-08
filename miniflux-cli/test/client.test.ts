import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { MinifluxClient, buildEntryQuery, buildUpdateFeedBody } from "../src/api/client.ts";
import { MinifluxError } from "../src/api/error.ts";
import { MockServer, startMockServer } from "./helpers/mock-server.ts";

let server: MockServer;

function client(overrides: { timeoutMs?: number } = {}): MinifluxClient {
  return new MinifluxClient({ baseUrl: server.url, apiKey: "test-key", ...overrides });
}

afterEach(async () => {
  await server?.close();
});

beforeEach(async () => {
  server = await startMockServer([
    { method: "GET", path: "/v1/healthcheck", json: { message: "OK" } },
    { method: "GET", path: "/v1/me", json: { id: 1, username: "limour" } },
    { method: "GET", path: "/v1/feeds", json: [{ id: 7, title: "Feed 7" }] },
    { method: "GET", path: "/v1/feeds/7", json: { id: 7, title: "Feed 7" } },
    { method: "DELETE", path: "/v1/feeds/7", status: 204 },
    { method: "GET", path: "/v1/entries", json: { total: 2, entries: [{ id: 1 }, { id: 2 }] } },
    { method: "GET", path: "/v1/entries/9", json: { id: 9, title: "Entry 9" } },
    { method: "GET", path: "/v1/feeds/7/entries", json: { total: 1, entries: [{ id: 3 }] } },
    { method: "PUT", path: "/v1/entries", status: 204 },
    { method: "PUT", path: "/v1/entries/9/bookmark", status: 204 },
    { method: "POST", path: "/v1/feeds", json: { feed_id: 42 } },
    { method: "POST", path: "/v1/categories", json: { id: 5, title: "News" } },
    { method: "GET", path: "/v1/export/opml", text: "<opml>feeds</opml>", contentType: "text/xml" },
    { method: "POST", path: "/v1/import/opml", status: 201, text: "" },
    { method: "GET", path: "/v1/unauthorized", status: 401, json: { error_message: "bad token" } },
    { method: "GET", path: "/", text: "miniflux home" },
  ]);
});

test("sends X-Auth-Token header and /v1 path", async () => {
  const feeds = await client().getFeeds();
  assert.deepEqual(feeds, [{ id: 7, title: "Feed 7" }]);
  const req = server.requests.at(-1)!;
  assert.equal(req.pathname, "/v1/feeds");
  assert.equal(req.headers["x-auth-token"], "test-key");
});

test("normalizes base URLs with trailing /v1", async () => {
  const c = new MinifluxClient({ baseUrl: `${server.url}/v1/`, apiKey: "k" });
  await c.getFeeds();
  assert.equal(server.requests.at(-1)!.pathname, "/v1/feeds");
});

test("getEntries builds the filter query string", async () => {
  await client().getEntries({
    status: "unread",
    limit: 20,
    direction: "desc",
    beforeEntryId: 100,
    starred: true,
  });
  const url = server.requests.at(-1)!.url;
  assert.match(url, /status=unread/);
  assert.match(url, /limit=20/);
  assert.match(url, /direction=desc/);
  assert.match(url, /before_entry_id=100/);
  assert.match(url, /starred=true/);
});

test("getFeedEntries targets the feed-scoped path", async () => {
  const res = await client().getFeedEntries(7, { limit: 5 });
  assert.equal(res.total, 1);
  assert.match(server.requests.at(-1)!.url, /^\/v1\/feeds\/7\/entries\?limit=5$/);
});

test("createFeed POSTs a JSON body", async () => {
  const res = await client().createFeed("https://example.com/rss", 3);
  assert.deepEqual(res, { feed_id: 42 });
  const req = server.requests.at(-1)!;
  assert.equal(req.method, "POST");
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(req.body), { feed_url: "https://example.com/rss", category_id: 3 });
});

test("updateEntryStatus PUTs entry_ids and validates status", async () => {
  await client().updateEntryStatus([1, 2], "read");
  const req = server.requests.at(-1)!;
  assert.equal(req.method, "PUT");
  assert.deepEqual(JSON.parse(req.body), { entry_ids: [1, 2], status: "read" });

  assert.throws(
    // cast: deliberately test the runtime guard against invalid input
    () => client().updateEntryStatus([1], "bogus" as never),
    /Invalid entry status/,
  );
});

test("204 responses resolve to undefined", async () => {
  assert.equal(await client().deleteFeed(7), undefined);
  assert.equal(await client().toggleBookmark(9), undefined);
});

test("API errors become MinifluxError with status and server detail", async () => {
  let err: unknown;
  try {
    await client().getFeed(999); // no mock route -> 404
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof MinifluxError);
  assert.equal(err.status, 404);
  assert.match(err.message, /no mock route/);
});
test("exportOpml returns raw text, importOpml sends raw XML", async () => {
  const opml = await client().exportOpml();
  assert.equal(opml, "<opml>feeds</opml>");

  await client().importOpml("<opml>new</opml>");
  const req = server.requests.at(-1)!;
  assert.equal(req.body, "<opml>new</opml>");
  assert.equal(req.headers["content-type"], "text/xml");
});

test("healthcheck succeeds via /v1/healthcheck", async () => {
  await client().healthcheck();
  assert.equal(server.requests.at(-1)!.pathname, "/v1/healthcheck");
});

test("healthcheck falls back to base URL when endpoint is missing", async () => {
  const s = await startMockServer([{ method: "GET", path: "/", text: "ok" }]);
  try {
    const c = new MinifluxClient({ baseUrl: s.url, apiKey: "k" });
    await c.healthcheck();
    const paths = s.requests.map((r) => r.pathname);
    assert.deepEqual(paths, ["/v1/healthcheck", "/"]);
  } finally {
    await s.close();
  }
});

test("healthcheck reports auth errors instead of falling back", async () => {
  const s = await startMockServer([
    { method: "GET", path: "/v1/healthcheck", status: 401, json: { error_message: "access denied" } },
    { method: "GET", path: "/", text: "ok" },
  ]);
  try {
    const c = new MinifluxClient({ baseUrl: s.url, apiKey: "k" });
    await assert.rejects(() => c.healthcheck(), /401/);
    // must not have probed the base URL
    assert.equal(s.requests.length, 1);
  } finally {
    await s.close();
  }
});

test("requests time out with a MinifluxError", async () => {
  const { createServer } = await import("node:http");
  // server that accepts connections but never responds
  const blackhole = createServer(() => {
    /* never respond */
  });
  await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  const { port } = blackhole.address() as import("node:net").AddressInfo;
  try {
    const c = new MinifluxClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", timeoutMs: 50 });
    await assert.rejects(() => c.getFeeds(), /timed out after 50ms/);
  } finally {
    await new Promise<void>((resolve) => blackhole.close(() => resolve()));
  }
});
test("buildUpdateFeedBody maps camelCase fields to snake_case", () => {
  assert.deepEqual(buildUpdateFeedBody({ title: "T", categoryId: 2, userAgent: "UA" }), {
    title: "T",
    category_id: 2,
    user_agent: "UA",
  });
  assert.deepEqual(buildUpdateFeedBody({}), {});
});
