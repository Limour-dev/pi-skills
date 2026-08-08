import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, normalizeBaseUrl } from "../src/api/config.js";
import { MinifluxError } from "../src/api/error.js";

test("normalizeBaseUrl strips trailing slashes", () => {
  assert.equal(normalizeBaseUrl("https://example.com/"), "https://example.com");
  assert.equal(normalizeBaseUrl("https://example.com///"), "https://example.com");
});

test("normalizeBaseUrl strips trailing /v1 (case-insensitive)", () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1"), "https://example.com");
  assert.equal(normalizeBaseUrl("https://example.com/v1/"), "https://example.com");
  assert.equal(normalizeBaseUrl("https://example.com/V1"), "https://example.com");
  // only one level of /v1 is stripped
  assert.equal(normalizeBaseUrl("https://example.com/v1/v1"), "https://example.com/v1");
});

test("normalizeBaseUrl trims whitespace", () => {
  assert.equal(normalizeBaseUrl("  https://example.com/  "), "https://example.com");
});

test("normalizeBaseUrl rejects empty or schemeless URLs", () => {
  assert.throws(() => normalizeBaseUrl(""), MinifluxError);
  assert.throws(() => normalizeBaseUrl("   "), MinifluxError);
  assert.throws(() => normalizeBaseUrl("example.com"), /http:\/\/ or https:\/\//);
});

test("loadConfig reads MINIFLUX_URL and MINIFLUX_API_KEY", () => {
  const cfg = loadConfig({ MINIFLUX_URL: "https://example.com/", MINIFLUX_API_KEY: "k" });
  assert.deepEqual(cfg, { baseUrl: "https://example.com", apiKey: "k" });
});

test("loadConfig falls back to MINIFLUX_API_TOKEN", () => {
  const cfg = loadConfig({ MINIFLUX_URL: "https://example.com", MINIFLUX_API_TOKEN: "t" });
  assert.equal(cfg.apiKey, "t");
});

test("loadConfig prefers MINIFLUX_API_KEY over MINIFLUX_API_TOKEN", () => {
  const cfg = loadConfig({
    MINIFLUX_URL: "https://example.com",
    MINIFLUX_API_KEY: "k",
    MINIFLUX_API_TOKEN: "t",
  });
  assert.equal(cfg.apiKey, "k");
});

test("loadConfig reports missing variables clearly", () => {
  assert.throws(() => loadConfig({ MINIFLUX_API_KEY: "k" }), /MINIFLUX_URL environment variable is required/);
  assert.throws(() => loadConfig({ MINIFLUX_URL: "https://example.com" }), /MINIFLUX_API_KEY/);
});
