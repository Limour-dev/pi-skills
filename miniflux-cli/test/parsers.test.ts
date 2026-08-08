import assert from "node:assert/strict";
import test from "node:test";
import { CliUsageError, parseBoolOption, parseId, parseIntOption } from "../src/cli/parsers.ts";
import { parseTimeOption, splitList } from "../src/cli/parsers.ts";

test("parseId accepts positive integers", () => {
  assert.equal(parseId("1"), 1);
  assert.equal(parseId("42"), 42);
});

test("parseId rejects zero, negatives, floats and garbage", () => {
  for (const bad of ["0", "-1", "1.5", "abc", "", "NaN"]) {
    assert.throws(() => parseId(bad), CliUsageError);
  }
});

test("parseIntOption accepts integers including zero and negatives", () => {
  assert.equal(parseIntOption("0"), 0);
  assert.equal(parseIntOption("-5"), -5);
  assert.equal(parseIntOption("1700000000"), 1700000000);
});

test("parseIntOption rejects floats and garbage", () => {
  for (const bad of ["1.5", "abc", ""]) {
    assert.throws(() => parseIntOption(bad), CliUsageError);
  }
});

test("parseBoolOption accepts common truthy/falsy spellings", () => {
  assert.equal(parseBoolOption("true"), true);
  assert.equal(parseBoolOption("1"), true);
  assert.equal(parseBoolOption("YES"), true);
  assert.equal(parseBoolOption("false"), false);
  assert.equal(parseBoolOption("0"), false);
  assert.equal(parseBoolOption("No"), false);
});

test("parseBoolOption rejects anything else", () => {
  for (const bad of ["maybe", "2", ""]) {
    assert.throws(() => parseBoolOption(bad), CliUsageError);
  }
});

test("parseTimeOption accepts unix timestamps and ISO dates", () => {
  assert.equal(parseTimeOption("1700000000"), 1700000000);
  assert.equal(parseTimeOption("2026-08-01T00:00:00Z"), Date.UTC(2026, 7, 1) / 1000);
  assert.equal(parseTimeOption("now"), Math.floor(Date.now() / 1000));
});

test("parseTimeOption accepts relative durations", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(parseTimeOption("1h"), now + 3600);
  assert.equal(parseTimeOption("7d"), now + 7 * 86400);
  assert.equal(parseTimeOption("30m"), now + 30 * 60);
});

test("parseTimeOption rejects garbage and millisecond timestamps", () => {
  assert.throws(() => parseTimeOption(""), CliUsageError);
  assert.throws(() => parseTimeOption("not-a-time"), CliUsageError);
  assert.throws(() => parseTimeOption("1700000000000"), CliUsageError); // ms
});

test("splitList splits on commas and trims empties", () => {
  assert.deepEqual(splitList("read,unread"), ["read", "unread"]);
  assert.deepEqual(splitList(" read , unread "), ["read", "unread"]);
  assert.deepEqual(splitList(""), []);
  assert.deepEqual(splitList("read,"), ["read"]);
});
