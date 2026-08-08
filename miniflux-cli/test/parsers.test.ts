import assert from "node:assert/strict";
import test from "node:test";
import { InvalidArgumentError } from "commander";
import { parseBoolOption, parseId, parseIntOption } from "../src/cli/parsers.js";

test("parseId accepts positive integers", () => {
  assert.equal(parseId("1"), 1);
  assert.equal(parseId("42"), 42);
});

test("parseId rejects zero, negatives, floats and garbage", () => {
  for (const bad of ["0", "-1", "1.5", "abc", "", "NaN"]) {
    assert.throws(() => parseId(bad), InvalidArgumentError);
  }
});

test("parseIntOption accepts integers including zero and negatives", () => {
  assert.equal(parseIntOption("0"), 0);
  assert.equal(parseIntOption("-5"), -5);
  assert.equal(parseIntOption("1700000000"), 1700000000);
});

test("parseIntOption rejects floats and garbage", () => {
  for (const bad of ["1.5", "abc", ""]) {
    assert.throws(() => parseIntOption(bad), InvalidArgumentError);
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
    assert.throws(() => parseBoolOption(bad), InvalidArgumentError);
  }
});
