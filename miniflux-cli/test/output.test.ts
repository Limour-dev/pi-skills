import assert from "node:assert/strict";
import test from "node:test";
import {
  compactEntries,
  parseFieldsOption,
  sanitizeZeroDates,
  selectEntryFields,
  stripHtml,
} from "../src/cli/output.ts";

test("sanitizeZeroDates blanks Go zero-value timestamps", () => {
  const input = { next_check_at: "0001-01-01T00:00:00Z", checked_at: "2026-08-08T10:00:00Z" };
  const out = sanitizeZeroDates(input) as Record<string, unknown>;
  assert.equal(out.next_check_at, null);
  assert.equal(out.checked_at, "2026-08-08T10:00:00Z");
});

test("sanitizeZeroDates recurses into arrays and objects", () => {
  const out = sanitizeZeroDates([{ a: "0001-01-01T00:00:00Z" }, { b: "ok" }]) as Array<
    Record<string, unknown>
  >;
  assert.equal(out[0].a, null);
  assert.equal(out[1].b, "ok");
});

test("compactEntries keeps a short field set and flattens feed", () => {
  const data = {
    total: 1,
    entries: [
      {
        id: 5,
        title: "Hello",
        feed_id: 7,
        published_at: "2026-08-08T00:00:00Z",
        status: "unread",
        starred: false,
        content: "<p>body</p>",
        feed: { id: 7, title: "Feed 7" },
      },
    ],
  };
  const out = compactEntries(data) as { entries: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(out.entries[0]).sort(), [
    "feed",
    "feed_id",
    "id",
    "published_at",
    "starred",
    "status",
    "title",
  ]);
});

test("compactEntries with plainText strips HTML from content", () => {
  const data = { total: 1, entries: [{ id: 1, content: "<p>Hello <b>world</b></p>" }] };
  const out = compactEntries(data, { plainText: true }) as { entries: Array<Record<string, unknown>> };
  assert.equal(out.entries[0].content, "Hello world");
});

test("stripHtml removes tags and collapses whitespace", () => {
  assert.equal(stripHtml("<p>Hello <b>world</b></p>"), "Hello world");
});

test("parseFieldsOption parses a CSV into a Set", () => {
  const set = parseFieldsOption("id,title,published_at");
  assert.ok(set);
  assert.deepEqual([...set!].sort(), ["id", "published_at", "title"]);
  assert.equal(parseFieldsOption(undefined), undefined);
  assert.equal(parseFieldsOption(","), undefined);
});

test("selectEntryFields keeps only requested fields", () => {
  const data = { total: 1, entries: [{ id: 5, title: "Hello", feed_id: 7 }] };
  const out = selectEntryFields(data, new Set(["id", "title"])) as {
    entries: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(out.entries[0]).sort(), ["id", "title"]);
});